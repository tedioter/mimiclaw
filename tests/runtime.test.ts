import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Agent } from "../src/agent/agent.js";
import {
  AgentRuntime,
  createAgentLoopControl,
  createRuntime,
  shouldShowEvent
} from "../src/app/runtime.js";
import { MessageBus } from "../src/bus/message-bus.js";
import type { InboundMessage } from "../src/bus/message-bus.js";
import type { AgentEvent } from "../src/types/events.js";
import { createDeferred } from "../src/utils/async.js";
import { makeConfig, temporaryDirectory } from "./test-helpers.js";

function mockAgent(
  respond: (inbound: InboundMessage) => AsyncIterable<AgentEvent>,
  handleTurnDone: Agent["handleTurnDone"] = async () => {}
): Agent {
  return { respond, handleTurnDone } as Agent;
}

describe("Agent 应用层运行循环", () => {
  it("收到 turn_done 后提交轮次记忆", async () => {
    const bus = new MessageBus();
    const control = createAgentLoopControl();
    const inbound: InboundMessage = {
      platform: "cli",
      text: "你好",
      messageId: "message-1"
    };
    const committed = createDeferred<{ inbound: InboundMessage; assistantReply: string }>();
    const published = createDeferred<void>();
    const events: AgentEvent[] = [];
    const unregister = bus.registerHandler("cli", async ({ event }) => {
      events.push(event);
      if (event.type === "turn_done") {
        published.resolve();
      }
    });
    const agent = mockAgent(
      async function* respond(_inbound: InboundMessage): AsyncIterable<AgentEvent> {
        yield { type: "text_delta", text: "你好，" };
        yield { type: "turn_done", text: "你好，很高兴认识你。" };
      },
      async (received, assistantReply) => {
        committed.resolve({ inbound: received, assistantReply });
      }
    );
    const runtime = new AgentRuntime(makeConfig(temporaryDirectory()), agent, bus);
    const agentTask = runtime.runLoop(control);
    const dispatchTask = bus.dispatchHandlers();

    try {
      bus.publishInboundMessage(inbound);
      await expect(committed.promise).resolves.toEqual({
        inbound,
        assistantReply: "你好，很高兴认识你。"
      });
      await published.promise;
      expect(events).toEqual([
        { type: "text_delta", text: "你好，" },
        { type: "turn_done", text: "你好，很高兴认识你。" }
      ]);
    } finally {
      control.stop();
      bus.close();
      unregister();
      await Promise.allSettled([agentTask, dispatchTask]);
    }
  });

  it("partial turn_done 仍提交轮次记忆", async () => {
    const bus = new MessageBus();
    const control = createAgentLoopControl();
    const inbound: InboundMessage = {
      platform: "cli",
      text: "你好",
      messageId: "message-partial"
    };
    const committed = createDeferred<{ inbound: InboundMessage; assistantReply: string }>();
    const agent = mockAgent(
      async function* respond(_inbound: InboundMessage): AsyncIterable<AgentEvent> {
        yield { type: "text_delta", text: "部分" };
        yield { type: "turn_done", text: "部分" };
      },
      async (received, assistantReply) => {
        committed.resolve({ inbound: received, assistantReply });
      }
    );
    const runtime = new AgentRuntime(makeConfig(temporaryDirectory()), agent, bus);
    const agentTask = runtime.runLoop(control);
    const dispatchTask = bus.dispatchHandlers();

    try {
      bus.publishInboundMessage(inbound);
      await expect(committed.promise).resolves.toEqual({
        inbound,
        assistantReply: "部分"
      });
    } finally {
      control.stop();
      bus.close();
      await Promise.allSettled([agentTask, dispatchTask]);
    }
  });

  it("按展示配置过滤思考与工具意图事件", async () => {
    const bus = new MessageBus();
    const control = createAgentLoopControl();
    const inbound: InboundMessage = {
      platform: "cli",
      text: "执行",
      messageId: "message-2"
    };
    const published = createDeferred<void>();
    const events: AgentEvent[] = [];
    const unregister = bus.registerHandler("cli", async ({ event }) => {
      events.push(event);
      if (event.type === "turn_done") {
        published.resolve();
      }
    });
    const agent = mockAgent(async function* respond(
      _inbound: InboundMessage
    ): AsyncIterable<AgentEvent> {
      yield { type: "thinking_delta", text: "先想一下。" };
      yield { type: "tool_intent", toolName: "read", intent: "读取文件" };
      yield { type: "text_delta", text: "完成。" };
      yield { type: "turn_done", text: "完成。" };
    });
    const config = makeConfig(temporaryDirectory());
    config.display = { showThinking: false, showToolCalls: false };
    const runtime = new AgentRuntime(config, agent, bus);
    const agentTask = runtime.runLoop(control);
    const dispatchTask = bus.dispatchHandlers();

    try {
      bus.publishInboundMessage(inbound);
      await published.promise;
      expect(events).toEqual([
        { type: "text_delta", text: "完成。" },
        { type: "turn_done", text: "完成。" }
      ]);
    } finally {
      control.stop();
      bus.close();
      unregister();
      await Promise.allSettled([agentTask, dispatchTask]);
    }
  });
});

describe("shouldShowEvent", () => {
  it("按 display 开关决定是否发布思考与工具意图", () => {
    expect(
      shouldShowEvent(
        { type: "thinking_delta", text: "x" },
        { showThinking: false, showToolCalls: true }
      )
    ).toBe(false);
    expect(
      shouldShowEvent(
        { type: "tool_intent", toolName: "read", intent: "读取" },
        { showThinking: true, showToolCalls: false }
      )
    ).toBe(false);
    expect(
      shouldShowEvent(
        { type: "text_delta", text: "ok" },
        { showThinking: false, showToolCalls: false }
      )
    ).toBe(true);
  });
});

function writeRuntimeConfig(root: string): string {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp.json"), '{"mcpServers": {}}\n');
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(
    configPath,
    [
      `data_dir = "${path.join(root, "data").replace(/\\/g, "/")}"`,
      "[model]",
      'base_url = "https://example.com/v1"',
      'api_key = "test-key"',
      'model = "demo"',
      "[mcp]",
      `config_file = "${path.join(root, "mcp.json").replace(/\\/g, "/")}"`,
      ""
    ].join("\n")
  );
  return configPath;
}

describe("createRuntime", () => {
  it("从配置文件组装 AgentRuntime", async () => {
    const root = temporaryDirectory();
    const configPath = writeRuntimeConfig(root);
    const runtime = await createRuntime(true, configPath);
    try {
      expect(runtime.config.model.model).toBe("demo");
      expect(runtime.agent).toBeDefined();
      expect(runtime.bus).toBeDefined();
    } finally {
      await runtime.close();
    }
  });
});
