import { ConfigError } from "../types/errors.js";
import { isRecord } from "../utils/type-guards.js";

export type Table = Record<string, unknown>;

export function table(value: unknown, name: string): Table {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new ConfigError(`配置项 [${name}] 必须是表格`);
  }
  return value;
}

export function configString(value: unknown, fallback: string, fieldName: string): string {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "string") {
    throw new ConfigError(`配置项 ${fieldName} 必须是字符串`);
  }
  return resolved;
}

export function requiredString(value: unknown, fieldName: string): string {
  const resolved = configString(value, "", fieldName).trim();
  if (!resolved) {
    throw new ConfigError(`配置项 ${fieldName} 不能为空`);
  }
  return resolved;
}

export function httpUrl(value: unknown, fieldName: string): string {
  const resolved = requiredString(value, fieldName);
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new ConfigError(`配置项 ${fieldName} 必须是有效的 HTTP 或 HTTPS URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`配置项 ${fieldName} 必须是有效的 HTTP 或 HTTPS URL`);
  }
  return resolved;
}

export function stringSet(value: unknown, fieldName: string): ReadonlySet<string> {
  if (value === undefined || value === null) {
    return new Set();
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(`配置项 ${fieldName} 必须是字符串数组`);
  }
  if (!value.every((item): item is string => typeof item === "string")) {
    throw new ConfigError(`配置项 ${fieldName} 必须只包含字符串`);
  }
  return new Set(value.map((item) => item.trim()).filter(Boolean));
}

function checkedNumber(
  value: unknown,
  fallback: number | undefined,
  fieldName: string,
  requirement: string,
  accepts: (number: number) => boolean
): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || !accepts(resolved)) {
    throw new ConfigError(`配置项 ${fieldName} 必须是${requirement}`);
  }
  return resolved;
}

export function finiteNumber(value: unknown, fallback: number, fieldName: string): number {
  return checkedNumber(value, fallback, fieldName, "有限数字", () => true);
}

export function positiveNumber(value: unknown, fallback: number, fieldName: string): number {
  return checkedNumber(value, fallback, fieldName, "大于 0 的有限数字", (number) => number > 0);
}

export function positiveInteger(value: unknown, fallback: number, fieldName: string): number {
  return checkedNumber(
    value,
    fallback,
    fieldName,
    "正整数",
    (number) => Number.isInteger(number) && number > 0
  );
}

export function nonNegativeInteger(value: unknown, fallback: number, fieldName: string): number {
  return checkedNumber(
    value,
    fallback,
    fieldName,
    "非负整数",
    (number) => Number.isInteger(number) && number >= 0
  );
}

export function bool(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(`配置项 ${fieldName} 必须是布尔值`);
  }
  return value;
}
