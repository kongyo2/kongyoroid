import { KongyoroidError, aborted, checkAbort } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { integer } from "./validate.ts";

interface Waiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: KongyoroidError) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}

export class Semaphore {
  private active: number = 0;
  private readonly limit: number;
  private readonly maxQueue: number;
  private readonly queue: Waiter[] = [];

  public constructor(limit: number, maxQueue: number = 1024) {
    this.limit = integer(limit, "$.concurrency", 1, LIMITS.concurrency);
    this.maxQueue = integer(maxQueue, "$.maxQueue", 0, 100_000);
  }

  public get pending(): number {
    return this.queue.length;
  }

  public get running(): number {
    return this.active;
  }

  private release(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      const waiter = this.queue.shift();
      if (waiter !== undefined) {
        waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.resolve(this.release());
      } else {
        this.active -= 1;
      }
    };
  }

  public acquire(signal?: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.release());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(
        new KongyoroidError({
          code: "QUEUE_FULL",
          message: `The render queue is full (${this.maxQueue} waiting).`,
          retryable: true,
        }),
      );
    }
    return new Promise((resolve, reject: (error: KongyoroidError) => void) => {
      const abort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(aborted("Queued render cancelled."));
      };
      const waiter: Waiter = { resolve, reject, signal, abort };
      this.queue.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  public async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const controller = new AbortController();
  const forward = (): void => {
    controller.abort();
  };
  signal?.addEventListener("abort", forward, { once: true });
  const pending = items.entries();
  let failure: unknown;
  const worker = async (): Promise<void> => {
    if (failure !== undefined || controller.signal.aborted) return;
    const entry = pending.next();
    if (entry.done === true) return;
    const [index, item] = entry.value;
    try {
      results[index] = await task(item, index);
    } catch (error) {
      failure ??= error;
      controller.abort();
      return;
    }
    return worker();
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
  } finally {
    signal?.removeEventListener("abort", forward);
  }
  if (failure !== undefined) throw failure;
  checkAbort(signal);
  return results;
}
