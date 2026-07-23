import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import type { Model, ModelEvent, ModelMessage } from "../src/model/index.js";
import { MemoryStoreError } from "../src/types/errors.js";
import { LongTermMemory, Memory, ShortTermMemory } from "../src/memory/index.js";
import { ToolRegistry } from "../src/tools/index.js";
import {
  cleanupTemporaryDirectories,
  FakeModel,
  makeConfig,
  temporaryDirectory
} from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

function createMemory(root: string, maxTurns = 3): Memory {
  return new Memory(
    new ShortTermMemory(path.join(root, "data", "recent.json"), maxTurns),
    new LongTermMemory(path.join(root, "data"))
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

async function consumeTurn(agent: Agent, text: string): Promise<void> {
  for await (const _event of agent.respond({ platform: "cli", text })) {
    // 消费完整事件流
  }
}

function readErrorLogs(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
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
    const agent = new Agent(makeConfig(root), model, memory, new ToolRegistry([]));

    await consumeTurn(agent, "读取记忆");

    const systemPrompt = String(model.calls[0]?.[0]?.content);
    expect(systemPrompt).toContain("已确认的信息");
    expect(systemPrompt).toContain("之前讨论过工作区路径");
    expect(systemPrompt).toContain("<context_summary>");
  });

  it("记录上下文压缩错误并继续提交当前轮次", async () => {
    const root = temporaryDirectory();
    const config = makeConfig(root);
    config.memory = {
      ...config.memory,
      compressContext: true,
      contextTurns: 2,
      compressBatch: 1
    };
    const memory = createMemory(root, 2);
    await memory.shortTerm.append("旧问题一", "旧回答一", "cli");
    await memory.shortTerm.append("旧问题二", "旧回答二", "cli");
    const agent = new Agent(
      config,
      new FailingFollowUpModel("压缩器暂时不可用"),
      memory,
      new ToolRegistry([])
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await consumeTurn(agent, "当前问题");

      expect(readErrorLogs(errors)).toContainEqual(
        expect.objectContaining({
          type: "context_compression_error",
          errorName: "Error",
          content: "压缩器暂时不可用"
        })
      );
      expect(memory.shortTerm.loadState().turns.at(-1)?.user).toBe("当前问题");
    } finally {
      errors.mockRestore();
    }
  });

  it("压缩器返回空内容时保留原有近期记忆", async () => {
    const root = temporaryDirectory();
    const config = makeConfig(root);
    config.memory = {
      ...config.memory,
      compressContext: true,
      contextTurns: 2,
      compressBatch: 1
    };
    const memory = createMemory(root, 3);
    await memory.shortTerm.append("旧问题一", "旧回答一", "cli");
    await memory.shortTerm.append("旧问题二", "旧回答二", "cli");
    const agent = new Agent(config, new EmptyFollowUpModel(), memory, new ToolRegistry([]));

    await consumeTurn(agent, "当前问题");

    expect(memory.shortTerm.loadState().turns.map((turn) => turn.user)).toEqual([
      "旧问题一",
      "旧问题二",
      "当前问题"
    ]);
  });

  it("达到窗口上限时压缩最早的一半对话", async () => {
    const root = temporaryDirectory();
    const config = makeConfig(root);
    config.memory = {
      ...config.memory,
      contextTurns: 4,
      compressBatch: 2,
      compressContext: true
    };
    const memory = createMemory(root, 4);
    await memory.shortTerm.append("旧问题一", "旧回答一", "cli");
    await memory.shortTerm.append("旧问题二", "旧回答二", "cli");
    await memory.shortTerm.append("旧问题三", "旧回答三", "cli");
    await memory.shortTerm.append("旧问题四", "旧回答四", "cli");
    const model = new FakeModel([
      [{ type: "model_text_delta", text: "最终回答" }],
      [{ type: "model_text_delta", text: "压缩摘要" }]
    ]);
    const agent = new Agent(config, model, memory, new ToolRegistry([]));

    await consumeTurn(agent, "当前问题");

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
    const model = new FakeModel([[{ type: "model_text_delta", text: "仍可回复" }]]);
    const memory = createMemory(root);
    vi.spyOn(memory.shortTerm, "append").mockRejectedValue(
      new MemoryStoreError("模拟记忆写入失败")
    );
    const agent = new Agent(makeConfig(root), model, memory, new ToolRegistry([]));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const events = [];
      for await (const event of agent.respond({ platform: "cli", text: "测试记忆故障" })) {
        events.push(event);
      }

      expect(events).toContainEqual({ type: "turn_done", text: "仍可回复" });
      expect(events.some((event) => event.type === "turn_error")).toBe(false);
      expect(readErrorLogs(errors)).toContainEqual(
        expect.objectContaining({ type: "memory_commit_error", errorName: "MemoryStoreError" })
      );
    } finally {
      errors.mockRestore();
    }
  });
});
