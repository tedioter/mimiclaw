export type HistoryDirection = "up" | "down";

/** 管理 CLI 的命令历史，并保留用户尚未提交的输入草稿。 */
export class CommandHistory {
  private readonly entries: string[] = [];
  private cursor = 0;
  private draft = "";

  constructor(private readonly limit = 1000) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError("命令历史容量必须是非负整数");
    }
  }

  add(command: string): void {
    const value = command.trim();
    if (!value || this.limit === 0) {
      this.reset(command);
      return;
    }
    const duplicateIndex = this.entries.indexOf(value);
    if (duplicateIndex >= 0) {
      this.entries.splice(duplicateIndex, 1);
    }
    this.entries.unshift(value);
    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }
    this.reset("");
  }

  reset(currentLine = ""): void {
    this.cursor = 0;
    this.draft = currentLine;
  }

  navigate(direction: HistoryDirection, currentLine: string): string {
    if (!this.entries.length) {
      return currentLine;
    }
    if (this.cursor === 0) {
      this.draft = currentLine;
    }
    if (direction === "up") {
      this.cursor = Math.min(this.entries.length, this.cursor + 1);
    } else {
      this.cursor = Math.max(0, this.cursor - 1);
    }
    return this.cursor === 0 ? this.draft : (this.entries[this.cursor - 1] ?? "");
  }

  values(): string[] {
    return [...this.entries];
  }
}
