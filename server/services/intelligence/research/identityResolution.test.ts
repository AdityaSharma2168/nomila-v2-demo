/**
 * identityResolution.test.ts — PR E1, the pure half (design record pr-e-identity-resolution-design.md §1, §2.2, §5.7, §8).
 *
 *   - the exhaustive transition table: every from-value × every event, allowed, no-op or refused; never → NULL
 *   - the Q1 classifier over ParsedDirectV2 fixtures, T-a … T-e, incl. the tightened T-e (exact team / cited handle only)
 *   - the anchor hash (stable, order-independent, normalization-only)
 *   - provenance: "current plus one", no workflow facts
 *   - the boundary: identityResolutionEnabled() truth table, default off, and the deployed yaml values keep it off
 *   - the writer allow-list: nothing but this module writes the columns; applyIdentityTransition is imported by exactly
 *     the allow-listed writers (E2a: the v3 Q1 identity gate, research/identityGate.ts; E2b: research/lifecycle.ts, research/confirmation.ts)
 *
 * No database, no provider: db is a stub; nothing here calls a provider.
 */

jest.mock("../../../db", () => ({ db: {}, pool: {} }));
jest.mock("../../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { identityResolutionEnabled } from "./config";
import {
  anchorHash, applyIdentityTransition, canonicalAnchor, classifyQ1, planIdentityTransition,
  type IdentityAnchor, type IdentityDetail, type IdentityEvent, type IdentityState, type Q1Determination, type Q1Result,
} from "./identityResolution";
import type { Finding, ParsedDirectV2 } from "./spec/directEvidenceV2";

const AT = new Date("2026-10-01T12:00:00.000Z");

// ── fixtures ──────────────────────────────────────────────────────────────────
type Level = "native_supported" | "native_retrieved" | "asserted_only" | "unsupported";
const finding = (section: "S1" | "S2" | "S3", item: string, value: Record<string, unknown>, opts: { level?: Level; urls?: string[] } = {}): Finding => ({
  section, item, value, statement: "as the source states it", asOf: null,
  sources: (opts.urls ?? ["https://news.example/story"]).map((url) => ({ url, title: null, publishedAt: null, quote: "q" })),
  lineage: { level: opts.level ?? "native_supported", match: "none", boundChunkIds: [], boundSources: [], detail: null, bindingMethod: "none" },
});
const parsed = (identity: Partial<ParsedDirectV2["identity"]>, findings: Finding[], over: Partial<ParsedDirectV2> = {}): ParsedDirectV2 => {
  const items: ParsedDirectV2["items"] = { full_name: { status: "not_found", reason: null, findings: [] } };
  for (const f of findings) { const it = (items[f.item] ??= { status: "found", reason: null, findings: [] })!; it.status = "found"; it.findings.push(f); }
  return { items, unknownItems: [], parseError: null, identity: { anchorMatch: "matched", confidence: 0.9, namesakes: [], ...identity }, ...over };
};
const q1 = (p: ParsedDirectV2 | null, over: Partial<Q1Result> = {}): Q1Result => ({ completed: true, parsed: p, nativeSources: 4, askedItems: 12, conflictsAthleteStatement: false, ...over });

const ANCHOR: IdentityAnchor = { fullName: "Jordan Example", sport: "Soccer", team: "Stanford", handles: { instagram: "@JordanEx", twitter: "jordan_x" } };
const NAME = finding("S1", "full_name", { name: "Jordan Example" });
const NAMESAKE = { description: "a musician with the same name", sourceUrl: "https://other.example/a" };

// ── the classifier ────────────────────────────────────────────────────────────
describe("classifyQ1 — T-a … T-e", () => {
  const cls = (r: Q1Result, a: IdentityAnchor = ANCHOR) => classifyQ1(r, a);
  const outcome = (d: Q1Determination) => [d.outcome, "reason" in d ? d.reason : null];

  test("T-a: not completed / unparseable / degenerate / anchorMatch null ⇒ no determination (never failed)", () => {
    expect(outcome(cls(q1(parsed({}, [NAME]), { completed: false })))).toEqual(["no_determination", "not_completed"]);
    expect(outcome(cls(q1(null)))).toEqual(["no_determination", "unparseable"]);
    expect(outcome(cls(q1(parsed({}, [], { parseError: "bad json" }))))).toEqual(["no_determination", "unparseable"]);
    // degenerate: matched, zero findings, sources retrieved
    expect(outcome(cls(q1(parsed({ anchorMatch: "matched" }, []))))).toEqual(["no_determination", "degenerate"]);
    // degenerate: no asked item reported
    expect(outcome(cls(q1(parsed({}, [], { items: {} }))))).toEqual(["no_determination", "degenerate"]);
    expect(outcome(cls(q1(parsed({ anchorMatch: null }, [NAME]))))).toEqual(["no_determination", "anchor_match_null"]);
  });

  test("uncertain ⇒ ambiguous (with or without namesakes)", () => {
    expect(outcome(cls(q1(parsed({ anchorMatch: "uncertain" }, [NAME]))))).toEqual(["ambiguous", "uncertain"]);
    expect(outcome(cls(q1(parsed({ anchorMatch: "uncertain", namesakes: [NAMESAKE] }, [NAME]))))).toEqual(["ambiguous", "uncertain"]);
  });

  test("not_resolved: zero namesakes ⇒ failed (no_public_match); ≥ 1 namesake ⇒ ambiguous (namesakes_unseparated)", () => {
    expect(outcome(cls(q1(parsed({ anchorMatch: "not_resolved", confidence: 0.1 }, []))))).toEqual(["failed", "no_public_match"]);
    expect(outcome(cls(q1(parsed({ anchorMatch: "not_resolved", namesakes: [NAMESAKE] }, []))))).toEqual(["ambiguous", "namesakes_unseparated"]);
    // a namesake reported only as an S1 `namesakes` item finding counts too
    expect(outcome(cls(q1(parsed({ anchorMatch: "not_resolved" }, [finding("S1", "namesakes", { description: "a musician" })]))))).toEqual(["ambiguous", "namesakes_unseparated"]);
  });

  test("T-b: matched with zero ACCEPTED S1/S2 findings ⇒ no determination", () => {
    expect(outcome(cls(q1(parsed({}, [finding("S1", "full_name", { name: "x" }, { level: "asserted_only" }), finding("S2", "current_affiliation", { organization: "Stanford" }, { level: "unsupported" })]))))).toEqual(["no_determination", "no_accepted_evidence"]);
    // accepted, but only in S3 — not S1/S2
    expect(outcome(cls(q1(parsed({}, [finding("S3", "position_role", { position: "forward" })]))))).toEqual(["no_determination", "no_accepted_evidence"]);
    // an accepted namesake finding is about someone else: it does not satisfy T-b
    expect(outcome(cls(q1(parsed({}, [finding("S1", "namesakes", { description: "a musician" })]))))).toEqual(["no_determination", "no_accepted_evidence"]);
    // native_retrieved is accepted
    expect(cls(q1(parsed({}, [finding("S1", "full_name", { name: "x" }, { level: "native_retrieved" })]))).outcome).toBe("resolved");
  });

  test("T-c: matched but it conflicts with her said/proof affiliation ⇒ ambiguous", () => {
    expect(outcome(cls(q1(parsed({}, [NAME]), { conflictsAthleteStatement: true })))).toEqual(["ambiguous", "conflicts_athlete_statement"]);
  });

  test("T-d: confidence is recorded, never thresholded", () => {
    const d = cls(q1(parsed({ confidence: 0.01 }, [NAME])));
    expect(d).toMatchObject({ outcome: "resolved", confidence: 0.01 });
    expect(cls(q1(parsed({ confidence: null }, [NAME]))).outcome).toBe("resolved");
  });

  test("matched, no namesakes, accepted evidence ⇒ resolved (no corroboration needed)", () => {
    expect(cls(q1(parsed({}, [NAME])))).toEqual({ outcome: "resolved", anchorMatch: "matched", confidence: 0.9, namesakes: 0, corroboratedBy: [] });
  });

  describe("T-e (tightened): matched + namesakes resolves only on an EXACT normalized team or cited-handle corroboration", () => {
    const withNamesake = (fs: Finding[]) => q1(parsed({ namesakes: [NAMESAKE] }, [NAME, ...fs]));

    test("exact team (normalizeText equality: case, diacritics, punctuation) ⇒ resolved", () => {
      expect(cls(withNamesake([finding("S2", "current_affiliation", { organization: "STANFORD" })]))).toMatchObject({ outcome: "resolved", corroboratedBy: ["team"] });
      expect(cls(withNamesake([finding("S2", "current_affiliation", { organization: "São Paulo F.C." })]), { ...ANCHOR, team: "Sao Paulo F. C." })).toMatchObject({ outcome: "resolved", corroboratedBy: ["team"] });
    });

    test("near-miss team ('Stanford' vs 'Stanford University') ⇒ ambiguous; no fuzzy or substring match", () => {
      expect(outcome(cls(withNamesake([finding("S2", "current_affiliation", { organization: "Stanford University" })])))).toEqual(["ambiguous", "namesakes_uncorroborated"]);
      expect(outcome(cls(withNamesake([finding("S2", "current_affiliation", { organization: "Stanfor" })])))).toEqual(["ambiguous", "namesakes_uncorroborated"]);
    });

    test("team corroboration needs an ACCEPTED S2 current_affiliation (not past, not asserted_only, not S1)", () => {
      expect(cls(withNamesake([finding("S2", "current_affiliation", { organization: "Stanford" }, { level: "asserted_only" })])).outcome).toBe("ambiguous");
      expect(cls(withNamesake([finding("S2", "past_affiliations", { organization: "Stanford" })])).outcome).toBe("ambiguous");
      expect(cls(withNamesake([finding("S1", "current_affiliation", { organization: "Stanford" })])).outcome).toBe("ambiguous");
      // no anchor team ⇒ nothing to corroborate
      expect(cls(withNamesake([finding("S2", "current_affiliation", { organization: "Stanford" })]), { ...ANCHOR, team: null }).outcome).toBe("ambiguous");
    });

    test("cited handle: an accepted S1/S2 finding cites the platform URL whose first path segment equals the handle ⇒ resolved", () => {
      expect(cls(withNamesake([finding("S1", "aliases", { alias: "JE" }, { urls: ["https://www.instagram.com/jordanex/"] })]))).toMatchObject({ outcome: "resolved", corroboratedBy: ["handle"] });
      // twitter.com and x.com both count for the anchor's twitter/x handle; '@' is stripped by normalizeHandle
      expect(cls(withNamesake([finding("S2", "current_affiliation", { organization: "Elsewhere" }, { urls: ["https://twitter.com/Jordan_X/status/1"] })])).outcome).toBe("resolved");
      expect(cls(withNamesake([finding("S1", "full_name", { name: "x" }, { urls: ["https://x.com/@jordan_x"] })])).outcome).toBe("resolved");
    });

    test("uncited handle / wrong host / non-first segment / substring / unaccepted ⇒ ambiguous", () => {
      const amb = (urls: string[], level: Level = "native_supported") => outcome(cls(withNamesake([finding("S1", "aliases", { alias: "JE" }, { urls, level })])));
      expect(amb(["https://news.example/jordanex"])).toEqual(["ambiguous", "namesakes_uncorroborated"]);            // not a platform host
      expect(amb(["https://www.tiktok.com/@jordanex"])).toEqual(["ambiguous", "namesakes_uncorroborated"]);         // the handle is on instagram, not tiktok
      expect(amb(["https://www.instagram.com/p/jordanex"])).toEqual(["ambiguous", "namesakes_uncorroborated"]);     // not the first path segment
      expect(amb(["https://www.instagram.com/jordanex_fan"])).toEqual(["ambiguous", "namesakes_uncorroborated"]);   // substring
      expect(amb(["https://notinstagram.com/jordanex"])).toEqual(["ambiguous", "namesakes_uncorroborated"]);        // host suffix without a dot
      expect(amb(["https://www.instagram.com/jordanex"], "asserted_only")).toEqual(["ambiguous", "namesakes_uncorroborated"]);
      // the handle in the anchor alone (no public source citing it) corroborates nothing
      expect(outcome(cls(withNamesake([])))).toEqual(["ambiguous", "namesakes_uncorroborated"]);
    });

    test("T-c wins over T-e: a corroborated match that conflicts with her statement stays ambiguous", () => {
      expect(outcome(cls(q1(parsed({ namesakes: [NAMESAKE] }, [NAME, finding("S2", "current_affiliation", { organization: "Stanford" })]), { conflictsAthleteStatement: true })))).toEqual(["ambiguous", "conflicts_athlete_statement"]);
    });
  });
});

// ── the anchor hash ───────────────────────────────────────────────────────────
describe("anchorHash", () => {
  test("stable under order, case, diacritics, '@' and twitter→x; changes when name, sport, team or a handle changes", () => {
    const h = anchorHash(ANCHOR);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(anchorHash({ fullName: "jordan  EXAMPLE", sport: "soccer", team: "stanford", handles: { x: "Jordan_X", instagram: "jordanex" } })).toBe(h);
    expect(anchorHash({ ...ANCHOR, handles: { ...ANCHOR.handles, tiktok: "" } })).toBe(h);   // empty handles are dropped
    for (const changed of [{ fullName: "Jordan Exampel" }, { sport: "Basketball" }, { team: "Stanford University" }, { team: null }, { handles: { instagram: "jordanex2", twitter: "jordan_x" } }]) {
      expect(anchorHash({ ...ANCHOR, ...changed })).not.toBe(h);
    }
    expect(JSON.parse(canonicalAnchor(ANCHOR))).toEqual({ v: "identity-anchor/1", name: "jordan example", sport: "soccer", team: "stanford", handles: [["instagram", "jordanex"], ["x", "jordan_x"]] });
  });
});

// ── the transition table ──────────────────────────────────────────────────────
const RESOLVED_Q1: Q1Determination = { outcome: "resolved", anchorMatch: "matched", confidence: 0.9, namesakes: 0, corroboratedBy: [] };
const AMBIG_Q1: Q1Determination = { outcome: "ambiguous", anchorMatch: "uncertain", confidence: 0.4, namesakes: 1, reason: "uncertain" };
const FAILED_Q1: Q1Determination = { outcome: "failed", anchorMatch: "not_resolved", confidence: 0.1, namesakes: 0, reason: "no_public_match" };
const NONE_Q1: Q1Determination = { outcome: "no_determination", anchorMatch: null, confidence: null, namesakes: 0, reason: "not_completed", detail: null };
const q1Event = (d: Q1Determination, over: Partial<Extract<IdentityEvent, { kind: "q1" }>> = {}): IdentityEvent => ({ kind: "q1", determination: d, researchRunId: "rr-1", workflowRunId: "wf-1", requestAnchorHash: "h1", currentAnchorHash: "h1", namesakeEvidenceIds: ["ev-1"], ...over });

const EVENTS: Record<string, IdentityEvent> = {
  enter: { kind: "enter", trigger: "signup", by: "user-1", anchorHash: "h1" },
  q1_resolved: q1Event(RESOLVED_Q1),
  q1_ambiguous: q1Event(AMBIG_Q1),
  q1_failed: q1Event(FAILED_Q1),
  q1_none: q1Event(NONE_Q1),
  confirm: { kind: "athlete_confirmed", assertedId: "as-1", evidenceIds: ["ev-1"], q1ResearchRunId: "rr-1", by: "user-1" },
  reenter_name: { kind: "reenter", trigger: "anchor_changed", anchorHash: "h2", nameOrSportChanged: true },
  reenter_team: { kind: "reenter", trigger: "anchor_changed", anchorHash: "h2", nameOrSportChanged: false },
  reenter_ttl: { kind: "reenter", trigger: "ttl", anchorHash: "h1", nameOrSportChanged: false },
  reenter_admin: { kind: "reenter", trigger: "admin", anchorHash: "h1", nameOrSportChanged: false },
  reject: { kind: "athlete_rejected", assertedId: "as-2", by: "user-1" },
};
const q1Detail = (over: Record<string, unknown> = {}) => ({ at: "2026-09-01T00:00:00.000Z", basis: "q1", researchRunId: "rr-0", workflowRunId: "wf-0", queryId: "Q1", anchorMatch: "matched", confidence: 0.8, namesakes: 0, namesakeEvidenceIds: [], anchorHash: "h1", previous: null, ...over }) as IdentityDetail;
const STATES: Record<string, IdentityState> = {
  NULL: { value: null, detail: null },
  pending: { value: "pending", detail: { at: "2026-09-01T00:00:00.000Z", trigger: "signup", by: null, anchorHash: "h1", previous: null } },
  resolved: { value: "resolved", detail: q1Detail() },
  ambiguous: { value: "ambiguous", detail: q1Detail({ anchorMatch: "uncertain", reason: "uncertain" }) },
  failed: { value: "failed", detail: q1Detail({ anchorMatch: "not_resolved", reason: "no_public_match" }) },
};

// "Tn → value" = written; "noop:reason" = legal, nothing written; "refused" = not in the table.
const R = "refused";
const TABLE: Record<string, Record<string, string>> = {
  NULL:      { enter: "T1→pending", q1_resolved: R, q1_ambiguous: R, q1_failed: R, q1_none: "noop:no_determination", confirm: R, reenter_name: R, reenter_team: R, reenter_ttl: R, reenter_admin: R, reject: R },
  pending:   { enter: R, q1_resolved: "T2→resolved", q1_ambiguous: "T3→ambiguous", q1_failed: "T4→failed", q1_none: "noop:no_determination", confirm: R, reenter_name: R, reenter_team: R, reenter_ttl: R, reenter_admin: R, reject: R },
  resolved:  { enter: R, q1_resolved: "T10→resolved", q1_ambiguous: "noop:resolved_sticky", q1_failed: "noop:resolved_sticky", q1_none: "noop:no_determination", confirm: R, reenter_name: "T9→pending", reenter_team: R, reenter_ttl: R, reenter_admin: R, reject: "T8→ambiguous" },
  ambiguous: { enter: R, q1_resolved: R, q1_ambiguous: R, q1_failed: R, q1_none: "noop:no_determination", confirm: "T6→resolved", reenter_name: "T7→pending", reenter_team: "T7→pending", reenter_ttl: "T7→pending", reenter_admin: "T7→pending", reject: R },
  failed:    { enter: R, q1_resolved: R, q1_ambiguous: R, q1_failed: R, q1_none: "noop:no_determination", confirm: R, reenter_name: "T7→pending", reenter_team: "T7→pending", reenter_ttl: "T7→pending", reenter_admin: "T7→pending", reject: R },
};
const show = (p: ReturnType<typeof planIdentityTransition>) => (p.ok ? `${p.transition}→${p.to}` : p.kind === "noop" ? `noop:${p.reason}` : "refused");

describe("planIdentityTransition — the exhaustive table (every from × every event)", () => {
  for (const [from, row] of Object.entries(TABLE)) for (const [ev, want] of Object.entries(row)) {
    test(`${from} × ${ev} ⇒ ${want}`, () => { expect(show(planIdentityTransition(STATES[from], EVENTS[ev], AT))).toBe(want); });
  }

  test("any → NULL is impossible: no event, from any state, plans a NULL value", () => {
    for (const s of Object.values(STATES)) for (const e of Object.values(EVENTS)) {
      const p = planIdentityTransition(s, e, AT);
      if (p.ok) { expect(p.to).not.toBeNull(); expect(["pending", "resolved", "ambiguous", "failed"]).toContain(p.to); }
    }
  });

  test("T10 keeps an athlete_confirmed basis (no write); refreshes a q1 basis", () => {
    const confirmed: IdentityState = { value: "resolved", detail: { at: "2026-09-02T00:00:00.000Z", basis: "athlete_confirmed", assertedId: "as-1", evidenceIds: [], q1ResearchRunId: "rr-0", by: "u", previous: null } };
    expect(show(planIdentityTransition(confirmed, EVENTS.q1_resolved, AT))).toBe("noop:athlete_confirmed_kept");
    const p = planIdentityTransition(STATES.resolved, EVENTS.q1_resolved, AT);
    expect(p.ok && p.detail).toMatchObject({ basis: "q1", researchRunId: "rr-1", previous: { value: "resolved", basis: "q1", at: "2026-09-01T00:00:00.000Z", reason: null } });
  });

  test("a Q1 result whose request anchor is no longer the current anchor is refused (T2 precondition)", () => {
    expect(show(planIdentityTransition(STATES.pending, q1Event(RESOLVED_Q1, { currentAnchorHash: "h2" }), AT))).toBe("refused");
  });

  test("anchor_changed re-entry with an unchanged anchor hash is refused", () => {
    expect(show(planIdentityTransition(STATES.ambiguous, { kind: "reenter", trigger: "anchor_changed", anchorHash: "h1", nameOrSportChanged: false }, AT))).toBe("refused");
  });
});

describe("provenance — current plus one, no workflow facts", () => {
  const WORKFLOW_WORDS = /attempt|retry|next_?retry|queued|running|lease|budget|refus|deferred|failures/i;
  test("every written detail carries at most one predecessor, flattened, and no workflow fact", () => {
    for (const s of Object.values(STATES)) for (const e of Object.values(EVENTS)) {
      const p = planIdentityTransition(s, e, AT);
      if (!p.ok) continue;
      const d = p.detail as any;
      expect(d.at).toBe(AT.toISOString());
      if (d.previous) { expect(Object.keys(d.previous).sort()).toEqual(["at", "basis", "reason", "value"]); expect(d.previous.value).toBe(s.value); }
      else expect(s.value).toBeNull();
      for (const k of Object.keys(d)) expect(k).not.toMatch(WORKFLOW_WORDS);
    }
  });

  test("T2/T3/T4 record the Q1 provenance the record names", () => {
    const p = planIdentityTransition(STATES.pending, EVENTS.q1_ambiguous, AT);
    expect(p.ok && p.detail).toEqual({ at: AT.toISOString(), basis: "q1", researchRunId: "rr-1", workflowRunId: "wf-1", queryId: "Q1", anchorMatch: "uncertain", confidence: 0.4, namesakes: 1, namesakeEvidenceIds: ["ev-1"], anchorHash: "h1", reason: "uncertain", previous: { value: "pending", at: "2026-09-01T00:00:00.000Z", basis: null, reason: null } });
    const t1 = planIdentityTransition(STATES.NULL, EVENTS.enter, AT);
    expect(t1.ok && t1.detail).toEqual({ at: AT.toISOString(), trigger: "signup", by: "user-1", anchorHash: "h1", previous: null });
  });
});

// ── NULL is not pending ───────────────────────────────────────────────────────
describe("NULL ≠ pending", () => {
  test("NULL accepts only T1; pending accepts Q1 determinations — they are different states", () => {
    const fromNull = Object.keys(EVENTS).map((e) => show(planIdentityTransition(STATES.NULL, EVENTS[e], AT)));
    const fromPending = Object.keys(EVENTS).map((e) => show(planIdentityTransition(STATES.pending, EVENTS[e], AT)));
    expect(fromNull).not.toEqual(fromPending);
    expect(show(planIdentityTransition(STATES.NULL, EVENTS.q1_resolved, AT))).toBe("refused");   // a calibration/backfill Q1 never writes a NULL row
  });
});

// ── the boundary ──────────────────────────────────────────────────────────────
const FLAGS = ["RESEARCH_SUBSTRATE_WRITE", "RESEARCH_REFRESH_ENABLED", "RESEARCH_REFRESH_PROVIDER"] as const;
const env = process.env;
const setFlags = (f: Partial<Record<(typeof FLAGS)[number], string>>) => { process.env = { ...env }; for (const k of FLAGS) delete process.env[k]; Object.assign(process.env, f); };
afterEach(() => { process.env = env; });

describe("identityResolutionEnabled() — the one boundary PR E and PR H read", () => {
  test("default (no flags) ⇒ off", () => { setFlags({}); expect(identityResolutionEnabled()).toBe(false); });

  test("truth table: on only when RESEARCH_REFRESH_ENABLED && RESEARCH_SUBSTRATE_WRITE && provider = direct", () => {
    for (const r of [false, true]) for (const s of [false, true]) for (const p of ["", "kimi", "direct"]) {
      setFlags({ RESEARCH_REFRESH_ENABLED: String(r), RESEARCH_SUBSTRATE_WRITE: String(s), ...(p ? { RESEARCH_REFRESH_PROVIDER: p } : {}) });
      expect(identityResolutionEnabled()).toBe(r && s && p === "direct");
    }
  });

  test("dev yaml turns identity resolution on (approved 1 Oct 2026)", () => {
    const doc = parse(readFileSync(join(__dirname, "..", "..", "..", "..", "gcp", "cloud-run-dev.yaml"), "utf8"));
    const deployed = Object.fromEntries((doc.spec.template.spec.containers[0].env as { name: string; value?: string }[]).filter((e) => (FLAGS as readonly string[]).includes(e.name)).map((e) => [e.name, e.value]));
    setFlags(deployed);
    expect(identityResolutionEnabled()).toBe(true);
  });

  test("the deployed flag values (prod yaml) keep it off", () => {
    for (const file of ["cloud-run-prod.yaml"]) {
      const doc = parse(readFileSync(join(__dirname, "..", "..", "..", "..", "gcp", file), "utf8"));
      const deployed = Object.fromEntries((doc.spec.template.spec.containers[0].env as { name: string; value?: string }[]).filter((e) => (FLAGS as readonly string[]).includes(e.name)).map((e) => [e.name, e.value]));
      // Stage 1 (owner, 25 Oct 2026): substrate on and the direct binding, but RESEARCH_REFRESH_ENABLED stays off — so off.
      expect(deployed).toMatchObject({ RESEARCH_SUBSTRATE_WRITE: "true", RESEARCH_REFRESH_ENABLED: "false", RESEARCH_REFRESH_PROVIDER: "direct" });
      setFlags(deployed);
      expect(identityResolutionEnabled()).toBe(false);
    }
  });

  test("flag off ⇒ applyIdentityTransition refuses before touching the database (db is an empty stub here)", async () => {
    setFlags({});
    await expect(applyIdentityTransition("a1", STATES.pending, EVENTS.q1_resolved, { at: AT })).resolves.toEqual({ written: false, reason: "disabled" });
  });
});

// ── the writer allow-list (design §5.8) ───────────────────────────────────────
/**
 * The only files allowed to import applyIdentityTransition. E1: none. E2a: the v3 Q1 identity gate (identityGate.ts).
 * E2b adds lifecycle.ts and the athlete confirmation service — each by adding its path here in the PR that introduces
 * it. Calibration, backfill, the planner, the v3 stage itself and persistResearchRun must never appear.
 */
// Design record §5.8: "the v3 Q1 step, lifecycle.ts and the confirmation service only". E2a: the Q1 gate module; E2b adds
// lifecycle.ts (T1 signup/claim/admin, T7, T9) and confirmation.ts (T6, T8). The planner reaches T7 only THROUGH
// lifecycle.ts and never imports the writer itself; calibration, backfill and persist never do.
const IDENTITY_WRITERS: string[] = [
  "server/services/intelligence/research/identityGate.ts",
  "server/services/intelligence/research/lifecycle.ts",
  "server/services/intelligence/research/confirmation.ts",
];
const MODULE = "server/services/intelligence/research/identityResolution.ts";
/** Files that may name the identity_resolution columns: the writer/reader module and the schema mirror. */
const COLUMN_OWNERS = [MODULE, "shared/schema.ts"];

describe("only the identity module writes identity_resolution", () => {
  const REPO = resolve(__dirname, "../../../..");
  const posix = (p: string) => p.split(sep).join("/");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "server_dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(?:[cm]?[jt]s|tsx)$/.test(name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) out.push(posix(relative(REPO, p)));
    }
    return out;
  };
  const files = ["server", "scripts", "shared"].filter((r) => existsSync(join(REPO, r))).flatMap((r) => walk(join(REPO, r)));
  const code = (f: string) => readFileSync(join(REPO, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  test("the scan sees the tree", () => { expect(files.length).toBeGreaterThan(200); expect(files).toContain(MODULE); });

  test("applyIdentityTransition is imported only by allow-listed writers (exactly: the v3 gate, lifecycle, confirmation)", () => {
    const users = files.filter((f) => f !== MODULE && /\bapplyIdentityTransition\b/.test(code(f)));
    expect(users.filter((f) => !IDENTITY_WRITERS.includes(f))).toEqual([]);
    expect(users.sort()).toEqual([...IDENTITY_WRITERS].sort());   // exact: a stale writer entry fails too
  });

  test("no other source file names the identity_resolution columns (persist, planner, calibration and backfill never write them)", () => {
    const offenders = files.filter((f) => !COLUMN_OWNERS.includes(f) && /\bidentity_resolution(_detail)?\b/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

