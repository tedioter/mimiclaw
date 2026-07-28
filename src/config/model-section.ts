import type { ModelConfig, ModelSectionConfig } from "./types.js";
import { ConfigError } from "../types/errors.js";

/** 返回当前模型的配置。 */
export function getCurrentModelConfig(section: ModelSectionConfig): ModelConfig {
  const config = section.runtimes[section.currentModel];
  if (!config) {
    throw new ConfigError(`model.current_model 指向未知模型：${section.currentModel}`);
  }
  return config;
}
