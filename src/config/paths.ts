import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../types/errors.js";
import { configString } from "./parser.js";

const MODULE_PARENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROJECT_ROOT = fs.existsSync(path.join(MODULE_PARENT, "package.json"))
  ? MODULE_PARENT
  : path.resolve(MODULE_PARENT, "..");
export const DEFAULT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.toml");
export const DEFAULT_DATA_PATH = path.join(PROJECT_ROOT, "data");
export const DEFAULT_MCP_CONFIG_PATH = path.join(PROJECT_ROOT, "mcp.json");

export function projectPath(value: unknown, fallback: string, fieldName: string): string {
  const raw = configString(value, fallback, fieldName).trim();
  if (!raw) {
    throw new ConfigError(`配置项 ${fieldName} 不能为空`);
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(PROJECT_ROOT, raw);
}

export function workspacePath(value: unknown): string {
  const raw = configString(value, ".", "tools.workspace").trim();
  if (!raw || raw === ".") {
    return path.resolve(process.cwd());
  }
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const isHomePath = raw === "~" || raw.startsWith("~/") || raw.startsWith(`~${path.sep}`);
  if (isHomePath && !homeDirectory) {
    throw new ConfigError("配置项 tools.workspace 使用了 ~，但当前环境没有 HOME 或 USERPROFILE");
  }
  const expanded = isHomePath ? path.join(homeDirectory, raw.slice(2)) : raw;
  return path.resolve(process.cwd(), expanded);
}

export function recentMemoryPath(dataDir: string): string {
  return path.join(dataDir, "recent.json");
}
