import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/app/main.js";

describe("parseCommand", () => {
  it("无参数时直接进入 CLI 交互模式", () => {
    expect(parseCommand([])).toEqual({
      kind: "platform",
      platforms: ["cli"],
      cli: { mode: "chat" }
    });
  });

  it("支持初始化和帮助命令", () => {
    expect(parseCommand(["init"])).toEqual({ kind: "init" });
    expect(parseCommand(["--help"])).toEqual({ kind: "help", showHelp: true });
  });

  it("保留 CLI 快捷命令", () => {
    expect(parseCommand(["chat"])).toEqual({
      kind: "platform",
      platforms: ["cli"],
      cli: { mode: "chat" }
    });
    expect(parseCommand(["ask", "你好", "吗"])).toEqual({
      kind: "platform",
      platforms: ["cli"],
      cli: { mode: "ask", text: "你好 吗" }
    });
    expect(() => parseCommand(["ask"])).toThrow("ask 命令需要文本参数");
  });

  it("支持 QQ、飞书和同时启动两个远程平台", () => {
    expect(parseCommand(["qq"])).toEqual({ kind: "platform", platforms: ["qq"] });
    expect(parseCommand(["feishu"])).toEqual({ kind: "platform", platforms: ["feishu"] });
    expect(parseCommand(["serve"])).toEqual({ kind: "platform", platforms: ["qq", "feishu"] });
  });

  it("未知命令时抛错", () => {
    expect(() => parseCommand(["unknown"])).toThrow(/未知命令/);
  });
});
