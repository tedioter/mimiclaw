import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import type {
  ToolConfig,
  AppConfig,
  DisplayConfig,
  McpConfig,
  MemoryConfig,
  ModelConfig,
  ModelSectionConfig,
  PlatformConfig
} from "./types.js";
import { ConfigError } from "../types/errors.js";
import { isRecord } from "../utils/type-guards.js";
import { loadMcpServersFromJson } from "../mcp/json-config.js";
import {
  bool,
  configString,
  finiteNumber,
  httpUrl,
  nonNegativeInteger,
  positiveInteger,
  positiveNumber,
  requiredString,
  stringSet,
  table,
  type Table
} from "./parser.js";
import { DEFAULT_CONFIG_PATH, PROJECT_ROOT, projectPath, workspacePath } from "./paths.js";

function parseModelFieldsFromTable(
  runtimeTable: Table,
  labelPrefix: string,
  requireModelKey: boolean
): ModelConfig {
  const apiKey = configString(runtimeTable.api_key, "", `${labelPrefix}.api_key`);
  if (requireModelKey && !apiKey.trim()) {
    throw new ConfigError(`未配置模型密钥，请填写 config.toml 中的 ${labelPrefix}.api_key`);
  }
  const baseUrl = httpUrl(runtimeTable.base_url, `${labelPrefix}.base_url`);
  const modelName = requiredString(runtimeTable.model, `${labelPrefix}.model`);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model: modelName,
    timeoutSeconds: positiveNumber(
      runtimeTable.timeout_seconds,
      90,
      `${labelPrefix}.timeout_seconds`
    ),
    maxRetries: nonNegativeInteger(runtimeTable.max_retries, 2, `${labelPrefix}.max_retries`),
    temperature: finiteNumber(runtimeTable.temperature, 0.7, `${labelPrefix}.temperature`),
    enableThinking: bool(runtimeTable.enable_thinking, true, `${labelPrefix}.enable_thinking`)
  };
}

function parseModelSection(raw: Table, requireModelKey: boolean): ModelSectionConfig {
  const modelTable = table(raw.model, "model");
  const runtimesTable = modelTable.runtimes;
  if (isRecord(runtimesTable) && Object.keys(runtimesTable).length > 0) {
    const runtimes: Record<string, ModelConfig> = {};
    for (const [id, value] of Object.entries(runtimesTable)) {
      if (!isRecord(value)) {
        throw new ConfigError(`配置项 model.runtimes.${id} 必须是表`);
      }
      runtimes[id] = parseModelFieldsFromTable(value, `model.runtimes.${id}`, requireModelKey);
    }
    const runtimeIds = Object.keys(runtimes);
    const active =
      configString(modelTable.active, "", "model.active").trim() || runtimeIds[0] || "main";
    if (!runtimes[active]) {
      throw new ConfigError(`model.active 指向未知 runtime：${active}`);
    }
    return { active, runtimes };
  }
  const single = parseModelFieldsFromTable(modelTable, "model", requireModelKey);
  return { active: "default", runtimes: { default: single } };
}

function parseDisplayConfig(raw: Table): DisplayConfig {
  const display = table(raw.display, "display");
  return {
    showThinking: bool(display.show_thinking, false, "display.show_thinking"),
    showToolCalls: bool(display.show_tool_calls, true, "display.show_tool_calls")
  };
}

function parseToolConfig(raw: Table): ToolConfig {
  const tools = table(raw.tools, "tools");
  return {
    maxWebChars: positiveInteger(tools.max_web_chars, 30_000, "tools.max_web_chars"),
    maxFileChars: positiveInteger(tools.max_file_chars, 30_000, "tools.max_file_chars"),
    maxFileBytes: positiveInteger(tools.max_file_bytes, 512 * 1024, "tools.max_file_bytes"),
    webFetchTimeoutSeconds: positiveNumber(
      tools.web_fetch_timeout_seconds,
      20,
      "tools.web_fetch_timeout_seconds"
    ),
    bashTimeoutSeconds: positiveNumber(
      tools.bash_timeout_seconds,
      120,
      "tools.bash_timeout_seconds"
    ),
    bashMaxOutputChars: positiveInteger(
      tools.bash_max_output_chars,
      30_000,
      "tools.bash_max_output_chars"
    ),
    findMaxResults: positiveInteger(tools.find_max_results, 200, "tools.find_max_results"),
    grepMaxMatches: positiveInteger(tools.grep_max_matches, 200, "tools.grep_max_matches"),
    workspace: workspacePath(tools.workspace)
  };
}

function parseMemoryConfig(raw: Table): MemoryConfig {
  const memory = table(raw.memory, "memory");
  const contextTurns = positiveInteger(memory.context_turns, 10, "memory.context_turns");
  const defaultBatch = Math.max(1, Math.floor(contextTurns / 2));
  const compressBatch = positiveInteger(
    memory.compress_batch,
    defaultBatch,
    "memory.compress_batch"
  );
  const compressContext = bool(memory.compress_context, true, "memory.compress_context");
  if (compressBatch > contextTurns) {
    throw new ConfigError("配置项 memory.compress_batch 不能大于 memory.context_turns");
  }
  return {
    contextTurns,
    compressBatch,
    compressContext,
    maxMemoryChars: positiveInteger(memory.max_memory_chars, 30_000, "memory.max_memory_chars")
  };
}

function parsePlatformConfig(raw: Table): PlatformConfig {
  const platforms = table(raw.platform, "platform");
  const qq = table(platforms.qq, "platform.qq");
  const feishu = table(platforms.feishu, "platform.feishu");
  return {
    qq: {
      appId: configString(qq.app_id, "", "platform.qq.app_id"),
      appSecret: configString(qq.app_secret, "", "platform.qq.app_secret"),
      sandbox: bool(qq.sandbox, false, "platform.qq.sandbox"),
      connectTimeoutSeconds: positiveNumber(
        qq.connect_timeout_seconds,
        30,
        "platform.qq.connect_timeout_seconds"
      ),
      maxMessageLength: positiveInteger(
        qq.max_message_length,
        5000,
        "platform.qq.max_message_length"
      ),
      markdownSupport: bool(qq.markdown_support, true, "platform.qq.markdown_support"),
      allowedOpenids: stringSet(qq.allowed_openids, "platform.qq.allowed_openids")
    },
    feishu: {
      appId: configString(feishu.app_id, "", "platform.feishu.app_id"),
      appSecret: configString(feishu.app_secret, "", "platform.feishu.app_secret"),
      connectTimeoutSeconds: positiveNumber(
        feishu.connect_timeout_seconds,
        30,
        "platform.feishu.connect_timeout_seconds"
      ),
      maxMessageLength: positiveInteger(
        feishu.max_message_length,
        3500,
        "platform.feishu.max_message_length"
      ),
      allowedSenderIds: stringSet(feishu.allowed_sender_ids, "platform.feishu.allowed_sender_ids")
    }
  };
}

function parseMcpConfig(raw: Table): McpConfig {
  const mcp = table(raw.mcp, "mcp");
  const enabled = bool(mcp.enabled, false, "mcp.enabled");
  const configFile = projectPath(mcp.config_file, "mcp.json", "mcp.config_file");
  if (enabled && !fs.existsSync(configFile)) {
    throw new ConfigError(`已启用 MCP，但找不到配置文件：${configFile}`);
  }
  return {
    enabled,
    configFile,
    callTimeoutSeconds: positiveNumber(mcp.call_timeout_seconds, 60, "mcp.call_timeout_seconds"),
    connectTimeoutSeconds: positiveNumber(
      mcp.connect_timeout_seconds,
      30,
      "mcp.connect_timeout_seconds"
    ),
    servers: enabled ? loadMcpServersFromJson(configFile) : []
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_PATH, requireModelKey = true): AppConfig {
  const resolved = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(PROJECT_ROOT, configPath);
  if (!fs.existsSync(resolved)) {
    throw new ConfigError(`找不到配置文件：${resolved}，请先运行 npm run dev -- init`);
  }
  let raw: Table;
  try {
    raw = TOML.parse(fs.readFileSync(resolved, "utf8")) as Table;
  } catch (error) {
    throw new ConfigError(`配置文件格式错误：${String(error)}`, { cause: error });
  }
  const dataDir = projectPath(raw.data_dir, "data", "data_dir");
  return {
    model: parseModelSection(raw, requireModelKey),
    display: parseDisplayConfig(raw),
    tools: parseToolConfig(raw),
    memory: parseMemoryConfig(raw),
    platform: parsePlatformConfig(raw),
    mcp: parseMcpConfig(raw),
    dataDir
  };
}
