import { describe, expect, it } from "vitest";
import { CommandHistory } from "../src/utils/command-history.js";

describe("CommandHistory", () => {
  it("按最近使用顺序回溯命令，并恢复临时输入草稿", () => {
    const history = new CommandHistory();
    history.add("第一条");
    history.add("第二条");

    expect(history.navigate("up", "临时输入")).toBe("第二条");
    expect(history.navigate("up", "第二条")).toBe("第一条");
    expect(history.navigate("down", "第一条")).toBe("第二条");
    expect(history.navigate("down", "第二条")).toBe("临时输入");
  });

  it("重复命令只保留一条，并限制历史容量", () => {
    const history = new CommandHistory(2);
    history.add("旧命令");
    history.add("新命令");
    history.add("旧命令");
    history.add("超出容量");

    expect(history.values()).toEqual(["超出容量", "旧命令"]);
  });

  it("忽略空命令和零容量历史", () => {
    const history = new CommandHistory(0);
    history.add("  ");
    history.add("命令");

    expect(history.values()).toEqual([]);
    expect(history.navigate("up", "当前输入")).toBe("当前输入");
  });
});
