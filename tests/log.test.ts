import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLog } from "../src/utils/log.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
