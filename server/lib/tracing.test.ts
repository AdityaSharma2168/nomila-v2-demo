/**
 * Tracing is off unless it is fully configured, and off means untouched.
 *
 * ── WHY THESE ARE THE TESTS ─────────────────────────────────────────────────
 * This ships default-off, which means the disabled path is the one that runs in production
 * on day one and the one nobody would notice being wrong. The risk is not "traces are
 * missing" — it is an observability layer changing behaviour of the thing it observes. So
 * the properties worth pinning are that a disabled tracer returns clients unwrapped, and
 * that a half-configured deploy stays off rather than throwing inside a model call.
 *
 * `tracingEnabled()` reads the environment on every call rather than capturing it at import,
 * which is what makes it testable here at all — and is the same reason the flag can be
 * flipped on a running Cloud Run service without a deploy.
 */

jest.mock("../logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { tracingEnabled, traceUnit, observeAnthropic, traceGeneration, withTraceAthlete } from "./tracing";

const KEYS = ["LANGFUSE_TRACING", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * Sets each variable to exactly what it is given, and DELETES it when given "".
 *
 * The delete matters: an earlier version only assigned truthy values, so a second call in
 * the same test inherited the first call's keys and the missing-key case silently passed
 * with both keys present. The helper has to be able to express absence.
 */
function configure(flag?: string, pk = "pk-lf-test", sk = "sk-lf-test") {
  const set = (name: string, v: string | undefined) => {
    if (v === undefined || v === "") delete process.env[name];
    else process.env[name] = v;
  };
  set("LANGFUSE_TRACING", flag);
  set("LANGFUSE_PUBLIC_KEY", pk);
  set("LANGFUSE_SECRET_KEY", sk);
}

describe("tracingEnabled", () => {
  it("is off when the flag is unset", () => {
    configure(undefined);
    expect(tracingEnabled()).toBe(false);
  });

  it("is off for every value that is not exactly true", () => {
    // A flag that accepts "1" or "yes" is a flag someone turns on by accident.
    for (const v of ["false", "0", "1", "yes", "on", "", " "]) {
      configure(v);
      expect(tracingEnabled()).toBe(false);
    }
  });

  it("is on for 'true', case- and whitespace-insensitively", () => {
    for (const v of ["true", "TRUE", " True "]) {
      configure(v);
      expect(tracingEnabled()).toBe(true);
    }
  });

  it("STAYS OFF when the flag is on but a key is missing", () => {
    // The half-configured deploy: someone flips the env var before the secrets land.
    // Failing closed here means an unconfigured exporter never throws inside a model call,
    // which would turn an observability gap into an outage.
    configure("true", "pk-lf-test", "");
    expect(tracingEnabled()).toBe(false);

    configure("true", "", "sk-lf-test");
    expect(tracingEnabled()).toBe(false);
  });

  it("treats whitespace-only keys as missing", () => {
    configure("true", "   ", "   ");
    expect(tracingEnabled()).toBe(false);
  });
});

describe("the disabled path leaves clients untouched", () => {
  it("returns the same Gemini client object when tracing is off", async () => {
    configure(undefined);
    const { genai } = await import("./models");
    // Identity, not equality: a Proxy would pass a deep-equal check while still
    // intercepting every call. Only `toBe` proves nothing was wrapped.
    expect(genai()).toBe(genai());
  });
});

/**
 * The wrappers must be invisible to the code they wrap — in BOTH modes.
 *
 * This is the real risk of this whole phase. Nobody is harmed by a missing trace; they are
 * harmed by an observability layer that swallows an error, changes a return value, or turns a
 * rejected promise into a resolved one. detectDeal's result decides whether a message is
 * retried or marked processed, so a wrapper that alters it silently loses inbound deals.
 *
 * Both modes are exercised on purpose. Testing only the disabled path would pass trivially —
 * it is a direct call. The enabled path is where a span could actually intercept something,
 * and it runs here without a configured exporter, which is also a useful proof in itself: the
 * spans go nowhere and the code still behaves exactly the same.
 */
describe("the wrappers do not change behaviour", () => {
  for (const mode of ["off", "on"] as const) {
    describe(`tracing ${mode}`, () => {
      beforeEach(() => configure(mode === "on" ? "true" : undefined));

      it("returns exactly what the wrapped function returned", async () => {
        const value = { skipped: false, reason: "ok", dealId: "d1" };
        // Identity, not deep equality — a wrapper that reconstructed the object would pass a
        // toEqual check while breaking callers that compare references.
        await expect(traceUnit("t", {}, async () => value)).resolves.toBe(value);
      });

      it("rethrows the original error object, not a wrapped one", async () => {
        const boom = Object.assign(new Error("provider exploded"), { code: "provider_error" });
        await expect(traceUnit("t", {}, async () => { throw boom; })).rejects.toBe(boom);
      });

      it("does not swallow a falsy or undefined return", async () => {
        // A naive `return result || something` would break these two and nothing else.
        await expect(traceUnit("t", {}, async () => undefined)).resolves.toBeUndefined();
        await expect(traceUnit("t", {}, async () => false)).resolves.toBe(false);
      });

      it("passes generation results and failures through untouched", async () => {
        const out = { assets: [{ url: "https://x/1.png" }], cost: { amountUsd: 0.04 }, model: "m" };
        const args = { task: "image.generate", provider: "openrouter", model: "m" };
        await expect(traceGeneration(args, async () => out)).resolves.toBe(out);

        const err = new Error("timed out");
        await expect(traceGeneration(args, async () => { throw err; })).rejects.toBe(err);
      });
    });
  }

  it("leaves an Anthropic client untouched when tracing is off", () => {
    configure(undefined);
    const client = { messages: { create: async () => ({}) } };
    expect(observeAnthropic(client)).toBe(client);
  });

  it("hands back the SAME wrapper for a client it has already wrapped", () => {
    configure("true");
    const client = { messages: { create: async () => ({}) } };
    // The Narrator re-enters its accessor once per bake-off option; a fresh Proxy per call
    // would be waste. Two different clients must still get two different wrappers.
    expect(observeAnthropic(client)).toBe(observeAnthropic(client));
    expect(observeAnthropic({ messages: { create: async () => ({}) } })).not.toBe(observeAnthropic(client));
  });

  it("forwards non-create properties on a wrapped Anthropic client", () => {
    configure("true");
    const client = { messages: { create: async () => ({}), countTokens: () => 7 }, apiKey: "k" } as any;
    const traced = observeAnthropic(client);
    // The Proxy intercepts one method. Everything else must fall through, or an unrelated
    // caller breaks the moment tracing is switched on in production.
    expect(traced.messages.countTokens()).toBe(7);
    expect(traced.apiKey).toBe("k");
  });
});

describe("withTraceAthlete — traces are findable per athlete", () => {
  it("runs fn directly when tracing is off or no athlete is known", () => {
    expect(withTraceAthlete("a1", () => 5)).toBe(5);
    configure("true");
    expect(withTraceAthlete(null, () => 6)).toBe(6);
  });

  it("tags the context with userId = the athlete id when tracing is on, and runs fn once", () => {
    configure("true");
    const propagateAttributes = jest.fn((_p: unknown, f: () => unknown) => f());
    jest.isolateModules(() => {
      jest.doMock("@langfuse/tracing", () => ({ propagateAttributes }));
      const { withTraceAthlete: isolated } = require("./tracing");
      const fn = jest.fn(() => "ok");
      expect(isolated("athlete-1", fn)).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });
    expect(propagateAttributes).toHaveBeenCalledWith({ userId: "athlete-1", metadata: { athlete_id: "athlete-1" } }, expect.any(Function));
    jest.dontMock("@langfuse/tracing");
  });

  it("does not run fn twice when fn itself throws inside the tagged context", () => {
    configure("true");
    const boom = new Error("handler failed");
    jest.isolateModules(() => {
      jest.doMock("@langfuse/tracing", () => ({ propagateAttributes: (_p: unknown, f: () => unknown) => f() }));
      const { withTraceAthlete: isolated } = require("./tracing");
      const fn = jest.fn(() => { throw boom; });
      expect(() => isolated("athlete-1", fn)).toThrow(boom);
      expect(fn).toHaveBeenCalledTimes(1);
    });
    jest.dontMock("@langfuse/tracing");
  });
});
