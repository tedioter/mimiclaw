import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { buildPromptContext } from "../src/agent/prompt.js";
import { AgentRuntime } from "../src/app/runtime.js";
import { MessageBus } from "../src/bus/message-bus.js";
import type { Model, ModelEvent, ModelMessage } from "../src/model/index.js";
import { MemoryStoreError } from "../src/types/errors.js";
import type { AgentEvent } from "../src/types/events.js";
import {
  LongTermMemory,
  Memory,
  ShortTermMemory,
  type MemoryCompression
} from "../src/memory/index.js";
import { ToolRegistry } from "../src/tools/index.js";
import {
  cleanupTemporaryDirectories,
  createTestAgent,
  FakeModel,
  makeConfig,
  readLogFile,
  temporaryDirectory,
  useTestLogFile
} from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

function createMemory(
  root: string,
  maxTurns = 3,
  compression: MemoryCompression = { compressBatch: 1, compressContext: false }
): Memory {
  return new Memory(
    new ShortTermMemory(path.join(root, "data", "recent.json"), maxTurns),
    new LongTermMemory(path.join(root, "data")),
    compression
  );
}

class FailingFollowUpModel implements Model {
  private calls = 0;

  constructor(private readonly failureMessage: string) {}

  async *streamChat(_messages: ModelMessage[]): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls > 1) {
      throw new Error(this.failureMessage);
    }
    yield { type: "model_text_delta", text: "最终回答" };
  }

  async close(): Promise<void> {}
}

class EmptyFollowUpModel implements Model {
  private calls = 0;

  async *streamChat(_messages: ModelMessage[]): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.calls === 1) {
      yield { type: "model_text_delta", text: "最终回答" };
    }
  }

  async close(): Promise<void> {}
}

async function consumeTurn(agent: Agent, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const _event of agent.respond({ platform: "cli", text })) {
    events.push(_event);
  }
  return events;
}

async function commitConsumedTurn(agent: Agent, text: string, events: AgentEvent[]): Promise<void> {
  const done = events.find(
    (event): event is Extract<AgentEvent, { type: "turn_done" }> => event.type === "turn_done"
  );
  if (!done) {
    throw new Error("测试轮次没有完成事件");
  }
  await agent.handleTurnDone({ platform: "cli", text }, done.text);
}

function readErrorLogs(logPath: string): Record<string, unknown>[] {
  return readLogFile(logPath).filter((entry) => entry.level === "error");
}

describe("Agent 记忆", () => {
  it("将长期记忆和上下文摘要注入模型上下文", async () => {
    const root = temporaryDirectory();
    const memory = createMemory(root);
    await memory.longTerm.replaceMemory("# 长期记忆\n\n- 已确认的信息");
    await memory.shortTerm.saveState({
      summary: "之前讨论过工作区路径",
      turns: []
    });
    const model = new FakeModel([[{ type: "model_text_delta", text: "已读取。" }]]);
    const agent = createTestAgent(model, memory, new ToolRegistry([]));

    await consumeTurn(agent, "读取记忆");

    const systemPrompt = String(model.calls[0]?.[0]?.content);
    expect(systemPrompt).toContain("已确认的信息");
    expect(systemPrompt).toContain("之前讨论过工作区路径");
    expect(systemPrompt).toContain("<recent_conversation_summary>");
  });

  it("App 提交轮次后刷新 prompt 和对话历史", async () => {
    const root = temporaryDirectory();
    const config = makeConfig(root);
    const model = new FakeModel([[{ type: "model_text_delta", text: "下一轮回复" }]]);
    const memory = createMemory(root);
    const agent = createTestAgent(model, memory, new ToolRegistry([]));
    const runtime = new AgentRuntime(config, agent, new MessageBus());

    try {
      await memory.longTerm.replaceMemory("更新后的记忆");
      await agent.handleTurnDone({ platform: "cli", text: "当前问题" }, "当前回答");

      const promptContext = buildPromptContext(memory);
      expect(promptContext.prompt).toContain("更新后的记忆");
      expect(promptContext.messages).toEqual(
        expect.arrayContaining([
          { role: "user", content: "当前问题" },
          { role: "assistant", content: "当前回答" }
        ])
      );

      await consumeTurn(agent, "下一轮问题");
      expect(String(model.calls[0]?.[0]?.content)).toContain("更新后的记忆");
    } finally {
      await runtime.close();
    }
  });

  it("记录上下文压缩错误并继续提交当前轮次", async () => {
    const root = temporaryDirectory();
    const memory = createMemory(root, 2, {
      compressContext: true,
      compressBatch: 1
    });
    await memory.shortTerm.append("旧问题一", "旧回答一", "cli");
    await memory.shortTerm.append("旧问题二", "旧回答二", "cli");
    const model = new FailingFollowUpModel("压缩器暂时不可用");
    const logPath = useTestLogFile(root);
    const agent = createTestAgent(model, memory, new ToolRegistry([]));

    const events = await consumeTurn(agent, "当前问题");
    await commitConsumedTurn(agent, "当前问题", events);

    expect(readErrorLogs(logPath)).toContainEqual(
      expect.objectContaining({
        type: "context_compression_error",
        errorName: "Error",
        content: "压缩器暂时不可用"
      })
    );
    expect(memory.shortTerm.loadState().turns.at(-1)?.user).toBe("当前问题");
  });

  it("压缩器返回空内容时保留原有近期记忆", async () => {
    const root = temporaryDirectory();
    const memory = createMemory(root, 3, {
      compressContext: true,
      compressBatch: 1
    });
    await memory.shortTerm.append("旧问题一", "旧回答一", "cli");
    await memory.shortTerm.append("旧问题二", "旧回答二", "cli");
    const model = new EmptyFollowUpModel();
    const agent = createTestAgent(model, memory, new ToolRegistry([]));

    const events = await consumeTurn(agent, "当前问题");
    await commitConsumedTurn(agent, "当前问题", events);

    expect(memory.shortTerm.loadState().turns.map((turn) => turn.user)).toEqual([
      "旧问题一",
      "旧问题二",
      "当前问题"
    ]);
  });

  it("达到窗口上限时压缩最早的一半对话", async () => {
    const root = temporaryDirectory();
    const memory = createMemory(root, 4, {
      compressContext: true,
      compressBatch: 2
    });
    await memory.shortTerm.append("旧问题一", "旧回答一", "cli");
    await memory.shortTerm.append("旧问题二", "旧回答二", "cli");
    await memory.shortTerm.append("旧问题三", "旧回答三", "cli");
    await memory.shortTerm.append("旧问题四", "旧回答四", "cli");
    const model = new FakeModel([
      [{ type: "model_text_delta", text: "最终回答" }],
      [{ type: "model_text_delta", text: "压缩摘要" }]
    ]);
    const agent = createTestAgent(model, memory, new ToolRegistry([]));

    const events = await consumeTurn(agent, "当前问题");
    await commitConsumedTurn(agent, "当前问题", events);

    expect(memory.shortTerm.loadState()).toMatchObject({
      summary: "压缩摘要",
      turns: expect.arrayContaining([
        expect.objectContaining({ user: "旧问题三" }),
        expect.objectContaining({ user: "旧问题四" }),
        expect.objectContaining({ user: "当前问题" })
      ])
    });
    expect(memory.shortTerm.loadState().turns.map((turn) => turn.user)).toEqual([
      "旧问题三",
      "旧问题四",
      "当前问题"
    ]);
  });

  it("记忆写入失败时仍然返回模型回复", async () => {
    const root = temporaryDirectory();
    const config = makeConfig(root);
    const model = new FakeModel([[{ type: "model_text_delta", text: "仍可回复" }]]);
    const memory = createMemory(root);
    vi.spyOn(memory.shortTerm, "append").mockRejectedValue(
      new MemoryStoreError("模拟记忆写入失败")
    );
    const agent = createTestAgent(model, memory, new ToolRegistry([]));
    const runtime = new AgentRuntime(config, agent, new MessageBus());
    const logPath = useTestLogFile(root);

    const events = await consumeTurn(agent, "测试记忆故障");
    expect(events).toContainEqual({ type: "turn_done", text: "仍可回复" });
    expect(events.some((event) => event.type === "turn_error")).toBe(false);
    const done = events.find(
      (event): event is Extract<AgentEvent, { type: "turn_done" }> => event.type === "turn_done"
    );
    if (!done) {
      throw new Error("测试轮次没有完成事件");
    }
    await agent.handleTurnDone({ platform: "cli", text: "测试记忆故障" }, done.text);
    expect(readErrorLogs(logPath)).toContainEqual(
      expect.objectContaining({ type: "memory_commit_error", errorName: "MemoryStoreError" })
    );
    expect(memory.shortTerm.loadState().turns).toHaveLength(0);
    await runtime.close();
  });
});
