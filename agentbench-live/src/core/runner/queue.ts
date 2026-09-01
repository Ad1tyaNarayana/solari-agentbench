type PendingJob<T> = {
  job: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export class QueueCancelledError extends Error {
  constructor() {
    super("Queue job was cancelled before it started");
    this.name = "QueueCancelledError";
  }
}

export class RunQueue {
  private active = 0;
  private readonly pending: PendingJob<unknown>[] = [];

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
      throw new Error("Concurrency must be an integer between 1 and 2");
    }
  }

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({ job, resolve, reject } as PendingJob<unknown>);
    });
    this.drain();
    return result;
  }

  cancelPending(): number {
    const cancelled = this.pending.splice(0);
    for (const item of cancelled) {
      item.reject(new QueueCancelledError());
    }
    return cancelled.length;
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const item = this.pending.shift();
      if (!item) return;

      this.active += 1;
      void Promise.resolve()
        .then(item.job)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
