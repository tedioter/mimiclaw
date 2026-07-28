import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, getCurrentModelConfig, workspacePath } from "../src/config/index.js";
import { ConfigError } from "../src/types/errors.js";
import { cleanupTemporaryDirectories, temporaryDirectory } from "./test-helpers.js";

afterEach(cleanupTemporaryDirectories);

function writeConfig(modelSettings = ""): string {
  const root = temporaryDirectory();
  const file = path.join(root, "config.toml");
  fs.writeFileSync(
    file,
    [
      "[model]",
      'base_url = "https://example.com/v1"',
      'api_key = "key"',
      'model = "demo"',
      modelSettings,
      ""
    ].join("\n")
  );
  return file;
}

describe("配置解析", () => {
  it("读取基础配置和默认值", () => {
    const file = writeConfig();
    const config = loadConfig(file);
    expect(getCurrentModelConfig(config.model).model).toBe("demo");
    expect(config.model.currentModel).toBe("demo");
    expect(config.model.vendors).toEqual({
      deepseek: { name: "DeepSeek", models: ["demo"] }
    });
    expect(config.tools.maxWebChars).toBe(30_000);
    expect(config.platform.qq.markdownSupport).toBe(true);
  });

  it("允许关闭 QQ 普通消息的 Markdown 支持", () => {
    const file = writeConfig(["[platform.qq]", "markdown_support = false"].join("\n"));
    expect(loadConfig(file).platform.qq.markdownSupport).toBe(false);
  });

  it.each([
    [
      "数值字符串",
      'timeout_seconds = "90"',
      "配置项 model.timeout_seconds 必须是大于 0 的有限数字"
    ],
    ["NaN", "timeout_seconds = nan", "配置项 model.timeout_seconds 必须是大于 0 的有限数字"],
    ["Infinity", "timeout_seconds = inf", "配置项 model.timeout_seconds 必须是大于 0 的有限数字"],
    [
      "错误数值类型",
      "timeout_seconds = true",
      "配置项 model.timeout_seconds 必须是大于 0 的有限数字"
    ],
    ["小数计数值", "max_retries = 1.5", "配置项 model.max_retries 必须是非负整数"],
    ["错误布尔类型", 'enable_thinking = "false"', "配置项 model.enable_thinking 必须是布尔值"]
  ])("拒绝%s", (_caseName, setting, expectedMessage) => {
    const file = writeConfig(setting);
    expect(() => loadConfig(file)).toThrow(ConfigError);
    expect(() => loadConfig(file)).toThrow(expectedMessage);
  });

  it("保留有效的显式数值和布尔值", () => {
    const file = writeConfig(
      [
        "timeout_seconds = 0.5",
        "max_retries = 0",
        "temperature = 0",
        "enable_thinking = false"
      ].join("\n")
    );
    const config = loadConfig(file);
    expect(getCurrentModelConfig(config.model)).toMatchObject({
      timeoutSeconds: 0.5,
      maxRetries: 0,
      temperature: 0,
      enableThinking: false
    });
  });

  it("拒绝被隐式转换的字符串字段和白名单元素", () => {
    const sourcePath = writeConfig();
    const invalidModelFile = fs
      .readFileSync(sourcePath, "utf8")
      .replace('model = "demo"', "model = 123");
    const invalidModelPath = path.join(temporaryDirectory(), "invalid-model.toml");
    fs.writeFileSync(invalidModelPath, invalidModelFile);
    expect(() => loadConfig(invalidModelPath)).toThrow("配置项 model.model 必须是字符串");

    const file = writeConfig();
    fs.appendFileSync(file, "[platform.qq]\nallowed_openids = [123]\n");
    expect(() => loadConfig(file)).toThrow("配置项 platform.qq.allowed_openids 必须只包含字符串");
  });

  it("拒绝无效的模型服务地址", () => {
    const sourcePath = writeConfig();
    const invalidUrlConfig = fs
      .readFileSync(sourcePath, "utf8")
      .replace("https://example.com/v1", "not-a-url");
    const invalidUrlPath = path.join(temporaryDirectory(), "invalid-url.toml");
    fs.writeFileSync(invalidUrlPath, invalidUrlConfig);
    expect(() => loadConfig(invalidUrlPath)).toThrow(
      "配置项 model.base_url 必须是有效的 HTTP 或 HTTPS URL"
    );
  });

  it("拒绝只有空白字符的模型密钥", () => {
    const sourcePath = writeConfig();
    const invalidKeyConfig = fs
      .readFileSync(sourcePath, "utf8")
      .replace('api_key = "key"', 'api_key = "   "');
    const invalidKeyPath = path.join(temporaryDirectory(), "invalid-key.toml");
    fs.writeFileSync(invalidKeyPath, invalidKeyConfig);
    expect(() => loadConfig(invalidKeyPath)).toThrow("未配置模型密钥");
  });

  it("只将独立的波浪号路径展开为用户目录", () => {
    expect(workspacePath("~another-user")).toBe(path.resolve(process.cwd(), "~another-user"));
  });

  it("拒绝 compress_batch 大于 context_turns", () => {
    const file = writeConfig(["[memory]", "context_turns = 3", "compress_batch = 5"].join("\n"));
    expect(() => loadConfig(file)).toThrow("memory.compress_batch 不能大于 memory.context_turns");
  });

  it("解析多 runtime 配置", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "config.toml");
    fs.writeFileSync(
      file,
      [
        "[model]",
        'active = "fast"',
        "",
        "[model.runtimes.main]",
        'base_url = "https://main.example.com/v1"',
        'api_key = "main-key"',
        'model = "main-model"',
        "",
        "[model.runtimes.fast]",
        'base_url = "https://fast.example.com/v1"',
        'api_key = "fast-key"',
        'model = "fast-model"',
        ""
      ].join("\n")
    );
    const config = loadConfig(file);
    expect(config.model.currentModel).toBe("fast-model");
    expect(config.model.runtimes["main-model"]?.model).toBe("main-model");
    expect(getCurrentModelConfig(config.model).model).toBe("fast-model");
  });

  it("解析厂商与模型两级配置", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "config.toml");
    fs.writeFileSync(
      file,
      [
        "[model]",
        'current_model = "deepseek-v4-pro"',
        "",
        "[model.vendors.deepseek]",
        'name = "DeepSeek"',
        'base_url = "https://api.deepseek.com"',
        'api_key = "deepseek-key"',
        'models = ["deepseek-v4-pro", "deepseek-v4-flash"]',
        "",
        "[model.vendors.deepseek.model_options.deepseek-v4-flash]",
        "enable_thinking = false",
        ""
      ].join("\n")
    );

    const config = loadConfig(file);
    expect(config.model.currentModel).toBe("deepseek-v4-pro");
    expect(config.model.vendors?.deepseek).toEqual({
      name: "DeepSeek",
      models: ["deepseek-v4-pro", "deepseek-v4-flash"]
    });
    expect(config.model.runtimes["deepseek-v4-flash"]).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      apiKey: "deepseek-key",
      model: "deepseek-v4-flash",
      enableThinking: false
    });
    expect(config.model.runtimes["deepseek-v4-pro"]?.enableThinking).toBe(true);
  });

  it("拒绝指向未知 runtime 的 active", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "config.toml");
    fs.writeFileSync(
      file,
      [
        "[model]",
        'current_model = "missing"',
        "",
        "[model.runtimes.main]",
        'base_url = "https://example.com/v1"',
        'api_key = "key"',
        'model = "demo"',
        ""
      ].join("\n")
    );
    expect(() => loadConfig(file)).toThrow("model.current_model 指向未知模型：missing");
  });
});
