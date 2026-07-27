import type { ModelConfig, ModelSectionConfig } from "../config/types.js";
import { ConfigError, MimiError } from "../types/errors.js";
import type { Model } from "./model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";

export type ModelRuntimeInfo = {
  id: string;
  model: string;
  baseUrl: string;
  active: boolean;
};

export type ModelFactory = (id: string, config: ModelConfig) => Model;

const defaultFactory: ModelFactory = (_id, config) => new OpenAICompatibleModel(config);

/** 管理多个对话模型 runtime，按 active 懒加载实例；切换仅影响下一轮 respond。 */
export class ModelRuntime {
  private activeId: string;
  private readonly configs: Readonly<Record<string, ModelConfig>>;
  private readonly instances = new Map<string, Model>();
  private closePromise?: Promise<void>;

  constructor(
    section: ModelSectionConfig,
    private readonly factory: ModelFactory = defaultFactory
  ) {
    this.configs = section.runtimes;
    this.activeId = section.active;
    if (!this.configs[this.activeId]) {
      throw new ConfigError(`model.active 指向未知 runtime：${this.activeId}`);
    }
  }

  getActiveId(): string {
    return this.activeId;
  }

  getActive(): Model {
    return this.getOrCreate(this.activeId);
  }

  list(): ModelRuntimeInfo[] {
    return Object.entries(this.configs).map(([id, config]) => ({
      id,
      model: config.model,
      baseUrl: config.baseUrl,
      active: id === this.activeId
    }));
  }

  switchActive(id: string): void {
    const resolved = this.resolveRuntimeId(id);
    if (!resolved) {
      throw new MimiError(`未知模型 runtime：${id}`);
    }
    this.activeId = resolved;
  }

  private resolveRuntimeId(id: string): string | undefined {
    if (this.configs[id]) {
      return id;
    }
    const normalized = id.toLowerCase();
    return Object.keys(this.configs).find((runtimeId) => runtimeId.toLowerCase() === normalized);
  }

  close(): Promise<void> {
    this.closePromise ??= Promise.all(
      [...this.instances.values()].map((model) => model.close())
    ).then(() => {});
    return this.closePromise;
  }

  private getOrCreate(id: string): Model {
    let instance = this.instances.get(id);
    if (!instance) {
      const config = this.configs[id];
      if (!config) {
        throw new MimiError(`未知模型 runtime：${id}`);
      }
      instance = this.factory(id, config);
      this.instances.set(id, instance);
    }
    return instance;
  }
}
