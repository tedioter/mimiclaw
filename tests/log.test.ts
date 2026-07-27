import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeAssistantReplyLog, summarizeLogText, writeLog } from "../src/utils/log.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

describe("writeLog 颜色", () => {
  it("TTY 下用户为蓝色、助手为绿色、错误为红色", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    delete process.env.NO_COLOR;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    writeLog("info", "user", { content: "你好" });
    writeLog("info", "assistant", { content: "回复" });
    writeLog("error", "tool", { type: "tool_argument_error", content: "失败" });

    expect(String(info.mock.calls[0]?.[0])).toMatch(/\x1b\[34m/);
    expect(String(info.mock.calls[1]?.[0])).toMatch(/\x1b\[32m/);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/\x1b\[31m/);
  });

  it("设置 NO_COLOR 时不加颜色", () => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("FORCE_COLOR", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    writeLog("info", "user", { content: "你好" });

    expect(String(info.mock.calls[0]?.[0])).not.toMatch(/\x1b\[/);
  });
});
