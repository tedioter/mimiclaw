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
        active: "main",
        runtimes: {
          main: makeModelConfig({ model: "main-model" }),
          fast: makeModelConfig({ model: "fast-model" })
        }
      },
      (id) => {
        created.push(id);
        return new TrackingModel(id);
      }
    );

    const first = runtime.getActive();
    expect(first).toBeInstanceOf(TrackingModel);
    expect((first as TrackingModel).id).toBe("main");
    expect(created).toEqual(["main"]);

    runtime.switchActive("fast");
    expect(runtime.getActiveId()).toBe("fast");
    const second = runtime.getActive();
    expect((second as TrackingModel).id).toBe("fast");
    expect(created).toEqual(["main", "fast"]);
  });

  it("持久化切换的模型并在重启后恢复", () => {
    const statePath = path.join(temporaryDirectory(), "data", "model-selection.json");
    const section = {
      active: "main",
      runtimes: {
        main: makeModelConfig({ model: "main-model" }),
        fast: makeModelConfig({ model: "fast-model" })
      }
    };

    const first = new ModelRuntime(section, undefined, statePath);
    first.switchActive("fast");
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({ active: "fast" });

    const second = new ModelRuntime(section, undefined, statePath);
    expect(second.getActiveId()).toBe("fast");
  });

  it("忽略已失效的持久化模型并回退至配置 active", () => {
    const statePath = path.join(temporaryDirectory(), "model-selection.json");
    fs.writeFileSync(statePath, JSON.stringify({ active: "removed" }));
    const runtime = new ModelRuntime(
      {
        active: "main",
        runtimes: { main: makeModelConfig({ model: "main-model" }) }
      },
      undefined,
      statePath
    );

    expect(runtime.getActiveId()).toBe("main");
  });

  it("list 标记当前 active", () => {
    const runtime = new ModelRuntime(
      {
        active: "a",
        runtimes: {
          a: makeModelConfig({ model: "a-model", baseUrl: "https://a.example.com/v1" }),
          b: makeModelConfig({ model: "b-model", baseUrl: "https://b.example.com/v1" })
        }
      },
      () => new TrackingModel("x")
    );
    expect(runtime.list()).toEqual([
      {
        id: "a",
        vendorId: "deepseek",
        vendorName: "DeepSeek",
        model: "a-model",
        baseUrl: "https://a.example.com/v1",
        active: true
      },
      {
        id: "b",
        vendorId: "deepseek",
        vendorName: "DeepSeek",
        model: "b-model",
        baseUrl: "https://b.example.com/v1",
        active: false
      }
    ]);
  });

  it("按厂商分组模型并标记当前厂商", () => {
    const runtime = new ModelRuntime({
      active: "deepseek/deepseek-v4-pro",
      runtimes: {
        "deepseek/deepseek-v4-pro": makeModelConfig({ model: "deepseek-v4-pro" }),
        "deepseek/deepseek-v4-flash": makeModelConfig({ model: "deepseek-v4-flash" })
      },
      vendors: {
        deepseek: {
          name: "DeepSeek",
          runtimeIds: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"]
        }
      }
    });

    expect(runtime.listVendors()).toEqual([
      { id: "deepseek", name: "DeepSeek", modelCount: 2, active: true }
    ]);
    expect(runtime.list("deepseek").map((item) => [item.model, item.active])).toEqual([
      ["deepseek-v4-pro", true],
      ["deepseek-v4-flash", false]
    ]);
  });

  it("拒绝未归属厂商的模型 runtime", () => {
    expect(
      () =>
        new ModelRuntime({
          active: "main",
          runtimes: { main: makeModelConfig() },
          vendors: { deepseek: { name: "DeepSeek", runtimeIds: [] } }
        })
    ).toThrow("模型 runtime 未归属任何厂商：main");
  });

  it("拒绝切换到未知 runtime", () => {
    const runtime = new ModelRuntime(
      { active: "main", runtimes: { main: makeModelConfig() } },
      () => new TrackingModel("main")
    );
    expect(() => runtime.switchActive("missing")).toThrow(MimiError);
  });

  it("按名称大小写不敏感切换 runtime", () => {
    const runtime = new ModelRuntime(
      {
        active: "main",
        runtimes: {
          main: makeModelConfig({ model: "main-model" }),
          fast: makeModelConfig({ model: "fast-model" })
        }
      },
      (id) => new TrackingModel(id)
    );
    runtime.switchActive("FAST");
    expect(runtime.getActiveId()).toBe("fast");
    expect((runtime.getActive() as TrackingModel).id).toBe("fast");
  });

  it("close 只释放已实例化的模型", async () => {
    const main = new TrackingModel("main");
    const fast = new TrackingModel("fast");
    const runtime = new ModelRuntime(
      {
        active: "main",
        runtimes: {
          main: makeModelConfig(),
          fast: makeModelConfig()
        }
      },
      (id) => (id === "main" ? main : fast)
    );
    runtime.getActive();
    await runtime.close();
    expect(main.close).toHaveBeenCalledOnce();
    expect(fast.close).not.toHaveBeenCalled();
  });
});
