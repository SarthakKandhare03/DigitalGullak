/** Defers work (settlement, webhook retries) so it can be driven by timers or by tests. */
export interface Scheduler {
  schedule(task: () => Promise<void> | void, delayMs: number): void;
}

export function timerScheduler(onError: (error: unknown) => void): Scheduler {
  return {
    schedule(task, delayMs) {
      setTimeout(() => {
        Promise.resolve()
          .then(task)
          .catch(onError);
      }, delayMs);
    },
  };
}

/** Collects tasks and runs them only when asked. Used by tests for determinism. */
export class ManualScheduler implements Scheduler {
  private queue: Array<() => Promise<void> | void> = [];

  schedule(task: () => Promise<void> | void): void {
    this.queue.push(task);
  }

  get size(): number {
    return this.queue.length;
  }

  /** Runs queued tasks, including ones they enqueue, up to `limit` tasks. */
  async runAll(limit = 100): Promise<void> {
    let ran = 0;
    while (this.queue.length && ran < limit) {
      const task = this.queue.shift()!;
      await task();
      ran++;
    }
  }

  clear(): void {
    this.queue = [];
  }
}
