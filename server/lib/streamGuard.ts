/**
 * guardStream — wrap an async iterable (e.g. a Vertex/Kimi chat stream) so a
 * stalled or runaway model stream can't hang a request forever.
 *
 * Two independent budgets:
 *   - idleMs:  max gap between chunks, reset on every chunk. Catches a stream
 *              that connects then stalls mid-iteration — `kimiStream` itself has
 *              no timeout (unlike kimiInstant/kimiThinking via withTimeout), so a
 *              Vertex stall would otherwise block `for await` indefinitely.
 *   - totalMs: absolute ceiling on the whole stream. Catches a stream that
 *              dribbles chunks forever.
 *
 * On expiry it calls `onTimeout` (wire this to an AbortController.abort() so the
 * underlying SDK request is actually cancelled, not merely abandoned — the loser
 * of a Promise.race keeps running otherwise) and throws, so the caller's existing
 * catch / `{ error }` SSE path fires.
 */
export class StreamTimeoutError extends Error {
  constructor(public readonly kind: "idle" | "total", ms: number) {
    super(`stream timed out (${kind}, ${ms}ms)`);
    this.name = "StreamTimeoutError";
  }
}

export interface GuardStreamOptions {
  idleMs: number;
  totalMs: number;
  onTimeout?: (kind: "idle" | "total") => void;
}

export async function* guardStream<T>(
  stream: AsyncIterable<T>,
  opts: GuardStreamOptions,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const totalDeadline = Date.now() + opts.totalMs;

  try {
    while (true) {
      // Hard total-budget check up front so a steady stream that never idles
      // still terminates deterministically once the absolute ceiling passes.
      if (Date.now() >= totalDeadline) {
        opts.onTimeout?.("total");
        throw new StreamTimeoutError("total", opts.totalMs);
      }

      const idleDeadline = Date.now() + opts.idleMs;
      const kind: "idle" | "total" = idleDeadline <= totalDeadline ? "idle" : "total";
      const wait = Math.max(0, Math.min(idleDeadline, totalDeadline) - Date.now());

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new StreamTimeoutError(kind, kind === "idle" ? opts.idleMs : opts.totalMs)),
          wait,
        );
      });

      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), timeout]);
      } catch (err) {
        if (err instanceof StreamTimeoutError) opts.onTimeout?.(err.kind);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Best-effort source teardown. For SDK streams the primary cancellation path
    // is onTimeout -> controller.abort(); this covers plain iterables (tests).
    try {
      await iterator.return?.();
    } catch {
      /* ignore teardown errors */
    }
  }
}
