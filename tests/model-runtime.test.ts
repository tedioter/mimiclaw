import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/model/runtime.js";
import type { Model, ModelEvent, ModelMessage } from "../src/model/index.js";
import { MimiError } from "../src/types/errors.js";
import { makeModelConfig, temporaryDirectory } from "./test-helpers.js";

class TrackingModel implements Model {
  readonly id: string;
  readonly close = vi.fn(async () => {});

  constructor(id: string) {
    this.id = id;
  }

  async *streamChat(_messages: ModelMessage[]): AsyncIterable<ModelEvent> {
    yield { type: "model_text_delta", text: this.id };
  }
}

describe("ModelRuntime", () => {
  it("懒加载 active 模型并在切换后影响下一次 getActive", () => {
    const created: string[] = [];
    const runtime = new ModelRuntime(
      {
        currentModel: "main-model",
        runtimes: {
          "main-model": makeModelConfig({ model: "main-model" }),
          "fast-model": makeModelConfig({ model: "fast-model" })
        }
      },
      (model) => {
        created.push(model);
        return new TrackingModel(model);
      }
    );

    const first = runtime.getCurrent();
    expect(first).toBeInstanceOf(TrackingModel);
    expect((first as TrackingModel).id).toBe("main-model");
    expect(created).toEqual(["main-model"]);

    runtime.switchModel("fast-model");
    expect(runtime.getCurrentModel()).toBe("fast-model");
    const second = runtime.getCurrent();
    expect((second as TrackingModel).id).toBe("fast-model");
    expect(created).toEqual(["main-model", "fast-model"]);
  });

  it("持久化切换的模型并在重启后恢复", () => {
    const statePath = path.join(temporaryDirectory(), "data", "model-selection.json");
    const section = {
      currentModel: "main-model",
      runtimes: {
        "main-model": makeModelConfig({ model: "main-model" }),
        "fast-model": makeModelConfig({ model: "fast-model" })
      }
    };

    const first = new ModelRuntime(section, undefined, statePath);
    first.switchModel("fast-model");
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({
      currentModel: "fast-model"
    });

    const second = new ModelRuntime(section, undefined, statePath);
    expect(second.getCurrentModel()).toBe("fast-model");
  });

  it("忽略已失效的持久化模型并回退至配置 active", () => {
    const statePath = path.join(temporaryDirectory(), "model-selection.json");
    fs.writeFileSync(statePath, JSON.stringify({ currentModel: "removed" }));
    const runtime = new ModelRuntime(
      {
        currentModel: "main-model",
        runtimes: { "main-model": makeModelConfig({ model: "main-model" }) }
      },
      undefined,
      statePath
    );

    expect(runtime.getCurrentModel()).toBe("main-model");
  });

  it("兼容读取旧格式的持久化模型名", () => {
    const statePath = path.join(temporaryDirectory(), "model-selection.json");
    fs.writeFileSync(statePath, JSON.stringify({ active: "deepseek/deepseek-v4-flash" }));
    const runtime = new ModelRuntime(
      {
        currentModel: "deepseek-v4-pro",
        runtimes: {
          "deepseek-v4-pro": makeModelConfig({ model: "deepseek-v4-pro" }),
          "deepseek-v4-flash": makeModelConfig({ model: "deepseek-v4-flash" })
        },
        vendors: {
          deepseek: {
            name: "DeepSeek",
            models: ["deepseek-v4-pro", "deepseek-v4-flash"]
          }
        }
      },
      undefined,
      statePath
    );

    expect(runtime.getCurrentModel()).toBe("deepseek-v4-flash");
  });

  it("兼容读取旧 runtime 名称的持久化选择", () => {
    const statePath = path.join(temporaryDirectory(), "model-selection.json");
    fs.writeFileSync(statePath, JSON.stringify({ active: "fast" }));
    const runtime = new ModelRuntime(
      {
        currentModel: "deepseek-v4-pro",
        runtimes: {
          "deepseek-v4-pro": makeModelConfig({ model: "deepseek-v4-pro" }),
          "deepseek-v4-flash": makeModelConfig({ model: "deepseek-v4-flash" })
        },
        vendors: {
          deepseek: {
            name: "DeepSeek",
            models: ["deepseek-v4-pro", "deepseek-v4-flash"]
          }
        },
        modelAliases: { fast: "deepseek-v4-flash" }
      },
      undefined,
      statePath
    );

    expect(runtime.getCurrentModel()).toBe("deepseek-v4-flash");
  });

  it("list 标记当前 active", () => {
    const runtime = new ModelRuntime(
      {
        currentModel: "a-model",
        runtimes: {
          "a-model": makeModelConfig({ model: "a-model", baseUrl: "https://a.example.com/v1" }),
          "b-model": makeModelConfig({ model: "b-model", baseUrl: "https://b.example.com/v1" })
        }
      },
      () => new TrackingModel("x")
    );
    expect(runtime.list()).toEqual([
      {
        vendorId: "deepseek",
        vendorName: "DeepSeek",
        model: "a-model",
        baseUrl: "https://a.example.com/v1",
        current: true
      },
      {
        vendorId: "deepseek",
        vendorName: "DeepSeek",
        model: "b-model",
        baseUrl: "https://b.example.com/v1",
        current: false
      }
    ]);
  });

  it("按厂商分组模型并标记当前厂商", () => {
    const runtime = new ModelRuntime({
      currentModel: "deepseek-v4-pro",
      runtimes: {
        "deepseek-v4-pro": makeModelConfig({ model: "deepseek-v4-pro" }),
        "deepseek-v4-flash": makeModelConfig({ model: "deepseek-v4-flash" })
      },
      vendors: {
        deepseek: {
          name: "DeepSeek",
          models: ["deepseek-v4-pro", "deepseek-v4-flash"]
        }
      }
    });

    expect(runtime.listVendors()).toEqual([
      { id: "deepseek", name: "DeepSeek", modelCount: 2, current: true }
    ]);
    expect(runtime.list("deepseek").map((item) => [item.model, item.current])).toEqual([
      ["deepseek-v4-pro", true],
      ["deepseek-v4-flash", false]
    ]);
  });

  it("拒绝未归属厂商的模型 runtime", () => {
    expect(
      () =>
        new ModelRuntime({
          currentModel: "main-model",
          runtimes: { "main-model": makeModelConfig({ model: "main-model" }) },
          vendors: { deepseek: { name: "DeepSeek", models: [] } }
        })
    ).toThrow("模型未归属任何厂商：main-model");
  });

  it("拒绝切换到未知 runtime", () => {
    const runtime = new ModelRuntime(
      { currentModel: "test", runtimes: { test: makeModelConfig() } },
      () => new TrackingModel("test")
    );
    expect(() => runtime.switchModel("missing")).toThrow(MimiError);
  });

  it("按名称大小写不敏感切换 runtime", () => {
    const runtime = new ModelRuntime(
      {
        currentModel: "main-model",
        runtimes: {
          "main-model": makeModelConfig({ model: "main-model" }),
          "fast-model": makeModelConfig({ model: "fast-model" })
        }
      },
      (model) => new TrackingModel(model)
    );
    runtime.switchModel("FAST-MODEL");
    expect(runtime.getCurrentModel()).toBe("fast-model");
    expect((runtime.getCurrent() as TrackingModel).id).toBe("fast-model");
  });

  it("close 只释放已实例化的模型", async () => {
    const main = new TrackingModel("main");
    const fast = new TrackingModel("fast");
    const runtime = new ModelRuntime(
      {
        currentModel: "main-model",
        runtimes: {
          "main-model": makeModelConfig({ model: "main-model" }),
          "fast-model": makeModelConfig({ model: "fast-model" })
        }
      },
      (model) => (model === "main-model" ? main : fast)
    );
    runtime.getCurrent();
    await runtime.close();
    expect(main.close).toHaveBeenCalledOnce();
    expect(fast.close).not.toHaveBeenCalled();
  });
});
