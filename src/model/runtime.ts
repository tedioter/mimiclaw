import fs from "node:fs";
import type { ModelConfig, ModelSectionConfig, ModelVendorConfig } from "../config/types.js";
import { ConfigError, MimiError } from "../types/errors.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { isRecord } from "../utils/type-guards.js";
import type { Model } from "./model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";

export type ModelRuntimeInfo = {
  vendorId: string;
  vendorName: string;
  model: string;
  baseUrl: string;
  current: boolean;
};

export type ModelVendorInfo = {
  id: string;
  name: string;
  modelCount: number;
  current: boolean;
};

export type ModelFactory = (model: string, config: ModelConfig) => Model;

const defaultFactory: ModelFactory = (_model, config) => new OpenAICompatibleModel(config);

/** 管理多个对话模型 runtime，按 active 懒加载实例；切换仅影响下一轮 respond。 */
export class ModelRuntime {
  private currentModel: string;
  private readonly configs: Readonly<Record<string, ModelConfig>>;
  private readonly statePath: string | undefined;
  private readonly vendors: Readonly<Record<string, ModelVendorConfig>>;
  private readonly modelAliases: Readonly<Record<string, string>>;
  private readonly modelVendors = new Map<string, { id: string; name: string }>();
  private readonly instances = new Map<string, Model>();
  private closePromise?: Promise<void>;

  constructor(
    section: ModelSectionConfig,
    private readonly factory: ModelFactory = defaultFactory,
    statePath?: string
  ) {
    this.configs = section.runtimes;
    this.statePath = statePath;
    this.modelAliases = section.modelAliases ?? {};
    this.currentModel = section.currentModel;
    if (!this.configs[this.currentModel]) {
      throw new ConfigError(`model.current_model 指向未知模型：${this.currentModel}`);
    }

    const configuredVendors = section.vendors ?? {
      deepseek: { name: "DeepSeek", models: Object.keys(this.configs) }
    };
    const assignedModels = new Set<string>();
    for (const [vendorId, vendor] of Object.entries(configuredVendors)) {
      for (const model of vendor.models) {
        if (!this.configs[model]) {
          throw new ConfigError(`厂商 ${vendorId} 引用了未知模型：${model}`);
        }
        if (assignedModels.has(model)) {
          throw new ConfigError(`模型重复归属多个厂商：${model}`);
        }
        assignedModels.add(model);
        this.modelVendors.set(model, { id: vendorId, name: vendor.name });
      }
    }

    const unassignedModels = Object.keys(this.configs).filter(
      (model) => !assignedModels.has(model)
    );
    if (unassignedModels.length) {
      throw new ConfigError(`模型未归属任何厂商：${unassignedModels.join("、")}`);
    }
    this.vendors = configuredVendors;
    this.restorePersistedSelection();
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  getCurrent(): Model {
    return this.getOrCreate(this.currentModel);
  }

  list(vendorId?: string): ModelRuntimeInfo[] {
    const models = vendorId
      ? (this.vendors[this.resolveVendorId(vendorId) ?? ""]?.models ?? [])
      : Object.keys(this.configs);
    return models.flatMap((model) => {
      const config = this.configs[model];
      const vendor = this.modelVendors.get(model);
      if (!config || !vendor) {
        return [];
      }
      return [
        {
          vendorId: vendor.id,
          vendorName: vendor.name,
          model: config.model,
          baseUrl: config.baseUrl,
          current: model === this.currentModel
        }
      ];
    });
  }

  listVendors(): ModelVendorInfo[] {
    return Object.entries(this.vendors).map(([id, vendor]) => ({
      id,
      name: vendor.name,
      modelCount: vendor.models.filter((model) => Boolean(this.configs[model])).length,
      current: vendor.models.includes(this.currentModel)
    }));
  }

  switchModel(model: string): void {
    const resolved = this.resolveModelName(model);
    if (!resolved) {
      throw new MimiError(`未知模型：${model}`);
    }
    if (this.statePath) {
      atomicWriteText(this.statePath, `${JSON.stringify({ currentModel: resolved }, null, 2)}\n`);
    }
    this.currentModel = resolved;
  }

  private restorePersistedSelection(): void {
    if (!this.statePath || !fs.existsSync(this.statePath)) {
      return;
    }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (!isRecord(raw)) {
        return;
      }
      const persistedModel =
        typeof raw.currentModel === "string"
          ? raw.currentModel
          : typeof raw.active === "string"
            ? raw.active
            : undefined;
      if (!persistedModel) {
        return;
      }
      const resolved = this.resolveModelName(persistedModel);
      if (resolved) {
        this.currentModel = resolved;
      }
    } catch {
      // 选择状态损坏时回退到配置中的默认模型，避免阻塞启动。
    }
  }

  private resolveModelName(model: string): string | undefined {
    const candidates = model.includes("/")
      ? [model, model.slice(model.lastIndexOf("/") + 1)]
      : [model];
    for (const candidate of candidates) {
      const normalized = candidate.toLowerCase();
      const resolved = Object.keys(this.configs).find(
        (modelName) => modelName.toLowerCase() === normalized
      );
      if (resolved) {
        return resolved;
      }
      const alias = Object.entries(this.modelAliases).find(
        ([name]) => name.toLowerCase() === normalized
      )?.[1];
      if (alias && this.configs[alias]) {
        return alias;
      }
    }
    return undefined;
  }

  private resolveVendorId(id: string): string | undefined {
    const normalized = id.toLowerCase();
    return Object.entries(this.vendors).find(
      ([vendorId, vendor]) =>
        vendorId.toLowerCase() === normalized || vendor.name.toLowerCase() === normalized
    )?.[0];
  }

  close(): Promise<void> {
    this.closePromise ??= Promise.all(
      [...this.instances.values()].map((model) => model.close())
    ).then(() => {});
    return this.closePromise;
  }

  private getOrCreate(model: string): Model {
    let instance = this.instances.get(model);
    if (!instance) {
      const config = this.configs[model];
      if (!config) {
        throw new MimiError(`未知模型：${model}`);
      }
      instance = this.factory(model, config);
      this.instances.set(model, instance);
    }
    return instance;
  }
}
