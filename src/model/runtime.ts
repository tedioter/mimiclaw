import fs from "node:fs";
import type { ModelConfig, ModelSectionConfig, ModelVendorConfig } from "../config/types.js";
import { ConfigError, MimiError } from "../types/errors.js";
import { atomicWriteText } from "../utils/atomic-write.js";
import { isRecord } from "../utils/type-guards.js";
import type { Model } from "./model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";

export type ModelRuntimeInfo = {
  id: string;
  vendorId: string;
  vendorName: string;
  model: string;
  baseUrl: string;
  active: boolean;
};

export type ModelVendorInfo = {
  id: string;
  name: string;
  modelCount: number;
  active: boolean;
};

export type ModelFactory = (id: string, config: ModelConfig) => Model;

const defaultFactory: ModelFactory = (_id, config) => new OpenAICompatibleModel(config);

/** 管理多个对话模型 runtime，按 active 懒加载实例；切换仅影响下一轮 respond。 */
export class ModelRuntime {
  private activeId: string;
  private readonly configs: Readonly<Record<string, ModelConfig>>;
  private readonly statePath: string | undefined;
  private readonly vendors: Readonly<Record<string, ModelVendorConfig>>;
  private readonly runtimeVendors = new Map<string, { id: string; name: string }>();
  private readonly instances = new Map<string, Model>();
  private closePromise?: Promise<void>;

  constructor(
    section: ModelSectionConfig,
    private readonly factory: ModelFactory = defaultFactory,
    statePath?: string
  ) {
    this.configs = section.runtimes;
    this.statePath = statePath;
    this.activeId = section.active;
    if (!this.configs[this.activeId]) {
      throw new ConfigError(`model.active 指向未知 runtime：${this.activeId}`);
    }

    const configuredVendors = section.vendors ?? {
      deepseek: { name: "DeepSeek", runtimeIds: Object.keys(this.configs) }
    };
    const assignedRuntimeIds = new Set<string>();
    for (const [vendorId, vendor] of Object.entries(configuredVendors)) {
      for (const runtimeId of vendor.runtimeIds) {
        if (!this.configs[runtimeId]) {
          throw new ConfigError(`厂商 ${vendorId} 引用了未知模型 runtime：${runtimeId}`);
        }
        if (assignedRuntimeIds.has(runtimeId)) {
          throw new ConfigError(`模型 runtime 重复归属多个厂商：${runtimeId}`);
        }
        assignedRuntimeIds.add(runtimeId);
        this.runtimeVendors.set(runtimeId, { id: vendorId, name: vendor.name });
      }
    }

    const unassignedRuntimeIds = Object.keys(this.configs).filter(
      (runtimeId) => !assignedRuntimeIds.has(runtimeId)
    );
    if (unassignedRuntimeIds.length) {
      throw new ConfigError(`模型 runtime 未归属任何厂商：${unassignedRuntimeIds.join("、")}`);
    }
    this.vendors = configuredVendors;
    this.restorePersistedSelection();
  }

  getActiveId(): string {
    return this.activeId;
  }

  getActive(): Model {
    return this.getOrCreate(this.activeId);
  }

  list(vendorId?: string): ModelRuntimeInfo[] {
    const runtimeIds = vendorId
      ? (this.vendors[this.resolveVendorId(vendorId) ?? ""]?.runtimeIds ?? [])
      : Object.keys(this.configs);
    return runtimeIds.flatMap((id) => {
      const config = this.configs[id];
      const vendor = this.runtimeVendors.get(id);
      if (!config || !vendor) {
        return [];
      }
      return [
        {
          id,
          vendorId: vendor.id,
          vendorName: vendor.name,
          model: config.model,
          baseUrl: config.baseUrl,
          active: id === this.activeId
        }
      ];
    });
  }

  listVendors(): ModelVendorInfo[] {
    return Object.entries(this.vendors).map(([id, vendor]) => ({
      id,
      name: vendor.name,
      modelCount: vendor.runtimeIds.filter((runtimeId) => Boolean(this.configs[runtimeId])).length,
      active: vendor.runtimeIds.includes(this.activeId)
    }));
  }

  switchActive(id: string): void {
    const resolved = this.resolveRuntimeId(id);
    if (!resolved) {
      throw new MimiError(`未知模型 runtime：${id}`);
    }
    if (this.statePath) {
      atomicWriteText(this.statePath, `${JSON.stringify({ active: resolved }, null, 2)}\n`);
    }
    this.activeId = resolved;
  }

  private restorePersistedSelection(): void {
    if (!this.statePath || !fs.existsSync(this.statePath)) {
      return;
    }
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (!isRecord(raw) || typeof raw.active !== "string") {
        return;
      }
      const resolved = this.resolveRuntimeId(raw.active);
      if (resolved) {
        this.activeId = resolved;
      }
    } catch {
      // 选择状态损坏时回退到配置中的默认模型，避免阻塞启动。
    }
  }

  private resolveRuntimeId(id: string): string | undefined {
    if (this.configs[id]) {
      return id;
    }
    const normalized = id.toLowerCase();
    const exact = Object.keys(this.configs).find(
      (runtimeId) => runtimeId.toLowerCase() === normalized
    );
    if (exact) {
      return exact;
    }
    const modelMatches = Object.entries(this.configs)
      .filter(([, config]) => config.model.toLowerCase() === normalized)
      .map(([runtimeId]) => runtimeId);
    return modelMatches.length === 1 ? modelMatches[0] : undefined;
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
