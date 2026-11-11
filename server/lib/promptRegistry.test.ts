/**
 * The registry's job is to change a prompt at runtime. Its more important job is to be
 * incapable of removing one.
 *
 * ── WHAT THESE PIN ──────────────────────────────────────────────────────────
 * Every test here is about a failure path, because the happy path — a published row is
 * returned — is the one anybody would notice breaking. What nobody would notice is the
 * registry quietly resolving to an empty string, or a database outage turning into an outage
 * in the model call, or a money prompt becoming swappable because a row said so.
 *
 * The locked-prompt tests are the ones to keep if the rest are ever thrown away. The
 * classifier decides whether a message is a deal; the scorer sets the number an athlete
 * negotiates against. Neither may be editable without a reviewed pull request, and that has
 * to hold when the table is unreachable, when a row claims otherwise, and when an environment
 * variable tries to override it.
 */

const execute = jest.fn();
jest.mock("../db", () => ({ db: { execute } }));
jest.mock("../logger", () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { resolvePrompt, clearPromptCache, envVarFor, LOCKED_PROMPTS, registryEnabled } from "./promptRegistry";

const IN_CODE = "the reviewed constant from the repository";
const ENV_KEYS: string[] = ["LANGFUSE_TRACING"];

function setEnv(name: string, value?: string) {
  ENV_KEYS.push(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  execute.mockReset();
  clearPromptCache();
  setEnv("PROMPT_REGISTRY", "true");
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  ENV_KEYS.length = 0;
});

/** Drizzle's execute returns a shape with `.rows` on node-postgres; tolerate both. */
const dbReturns = (body?: string) => execute.mockResolvedValue({ rows: body ? [{ body }] : [] });

describe("resolution order", () => {
  it("prefers the published row", async () => {
    dbReturns("from the table");
    setEnv("PROMPT_TEST_KEY", "from the environment");
    expect(await resolvePrompt("test.key", IN_CODE)).toBe("from the table");
  });

  it("falls back to the environment when no row is published", async () => {
    dbReturns(undefined);
    setEnv("PROMPT_TEST_KEY", "from the environment");
    expect(await resolvePrompt("test.key", IN_CODE)).toBe("from the environment");
  });

  it("falls back to the in-code constant when there is neither", async () => {
    dbReturns(undefined);
    expect(await resolvePrompt("test.key", IN_CODE)).toBe(IN_CODE);
  });

  it("never returns an empty or whitespace-only prompt", async () => {
    // The failure this exists to prevent: a blank row silently strips a model's instructions,
    // which does not error — it just produces confidently wrong output.
    dbReturns("   ");
    expect(await resolvePrompt("test.key", IN_CODE)).toBe(IN_CODE);
  });

  it("maps a dotted key to a SHOUTING env var", () => {
    expect(envVarFor("classify.system")).toBe("PROMPT_CLASSIFY_SYSTEM");
    expect(envVarFor("contract.extract.system")).toBe("PROMPT_CONTRACT_EXTRACT_SYSTEM");
  });
});

describe("locked prompts cannot be swapped at runtime", () => {
  it.each([...LOCKED_PROMPTS])("%s ignores a published row", async (key) => {
    dbReturns("an attacker's or an accident's prompt");
    expect(await resolvePrompt(key, IN_CODE)).toBe(IN_CODE);
  });

  it("ignores an environment override too", async () => {
    setEnv("PROMPT_CLASSIFY_SYSTEM", "from the environment");
    expect(await resolvePrompt("classify.system", IN_CODE)).toBe(IN_CODE);
  });

  it("does not even query the database", async () => {
    // Not an optimisation — the point is that lockedness is decided by code BEFORE the table
    // is consulted, so an unreachable or edited row can never make a money prompt swappable.
    await resolvePrompt("score.system", IN_CODE);
    expect(execute).not.toHaveBeenCalled();
  });

  it("covers the three money-and-compliance prompts", () => {
    // A guard on the set itself: dropping a key here silently makes that prompt live-editable,
    // which is exactly the kind of change that should have to be argued for in review.
    expect([...LOCKED_PROMPTS].sort()).toEqual(
      ["classify.system", "contract.extract.system", "score.system"],
    );
  });
});

describe("failure is never louder than the thing it interrupts", () => {
  it("returns the fallback when the database throws", async () => {
    execute.mockRejectedValue(new Error("connection terminated"));
    await expect(resolvePrompt("test.key", IN_CODE)).resolves.toBe(IN_CODE);
  });

  it("does not query once per call while the database is down", async () => {
    // A registry outage must not add a failing query to every model call on top of whatever
    // else is already wrong.
    execute.mockRejectedValue(new Error("connection terminated"));
    await resolvePrompt("test.key", IN_CODE);
    await resolvePrompt("test.key", IN_CODE);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("is inert until PROMPT_REGISTRY is on", async () => {
    setEnv("PROMPT_REGISTRY", undefined);
    expect(registryEnabled()).toBe(false);
    expect(await resolvePrompt("test.key", IN_CODE)).toBe(IN_CODE);
    expect(execute).not.toHaveBeenCalled();
  });

  it("still honours an env override while disabled, so the incident lever works", async () => {
    // The environment layer exists for the case where the registry itself is the problem.
    setEnv("PROMPT_REGISTRY", undefined);
    setEnv("PROMPT_TEST_KEY", "from the environment");
    expect(await resolvePrompt("test.key", IN_CODE)).toBe("from the environment");
  });
});

describe("caching", () => {
  it("reuses a resolved prompt instead of querying per call", async () => {
    dbReturns("from the table");
    await resolvePrompt("test.key", IN_CODE);
    await resolvePrompt("test.key", IN_CODE);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the cache is cleared", async () => {
    dbReturns("from the table");
    await resolvePrompt("test.key", IN_CODE);
    clearPromptCache();
    await resolvePrompt("test.key", IN_CODE);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

/**
 * Which prompt produced a run has to be recorded, or "I changed it and the metric moved" is a
 * correlation nobody can check afterwards. The trace shows the prompt TEXT already; what it
 * cannot show without this is whether that text came from a published row, an incident
 * override, or the repository — and at which version.
 */
describe("stamping the resolved prompt onto the trace", () => {
  const updateActiveObservation = jest.fn();
  beforeAll(() => {
    jest.doMock("@langfuse/tracing", () => ({ updateActiveObservation }));
  });
  beforeEach(() => {
    updateActiveObservation.mockReset();
    setEnv("LANGFUSE_TRACING", "true");
  });

  const stamped = () => updateActiveObservation.mock.calls[0]?.[0]?.metadata ?? {};

  it("records version and hash when the text came from the table", async () => {
    execute.mockResolvedValue({ rows: [{ body: "published text", version: 7, hash: "abc123def456" }] });
    await resolvePrompt("test.key", IN_CODE);
    expect(stamped()["prompt.test.key"]).toEqual({ source: "db", version: 7, hash: "abc123def456" });
  });

  it("distinguishes a locked prompt from an unpublished one", async () => {
    // "locked" and "code" both mean the constant ran, but only one of them means publishing
    // was REFUSED. Auditing a money decision needs to tell those apart.
    await resolvePrompt("classify.system", IN_CODE);
    expect(stamped()["prompt.classify.system"]).toMatchObject({ source: "locked" });

    updateActiveObservation.mockReset();
    dbReturns(undefined);
    await resolvePrompt("test.key", IN_CODE);
    expect(stamped()["prompt.test.key"]).toMatchObject({ source: "code" });
  });

  it("records an environment override as such", async () => {
    // The incident lever. If someone overrode a prompt at 3am, the trace should say so rather
    // than implying the repository's constant was running.
    dbReturns(undefined);
    setEnv("PROMPT_TEST_KEY", "from the environment");
    await resolvePrompt("test.key", IN_CODE);
    expect(stamped()["prompt.test.key"]).toMatchObject({ source: "env" });
  });

  it("stamps on a cache hit as well as on a read", async () => {
    // Otherwise only the first run each minute is attributed, which defeats the purpose.
    execute.mockResolvedValue({ rows: [{ body: "published text", version: 7, hash: "abc123def456" }] });
    await resolvePrompt("test.key", IN_CODE);
    updateActiveObservation.mockReset();
    await resolvePrompt("test.key", IN_CODE);
    expect(execute).toHaveBeenCalledTimes(1);                 // served from cache
    expect(stamped()["prompt.test.key"]).toMatchObject({ source: "db", version: 7 });
  });

  it("still returns the prompt when stamping throws", async () => {
    // Decoration on a trace must never become a failure to answer.
    updateActiveObservation.mockImplementation(() => { throw new Error("no active span"); });
    dbReturns(undefined);
    await expect(resolvePrompt("test.key", IN_CODE)).resolves.toBe(IN_CODE);
  });

  it("does not stamp when tracing is off", async () => {
    setEnv("LANGFUSE_TRACING", undefined);
    dbReturns(undefined);
    await resolvePrompt("test.key", IN_CODE);
    expect(updateActiveObservation).not.toHaveBeenCalled();
  });
});
