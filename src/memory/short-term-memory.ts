import fs from "node:fs";
import { MemoryStoreError } from "../types/errors.js";
import { AsyncMutexLock } from "../utils/async-mutex-lock.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { isRecord } from "../utils/type-guards.js";

export type RecentTurn = {
  user: string;
  assistant: string;
  platform: string;
  createdAt: string;
};

export type ShortTermMemoryState = {
  summary: string;
  turns: RecentTurn[];
};

export class ShortTermMemory {
  private readonly mutex = new AsyncMutexLock();

  constructor(
    readonly filePath: string,
    readonly maxTurns: number
  ) {
    if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0) {
      throw new RangeError("近期记忆轮数上限必须是正整数");
    }
  }

  loadState(): ShortTermMemoryState {
    if (!fs.existsSync(this.filePath)) {
      return { summary: "", turns: [] };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new MemoryStoreError(`近期记忆文件损坏或不可读：${this.filePath}`, { cause: error });
    }
    if (Array.isArray(raw)) {
      return { summary: "", turns: this.parseTurns(raw) };
    }
    if (!isRecord(raw)) {
      throw new MemoryStoreError(
        `近期记忆文件格式错误：${this.filePath}（根节点必须是对象或数组）`
      );
    }
    const summary = raw.summary;
    const turnsRaw = raw.turns;
    if (typeof summary !== "string") {
      throw new MemoryStoreError(`近期记忆文件格式错误：${this.filePath}（summary 必须是字符串）`);
    }
    if (!Array.isArray(turnsRaw)) {
      throw new MemoryStoreError(`近期记忆文件格式错误：${this.filePath}（turns 必须是数组）`);
    }
    return { summary, turns: this.parseTurns(turnsRaw) };
  }

  private parseTurns(raw: unknown[]): RecentTurn[] {
    return raw.map((item, index): RecentTurn => {
      if (!isRecord(item)) {
        throw new MemoryStoreError(
          `近期记忆文件格式错误：${this.filePath}（第 ${index + 1} 项必须是对象）`
        );
      }
      const user = item.user;
      const assistant = item.assistant;
      const platform = item.platform ?? "unknown";
      const createdAt = item.created_at ?? item.createdAt ?? "";
      if (
        typeof user !== "string" ||
        typeof assistant !== "string" ||
        typeof platform !== "string" ||
        typeof createdAt !== "string"
      ) {
        throw new MemoryStoreError(
          `近期记忆文件格式错误：${this.filePath}（第 ${index + 1} 项包含无效字段）`
        );
      }
      return {
        user,
        assistant,
        platform,
        createdAt
      };
    });
  }

  private writeState(state: ShortTermMemoryState): void {
    const turns = state.turns.slice(-this.maxTurns);
    const data = {
      summary: state.summary.trim(),
      turns: turns.map((turn) => ({
        user: turn.user,
        assistant: turn.assistant,
        platform: turn.platform,
        created_at: turn.createdAt
      }))
    };
    atomicWriteText(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  async append(user: string, assistant: string, platform: string): Promise<void> {
    await this.mutex.withLock(async () => {
      const state = this.loadState();
      state.turns.push({ user, assistant, platform, createdAt: new Date().toISOString() });
      this.writeState(state);
    });
  }

  async saveState(state: ShortTermMemoryState): Promise<void> {
    await this.mutex.withLock(async () => this.writeState(state));
  }

  asMessages(state: ShortTermMemoryState = this.loadState()): Array<{
    role: "user" | "assistant";
    content: string;
  }> {
    return state.turns.slice(-this.maxTurns).flatMap((turn) => [
      { role: "user" as const, content: turn.user },
      { role: "assistant" as const, content: turn.assistant }
    ]);
  }
}
