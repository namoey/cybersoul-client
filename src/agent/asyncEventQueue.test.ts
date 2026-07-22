/**
 * AsyncEventQueue characterization tests.
 *
 * Layer B (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §5.2). The queue is the foundation of CyberSoulAgent's public
 * AsyncIterable surface — if its ordering, back-pressure, or error
 * propagation semantics drift, every agent consumer breaks.
 *
 * Pins:
 *  - Events pushed before iteration starts are buffered in order.
 *  - Events pushed while a consumer is awaiting `next()` resolve
 *    immediately (no buffering).
 *  - `close()` terminates the iterator cleanly (`done: true`).
 *  - `closeWithError(error)` causes the next `next()` to reject.
 *  - Pushes after `close()` are no-ops (don't deadlock).
 *  - `for await ... of` works on the queue (idiomatic consumption).
 */

import { AsyncEventQueue } from "./asyncEventQueue.js";

const assert = {
  equal: (a: any, b: any, msg?: string) => {
    if (a !== b)
      throw new Error(msg || `Assertion failed: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  },
  deepEqual: (a: any, b: any, msg?: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(msg || `Deep assertion failed`);
  },
  ok: (condition: any, msg?: string) => {
    if (!condition) throw new Error(msg || "Assertion failed: expected truthy value");
  },
  throws: async (
    fn: () => unknown | Promise<unknown>,
    predicate: (e: unknown) => boolean,
    msg?: string,
  ) => {
    try {
      await fn();
      throw new Error(msg || "Expected throw, but nothing was thrown");
    } catch (e: any) {
      if (!predicate(e)) {
        throw new Error(
          msg || `Expected predicate to match thrown error, got: ${e?.message ?? e}`,
        );
      }
    }
  },
};

async function runTests() {
  let passed = 0;
  let failed = 0;

  const tests: { name: string; run: () => void | Promise<void> }[] = [
    {
      name: "AsyncEventQueue — buffered events arrive in FIFO order",
      run: async () => {
        const q = new AsyncEventQueue<string>();
        q.push("a");
        q.push("b");
        q.push("c");
        q.close();

        const out: string[] = [];
        for await (const ev of q) out.push(ev);
        assert.deepEqual(out, ["a", "b", "c"]);
      },
    },
    {
      name: "AsyncEventQueue — events pushed after consumer awaits resolve immediately",
      run: async () => {
        const q = new AsyncEventQueue<string>();
        const nextPromise = q[Symbol.asyncIterator]().next();

        // Push AFTER the consumer is already awaiting. The pending
        // promise must resolve with this event, not buffer it.
        q.push("hello");
        const result = await nextPromise;
        assert.equal(result.value, "hello");
        assert.equal(result.done, false);
      },
    },
    {
      name: "AsyncEventQueue — close() terminates the iterator",
      run: async () => {
        const q = new AsyncEventQueue<string>();
        q.push("x");
        q.close();

        const it = q[Symbol.asyncIterator]();
        const first = await it.next();
        assert.equal(first.value, "x");
        assert.equal(first.done, false);

        const second = await it.next();
        assert.equal(second.done, true);
      },
    },
    {
      name: "AsyncEventQueue — closeWithError(error) rejects the pending next()",
      run: async () => {
        const q = new AsyncEventQueue<string>();
        q.closeWithError(new Error("boom"));

        await assert.throws(
          async () => {
            await q[Symbol.asyncIterator]().next();
          },
          (e) => (e as Error)?.message === "boom",
          "Expected the queue's iterator to reject with the close-error",
        );
      },
    },
    {
      name: "AsyncEventQueue — closeWithError rejects even after a buffered event",
      run: async () => {
        const q = new AsyncEventQueue<string>();
        q.push("first");
        q.closeWithError(new Error("after-first"));

        const it = q[Symbol.asyncIterator]();
        const first = await it.next();
        assert.equal(first.value, "first");

        await assert.throws(
          async () => {
            await it.next();
          },
          (e) => (e as Error)?.message === "after-first",
          "Expected rejection on the second next() after the buffered event",
        );
      },
    },
    {
      name: "AsyncEventQueue — push after close is a no-op",
      run: async () => {
        const q = new AsyncEventQueue<string>();
        q.close();
        q.push("too late"); // must not throw, must not deadlock

        const out: string[] = [];
        for await (const ev of q) out.push(ev);
        assert.deepEqual(out, []);
      },
    },
    {
      name: "AsyncEventQueue — empty closed queue yields nothing",
      run: async () => {
        const q = new AsyncEventQueue<string>();
        q.close();
        const out: string[] = [];
        for await (const ev of q) out.push(ev);
        assert.deepEqual(out, []);
      },
    },
    {
      name: "AsyncEventQueue — interleaved push/consume (streaming pattern)",
      run: async () => {
        const q = new AsyncEventQueue<number>();

        // Producer: push 3 events with micro-task gaps, then close.
        (async () => {
          q.push(1);
          await Promise.resolve();
          q.push(2);
          await Promise.resolve();
          q.push(3);
          q.close();
        })();

        const out: number[] = [];
        for await (const ev of q) out.push(ev);
        assert.deepEqual(out, [1, 2, 3]);
      },
    },
  ];

  for (const t of tests) {
    try {
      await t.run();
      console.log(`✅ ${t.name}`);
      passed++;
    } catch (e: any) {
      console.error(`❌ ${t.name}`);
      console.error(`   ${e?.message ?? e}`);
      failed++;
    }
  }

  console.log(`\nTests completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    throw new Error("Tests failed");
  }
}

void runTests();
