/**
 * marketabilityBeta1Snapshot.test.ts — the two properties the snapshot exists to guarantee.
 *
 *   1. The trigger never reaches the evaluator. An orchestration fact is not evidence: if it did, an athlete who had
 *      just connected an account would score differently from an identical athlete who had not, which is the bonus
 *      ADR-002 forbids arriving by a side channel.
 *   2. The digest answers "would we send something different?" — not "has anything anywhere changed?" Idempotency
 *      hangs off it, and the evaluator is non-deterministic, so a needless re-run samples drift (a measured mean of
 *      20.5 MIA points) rather than learning anything.
 *
 * Pure functions only — no database. The db-backed build path is covered by the service test.
 */

// The module under test also exports the db-backed builder, so importing it pulls in ../db. An INERT stub is enough
// to satisfy that import — deliberately NOT the PGlite harness, which boots a real in-process Postgres that nothing
// here would close, firing an import after teardown and crashing the worker (see #470).
jest.mock("../db", () => ({ db: {}, pool: { end: async () => {} } }));

import { blindEvalPromptV02 } from "./marketabilityBeta1EvaluatorSpec";
import {
  TRIGGER_REASONS,
  evidenceAsOfFor,
  promptFor,
  snapshotDigest,
  type SnapshotSource,
} from "./marketabilityBeta1Snapshot";

// Shaped like the real thing: renderBlock() emits the observation date into the text, which is why freshness is
// evaluator input rather than provenance. Keep that substring here — a test below moves it.
const BLOCK = "AUTHORITATIVE SOCIAL DATA\n\n- instagram @athlete — source: connected verified; observed 2026-09-14; followers: 22,040";
const src = (platform: string, observedAt: string, accountId = `${platform}-1`): SnapshotSource => ({
  platform, accountId, observedAt, sourceClass: "connected_verified",
});
const base = { name: "Mia Bhuta", sport: "Soccer", socialBlock: BLOCK, socialSources: [src("instagram", "2026-09-14T00:00:00.000Z")] };

describe("the trigger never reaches the evaluator", () => {
  it("promptFor produces exactly the frozen prompt — no extra input can be smuggled in", () => {
    // If this diverges, the canonical-text digest in the freeze gate would also fail. Asserted here too so the
    // failure names the cause instead of appearing as an unrelated digest mismatch.
    expect(promptFor(base)).toBe(blindEvalPromptV02({ key: "snapshot", name: "Mia Bhuta", sport: "Soccer" }, BLOCK));
  });

  it("the prompt contains the block and the identity, and nothing about why we asked", () => {
    const prompt = promptFor(base);
    expect(prompt).toContain("Mia Bhuta");
    expect(prompt).toContain("Soccer");
    expect(prompt).toContain("followers: 22,040");
    for (const reason of TRIGGER_REASONS) expect(prompt).not.toContain(reason);
    expect(prompt).not.toMatch(/trigger/i);
  });

  it("an absent block still produces a prompt — the rubric's own fallback says the platforms are unavailable", () => {
    const prompt = promptFor({ ...base, socialBlock: null });
    expect(prompt).toContain("No authoritative platform data is available");
    expect(prompt).not.toContain("followers");
  });
});

describe("the digest answers 'would we send something different?'", () => {
  it("is stable for identical input", () => {
    expect(snapshotDigest(base)).toBe(snapshotDigest({ ...base }));
  });

  it("ignores provenance the evaluator never sees — only the prompt matters", () => {
    // socialSources is how the block was assembled; the block text is what is sent. Two snapshots that would produce
    // an identical prompt are asking the same question, whatever the surrounding bookkeeping says.
    const a = { ...base, socialSources: [src("instagram", "2026-09-14T00:00:00.000Z"), src("tiktok", "2026-09-14T00:00:00.000Z")] };
    expect(snapshotDigest(a)).toBe(snapshotDigest(base));
  });

  it("changes when the block changes — that is a different prompt", () => {
    expect(snapshotDigest({ ...base, socialBlock: `${BLOCK}\n- tiktok @athlete — followers: 15,511` })).not.toBe(snapshotDigest(base));
  });

  it("changes when identity changes — name and sport are the other two things we send", () => {
    expect(snapshotDigest({ ...base, sport: "Basketball" })).not.toBe(snapshotDigest(base));
    expect(snapshotDigest({ ...base, name: "Someone Else" })).not.toBe(snapshotDigest(base));
  });

  it("changes when the observation DATE moves, because the date is rendered into the block", () => {
    // renderBlock emits `… observed 2026-09-14 …`, so a re-observation genuinely changes the prompt: "22,040
    // followers observed today" is a stronger claim than the same number observed six months ago. Freshness is
    // substantive evaluator input here, not hidden provenance — which is why it belongs in the digest and why the
    // digest reads it from the block text rather than carrying the dates a second time.
    const fresher = BLOCK.replace("observed 2026-09-14", "observed 2026-09-15");
    expect(snapshotDigest({ ...base, socialBlock: fresher })).not.toBe(snapshotDigest(base));
  });

  it("is blind to why the evaluation was requested", () => {
    // Two requests differing only in trigger are asking the same question of the same information, so idempotency
    // must treat them as identical — the trigger is not part of the digest input type at all.
    expect(snapshotDigest(base)).toBe(snapshotDigest({ name: base.name, sport: base.sport, socialBlock: base.socialBlock }));
  });
});

describe("evidenceAsOf is the freshest evidence, not the clock", () => {
  const fallback = new Date("2026-01-01T00:00:00.000Z");

  it("takes the newest observation across platforms", () => {
    const sources = [src("instagram", "2026-09-10T00:00:00.000Z"), src("tiktok", "2026-09-14T00:00:00.000Z"), src("youtube", "2026-09-02T00:00:00.000Z")];
    expect(evidenceAsOfFor(sources, fallback)).toBe("2026-09-14T00:00:00.000Z");
  });

  it("falls back to the athlete record when no platform data resolved", () => {
    // Correct and honest for an unconnected athlete: our evidence about them genuinely has not changed. Idempotency
    // still hangs off the digest, so a fallback that moves cannot by itself cause a re-run.
    expect(evidenceAsOfFor([], fallback)).toBe(fallback.toISOString());
  });

  it("ignores an unparseable observation date rather than poisoning the result", () => {
    const sources = [src("instagram", "not-a-date"), src("tiktok", "2026-09-14T00:00:00.000Z")];
    expect(evidenceAsOfFor(sources, fallback)).toBe("2026-09-14T00:00:00.000Z");
  });
});
