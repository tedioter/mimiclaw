import { TimeoutError } from "../types/errors.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise: Deferred<T>["resolve"] = () => undefined;
  let rejectPromise: Deferred<T>["reject"] = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  onTimeout?: () => void | Promise<void>
): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RangeError("超时时间必须是大于 0 的有限数字");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          try {
            void Promise.resolve(onTimeout?.()).catch(() => undefined);
          } catch {
            // 超时清理失败不能覆盖原始超时错误。
          }
          reject(new TimeoutError(message));
        }, milliseconds);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
