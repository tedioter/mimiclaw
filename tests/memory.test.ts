import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStoreError } from "../src/types/errors.js";
import { parseContextCompressionResult } from "../src/memory/compress-context.js";
import { buildPromptContext } from "../src/agent/prompt.js";
import { LongTermMemory, Memory, ShortTermMemory } from "../src/memory/index.js";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

function createMemory(dataDir: string, maxTurns = 3): Memory {
  return new Memory(
    new ShortTermMemory(path.join(dataDir, "recent.json"), maxTurns),
    new LongTermMemory(dataDir)
  );
}

describe("透明记忆", () => {
  it("拒绝无效的记忆容量", () => {
    const root = temporaryDirectory();
    expect(() => new ShortTermMemory(path.join(root, "recent.json"), 0)).toThrow(
      "近期记忆轮数上限必须是正整数"
    );
    expect(() => new LongTermMemory(root, 0)).toThrow("长期记忆字符上限必须是正整数");
  });

  it("上下文压缩结果会去掉代码块包裹", () => {
    expect(parseContextCompressionResult("```\n用户正在讨论记忆简化\n```")).toBe(
      "用户正在讨论记忆简化"
    );
  });

  it("只保留完整的最近轮次", async () => {
    const root = temporaryDirectory();
    const memory = new ShortTermMemory(path.join(root, "recent.json"), 2);
    await memory.append("一", "答一", "cli");
    await memory.append("二", "答二", "qq");
    await memory.append("三", "答三", "feishu");
    expect(memory.loadState().turns.map((turn) => turn.user)).toEqual(["二", "三"]);
    expect(memory.asMessages()).toHaveLength(4);
  });

  it("摘要在 system prompt 中注入", async () => {
    const root = temporaryDirectory();
    const memory = createMemory(path.join(root, "data"));
    await memory.shortTerm.saveState({
      summary: "之前聊过工作区路径",
      turns: [
        {
          user: "你好",
          assistant: "你好",
          platform: "cli",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    const promptContext = buildPromptContext(memory);
    expect(promptContext.prompt).toContain("之前聊过工作区路径");
    expect(promptContext.messages).toHaveLength(2);
  });

  it("SOUL 与 USER 分别注入 system prompt", async () => {
    const root = temporaryDirectory();
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "SOUL.md"), "助手人格\n");
    fs.writeFileSync(path.join(dataDir, "USER.md"), "用户偏好\n");
    const memory = createMemory(dataDir);
    expect(buildPromptContext(memory).prompt).toContain("<soul>\n助手人格\n</soul>");
    expect(buildPromptContext(memory).prompt).toContain("<user>\n用户偏好\n</user>");
  });

  it("损坏时拒绝覆盖近期记忆", async () => {
    const root = temporaryDirectory();
    const file = path.join(root, "recent.json");
    fs.writeFileSync(file, "{not-json");
    const memory = new ShortTermMemory(file, 2);
    await expect(memory.append("新", "回复", "cli")).rejects.toBeInstanceOf(MemoryStoreError);
    expect(fs.readFileSync(file, "utf8")).toBe("{not-json");
  });

  it("明确记忆直接写入长期记忆", async () => {
    const root = temporaryDirectory();
    const longTerm = new LongTermMemory(root);
    const line = await longTerm.remember(" 用户偏好  TypeScript ", "偏好");
    expect(line).toContain("[偏好] 用户偏好 TypeScript");
    expect(longTerm.readMemory()).toContain("用户偏好 TypeScript");
  });
});
