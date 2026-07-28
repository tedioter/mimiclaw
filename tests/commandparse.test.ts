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

  it("不支持单次提问和远程平台命令", () => {
    for (const command of ["ask", "chat", "serve", "qq", "feishu"]) {
      expect(() => parseCommand([command])).toThrow(/未知命令/);
    }
  });

  it("未知命令时抛错", () => {
    expect(() => parseCommand(["unknown"])).toThrow(/未知命令/);
  });
});
