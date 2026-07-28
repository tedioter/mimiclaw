import { describe, expect, it } from "vitest";
import { resolveSlashSubmission } from "../src/platforms/cli.js";

const candidates = [{ command: "/model" }, { command: "/exit" }, { command: "/quit" }] as const;

describe("CLI 斜杠命令候选", () => {
  it("单独输入斜杠时不会自动提交首个候选", () => {
    expect(resolveSlashSubmission("/", candidates, 0, false)).toBe("/");
  });

  it("输入命令前缀时提交匹配的首个候选", () => {
    expect(resolveSlashSubmission("/m", candidates.slice(0, 1), 0, false)).toBe("/model");
  });

  it("方向键明确选中后提交对应候选", () => {
    expect(resolveSlashSubmission("/", candidates, 1, true)).toBe("/exit");
  });

  it("没有候选时保留原始输入", () => {
    expect(resolveSlashSubmission("/unknown", [], 0, false)).toBe("/unknown");
  });
});
