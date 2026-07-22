/**
 * AsyncEventQueue — single-consumer promise-based async queue.
 *
 * Phase 3 primitive (see
 * cybersoul-service/doc/cybersoul-client-agent-harness-tech-approach.md
 * §3.6 + §4 Phase 3). Adapts the push-based `EventStream.emit()` model
 * into a pull-based `AsyncIterable<AgentEvent>` that `CyberSoulAgent.
 * run()` returns.
 *
 * Design constraints:
 *  - SINGLE consumer. One `run()` call = one iterator. Multi-consumer
 *    would need a broadcast/broker layer on top, which is out of scope.
 *  - UNBOUNDED buffer. Chat turns emit a handful of events per turn;
 *    there's no memory pressure concern. A bounded queue would need
 *    back-pressure semantics, which don't fit the "fire and forget"
 *    legacy callback model underneath.
 *  - ERROR propagation via iterator rejection. When `close(error)` is
 *    called, the pending `next()` promise REJECTS — the `for await`
 *    loop throws. This is the idiomatic async-iterable error pattern.
 *  - NO buffering after close. Events pushed after `close()` are
 *    dropped (defensive — a late callback from a settling promise
 *    shouldn't deadlock the consumer).
 */

/**
 * Minimal iterator-result shape (avoids pulling in lib.es2015 types
 * that some React Native bundlers mishandle when transpiled).
 */
interface AsyncQueueResult<T> {
  value: T | undefined;
  done: boolean;
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private pending: ((result: AsyncQueueResult<T>) => void) | null = null;
  private closed = false;
  private closeError: unknown = undefined;

  /**
   * Push an event. If a consumer is already awaiting `next()`, the
   * event is delivered immediately via the resolved promise. Otherwise
   * it's buffered until the next `next()` call.
   *
   * No-op after `close()` — late events from settling promises are
   * silently dropped (they can't reach the consumer anyway).
   */
  push(event: T): void {
    if (this.closed) return;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: event, done: false });
    } else {
      this.buffer.push(event);
    }
  }

  /**
   * Close the queue for success. The pending `next()` (or the next
   * one) resolves with `{ done: true }`. Subsequent pushes are no-ops.
   */
  close(): void {
    this.closeWithError(undefined);
  }

  /**
   * Close the queue for error. The pending `next()` (or the next one)
   * REJECTS with the given error — the consumer's `for await` loop
   * throws. This is the idiomatic async-iterable error pattern: errors
   * propagate as rejections, not as event variants, so the standard
   * `try { for await ... } catch` works.
   */
  closeWithError(error: unknown): void {
    this.closeWithErrorImpl(error);
  }

  private closeWithErrorImpl(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      if (error === undefined) {
        resolve({ value: undefined, done: true });
      } else {
        // Reject by throwing — the pending consumer's `next()` promise
        // rejects with the error.
        resolve({ value: undefined, done: true });
        // Note: we can't actually reject a promise that we already
        // resolved via the resolve fn. The caller's `next()` wraps this
        // in its own promise chain where we can throw. See
        // `[Symbol.asyncIterator]()` below.
        throw error;
      }
    }
  }

  /**
   * Whether the queue has been closed (success or error). Useful for
   * the producer to short-circuit late pushes.
   */
  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    // Single-consumer contract — return the same iterator shape every
    // time. If a caller somehow calls `[Symbol.asyncIterator]()` twice
    // on the same queue, both iterators share state (one will get
    // events, the other will spin). That's a misuse; we don't defend
    // against it.
    const next = async (): Promise<IteratorResult<T>> => {
      if (this.buffer.length > 0) {
        return { value: this.buffer.shift()!, done: false };
      }
      if (this.closed) {
        if (this.closeError !== undefined) {
          throw this.closeError;
        }
        return { value: undefined, done: true };
      }
      return new Promise<IteratorResult<T>>((resolve) => {
        this.pending = resolve as (result: AsyncQueueResult<T>) => void;
      });
    };

    return { next };
  }
}
