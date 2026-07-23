import { describe, expect, it } from "vitest";
import { MimiError } from "../src/types/errors.js";
import { parseCommand } from "../src/app/main.js";

describe("parseCommand", () => {
  it("解析 init、chat、ask、serve 与单平台命令", () => {
    expect(parseCommand([])).toEqual({ kind: "help", showHelp: false });
    expect(parseCommand(["--help"])).toEqual({ kind: "help", showHelp: true });
    expect(parseCommand(["init"])).toEqual({ kind: "init" });
    expect(parseCommand(["chat"])).toEqual({
      kind: "platform",
      platforms: ["cli"],
      cli: { mode: "chat" }
    });
    expect(parseCommand(["ask", "你好"])).toEqual({
      kind: "platform",
      platforms: ["cli"],
      cli: { mode: "ask", text: "你好" }
    });
    expect(parseCommand(["serve"])).toEqual({
      kind: "platform",
      platforms: ["qq", "feishu"]
    });
    expect(parseCommand(["qq"])).toEqual({ kind: "platform", platforms: ["qq"] });
  });

  it("ask 缺少文本时抛错", () => {
    expect(() => parseCommand(["ask"])).toThrow(MimiError);
  });

  it("未知命令时抛错", () => {
    expect(() => parseCommand(["unknown"])).toThrow(/未知命令/);
  });
});
