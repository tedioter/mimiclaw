import { errorMessage } from "../types/errors.js";

export type LogLevel = "info" | "error";

/** 日志正文上限：短内容保留全文，避免长回复和工具输出淹没日志。 */
const LOG_TEXT_MAX_CHARS = 100;

const ANSI = {
  reset: "\x1b[0m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  red: "\x1b[31m"
} as const;

function colorsEnabled(stream: NodeJS.WriteStream | NodeJS.WritableStream): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return "isTTY" in stream && stream.isTTY === true;
}

function colorizeLine(
  level: LogLevel,
  role: string,
  line: string,
  stream: NodeJS.WriteStream | NodeJS.WritableStream
): string {
  if (!colorsEnabled(stream)) {
    return line;
  }
  if (level === "error") {
    return `${ANSI.red}${line}${ANSI.reset}`;
  }
  if (role === "user") {
    return `${ANSI.blue}${line}${ANSI.reset}`;
  }
  if (role === "assistant") {
    return `${ANSI.green}${line}${ANSI.reset}`;
  }
  return line;
}

export function summarizeLogText(text: string): string {
  if (text.length <= LOG_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, LOG_TEXT_MAX_CHARS)}…[已截断，原长 ${text.length} 字符]`;
}

export function writeLog(level: LogLevel, role: string, details: Record<string, unknown>): void {
  const line = JSON.stringify({ level, role, ...details });
  if (level === "error") {
    console.error(colorizeLine(level, role, line, process.stderr));
  } else {
    console.info(colorizeLine(level, role, line, process.stdout));
  }
}

export function formatErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, content: error.message, stack: error.stack };
  }
  return { content: errorMessage(error) };
}
