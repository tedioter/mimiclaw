import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, updateCurrentModel } from "../src/config/index.js";
import { ConfigError } from "../src/types/errors.js";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

function writeModelConfig(content: string): string {
  const root = temporaryDirectory();
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(configPath, content);
  return configPath;
}

describe("模型选择配置持久化", () => {
  it("只更新 [model] 的 current_model 并保留其他配置", () => {
    const source = [
      'data_dir = "data"',
      "",
      "[model]",
      "# 保留模型配置说明",
      'current_model = "main-model" # 保留行尾注释',
      "",
      "[model.vendors.deepseek]",
      'base_url = "https://example.com/v1"',
      'api_key = "test-key"',
      'models = ["main-model", "fast-model"]',
      "",
      "[display]",
      "show_thinking = false",
      ""
    ].join("\n");
    const configPath = writeModelConfig(source);

    updateCurrentModel(configPath, "fast-model");

    const updated = fs.readFileSync(configPath, "utf8");
    expect(updated).toContain('current_model = "fast-model" # 保留行尾注释');
    expect(updated).toContain("# 保留模型配置说明");
    expect(updated).toContain('api_key = "test-key"');
    expect(loadConfig(configPath).model.currentModel).toBe("fast-model");
  });

  it("[model] 缺少 current_model 时插入配置项", () => {
    const configPath = writeModelConfig(
      [
        "[model]",
        "",
        "[model.vendors.deepseek]",
        'base_url = "https://example.com/v1"',
        'api_key = "test-key"',
        'models = ["fast-model"]',
        ""
      ].join("\n")
    );

    updateCurrentModel(configPath, "fast-model");

    expect(fs.readFileSync(configPath, "utf8")).toContain('[model]\ncurrent_model = "fast-model"');
  });

  it("配置缺少 [model] 段时拒绝写入", () => {
    const configPath = writeModelConfig("[display]\nshow_thinking = false\n");

    expect(() => updateCurrentModel(configPath, "fast-model")).toThrow(ConfigError);
    expect(fs.readFileSync(configPath, "utf8")).toBe("[display]\nshow_thinking = false\n");
  });
});
