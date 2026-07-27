import { describe, expect, it } from "vitest";
import { parseTerminalSelectKey } from "../src/utils/terminal-select.js";

describe("parseTerminalSelectKey", () => {
  it("识别方向键与确认", () => {
    expect(parseTerminalSelectKey("\u001b[A")).toBe("up");
    expect(parseTerminalSelectKey("\u001b[B")).toBe("down");
    expect(parseTerminalSelectKey("\r")).toBe("enter");
    expect(parseTerminalSelectKey("\n")).toBe("enter");
  });

  it("识别取消键", () => {
    expect(parseTerminalSelectKey("\u0003")).toBe("cancel");
    expect(parseTerminalSelectKey("\u001b")).toBe("cancel");
  });

  it("无法识别时返回 null", () => {
    expect(parseTerminalSelectKey("a")).toBeNull();
  });
});
