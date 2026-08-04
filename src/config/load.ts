import fs from "node:fs";
import TOML from "@iarna/toml";
import type {
  ToolConfig,
  AppConfig,
  DisplayConfig,
  McpConfig,
  MemoryConfig,
  ModelConfig,
  ModelVendorConfig,
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
import { DEFAULT_CONFIG_PATH, projectPath, resolveConfigPath, workspacePath } from "./paths.js";

function parseModelFieldsFromTable(
  runtimeTable: Table,
  labelPrefix: string,
  requireModelKey: boolean,
  modelFallback?: string
): ModelConfig {
  const apiKey = configString(runtimeTable.api_key, "", `${labelPrefix}.api_key`);
  if (requireModelKey && !apiKey.trim()) {
    throw new ConfigError(`未配置模型密钥，请填写 config.toml 中的 ${labelPrefix}.api_key`);
  }
  const baseUrl = httpUrl(runtimeTable.base_url, `${labelPrefix}.base_url`);
  const modelName = requiredString(runtimeTable.model ?? modelFallback, `${labelPrefix}.model`);
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

function legacyModelVendors(
  runtimes: Readonly<Record<string, ModelConfig>>
): Readonly<Record<string, ModelVendorConfig>> {
  return {
    deepseek: {
      name: "DeepSeek",
      models: Object.keys(runtimes)
    }
  };
}

function configuredCurrentModel(modelTable: Table): string {
  return configString(
    modelTable.current_model ?? modelTable.active,
    "",
    "model.current_model"
  ).trim();
}

function resolveCurrentModel(
  value: string,
  runtimes: Readonly<Record<string, ModelConfig>>
): string {
  const candidates = value.includes("/")
    ? [value, value.slice(value.lastIndexOf("/") + 1)]
    : [value];
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    const model = Object.keys(runtimes).find((item) => item.toLowerCase() === normalized);
    if (model) {
      return model;
    }
  }
  throw new ConfigError(`model.current_model 指向未知模型：${value}`);
}

function parseVendorModelSection(
  raw: Table,
  requireModelKey: boolean
): ModelSectionConfig | undefined {
  const modelTable = table(raw.model, "model");
  const vendorsTable = modelTable.vendors;
  if (!isRecord(vendorsTable) || Object.keys(vendorsTable).length === 0) {
    return undefined;
  }

  const runtimes: Record<string, ModelConfig> = {};
  const vendors: Record<string, ModelVendorConfig> = {};
  for (const [vendorId, value] of Object.entries(vendorsTable)) {
    if (!isRecord(value)) {
      throw new ConfigError(`配置项 model.vendors.${vendorId} 必须是表`);
    }
    const vendorTable = value as Table;
    const vendorName = configString(
      vendorTable.name,
      vendorId,
      `model.vendors.${vendorId}.name`
    ).trim();
    const modelNames = [...stringSet(vendorTable.models, `model.vendors.${vendorId}.models`)];
    if (!modelNames.length) {
      throw new ConfigError(`配置项 model.vendors.${vendorId}.models 至少配置一个模型`);
    }
    const modelOptionsTable =
      vendorTable.model_options === undefined
        ? undefined
        : table(vendorTable.model_options, `model.vendors.${vendorId}.model_options`);

    const modelNamesInVendor: string[] = [];
    for (const modelName of modelNames) {
      const existingModel = Object.keys(runtimes).find(
        (item) => item.toLowerCase() === modelName.toLowerCase()
      );
      if (existingModel) {
        throw new ConfigError(`配置项 model.vendors 中存在重复模型：${modelName}`);
      }
      const modelOptions = modelOptionsTable?.[modelName];
      const modelOverrides =
        modelOptions === undefined
          ? {}
          : table(modelOptions, `model.vendors.${vendorId}.model_options.${modelName}`);
      runtimes[modelName] = parseModelFieldsFromTable(
        { ...vendorTable, ...modelOverrides, model: modelName },
        `model.vendors.${vendorId}.models.${modelName}`,
        requireModelKey
      );
      modelNamesInVendor.push(modelName);
    }
    vendors[vendorId] = { name: vendorName || vendorId, models: modelNamesInVendor };
  }

  const modelNames = Object.keys(runtimes);
  const configured = configuredCurrentModel(modelTable);
  const currentModel = resolveCurrentModel(configured || modelNames[0] || "", runtimes);
  return { currentModel, runtimes, vendors };
}

function parseModelSection(raw: Table, requireModelKey: boolean): ModelSectionConfig {
  const modelTable = table(raw.model, "model");
  const vendorSection = parseVendorModelSection(raw, requireModelKey);
  if (vendorSection) {
    return vendorSection;
  }
  const runtimesTable = modelTable.runtimes;
  if (isRecord(runtimesTable) && Object.keys(runtimesTable).length > 0) {
    const runtimes: Record<string, ModelConfig> = {};
    for (const [id, value] of Object.entries(runtimesTable)) {
      if (!isRecord(value)) {
        throw new ConfigError(`配置项 model.runtimes.${id} 必须是表`);
      }
      const config = parseModelFieldsFromTable(value, `model.runtimes.${id}`, requireModelKey);
      const existingModel = Object.keys(runtimes).find(
        (item) => item.toLowerCase() === config.model.toLowerCase()
      );
      if (existingModel) {
        throw new ConfigError(`配置项 model.runtimes 中存在重复模型：${config.model}`);
      }
      runtimes[config.model] = config;
    }
    const modelNames = Object.keys(runtimes);
    const configured = configuredCurrentModel(modelTable);
    const currentModel = resolveCurrentModel(configured || modelNames[0] || "", runtimes);
    return {
      currentModel,
      runtimes,
      vendors: legacyModelVendors(runtimes)
    };
  }
  const single = parseModelFieldsFromTable(modelTable, "model", requireModelKey);
  const runtimes = { [single.model]: single };
  return {
    currentModel: single.model,
    runtimes,
    vendors: legacyModelVendors(runtimes)
  };
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
  const resolved = resolveConfigPath(configPath);
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
