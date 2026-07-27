import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  getLogFilePath,
  parseLogLines,
  setLogFilePath,
  summarizeAssistantReplyLog,
  summarizeLogText,
  writeLog
} from "../src/utils/log.js";
import {
  cleanupTemporaryDirectories,
  readLogFile,
  temporaryDirectory,
  useTestLogFile
} from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

describe("summarizeLogText", () => {
  it("短文本原样返回", () => {
    expect(summarizeLogText("短")).toBe("短");
  });

  it("超长文本截断并标注原长", () => {
    const long = "甲".repeat(120);
    const summary = summarizeLogText(long);
    expect(summary.length).toBeLessThan(long.length);
    expect(summary).toContain("已截断");
    expect(summary).toContain("120 字符");
  });
});

describe("summarizeAssistantReplyLog", () => {
  it("8000 字符以内原样返回", () => {
    const text = "乙".repeat(8000);
    expect(summarizeAssistantReplyLog(text)).toBe(text);
  });

  it("超过 8000 字符时截断并标注原长", () => {
    const long = "丙".repeat(9000);
    const summary = summarizeAssistantReplyLog(long);
    expect(summary.startsWith("丙".repeat(8000))).toBe(true);
    expect(summary).toContain("已截断");
    expect(summary).toContain("9000 字符");
  });
});

describe("writeLog", () => {
  it("未配置日志文件时不写入", () => {
    setLogFilePath(undefined);
    writeLog("info", "user", { content: "你好" });
    expect(getLogFilePath()).toBeUndefined();
  });

  it("追加 JSON Lines 到日志文件", () => {
    const root = temporaryDirectory();
    const logPath = useTestLogFile(root);

    writeLog("info", "user", { content: "你好" });
    writeLog("info", "assistant", { content: "回复" });
    writeLog("error", "tool", { type: "tool_argument_error", content: "失败" });

    const entries = readLogFile(logPath);
    expect(entries).toEqual([
      { level: "info", role: "user", content: "你好" },
      { level: "info", role: "assistant", content: "回复" },
      { level: "error", role: "tool", type: "tool_argument_error", content: "失败" }
    ]);
    expect(fs.readFileSync(logPath, "utf8").endsWith("\n")).toBe(true);
  });

  it("parseLogLines 忽略空行", () => {
    expect(parseLogLines('{"level":"info"}\n\n{"level":"error"}\n')).toEqual([
      { level: "info" },
      { level: "error" }
    ]);
  });
});
