import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "../types/errors.js";

export type LogLevel = "info" | "error";

/** 日志正文上限：短内容保留全文，避免长回复和工具输出淹没日志。 */
const LOG_TEXT_MAX_CHARS = 100;

/** 助手 turn_done 日志上限（含代码块，需完整可读）。 */
const ASSISTANT_REPLY_LOG_MAX_CHARS = 8000;

let logFilePath: string | undefined;

/** 设置结构化日志文件路径；传 undefined 则停止写入。 */
export function setLogFilePath(filePath: string | undefined): void {
  logFilePath = filePath;
}

export function getLogFilePath(): string | undefined {
  return logFilePath;
}

export function summarizeLogText(text: string): string {
  if (text.length <= LOG_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, LOG_TEXT_MAX_CHARS)}…[已截断，原长 ${text.length} 字符]`;
}

export function summarizeAssistantReplyLog(text: string): string {
  if (text.length <= ASSISTANT_REPLY_LOG_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, ASSISTANT_REPLY_LOG_MAX_CHARS)}…[已截断，原长 ${text.length} 字符]`;
}

export function parseLogLines(content: string): Record<string, unknown>[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function writeLog(level: LogLevel, role: string, details: Record<string, unknown>): void {
  if (!logFilePath) {
    return;
  }
  const line = JSON.stringify({ level, role, ...details });
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
  } catch {
    // 日志写入失败时不影响主流程
  }
}

export function formatErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, content: error.message, stack: error.stack };
  }
  return { content: errorMessage(error) };
}
