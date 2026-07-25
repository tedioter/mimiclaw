import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "../src/types/errors.js";
import { executeToolCall } from "../src/agent/tool-executor.js";
import { parseToolArguments, Tool } from "../src/tools/base.js";
import { createTools, ToolRegistry } from "../src/tools/toolregistry.js";
import { resolveWorkspacePath } from "../src/utils/workspace-path.js";
import {
  cleanupTemporaryDirectories,
  temporaryDirectory,
  testTool,
  testToolDependencies
} from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

function namedTool(name: string): Tool {
  class NamedTestTool extends Tool {
    readonly description = "测试工具";
    readonly schema = z.object({});

    constructor(public readonly name: string) {
      super();
    }

    async execute(): Promise<string> {
      return "ok";
    }
  }
  return new NamedTestTool(name);
}

describe("工作区工具", () => {
  it("读写和精确编辑文件", async () => {
    const root = temporaryDirectory();
    const write = testTool("write", root);
    await write.execute({ path: "note.txt", content: "alpha\nbeta" });
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("alpha\nbeta\n");
    const edit = testTool("edit", root);
    await edit.execute({ path: "note.txt", old_string: "beta", new_string: "gamma" });
    const result = await testTool("read", root).execute({
      path: "note.txt",
      offset: 2,
      limit: 1
    });
    expect(result).toContain("gamma");
    expect(result).not.toContain("alpha");
  });

  it("拒绝超过字节上限的文件", async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "large.txt"), "x".repeat(200));
    await expect(
      testTool("read", root, { maxFileBytes: 100 }).execute({ path: "large.txt" })
    ).rejects.toThrow("文件过大");
  });

  it("拒绝越界路径", () => {
    const root = temporaryDirectory();
    expect(() => resolveWorkspacePath(root, "../outside.txt")).toThrow(ToolError);
  });

  it("拒绝通过目录链接读取工作区外的已有文件", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(
      outside,
      path.join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(testTool("read", root).execute({ path: "escape/secret.txt" })).rejects.toThrow(
      "符号链接或目录联接不能指向工作区外"
    );
  });

  it("拒绝通过目录链接在工作区外创建文件", async () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    fs.symlinkSync(
      outside,
      path.join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );

    await expect(
      testTool("write", root).execute({ path: "escape/new.txt", content: "blocked" })
    ).rejects.toThrow("符号链接或目录联接不能指向工作区外");
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
  });

  it("工作区是目录链接时仍返回工作区内相对路径", async () => {
    const actual = temporaryDirectory();
    const aliasRoot = temporaryDirectory();
    const alias = path.join(aliasRoot, "workspace");
    fs.writeFileSync(path.join(actual, "note.txt"), "内容");
    fs.symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");

    const result = await testTool("find", alias, { findMaxResults: 10 }).execute({
      pattern: "*.txt"
    });
    expect(result).toContain("note.txt");
    expect(result).not.toContain("../");
  });

  it("拒绝会越过工作区的 glob 模式", async () => {
    const root = temporaryDirectory();
    await expect(
      testTool("find", root, { findMaxResults: 10 }).execute({ pattern: "../*" })
    ).rejects.toThrow("工作区外的父目录片段");
    await expect(
      testTool("find", root, { findMaxResults: 10 }).execute({ pattern: path.join(root, "*") })
    ).rejects.toThrow("不能是绝对路径");
  });

  it("grep include 按相对路径支持多级 glob", async () => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "nested", "note.ts"), "needle\n");
    fs.writeFileSync(path.join(root, "src", "nested", "note.txt"), "needle\n");

    const result = await testTool("grep", root, { grepMaxMatches: 10 }).execute({
      pattern: "needle",
      include: "**/*.ts"
    });

    expect(result).toContain("note.ts");
    expect(result).not.toContain("note.txt");
  });

  it("拒绝不唯一的编辑片段", async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "note.txt"), "x x");
    await expect(
      testTool("edit", root).execute({ path: "note.txt", old_string: "x", new_string: "y" })
    ).rejects.toThrow("出现多次");
  });

  it("拒绝空的编辑匹配片段", async () => {
    const root = temporaryDirectory();
    await expect(
      testTool("edit", root).execute({ path: "note.txt", old_string: "", new_string: "内容" })
    ).rejects.toThrow("old_string 不能为空");
  });

  it("在执行前拒绝缺失和非法类型的工具参数", async () => {
    const root = temporaryDirectory();
    const tools = new ToolRegistry([testTool("read", root)]);

    await expect(
      executeToolCall(
        tools,
        { callId: "missing", name: "read", arguments: { intent: "读取文件" } },
        "test-turn"
      )
    ).resolves.toBe('工具参数无效：参数 "path" Invalid input: expected string, received undefined');
    await expect(
      executeToolCall(
        tools,
        {
          callId: "invalid",
          name: "read",
          arguments: { path: "a", limit: 1.5, intent: "读取文件" }
        },
        "test-turn"
      )
    ).resolves.toMatch(/工具参数无效：参数 "limit"/);
  });
});

describe("工具参数校验", () => {
  const schema = z.object({
    label: z.enum(["可用"]),
    ratio: z.number().min(0),
    count: z.number().int(),
    enabled: z.boolean(),
    options: z.object({ mode: z.string() }),
    tags: z.array(z.string())
  });
  class ValidateTestTool extends Tool {
    readonly name = "validate";
    readonly description = "测试";
    readonly schema = schema;

    async execute(): Promise<string> {
      return "ok";
    }
  }
  const tool = new ValidateTestTool();
  const valid = {
    label: "可用",
    ratio: 0.5,
    count: 1,
    enabled: true,
    options: { mode: "fast" },
    tags: ["a"],
    intent: "验证参数"
  };

  it("接受符合 Schema 的参数", () => {
    expect(parseToolArguments(tool, valid).success).toBe(true);
  });

  it("校验枚举、数字范围和类型", () => {
    expect(parseToolArguments(tool, { ...valid, label: "未知" }).success).toBe(false);
    expect(parseToolArguments(tool, { ...valid, ratio: -1 }).success).toBe(false);
    expect(parseToolArguments(tool, { ...valid, count: 1.5 }).success).toBe(false);
    expect(parseToolArguments(tool, { ...valid, enabled: "yes" }).success).toBe(false);
    expect(parseToolArguments(tool, { ...valid, tags: [1] }).success).toBe(false);
  });
});

describe("内置工具", () => {
  it("工厂组装全部内置工具", () => {
    const root = temporaryDirectory();
    const { config } = testToolDependencies(root);
    const tools = createTools(config);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "read",
      "remember",
      "web_fetch",
      "write"
    ]);
  });

  it("可按名称取单个内置工具", () => {
    const root = temporaryDirectory();
    expect(testTool("remember", root).name).toBe("remember");
  });

  it("拒绝空名称和重复名称", () => {
    expect(() => new ToolRegistry([namedTool("   ")])).toThrow("工具名称不能为空");
    expect(() => new ToolRegistry([namedTool("same"), namedTool("same")])).toThrow(
      '工具名称重复："same"'
    );
  });

  it("发给模型的 schema 包含工具真实参数而不只有 intent", () => {
    const root = temporaryDirectory();
    const registry = new ToolRegistry(createTools(testToolDependencies(root).config));
    const read = registry.schemas().find((schema) => schema.function.name === "read");
    const remember = registry.schemas().find((schema) => schema.function.name === "remember");
    expect(read?.function.parameters.properties).toMatchObject({
      path: { type: "string" },
      intent: { type: "string" }
    });
    expect(read?.function.parameters.required).toEqual(expect.arrayContaining(["path", "intent"]));
    expect(remember?.function.parameters.properties).toMatchObject({
      content: { type: "string" },
      category: { type: "string", enum: ["偏好", "事实"] },
      intent: { type: "string" }
    });
    expect(remember?.function.parameters.required).toEqual(
      expect.arrayContaining(["content", "category", "intent"])
    );
  });
});

describe("工具日志", () => {
  it("成功结果截断，失败结果完整记录", async () => {
    const longText = "x".repeat(200);
    class LoggingTestTool extends Tool {
      readonly name = "logging_test";
      readonly description = "测试";
      readonly schema = z.object({ mode: z.enum(["ok", "fail", "throw"]), intent: z.string() });

      async execute(arguments_: Record<string, unknown>): Promise<string> {
        const mode = String(arguments_.mode);
        if (mode === "throw") {
          throw new ToolError(longText);
        }
        if (mode === "fail") {
          return `工具执行失败：${longText}`;
        }
        return longText;
      }
    }
    const tools = new ToolRegistry([new LoggingTestTool()]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await executeToolCall(
      tools,
      { callId: "ok", name: "logging_test", arguments: { mode: "ok", intent: "测试" } },
      "turn-1"
    );
    await executeToolCall(
      tools,
      { callId: "fail", name: "logging_test", arguments: { mode: "fail", intent: "测试" } },
      "turn-1"
    );
    await executeToolCall(
      tools,
      { callId: "throw", name: "logging_test", arguments: { mode: "throw", intent: "测试" } },
      "turn-1"
    );

    const successLog = info.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { type?: string; content?: string })
      .find((entry) => entry.type === "tool_result");
    const failLog = error.mock.calls
      .map(([line]) => JSON.parse(String(line)) as { type?: string; content?: string })
      .find((entry) => entry.type === "tool_result_error");
    const throwLog = error.mock.calls
      .map(
        ([line]) =>
          JSON.parse(String(line)) as {
            type?: string;
            content?: string;
            stack?: string;
            arguments?: Record<string, unknown>;
          }
      )
      .find((entry) => entry.type === "tool_execution_error");

    expect(successLog?.content).toContain("…[已截断");
    expect(failLog?.content).toBe(`工具执行失败：${longText}`);
    expect(throwLog?.content).toBe(longText);
    expect(throwLog?.stack).toBeTruthy();
    expect(throwLog?.arguments).toEqual({ mode: "throw", intent: "测试" });

    info.mockRestore();
    error.mockRestore();
  });

  it("失败日志记录工具参数，成功调用日志仍不记录参数", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      await executeToolCall(
        new ToolRegistry([testTool("read", temporaryDirectory())]),
        {
          callId: "read_fail",
          name: "read",
          arguments: { path: "../outside.txt", intent: "读取文件" }
        },
        "turn-2"
      );

      const errorLogs = errors.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>
      );
      const executionError = errorLogs.find((entry) => entry.type === "tool_execution_error");
      expect(executionError?.arguments).toEqual({
        path: "../outside.txt",
        intent: "读取文件"
      });

      const toolCallLogs = info.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>
      );
      expect(toolCallLogs.find((entry) => entry.type === "tool_call")).not.toHaveProperty(
        "arguments"
      );
    } finally {
      errors.mockRestore();
      info.mockRestore();
    }
  });
});
