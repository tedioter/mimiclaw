import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolConfig, AppConfig } from "../src/config/types.js";
import type { Model, ModelEvent, ModelMessage } from "../src/model/index.js";
import { LongTermMemory, Memory, ShortTermMemory } from "../src/memory/index.js";
import { createTools } from "../src/tools/toolregistry.js";
import type { Tool } from "../src/tools/base.js";
import { ToolError } from "../src/types/errors.js";

const temporaryDirectories: string[] = [];

export function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mimiclaw-"));
  temporaryDirectories.push(directory);
  return directory;
}

export function cleanupTemporaryDirectories(): void {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

export function makeConfig(root: string, toolOverrides: Partial<ToolConfig> = {}): AppConfig {
  return {
    model: {
      baseUrl: "https://example.com/v1",
      apiKey: "test",
      model: "test",
      timeoutSeconds: 30,
      maxRetries: 0,
      temperature: 0.7,
      enableThinking: true
    },
    display: { showThinking: true, showToolCalls: true },
    tools: {
      maxWebChars: 1000,
      maxFileChars: 1000,
      maxFileBytes: 1000,
      webFetchTimeoutSeconds: 20,
      bashTimeoutSeconds: 5,
      bashMaxOutputChars: 1000,
      findMaxResults: 20,
      grepMaxMatches: 20,
      workspace: root,
      ...toolOverrides
    },
    memory: {
      contextTurns: 3,
      compressBatch: 1,
      compressContext: false,
      maxMemoryChars: 30_000
    },
    platform: {
      qq: {
        appId: "",
        appSecret: "",
        sandbox: false,
        connectTimeoutSeconds: 30,
        maxMessageLength: 5000,
        markdownSupport: true,
        allowedOpenids: new Set()
      },
      feishu: {
        appId: "",
        appSecret: "",
        connectTimeoutSeconds: 30,
        maxMessageLength: 3500,
        allowedSenderIds: new Set()
      }
    },
    mcp: {
      enabled: false,
      configFile: path.join(root, "mcp.json"),
      callTimeoutSeconds: 60,
      connectTimeoutSeconds: 30,
      servers: []
    },
    dataDir: path.join(root, "data")
  };
}

export class FakeModel implements Model {
  readonly calls: ModelMessage[][] = [];

  constructor(private readonly responses: ModelEvent[][]) {}

  async *streamChat(messages: ModelMessage[]): AsyncIterable<ModelEvent> {
    this.calls.push(structuredClone(messages));
    for (const event of this.responses.shift() ?? []) {
      yield event;
    }
  }

  async close(): Promise<void> {}
}

export function testToolDependencies(
  workspace: string,
  toolOverrides: Partial<ToolConfig> = {}
): { config: AppConfig; memory: Memory } {
  const dataDir = path.join(workspace, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const config = makeConfig(workspace, {
    maxFileChars: 1000,
    bashTimeoutSeconds: 5,
    bashMaxOutputChars: 1000,
    grepMaxMatches: 200,
    findMaxResults: 200,
    maxWebChars: 1000,
    webFetchTimeoutSeconds: 20,
    ...toolOverrides
  });
  return {
    config,
    memory: new Memory(
      new ShortTermMemory(path.join(dataDir, "recent.json"), config.memory.contextTurns),
      new LongTermMemory(dataDir, config.memory.maxMemoryChars)
    )
  };
}

export function testTool(
  name: string,
  workspace: string,
  toolOverrides?: Partial<ToolConfig>
): Tool {
  const { config } = testToolDependencies(workspace, toolOverrides);
  const tool = createTools(config).find((candidate) => candidate.name === name);
  if (!tool) {
    throw new ToolError(`未知工具："${name}"`);
  }
  return tool;
}
