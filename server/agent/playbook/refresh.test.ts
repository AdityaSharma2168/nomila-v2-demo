/**
 * refresh.test.ts — one playbook key's refresh, against a real (PGlite) Postgres with a faked model transport (no
 * provider is ever reached).
 *
 *   - a valid answer writes a draft and activates it in one call; re-running with the same answer is idempotent
 *     (dedupe and versioning: no second active row, the same version comes back)
 *   - a date leak DROPS the one hook/format line that has it (unless it leaves none) — never fails the whole key
 *     for an ordinary word ("may", "march") or a non-year number ("2000 characters")
 *   - a source is kept only when it is an EXACT page this run's own searches returned (factor === 1); an empty
 *     search-result list keeps NO sources at all, whatever the model named
 *   - a FAILED key (bad JSON, a model error, nothing left after dropping dated lines) leaves the old active row
 *     untouched, AND records a failure marker (store.ts recordPlaybookFailure) for triggers.ts's backoff
 *   - the call carries the existing playbook (when one is active) so a refresh can carry its identity forward
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { fakeResponses, skillOf, type FakeTransport } from "../../testUtils/agentModel";
import { setResponsesTransport } from "../research/llm";
import type { PlaybookKey } from "../../../shared/playbook";
import { getActivePlaybook, getLatestPlaybookRow } from "./store";
import { refreshPlaybookKey, validatePlaybookOutput } from "./refresh";

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { setResponsesTransport(null); await closeTestDb(); });

const key: PlaybookKey = { sport: "rowing", stage: "developing", platform: "instagram" };
const SEEN = [{ url: "https://example.org/playbook-guidance", title: "Platform guidance" }];

const goodJson = {
  formats: [{ name: "a short vertical video", post_format: "reel", when_to_use: "the default for this platform" }],
  hooks: ["ask a question the viewer already has an opinion on", "show the result before the setup"],
  ideal_length_sec: { min: 8, max: 25 },
  cadence: { posts_per_week: { min: 2, max: 4 } },
  cross_platform_reuse: [{ from: "a short vertical video", to: "a feed photo", rule: "keep the same first frame" }],
  sources: [{ url: "https://example.org/playbook-guidance", title: "Platform guidance" }],
  path_note: "p",
};

function serve(json: unknown, sources: Array<{ url: string; title?: string }> = SEEN): FakeTransport {
  return fakeResponses((body) => {
    if (skillOf(body) !== "playbook") throw new Error(`unexpected skill ${skillOf(body)}`);
    return { json, sources };
  });
}

describe("validatePlaybookOutput", () => {
  const now = new Date("2026-10-11T00:00:00Z");
  it("accepts a well-formed answer, stamps refreshedAt, and keeps a source the search actually returned", () => {
    const out = validatePlaybookOutput(goodJson, now, SEEN);
    expect(out).toMatchObject({ config: { idealLengthSec: { min: 8, max: 25 }, cadence: { postsPerWeek: { min: 2, max: 4 } }, refreshedAt: "2026-10-11" }, pathNote: "p" });
    expect(out?.config.formats).toEqual([{ name: "a short vertical video", postFormat: "reel", whenToUse: "the default for this platform" }]);
    expect(out?.config.hooks).toHaveLength(2);
    expect(out?.config.sources).toEqual([{ url: "https://example.org/playbook-guidance", title: "Platform guidance" }]);
  });

  it("post_format is bounded: an unknown or missing value is coerced to 'other', never rejected", () => {
    const withUnknown = { ...goodJson, formats: [{ ...goodJson.formats[0], post_format: "tiktok-dance" }] };
    expect(validatePlaybookOutput(withUnknown, now, SEEN)?.config.formats[0].postFormat).toBe("other");
    const withMissing = { ...goodJson, formats: [{ name: "a carousel", when_to_use: "for a multi-shot story" }] };
    expect(validatePlaybookOutput(withMissing, now, SEEN)?.config.formats[0].postFormat).toBe("other");
    const withKnown = { ...goodJson, formats: [{ ...goodJson.formats[0], post_format: "carousel" }] };
    expect(validatePlaybookOutput(withKnown, now, SEEN)?.config.formats[0].postFormat).toBe("carousel");
  });

  it("rejects no formats, no hooks, a backwards length range, a backwards cadence range, or a non-finite number", () => {
    expect(validatePlaybookOutput({ ...goodJson, formats: [] }, now, SEEN)).toBeNull();
    expect(validatePlaybookOutput({ ...goodJson, hooks: [] }, now, SEEN)).toBeNull();
    expect(validatePlaybookOutput({ ...goodJson, ideal_length_sec: { min: 30, max: 10 } }, now, SEEN)).toBeNull();
    expect(validatePlaybookOutput({ ...goodJson, cadence: { posts_per_week: { min: 5, max: 1 } } }, now, SEEN)).toBeNull();
    expect(validatePlaybookOutput({ ...goodJson, ideal_length_sec: { min: "a", max: 10 } }, now, SEEN)).toBeNull();
    expect(validatePlaybookOutput({}, now, SEEN)).toBeNull();
  });

  it("bounds: length over 600s, or cadence at 0 or over 21/week, is rejected", () => {
    expect(validatePlaybookOutput({ ...goodJson, ideal_length_sec: { min: 8, max: 601 } }, now, SEEN)).toBeNull();
    expect(validatePlaybookOutput({ ...goodJson, ideal_length_sec: { min: 8, max: 600 } }, now, SEEN)).not.toBeNull();   // 600 itself is fine
    expect(validatePlaybookOutput({ ...goodJson, cadence: { posts_per_week: { min: 0, max: 4 } } }, now, SEEN)).toBeNull();
    expect(validatePlaybookOutput({ ...goodJson, cadence: { posts_per_week: { min: 2, max: 22 } } }, now, SEEN)).toBeNull();
    expect(validatePlaybookOutput({ ...goodJson, cadence: { posts_per_week: { min: 2, max: 21 } } }, now, SEEN)).not.toBeNull();   // 21 itself is fine
  });

  it("playbook 1.2.0: the format mix and the stories range are kept when they pass, left out (never failing the key) when not", () => {
    const cadence = (over: Record<string, unknown>) => ({ ...goodJson, cadence: { posts_per_week: { min: 2, max: 4 }, ...over } });
    expect(validatePlaybookOutput(cadence({ format_mix: { reel: 2, carousel: 1, feed: 0 }, stories_per_week: { min: 3, max: 7 } }), now, SEEN)?.config.cadence)
      .toEqual({ postsPerWeek: { min: 2, max: 4 }, formatMix: { reel: 2, carousel: 1, feed: 0 }, storiesPerWeek: { min: 3, max: 7 } });
    // A mix over the range's max, a fraction, all zeros; a backwards or too-large stories range: left out, the key kept.
    for (const bad of [{ reel: 4, carousel: 1, feed: 0 }, { reel: 1.5, carousel: 1, feed: 0 }, { reel: 0, carousel: 0, feed: 0 }]) {
      expect(validatePlaybookOutput(cadence({ format_mix: bad, stories_per_week: { min: 0, max: 0 } }), now, SEEN)?.config.cadence).toEqual({ postsPerWeek: { min: 2, max: 4 }, storiesPerWeek: { min: 0, max: 0 } });
    }
    for (const bad of [{ min: 5, max: 2 }, { min: 0, max: 36 }]) {
      expect(validatePlaybookOutput(cadence({ format_mix: { reel: 1, carousel: 1, feed: 1 }, stories_per_week: bad }), now, SEEN)?.config.cadence).toEqual({ postsPerWeek: { min: 2, max: 4 }, formatMix: { reel: 1, carousel: 1, feed: 1 } });
    }
  });

  describe("the no-date rule (review fix, round 2: drop the line, never the whole key for an ordinary word)", () => {
    it("ordinary words that happen to spell a month are NOT a date leak: 'may', 'march', 'august', lowercase, with no adjoining number", () => {
      const out = validatePlaybookOutput({ ...goodJson, hooks: ["You may want to post today", "She likes to march in step with the season"] }, now, SEEN);
      expect(out?.config.hooks).toEqual(["You may want to post today", "She likes to march in step with the season"]);
    });

    it("a plain count is NOT a date leak: 'under 2000 characters' is a length, not a year", () => {
      const out = validatePlaybookOutput({ ...goodJson, hooks: ["Keep the caption under 2000 characters", goodJson.hooks[0]] }, now, SEEN);
      expect(out?.config.hooks).toContain("Keep the caption under 2000 characters");
    });

    it("a capitalised month next to a day or a year IS a date leak and is DROPPED, not kept — but a surviving hook keeps the key valid", () => {
      const out = validatePlaybookOutput({ ...goodJson, hooks: ["Post around the trend from March 2026", "a hook that lands on its own"] }, now, SEEN);
      expect(out?.config.hooks).toEqual(["a hook that lands on its own"]);
    });

    it("'May 12' and '12 March' are both caught (month-before-number and number-before-month)", () => {
      const a = validatePlaybookOutput({ ...goodJson, hooks: ["Lead with May 12", "a hook that lands on its own"] }, now, SEEN);
      expect(a?.config.hooks).toEqual(["a hook that lands on its own"]);
      const b = validatePlaybookOutput({ ...goodJson, hooks: ["Lead with 12 March", "a hook that lands on its own"] }, now, SEEN);
      expect(b?.config.hooks).toEqual(["a hook that lands on its own"]);
    });

    it("a format whose name or when_to_use leaks a date is dropped as a whole item, not trimmed mid-sentence", () => {
      const out = validatePlaybookOutput({
        ...goodJson,
        formats: [{ name: "a December 2026 recap reel", post_format: "reel", when_to_use: "once a year" }, goodJson.formats[0]],
      }, now, SEEN);
      expect(out?.config.formats).toEqual([{ name: "a short vertical video", postFormat: "reel", whenToUse: "the default for this platform" }]);
    });

    it("the key FAILS only when dropping the dated lines leaves NO formats or NO hooks at all", () => {
      expect(validatePlaybookOutput({ ...goodJson, hooks: ["Lean into the September 2026 rivalry week"] }, now, SEEN)).toBeNull();
      expect(validatePlaybookOutput({ ...goodJson, formats: [{ name: "a December 2026 recap reel", post_format: "reel", when_to_use: "once a year" }] }, now, SEEN)).toBeNull();
    });
  });

  describe("sources: only an EXACT page this run actually saw (factor === 1)", () => {
    it("drops a source the search did not actually see at all, rather than trusting the model's own URL", () => {
      const elsewhere = [{ url: "https://other-domain.example/unrelated", title: "Not what was searched" }];
      const out = validatePlaybookOutput(goodJson, now, elsewhere);
      expect(out?.config.sources).toEqual([]);   // dropped, not kept — but the key is still valid (sources may be empty)
    });

    it("drops a SAME-HOST-but-different-page match (factor 0.8) — good enough for a dated fact (moments), not here", () => {
      const sameHostDifferentPage = [{ url: "https://example.org/some-other-page", title: "Different page, same site" }];
      const out = validatePlaybookOutput(goodJson, now, sameHostDifferentPage);
      expect(out?.config.sources).toEqual([]);
    });

    it("drops a source with no usable URL, and keeps an EXACT verified one, rather than failing the whole key", () => {
      const out = validatePlaybookOutput({ ...goodJson, sources: [{ url: "not-a-url", title: "x" }, { url: "https://example.org/playbook-guidance", title: "ok" }] }, now, SEEN);
      expect(out?.config.sources).toEqual([{ url: "https://example.org/playbook-guidance", title: "ok" }]);
    });

    it("no sources at all is still a VALID output (flagged elsewhere, never rejected here)", () => {
      expect(validatePlaybookOutput({ ...goodJson, sources: [] }, now, SEEN)?.config.sources).toEqual([]);
    });

    it("an EMPTY seen list (the model made no searches) keeps NO sources, whatever the model named — review fix, round 2", () => {
      expect(validatePlaybookOutput(goodJson, now, [])?.config.sources).toEqual([]);
    });
  });
});

test("a valid refresh writes a draft and activates it", async () => {
  setResponsesTransport(serve(goodJson));
  const outcome = await refreshPlaybookKey(key, { athleteCount: 3, now: new Date("2026-10-11T00:00:00Z") });
  expect(outcome.status).toBe("activated");
  const row = await getActivePlaybook(key);
  expect(row).not.toBeNull();
  expect(row!.status).toBe("active");
  expect((row!.config as any).cadence.postsPerWeek).toEqual({ min: 2, max: 4 });
  expect(row!.note).toBe("p");   // path_note is stored on the row
});

test("dedupe and versioning: re-running with the same answer is idempotent — no second active row", async () => {
  const before = await getActivePlaybook(key);
  const outcome = await refreshPlaybookKey(key, { athleteCount: 3, now: new Date("2026-10-11T00:00:00Z") });
  expect(outcome).toMatchObject({ status: "activated", created: false });
  const after = await getActivePlaybook(key);
  expect(after!.id).toBe(before!.id);
  expect(after!.version).toBe(before!.version);
});

test("a failed key (invalid output) leaves the old active row untouched and records a failure marker", async () => {
  const before = await getActivePlaybook(key);
  setResponsesTransport(serve({ ...goodJson, hooks: [] }));
  const outcome = await refreshPlaybookKey(key, { athleteCount: 3, now: new Date("2026-11-01T00:00:00Z") });
  expect(outcome).toMatchObject({ status: "failed", reason: "invalid_output" });
  const after = await getActivePlaybook(key);
  expect(after).toEqual(before);
  const latest = await getLatestPlaybookRow(key);
  expect(latest!.status).toBe("draft");
  expect(latest!.note).toBe("failed: invalid_output");
});

test("a failed key (every hook/format leaks a date, so none survive) also leaves the old active row untouched", async () => {
  const before = await getActivePlaybook(key);
  setResponsesTransport(serve({ ...goodJson, hooks: ["Lean into the September 2026 rivalry week"] }));
  const outcome = await refreshPlaybookKey(key, { athleteCount: 3, now: new Date("2026-11-01T12:00:00Z") });
  expect(outcome).toMatchObject({ status: "failed", reason: "invalid_output" });
  expect(await getActivePlaybook(key)).toEqual(before);
});

test("a failed key (the model call throws) also leaves the old active row untouched and records the failure", async () => {
  const before = await getActivePlaybook(key);
  setResponsesTransport({
    async create() { throw new Error("network exploded"); },
  } as any);
  const outcome = await refreshPlaybookKey(key, { athleteCount: 3, now: new Date("2026-11-02T00:00:00Z") });
  expect(outcome).toMatchObject({ status: "failed", reason: "error" });
  const after = await getActivePlaybook(key);
  expect(after).toEqual(before);
  const latest = await getLatestPlaybookRow(key);
  expect(latest!.note).toBe("failed: error");
});

test("when the model made no searches at all (empty seen), the refresh keeps NO sources even though the model named one", async () => {
  setResponsesTransport(serve(goodJson, []));
  const freshKey: PlaybookKey = { sport: "fencing", stage: "early", platform: "x" };
  const outcome = await refreshPlaybookKey(freshKey, { athleteCount: 1, now: new Date("2026-10-11T00:00:00Z") });
  expect(outcome.status).toBe("activated");
  const row = await getActivePlaybook(freshKey);
  expect((row!.config as any).sources).toEqual([]);
});

test("a valid answer whose source was never actually seen (non-empty but unrelated search results) is still activated with an empty sources list", async () => {
  setResponsesTransport(serve(goodJson, [{ url: "https://other-domain.example/unrelated", title: "Not what was searched" }]));
  const freshKey: PlaybookKey = { sport: "fencing", stage: "developing", platform: "x" };
  const outcome = await refreshPlaybookKey(freshKey, { athleteCount: 1, now: new Date("2026-10-11T00:00:00Z") });
  expect(outcome.status).toBe("activated");
  const row = await getActivePlaybook(freshKey);
  expect((row!.config as any).sources).toEqual([]);
});

test("a key with no active row yet is refreshed with no existing playbook in the call", async () => {
  const freshKey: PlaybookKey = { sport: "fencing", stage: "elite", platform: "youtube" };
  const transport = serve(goodJson);
  setResponsesTransport(transport);
  const outcome = await refreshPlaybookKey(freshKey, { athleteCount: 1, now: new Date("2026-10-11T00:00:00Z") });
  expect(outcome.status).toBe("activated");
  expect(String(transport.calls[0].input)).toMatch(/\(none yet — this is the first refresh for this key\)/);
});

test("a key that already has an active row is refreshed WITH the existing playbook carried into the call", async () => {
  const transport = serve(goodJson);
  setResponsesTransport(transport);
  await refreshPlaybookKey(key, { athleteCount: 3, now: new Date("2026-12-01T00:00:00Z") });
  const existingCall = transport.calls.find((c) => String(c.input).includes("rowing"));
  expect(String(existingCall!.input)).not.toMatch(/\(none yet/);
  expect(JSON.parse(/EXISTING PLAYBOOK ON FILE\n(\{.*\})/.exec(String(existingCall!.input))![1]).cadence.postsPerWeek).toEqual({ min: 2, max: 4 });
});
