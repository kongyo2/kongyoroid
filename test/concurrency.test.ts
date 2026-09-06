import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Semaphore, mapConcurrent } from "../src/concurrency.ts";
import { KongyoroidError } from "../src/errors.ts";

test("Semaphore limits concurrency and queues fairly", async () => {
  const semaphore = new Semaphore(2, 10);
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      semaphore.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(5);
        order.push(index);
        running -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(semaphore.running, 0);
});

test("Semaphore rejects when the queue is full and on abort", async () => {
  const semaphore = new Semaphore(1, 1);
  const release = await semaphore.acquire();
  const queued = semaphore.acquire();
  await assert.rejects(
    semaphore.acquire(),
    (error: unknown) => error instanceof KongyoroidError && error.code === "QUEUE_FULL",
  );
  const controller = new AbortController();
  release();
  (await queued)();
  const releaseAgain = await semaphore.acquire();
  const waiting = semaphore.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED");
  releaseAgain();
  assert.equal(semaphore.pending, 0);
});

test("mapConcurrent preserves order, bounds parallelism, and propagates the first failure", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapConcurrent([3, 1, 2], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(item * 3);
    active -= 1;
    return item * 10;
  });
  assert.deepEqual(results, [30, 10, 20]);
  assert.equal(peak, 2);
  await assert.rejects(
    mapConcurrent([1, 2, 3], 3, async (item) => {
      await sleep(item);
      if (item === 2) throw new Error("boom");
      return item;
    }),
    /boom/u,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    mapConcurrent([1], 1, () => Promise.resolve(1), controller.signal),
    (error: unknown) => error instanceof KongyoroidError && error.code === "ABORTED",
  );
});
