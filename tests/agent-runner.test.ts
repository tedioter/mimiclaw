import { describe, expect, it } from "vitest";
import { MessageBus } from "../src/bus/message-bus.js";
import {
  createAgentLoopControl,
  runAgentLoop,
  shouldPublishAgentEvent
} from "../src/app/agent-runner.js";
import type { InboundMessage } from "../src/bus/message-bus.js";
import type { AgentEvent } from "../src/types/events.js";
import { createDeferred } from "../src/utils/async.js";

describe("Agent 应用层运行循环", () => {
  it("收到完成事件后把最终回复交给 App 层提交", async () => {
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
    const responder = {
      async *respond(_inbound: InboundMessage): AsyncIterable<AgentEvent> {
        yield { type: "text_delta", text: "你好，" };
        yield { type: "turn_done", text: "你好，很高兴认识你。" };
      }
    };
    const agentTask = runAgentLoop(responder, bus, control, async (received, assistantReply) => {
      committed.resolve({ inbound: received, assistantReply });
    });
    const dispatchTask = bus.dispatchHandlers();

    try {
      bus.publishInbound(inbound);
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
    const responder = {
      async *respond(_inbound: InboundMessage): AsyncIterable<AgentEvent> {
        yield { type: "thinking_delta", text: "先想一下。" };
        yield { type: "tool_intent", toolName: "read", intent: "读取文件" };
        yield { type: "text_delta", text: "完成。" };
        yield { type: "turn_done", text: "完成。" };
      }
    };
    const agentTask = runAgentLoop(responder, bus, control, undefined, {
      showThinking: false,
      showToolCalls: false
    });
    const dispatchTask = bus.dispatchHandlers();

    try {
      bus.publishInbound(inbound);
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

describe("shouldPublishAgentEvent", () => {
  it("按 display 开关决定是否发布思考与工具意图", () => {
    expect(
      shouldPublishAgentEvent(
        { type: "thinking_delta", text: "x" },
        { showThinking: false, showToolCalls: true }
      )
    ).toBe(false);
    expect(
      shouldPublishAgentEvent(
        { type: "tool_intent", toolName: "read", intent: "读取" },
        { showThinking: true, showToolCalls: false }
      )
    ).toBe(false);
    expect(
      shouldPublishAgentEvent(
        { type: "text_delta", text: "ok" },
        { showThinking: false, showToolCalls: false }
      )
    ).toBe(true);
  });
});
