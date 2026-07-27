import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/model/runtime.js";
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
      { id: "a", model: "a-model", baseUrl: "https://a.example.com/v1", active: true },
      { id: "b", model: "b-model", baseUrl: "https://b.example.com/v1", active: false }
    ]);
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
