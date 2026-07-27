import type { ModelConfig, ModelSectionConfig } from "./types.js";
import { ConfigError } from "../types/errors.js";

/** 返回当前 active runtime 的模型配置。 */
export function getActiveModelConfig(section: ModelSectionConfig): ModelConfig {
  const config = section.runtimes[section.active];
  if (!config) {
    throw new ConfigError(`model.active 指向未知 runtime：${section.active}`);
  }
  return config;
}
