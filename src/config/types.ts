export type McpServerConfig = {
  id: string;
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  url?: string;
  headers?: Readonly<Record<string, string>>;
};

export type ModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  maxRetries: number;
  temperature: number;
  enableThinking: boolean;
};

/** 一个厂商下可供选择的模型 runtime。 */
export type ModelVendorConfig = {
  name: string;
  models: readonly string[];
};

/** [model] 段：current_model 指定当前模型，runtimes 按模型名保存实例配置。 */
export type ModelSectionConfig = {
  currentModel: string;
  runtimes: Readonly<Record<string, ModelConfig>>;
  vendors?: Readonly<Record<string, ModelVendorConfig>>;
  /** 旧 runtime 名称到模型名的迁移映射。 */
  modelAliases?: Readonly<Record<string, string>>;
};

export type DisplayConfig = {
  showThinking: boolean;
  showToolCalls: boolean;
};

export type ToolConfig = {
  maxWebChars: number;
  maxFileChars: number;
  maxFileBytes: number;
  webFetchTimeoutSeconds: number;
  bashTimeoutSeconds: number;
  bashMaxOutputChars: number;
  findMaxResults: number;
  grepMaxMatches: number;
  workspace: string;
};

export type MemoryConfig = {
  contextTurns: number;
  compressBatch: number;
  compressContext: boolean;
  maxMemoryChars: number;
};

export type QQConfig = {
  appId: string;
  appSecret: string;
  sandbox: boolean;
  connectTimeoutSeconds: number;
  maxMessageLength: number;
  markdownSupport: boolean;
  allowedOpenids: ReadonlySet<string>;
};

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  connectTimeoutSeconds: number;
  maxMessageLength: number;
  allowedSenderIds: ReadonlySet<string>;
};

export type McpConfig = {
  enabled: boolean;
  configFile: string;
  callTimeoutSeconds: number;
  connectTimeoutSeconds: number;
  servers: readonly McpServerConfig[];
};

export type PlatformConfig = {
  qq: QQConfig;
  feishu: FeishuConfig;
};

export type AppConfig = {
  model: ModelSectionConfig;
  display: DisplayConfig;
  tools: ToolConfig;
  memory: MemoryConfig;
  platform: PlatformConfig;
  mcp: McpConfig;
  dataDir: string;
};
