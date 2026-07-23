import fs from "node:fs";
import path from "node:path";
import { MemoryStoreError } from "../types/errors.js";
import { AsyncMutexLock } from "../utils/async-mutex-lock.js";
import { atomicWriteText } from "../utils/atomic-write.js";

export const MEMORY_FILE_NAME = "MEMORY.md";

export type MemoryCategory = "偏好" | "事实";

const locks = new Map<string, AsyncMutexLock>();

function lockFor(filePath: string): AsyncMutexLock {
  const resolved = path.resolve(filePath);
  let lock = locks.get(resolved);
  if (!lock) {
    lock = new AsyncMutexLock();
    locks.set(resolved, lock);
  }
  return lock;
}

function readFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

export function memoryFilePath(dataDir: string): string {
  return path.join(dataDir, MEMORY_FILE_NAME);
}

export function limitMemoryContent(content: string, maxMemoryChars: number): string {
  if (content.length <= maxMemoryChars) {
    return content;
  }
  const marker = `\n\n[内容过长，长期记忆已截断，限制 ${maxMemoryChars} 字符]\n\n`;
  if (marker.length >= maxMemoryChars) {
    return marker.slice(0, maxMemoryChars);
  }
  const available = maxMemoryChars - marker.length;
  const head = Math.floor(available / 2);
  return content.slice(0, head) + marker + content.slice(-(available - head));
}

export async function appendMemoryLine(
  memoryPath: string,
  line: string,
  maxMemoryChars: number
): Promise<void> {
  const cleanLine = line.trim();
  if (!cleanLine) {
    throw new Error("记忆内容不能为空");
  }
  await lockFor(memoryPath).withLock(async () => {
    const current = readFile(memoryPath).trimEnd();
    const updated = current ? `${current}\n${cleanLine}\n` : `# 长期记忆\n\n${cleanLine}\n`;
    if (updated.length > maxMemoryChars) {
      throw new MemoryStoreError(`长期记忆超过字符上限（${maxMemoryChars}），本次未写入`);
    }
    atomicWriteText(memoryPath, updated);
  });
}

export async function replaceMemoryFile(
  memoryPath: string,
  content: string,
  maxMemoryChars: number
): Promise<void> {
  const updated = `${content.trimEnd()}\n`;
  if (updated.length > maxMemoryChars) {
    throw new MemoryStoreError(`长期记忆超过字符上限（${maxMemoryChars}），本次未写入`);
  }
  await lockFor(memoryPath).withLock(async () => {
    atomicWriteText(memoryPath, updated);
  });
}

export async function rememberToFile(
  memoryPath: string,
  content: string,
  category: MemoryCategory,
  maxMemoryChars: number
): Promise<string> {
  const clean = content.trim().split(/\s+/).join(" ");
  if (!clean) {
    throw new Error("记忆内容不能为空");
  }
  const today = new Date().toLocaleDateString("en-CA");
  const line = `- [${today}] [${category}] ${clean}`;
  await appendMemoryLine(memoryPath, line, maxMemoryChars);
  return line;
}
