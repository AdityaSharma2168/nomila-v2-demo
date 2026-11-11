/**
 * webSearchLimiter.test.ts — the per-athlete grounding rate limit (spike).
 *
 * Deterministic via an injected clock: allow up to `max` per window then block ·
 * per-athlete isolation · the window slides · record() consumes, allow() peeks.
 */

import { createWebSearchLimiter } from "./webSearchLimiter";

describe("createWebSearchLimiter", () => {
  it("allows up to max grounded calls, then blocks within the window", () => {
    let t = 1000;
    const lim = createWebSearchLimiter({
      max: 2,
      windowMs: 1000,
      now: () => t,
    });

    expect(lim.allow("a")).toBe(true);
    lim.record("a");
    expect(lim.allow("a")).toBe(true);
    lim.record("a");
    // Two in the window → the third is blocked.
    expect(lim.allow("a")).toBe(false);
  });

  it("keys the budget per athlete — one athlete's calls don't limit another", () => {
    let t = 1000;
    const lim = createWebSearchLimiter({
      max: 1,
      windowMs: 1000,
      now: () => t,
    });

    lim.record("a");
    expect(lim.allow("a")).toBe(false); // a is spent
    expect(lim.allow("b")).toBe(true); // b is independent
  });

  it("slides: budget frees up once the window passes", () => {
    let t = 1000;
    const lim = createWebSearchLimiter({
      max: 1,
      windowMs: 1000,
      now: () => t,
    });

    lim.record("a");
    expect(lim.allow("a")).toBe(false);
    // Advance past the window → the old hit ages out.
    t += 1001;
    expect(lim.allow("a")).toBe(true);
  });

  it("allow() is a pure peek — it never consumes", () => {
    let t = 1000;
    const lim = createWebSearchLimiter({
      max: 1,
      windowMs: 1000,
      now: () => t,
    });

    // Peeking many times must not exhaust the single slot.
    expect(lim.allow("a")).toBe(true);
    expect(lim.allow("a")).toBe(true);
    expect(lim.allow("a")).toBe(true);
    // Only a record consumes it.
    lim.record("a");
    expect(lim.allow("a")).toBe(false);
  });
});
