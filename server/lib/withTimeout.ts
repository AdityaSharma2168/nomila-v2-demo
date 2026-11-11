/**
 * withTimeout — reject if a promise doesn't settle within `ms`.
 *
 * Used to bound external model calls (Vertex/Kimi) so a hung request can't hold its
 * DB connection + batch slot indefinitely. Fail-fast matters: at the deal pipeline's
 * concurrency a hung call that lingers for a full minute can exhaust the pool
 * (max 20) before it times out — so the deal-path default is deliberately short (30s).
 *
 * NOTE: the loser of the race keeps running to completion in the background — this
 * unblocks the caller, it does not cancel the underlying request. Good enough to stop
 * a cascade; true cancellation would need an AbortSignal on the SDK call.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "call"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
