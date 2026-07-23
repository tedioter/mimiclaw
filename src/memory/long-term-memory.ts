import fs from "node:fs";
import path from "node:path";
import {
  limitMemoryContent,
  memoryFilePath,
  rememberToFile,
  replaceMemoryFile,
  type MemoryCategory
} from "./memory-file.js";

export type { MemoryCategory } from "./memory-file.js";

export class LongTermMemory {
  readonly soulPath: string;
  readonly userPath: string;
  readonly memoryPath: string;

  constructor(
    readonly dataDir: string,
    readonly maxMemoryChars = 30_000
  ) {
    if (!Number.isSafeInteger(maxMemoryChars) || maxMemoryChars <= 0) {
      throw new RangeError("长期记忆字符上限必须是正整数");
    }
    this.soulPath = path.join(dataDir, "SOUL.md");
    this.userPath = path.join(dataDir, "USER.md");
    this.memoryPath = memoryFilePath(dataDir);
  }

  private read(filePath: string): string {
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  }

  readSoul(): string {
    return this.read(this.soulPath).trim();
  }

  readUser(): string {
    return this.read(this.userPath).trim();
  }

  readMemory(): string {
    return limitMemoryContent(this.read(this.memoryPath), this.maxMemoryChars);
  }

  async remember(content: string, category: MemoryCategory = "事实"): Promise<string> {
    return rememberToFile(this.memoryPath, content, category, this.maxMemoryChars);
  }

  async replaceMemory(content: string): Promise<void> {
    await replaceMemoryFile(this.memoryPath, content, this.maxMemoryChars);
  }
}
