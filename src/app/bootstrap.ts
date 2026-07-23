import { Agent } from "../agent/agent.js";
import { createAgentLoopControl, runAgentLoop } from "./agent-runner.js";
import { MessageBus } from "../bus/message-bus.js";
import { runShutdownSteps } from "../utils/shutdown.js";
import { OpenAICompatibleModel } from "../model/openai-compatible.js";
import { DEFAULT_CONFIG_PATH, loadConfig, recentMemoryPath } from "../config/index.js";
import type { AppConfig } from "../config/types.js";
import { LongTermMemory } from "../memory/long-term-memory.js";
import { Memory } from "../memory/memory.js";
import { ShortTermMemory } from "../memory/short-term-memory.js";
import type { McpToolHub } from "../mcp/hub.js";
import { createToolRegistry } from "../tools/toolregistry.js";
import type { ToolRegistry } from "../tools/toolregistry.js";
import { MimiError } from "../types/errors.js";
import {
  CliAdapter,
  FeishuAdapter,
  QQAdapter,
  type CliPlatformOptions,
  type PlatformAdapter
} from "../platforms/index.js";

export type PlatformName = "qq" | "feishu" | "cli";

export type ServeOptions = {
  cli?: CliPlatformOptions;
};

type PreparedAgentDependencies = {
  memory: Memory;
  registry: ToolRegistry;
  hub?: McpToolHub;
};

type CreatedAgent = {
  agent: Agent;
  bus: MessageBus;
  hub?: McpToolHub;
};

export class AgentRuntime {
  private closePromise?: Promise<void>;

  constructor(
    readonly config: AppConfig,
    readonly agent: Agent,
    readonly bus: MessageBus,
    readonly mcpHub?: McpToolHub
  ) {}

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    await runShutdownSteps(
      [
        async () => {
          this.bus.close();
        },
        async () => {
          await this.mcpHub?.close();
        },
        async () => {
          await this.agent.close();
        }
      ],
      "运行时资源关闭失败"
    );
  }
}

async function prepare(config: AppConfig): Promise<PreparedAgentDependencies> {
  const memory = new Memory(
    new ShortTermMemory(recentMemoryPath(config.dataDir), config.memory.contextTurns),
    new LongTermMemory(config.dataDir, config.memory.maxMemoryChars)
  );
  const { registry, hub } = await createToolRegistry(config);
  return { memory, registry, ...(hub ? { hub } : {}) };
}

async function createAgent(config: AppConfig): Promise<CreatedAgent> {
  const dependencies = await prepare(config);
  const bus = new MessageBus();
  let model: OpenAICompatibleModel | undefined;
  try {
    model = new OpenAICompatibleModel(config.model);
    const agent = new Agent(config, model, dependencies.memory, dependencies.registry);
    return { agent, bus, ...(dependencies.hub ? { hub: dependencies.hub } : {}) };
  } catch (error) {
    await Promise.allSettled([
      ...(dependencies.hub ? [dependencies.hub.close()] : []),
      ...(model ? [model.close()] : [])
    ]);
    throw error;
  }
}

export async function loadRuntime(requireModelKey = true): Promise<AgentRuntime> {
  const config = loadConfig(DEFAULT_CONFIG_PATH, requireModelKey);
  const { agent, bus, hub } = await createAgent(config);
  return new AgentRuntime(config, agent, bus, hub);
}

function createAdapter(
  runtime: AgentRuntime,
  name: PlatformName,
  options?: ServeOptions
): PlatformAdapter {
  switch (name) {
    case "qq":
      return new QQAdapter(runtime.bus, runtime.config.platform.qq);
    case "feishu":
      return new FeishuAdapter(runtime.bus, runtime.config.platform.feishu);
    case "cli":
      return new CliAdapter(runtime.bus, options?.cli ?? { mode: "chat" });
    default:
      throw new MimiError(`未知平台：${name satisfies never}`);
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = (): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

/** 启动 Agent 与指定平台，阻塞直到 CLI 结束或收到退出信号。 */
export async function servePlatforms(
  platforms: PlatformName[],
  options?: ServeOptions
): Promise<number> {
  if (!platforms.length) {
    throw new MimiError("至少需要指定一个平台");
  }

  const runtime = await loadRuntime();
  const started: PlatformAdapter[] = [];
  const loopControl = createAgentLoopControl();
  const agentTask = runAgentLoop(runtime.agent, runtime.bus, loopControl);
  const dispatchTask = runtime.bus.dispatchHandlers();
  let cliAdapter: CliAdapter | undefined;

  try {
    const adapters = platforms.map((name) => createAdapter(runtime, name, options));
    const remote = adapters.filter((adapter) => adapter.name !== "cli");
    cliAdapter = adapters.find((adapter): adapter is CliAdapter => adapter.name === "cli");

    for (const adapter of remote) {
      await adapter.start();
      started.push(adapter);
    }

    const cliTask = cliAdapter?.start().then(() => {
      if (cliAdapter) {
        started.push(cliAdapter);
      }
    });

    if (remote.length > 0) {
      await Promise.race([waitForShutdownSignal(), ...(cliTask ? [cliTask] : [])]);
    } else if (cliTask) {
      await cliTask;
    }
  } finally {
    loopControl.stop();
    runtime.bus.close();
    await Promise.allSettled([agentTask, dispatchTask]);
    await runShutdownSteps(
      [
        () =>
          runShutdownSteps(
            [...started].reverse().map((adapter) => () => adapter.stop()),
            "平台适配器关闭失败"
          ),
        () => runtime.close()
      ],
      "平台服务关闭失败"
    );
  }

  return cliAdapter?.exitCode ?? 0;
}
