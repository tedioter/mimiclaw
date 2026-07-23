import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitTurn } from "../src/app/turn-coordinator.js";
import { LongTermMemory, Memory, ShortTermMemory } from "../src/memory/index.js";
import { ToolRegistry } from "../src/tools/toolregistry.js";
import { Tool } from "../src/tools/base.js";
import { buildTurnId } from "../src/utils/turn-id.js";
import type { AgentEvent } from "../src/types/events.js";
import {
  FakeModel,
  cleanupTemporaryDirectories,
  createTestAgent,
  makeConfig,
  temporaryDirectory,
  testTool
} from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

function createMemory(root: string, maxTurns = 3): Memory {
  return new Memory(
    new ShortTermMemory(path.join(root, "data", "recent.json"), maxTurns),
    new LongTermMemory(path.join(root, "data"))
  );
}

function createCountingTool() {
  const state = { count: 0 };
  class CountingTool extends Tool {
    readonly name = "count";
    readonly description = "计数工具";
    readonly schema = z.object({ value: z.number().int() });

    async execute(arguments_: Record<string, unknown>): Promise<string> {
      state.count++;
      return `第 ${state.count} 次，值 ${String(arguments_.value)}`;
    }
  }
  return { tool: new CountingTool(), state };
}

describe("Agent 工具循环", () => {
  it("关闭时只释放一次所拥有的模型", async () => {
    const root = temporaryDirectory();
    const model = new FakeModel([]);
    const close = vi.spyOn(model, "close");
    const agent = createTestAgent(
      makeConfig(root),
      model,
      createMemory(root),
      new ToolRegistry([])
    );

    await Promise.all([agent.close(), agent.close()]);
    await agent.close();

    expect(close).toHaveBeenCalledOnce();
  });

  it("工具循环回传 reasoning_content 供思考模式下的后续请求", async () => {
    const root = temporaryDirectory();
    const arguments_ = JSON.stringify({ value: 1, intent: "执行计数" });
    const config = makeConfig(root);
    config.model.enableThinking = true;
    config.display.showThinking = false;
    const model = new FakeModel([
      [
        { type: "model_thinking_delta", text: "需要先计数。" },
        {
          type: "model_tool_call_delta",
          index: 0,
          callId: "call_1",
          name: "count",
          arguments: arguments_
        }
      ],
      [{ type: "model_text_delta", text: "已完成。" }]
    ]);
    const { tool } = createCountingTool();
    const agent = createTestAgent(config, model, createMemory(root), new ToolRegistry([tool]));

    for await (const _event of agent.respond({ platform: "cli", text: "执行" })) {
      // 消费完整事件流
    }

    const assistantMessage = model.calls[1]?.find(
      (message) => message.role === "assistant" && message.tool_calls?.length
    );
    expect(assistantMessage).toMatchObject({
      reasoning_content: "需要先计数。"
    });
  });

  it("思考为空时不传 reasoning_content 字段", async () => {
    const root = temporaryDirectory();
    const arguments_ = JSON.stringify({ value: 1, intent: "执行计数" });
    const config = makeConfig(root);
    config.model.enableThinking = true;
    const model = new FakeModel([
      [
        {
          type: "model_tool_call_delta",
          index: 0,
          callId: "call_1",
          name: "count",
          arguments: arguments_
        }
      ],
      [{ type: "model_text_delta", text: "已完成。" }]
    ]);
    const { tool } = createCountingTool();
    const agent = createTestAgent(config, model, createMemory(root), new ToolRegistry([tool]));

    for await (const _event of agent.respond({ platform: "cli", text: "执行" })) {
      // 消费完整事件流
    }

    const assistantMessage = model.calls[1]?.find(
      (message) => message.role === "assistant" && message.tool_calls?.length
    );
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage).not.toHaveProperty("reasoning_content");
  });

  it("工具轮中间的 content 不展示给用户", async () => {
    const root = temporaryDirectory();
    const arguments_ = JSON.stringify({ path: "package.json", intent: "读取文件" });
    const config = makeConfig(root);
    const model = new FakeModel([
      [
        { type: "model_text_delta", text: "Let me analyze the fix." },
        {
          type: "model_tool_call_delta",
          index: 0,
          callId: "call_1",
          name: "read",
          arguments: arguments_
        }
      ],
      [{ type: "model_text_delta", text: "修复已完成。" }]
    ]);
    const agent = createTestAgent(
      config,
      model,
      createMemory(root),
      new ToolRegistry([testTool("read", root)])
    );
    const events = [];
    for await (const event of agent.respond({ platform: "cli", text: "评价修复" })) {
      events.push(event);
    }
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.text)
    ).toEqual(["修复已完成。"]);
    const assistantMessage = model.calls[1]?.find(
      (message) => message.role === "assistant" && message.tool_calls?.length
    );
    expect(assistantMessage?.content).toBe("Let me analyze the fix.");
  });

  it("相同参数仍然真实执行两次并提交最终记忆", async () => {
    const root = temporaryDirectory();
    const arguments_ = JSON.stringify({ value: 7, intent: "执行计数" });
    const model = new FakeModel([
      [
        {
          type: "model_tool_call_delta",
          index: 0,
          callId: "call_1",
          name: "count",
          arguments: arguments_
        },
        {
          type: "model_tool_call_delta",
          index: 1,
          callId: "call_2",
          name: "count",
          arguments: arguments_
        }
      ],
      [{ type: "model_text_delta", text: "已执行两次。" }]
    ]);
    const { tool, state } = createCountingTool();
    const memory = createMemory(root);
    const config = makeConfig(root);
    const agent = createTestAgent(config, model, memory, new ToolRegistry([tool]));
    const events = [];
    for await (const event of agent.respond({ platform: "cli", text: "执行" })) {
      events.push(event);
    }
    const done = events.find(
      (event): event is Extract<AgentEvent, { type: "turn_done" }> => event.type === "turn_done"
    );
    if (!done) {
      throw new Error("测试轮次没有完成事件");
    }
    await commitTurn(
      config.memory,
      model,
      memory,
      { platform: "cli", text: "执行" },
      done.text,
      buildTurnId({ platform: "cli" })
    );
    expect(state.count).toBe(2);
    expect(events.filter((event) => event.type === "tool_intent")).toHaveLength(2);
    expect(memory.shortTerm.loadState().turns[0]?.assistant).toBe("已执行两次。");
    expect(model.calls[1]?.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("区分工具解析失败并精简调用日志", async () => {
    const root = temporaryDirectory();
    const model = new FakeModel([
      [
        {
          type: "model_tool_call_delta",
          index: 0,
          callId: "call_unknown",
          name: "missing",
          arguments: JSON.stringify({ intent: "调用不存在的工具" })
        },
        {
          type: "model_tool_call_delta",
          index: 1,
          callId: "call_invalid",
          name: "count",
          arguments: '{"value":'
        }
      ],
      [{ type: "model_text_delta", text: "已处理失败信息。" }]
    ]);
    const agent = createTestAgent(
      makeConfig(root),
      model,
      createMemory(root),
      new ToolRegistry([createCountingTool().tool])
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      for await (const _event of agent.respond({ platform: "cli", text: "执行" })) {
        // 消费完整事件流
      }

      const toolMessages = model.calls[1]?.filter((message) => message.role === "tool") ?? [];
      expect(toolMessages.map((message) => message.content)).toEqual([
        '不存在此工具："missing"',
        "工具参数无效：工具参数不是有效的 JSON 对象"
      ]);

      const infoLogs = info.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>
      );
      const toolCallLogs = infoLogs.filter((entry) => entry.type === "tool_call");
      expect(toolCallLogs).toHaveLength(2);
      expect(toolCallLogs.every((entry) => !("arguments" in entry) && !("content" in entry))).toBe(
        true
      );

      const errorLogs = errors.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>
      );
      expect(errorLogs.map((entry) => entry.type)).toEqual([
        "tool_resolution_error",
        "tool_argument_error"
      ]);
    } finally {
      info.mockRestore();
      errors.mockRestore();
    }
  });
});

describe("buildTurnId", () => {
  it("平台 messageId 映射为 platform + sha256 前 8 位", () => {
    const turnId = buildTurnId({
      platform: "qq",
      messageId: "ROBOT1.0_QQTJ2UfhTxSclinI8XwJfgU3rJXFUBEyLtoRzx"
    });
    expect(turnId).toMatch(/^qq:[0-9a-f]{8}$/);
    expect(
      buildTurnId({ platform: "qq", messageId: "ROBOT1.0_QQTJ2UfhTxSclinI8XwJfgU3rJXFUBEyLtoRzx" })
    ).toBe(turnId);
  });

  it("无 messageId 时使用 platform + 8 位随机 id", () => {
    const turnId = buildTurnId({ platform: "cli" });
    expect(turnId).toMatch(/^cli:[0-9a-f]{8}$/);
  });
});
