import fs from "node:fs";
import type { McpServerConfig } from "../config/types.js";
import { ConfigError } from "../types/errors.js";
import { isRecord } from "../utils/type-guards.js";

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new ConfigError(`${field} 必须是对象`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new ConfigError(`${field} 的值必须是字符串`);
    }
    result[key] = item;
  }
  return result;
}

function optionalString(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${field} 必须是字符串`);
  }
  return value.trim();
}

function validateRemoteUrl(url: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError(`${field} 必须是有效的 HTTP 或 HTTPS URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`${field} 必须是有效的 HTTP 或 HTTPS URL`);
  }
}

export function parseMcpServerEntry(
  serverId: string,
  value: unknown,
  source: string
): McpServerConfig {
  if (!isRecord(value)) {
    throw new ConfigError(`${source}[${serverId}] 必须是对象`);
  }
  const item = value;
  const prefix = `${source}[${serverId}]`;
  const url = optionalString(item.url, `${prefix}.url`);
  const command = optionalString(item.command, `${prefix}.command`);
  let transport = optionalString(item.transport, `${prefix}.transport`).toLowerCase();
  if (transport === "streamable_http") {
    transport = "http";
  }
  if (transport && !["stdio", "sse", "http"].includes(transport)) {
    throw new ConfigError(`${source}[${serverId}].transport 只能是 stdio、sse 或 http`);
  }
  // sse 为旧配置别名，运行时与 http 一样走 Streamable HTTP。
  if (!transport) {
    if (url) {
      transport = "http";
    } else if (command) {
      transport = "stdio";
    }
  }
  if (!transport) {
    throw new ConfigError(`${source}[${serverId}] 需要 command（stdio）或 url（http/sse）`);
  }
  if ((transport === "http" || transport === "sse") && !url) {
    throw new ConfigError(`${source}[${serverId}] 使用 ${transport} 时必须填写 url`);
  }
  if (transport === "http" || transport === "sse") {
    validateRemoteUrl(url, `${prefix}.url`);
  }
  if (transport === "stdio" && !command) {
    throw new ConfigError(`${source}[${serverId}] 使用 stdio 时必须填写 command`);
  }
  const args = item.args ?? [];
  if (!Array.isArray(args)) {
    throw new ConfigError(`${prefix}.args 必须是字符串数组`);
  }
  if (!args.every((arg): arg is string => typeof arg === "string")) {
    throw new ConfigError(`${prefix}.args 必须只包含字符串`);
  }
  if (transport === "stdio") {
    return {
      id: serverId,
      transport,
      command,
      args,
      env: stringRecord(item.env, `${prefix}.env`)
    };
  }
  return {
    id: serverId,
    transport: transport as "http" | "sse",
    url,
    headers: stringRecord(item.headers, `${prefix}.headers`)
  };
}

export function loadMcpServersFromJson(filePath: string): readonly McpServerConfig[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ConfigError(`MCP 配置文件格式错误：${filePath}，${String(error)}`, { cause: error });
  }
  if (!isRecord(raw)) {
    throw new ConfigError(`MCP 配置文件根节点必须是对象：${filePath}`);
  }
  const servers = raw.mcpServers ?? {};
  if (!isRecord(servers)) {
    throw new ConfigError(`MCP 配置文件 mcpServers 必须是对象：${filePath}`);
  }
  return Object.entries(servers).map(([id, value]) => {
    const cleanId = id.trim();
    if (!cleanId) {
      throw new ConfigError(`${filePath} 中存在空的 MCP server 名称`);
    }
    return parseMcpServerEntry(cleanId, value, filePath);
  });
}
