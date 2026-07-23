import { describe, expect, it } from "vitest";
import { TimeoutError } from "../src/types/errors.js";
import { AsyncMutexLock } from "../src/utils/async-mutex-lock.js";
import { createDeferred, withTimeout } from "../src/utils/async.js";

describe("异步互斥锁", () => {
  it("按照获取锁的顺序串行执行", async () => {
    const mutex = new AsyncMutexLock();
    const order: string[] = [];

    const first = mutex.withLock(async () => {
      order.push("A 开始");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      order.push("A 结束");
    });
    const second = mutex.withLock(async () => {
      order.push("B 开始");
      order.push("B 结束");
    });

    await Promise.all([first, second]);

    expect(order).toEqual(["A 开始", "A 结束", "B 开始", "B 结束"]);
  });

  it("任务失败后仍然释放锁", async () => {
    const mutex = new AsyncMutexLock();

    await expect(
      mutex.withLock(async () => {
        throw new Error("测试异常");
      })
    ).rejects.toThrow("测试异常");

    await expect(mutex.withLock(async () => "下一轮")).resolves.toBe("下一轮");
  });
});

describe("异步辅助", () => {
  it("Deferred 可以在创建后完成 Promise", async () => {
    const deferred = createDeferred<string>();
    deferred.resolve("完成");
    await expect(deferred.promise).resolves.toBe("完成");
  });

  it("超时使用明确错误类型并拒绝非法时长", async () => {
    await expect(withTimeout(new Promise(() => undefined), 1, "等待超时")).rejects.toBeInstanceOf(
      TimeoutError
    );
    await expect(withTimeout(Promise.resolve("完成"), 0, "不会执行")).rejects.toThrow(
      "超时时间必须是大于 0 的有限数字"
    );
  });

  it("超时后调用取消回调", async () => {
    let cancelled = false;
    await expect(
      withTimeout(new Promise(() => undefined), 1, "等待超时", () => {
        cancelled = true;
      })
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(cancelled).toBe(true);
  });
});
