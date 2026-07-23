type ReleaseLock = () => void;

export class AsyncMutexLock {
  private tail: Promise<void> = Promise.resolve();

  /**
   * 获取锁并返回释放函数，调用方必须在 finally 中自行调用 release。
   * 适合需要在持锁期间多次 yield 的异步生成器。
   */
  async acquire(): Promise<ReleaseLock> {
    const prev = this.tail;
    let unlockNext!: () => void;

    this.tail = new Promise<void>((resolve) => {
      unlockNext = resolve;
    });

    await prev;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      unlockNext();
    };
  }

  /**
   * 获取锁、执行异步操作并在 finally 中自动释放锁。
   * 适合不需要流式 yield 的普通异步操作。
   */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
