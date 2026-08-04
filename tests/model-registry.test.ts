import { describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "../src/model/registry.js";
import type { Model, ModelEvent, ModelMessage } from "../src/model/index.js";
import { MimiError } from "../src/types/errors.js";
import { makeModelConfig } from "./test-helpers.js";

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

function twoModelSection() {
  return {
    currentModel: "main-model",
    runtimes: {
      "main-model": makeModelConfig({ model: "main-model" }),
      "fast-model": makeModelConfig({ model: "fast-model" })
    }
  };
}

describe("ModelRegistry", () => {
  it("懒加载当前模型，并在切换后使用新模型", () => {
    const created: string[] = [];
    const registry = new ModelRegistry(twoModelSection(), (model) => {
      created.push(model);
      return new TrackingModel(model);
    });

    const first = registry.getCurrent();
    expect(first).toBeInstanceOf(TrackingModel);
    expect((first as TrackingModel).id).toBe("main-model");
    expect(created).toEqual(["main-model"]);

    registry.switchModel("fast-model");
    expect(registry.getCurrentModel()).toBe("fast-model");
    const second = registry.getCurrent();
    expect((second as TrackingModel).id).toBe("fast-model");
    expect(created).toEqual(["main-model", "fast-model"]);
  });

  it("切换成功后通过写入器持久化当前模型", () => {
    const written: string[] = [];
    const registry = new ModelRegistry(twoModelSection(), undefined, (model) => {
      written.push(model);
    });

    registry.switchModel("fast-model");

    expect(written).toEqual(["fast-model"]);
    expect(registry.getCurrentModel()).toBe("fast-model");
  });

  it("持久化失败时不改变内存中的当前模型", () => {
    const registry = new ModelRegistry(twoModelSection(), undefined, () => {
      throw new MimiError("配置写入失败");
    });

    expect(() => registry.switchModel("fast-model")).toThrow("配置写入失败");
    expect(registry.getCurrentModel()).toBe("main-model");
  });

  it("list 标记当前模型并返回各模型端点", () => {
    const registry = new ModelRegistry(
      {
        currentModel: "a-model",
        runtimes: {
          "a-model": makeModelConfig({
            model: "a-model",
            baseUrl: "https://a.example.com/v1"
          }),
          "b-model": makeModelConfig({
            model: "b-model",
            baseUrl: "https://b.example.com/v1"
          })
        }
      },
      () => new TrackingModel("x")
    );

    expect(registry.list()).toEqual([
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
    const registry = new ModelRegistry({
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

    expect(registry.listVendors()).toEqual([
      { id: "deepseek", name: "DeepSeek", modelCount: 2, current: true }
    ]);
    expect(registry.list("deepseek").map((item) => [item.model, item.current])).toEqual([
      ["deepseek-v4-pro", true],
      ["deepseek-v4-flash", false]
    ]);
  });

  it("拒绝未归属厂商的模型配置", () => {
    expect(
      () =>
        new ModelRegistry({
          currentModel: "main-model",
          runtimes: { "main-model": makeModelConfig({ model: "main-model" }) },
          vendors: { deepseek: { name: "DeepSeek", models: [] } }
        })
    ).toThrow("模型未归属任何厂商：main-model");
  });

  it("拒绝切换到未知模型", () => {
    const registry = new ModelRegistry(
      { currentModel: "test", runtimes: { test: makeModelConfig() } },
      () => new TrackingModel("test")
    );
    expect(() => registry.switchModel("missing")).toThrow(MimiError);
  });

  it("按名称大小写不敏感地切换模型", () => {
    const registry = new ModelRegistry(twoModelSection(), (model) => new TrackingModel(model));

    registry.switchModel("FAST-MODEL");
    expect(registry.getCurrentModel()).toBe("fast-model");
    expect((registry.getCurrent() as TrackingModel).id).toBe("fast-model");
  });

  it("close 只释放已经实例化的模型", async () => {
    const main = new TrackingModel("main");
    const fast = new TrackingModel("fast");
    const registry = new ModelRegistry(twoModelSection(), (model) =>
      model === "main-model" ? main : fast
    );

    registry.getCurrent();
    await registry.close();
    expect(main.close).toHaveBeenCalledOnce();
    expect(fast.close).not.toHaveBeenCalled();
  });
});
