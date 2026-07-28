import { Agent } from "../agent/agent.js";
import { MessageBus, MessageBusClosedError } from "../bus/message-bus.js";
import { runShutdownSteps } from "../utils/shutdown.js";
import { ModelRuntime } from "../model/runtime.js";
import {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  modelSelectionPath,
  recentMemoryPath,
  runtimeLogPath
} from "../config/index.js";
import { setLogFilePath } from "../utils/log.js";
import type { AppConfig } from "../config/types.js";
import { LongTermMemory } from "../memory/long-term-memory.js";
import { Memory } from "../memory/memory.js";
import { ShortTermMemory } from "../memory/short-term-memory.js";
import { createToolRegistry } from "../tools/toolregistry.js";
import type { ToolRegistry } from "../tools/toolregistry.js";
import type { AgentEvent } from "../types/events.js";
import type { ModelRuntimeInfo, ModelVendorInfo } from "../model/runtime.js";

export type AgentLoopControl = {
  isActive(): boolean;
  stop(): void;
};

export function createAgentLoopControl(): AgentLoopControl {
  let active = true;
  return {
    isActive: () => active,
    stop: () => {
      active = false;
    }
  };
}

/** 按 display 配置判断事件是否展示给用户；Agent 本身始终产出完整事件流。 */
export function shouldShowEvent(event: AgentEvent, display: AppConfig["display"]): boolean {
  if (event.type === "thinking_delta") {
    return display.showThinking;
  }
  if (event.type === "tool_intent") {
    return display.showToolCalls;
  }
  return true;
}

export class AgentRuntime {
  private closePromise?: Promise<void>;

  constructor(
    readonly config: AppConfig,
    readonly agent: Agent,
    readonly bus: MessageBus
  ) {}

  /** 从 bus 消费入站消息，驱动 Agent 推理并将出站事件写回 bus。 */
  async runLoop(control: AgentLoopControl): Promise<void> {
    const { agent, bus, config } = this;
    const { display } = config;
    while (control.isActive()) {
      let inbound;
      try {
        inbound = await bus.consumeInboundMessage();
      } catch (error) {
        if (error instanceof MessageBusClosedError) {
          return;
        }
        throw error;
      }
      for await (const event of agent.respond(inbound)) {
        if (!shouldShowEvent(event, display)) {
          continue;
        }
        bus.publishOutboundMessage({
          platform: inbound.platform,
          event,
          ...(inbound.messageId ? { messageId: inbound.messageId } : {})
        });
        if (event.type === "turn_done") {
          await agent.handleTurnDone(inbound, event.text);
        }
      }
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeResources();
    return this.closePromise;
  }

  listVendors(): ModelVendorInfo[] {
    return this.agent.modelRuntime.listVendors();
  }

  listModels(vendorId?: string): ModelRuntimeInfo[] {
    return this.agent.modelRuntime.list(vendorId);
  }

  switchModel(id: string): void {
    this.agent.modelRuntime.switchActive(id);
  }

  private async closeResources(): Promise<void> {
    await runShutdownSteps(
      [
        async () => {
          this.bus.close();
        },
        async () => {
          await this.agent.close();
        }
      ],
      "运行时资源关闭失败"
    );
  }
}

async function createMemoryAndTools(config: AppConfig): Promise<{
  memory: Memory;
  registry: ToolRegistry;
}> {
  const memory = new Memory(
    new ShortTermMemory(recentMemoryPath(config.dataDir), config.memory.contextTurns),
    new LongTermMemory(config.dataDir, config.memory.maxMemoryChars),
    {
      compressBatch: config.memory.compressBatch,
      compressContext: config.memory.compressContext
    }
  );
  const registry = await createToolRegistry(config);
  return { memory, registry };
}

export async function createRuntime(
  requireModelKey = true,
  configPath: string = DEFAULT_CONFIG_PATH
): Promise<AgentRuntime> {
  const config = loadConfig(configPath, requireModelKey);
  setLogFilePath(runtimeLogPath(config.dataDir));
  const { memory, registry } = await createMemoryAndTools(config);
  const bus = new MessageBus();
  let modelRuntime: ModelRuntime | undefined;
  try {
    modelRuntime = new ModelRuntime(config.model, undefined, modelSelectionPath(config.dataDir));
    const agent = new Agent(modelRuntime, memory, registry);
    return new AgentRuntime(config, agent, bus);
  } catch (error) {
    await Promise.allSettled([registry.close(), ...(modelRuntime ? [modelRuntime.close()] : [])]);
    throw error;
  }
}
