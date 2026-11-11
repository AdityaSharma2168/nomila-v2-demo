/**
 * evals/agent/moments/runMomentsCase.ts — one moments case: seed the made-up athlete in an in-memory store, run the SAME
 * function the moments_scan workflow runs (server/agent/moments/scan.ts runMomentsScan), and record what it did.
 * Nothing here touches a database or names a real person; the only spend is the scan's own model call (live).
 */
import { randomUUID } from "node:crypto";
import type { Preference } from "../../../shared/agent";
import type { MomentDecisionDetail } from "../../../shared/plan";
import { runMomentsScan, type MomentDeal, type MomentsRunOutput } from "../../../server/agent/moments/scan";
import { EVENT_TOPICS } from "../../../server/agent/moments/facts";
import { createMemoryStore, type AgentStore } from "../../../server/agent/research/store";
import { traceOf } from "../runCase";
import type { CaseDate, MomentsCase, MomentsRecord } from "./types";

const DAY = 86_400_000;

/** The case's "avoid" preferences as stored rows (memory listPreferences' shape). */
export function preferencesOf(c: MomentsCase, athleteId: string): Preference[] {
  return (c.fixture.preferences ?? []).map((statement, i) => ({
    id: `pref-${i + 1}`, athleteId, kind: "avoid", statement, source: "said", status: "active", runId: null, createdAt: "2026-01-01T00:00:00.000Z",
  }));
}

/** A case date on the run's day: "+N" / "-N" days, else the date as written. */
export function caseDate(raw: CaseDate, today: string): string {
  const m = /^([+-])(\d+)$/.exec(raw.trim());
  if (!m) return raw.trim();
  const n = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Where a fixture item is said to be found: a made-up page per case and key. */
export const fixtureUrl = (c: MomentsCase, key: string) => `https://example.org/${c.id}/${key}`;

export interface SeededMoments {
  athleteId: string;
  store: AgentStore;
  deals: MomentDeal[];
  /** Case key → stored id (facts, moments) or deal id. */
  ids: Map<string, string>;
}

export async function seedMomentsCase(c: MomentsCase, today: string): Promise<SeededMoments> {
  const store = createMemoryStore();
  const athleteId = `00000000-0000-4000-b000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
  const name = c.athlete.name;
  const ids = new Map<string, string>();
  await store.insertFacts(athleteId, [
    { subject: { kind: "athlete", name }, claim: `The athlete's name is ${name}.`, type: "said", source: { ref: "onboarding/eval#name", title: "You told us" }, date: today, confidence: 1, runId: null },
    { subject: { kind: "athlete", name }, claim: `${name}'s sport is ${c.athlete.sport}.`, type: "said", source: { ref: "onboarding/eval#sport", title: "You told us" }, date: today, confidence: 1, runId: null },
  ]);
  for (const f of c.fixture.facts) {
    const [row] = await store.insertFacts(athleteId, [{
      subject: { kind: f.subject_kind, name: f.subject_name }, claim: f.claim, type: f.type,
      source: f.type === "said" ? { ref: `chat:eval#${f.key}`, title: "You told us" } : { url: fixtureUrl(c, f.key), title: "A made-up source" },
      date: f.date ? caseDate(f.date, today) : null, confidence: f.type === "said" ? 1 : 0.85, runId: null,
      ...(f.topic ? { topic: f.topic } : {}), ...(f.field && f.field_value ? { field: f.field as any, fieldValue: f.field_value } : {}),
      ...(f.care ? { sensitive: true, careKind: "personal" as const } : {}),
    }]);
    ids.set(f.key, row.id);
  }
  for (const m of c.fixture.moments) {
    const date = caseDate(m.date, today);
    const stored = m.date_precision === "month" ? `${date.slice(0, 7)}-01` : date;
    const [row] = await store.insertFacts(athleteId, [{
      subject: { kind: "event", name: m.name }, claim: m.claim, type: "found", source: { url: fixtureUrl(c, m.key), title: "A made-up source" },
      date: stored, datePrecision: m.date_precision ?? "day", confidence: 0.8, runId: null, topic: m.topic,
    }]);
    ids.set(m.key, row.id);
    if (m.idea) {
      const detail: MomentDecisionDetail = {
        kind: "moment", factId: row.id, name: m.name, date: stored, datePrecision: m.date_precision ?? "day", category: "schedule", whyNow: "On file from last week's scan.",
        rank: 1, idea: { hook: m.idea.hook, format: m.idea.format as MomentDecisionDetail["idea"]["format"], platform: m.idea.platform, timing: "before" },
        brief: { show: "On file.", captionAngle: "On file.", avoid: "On file." }, mediaNeeds: "On file.", scannedAt: `${today}T00:00:00.000Z`,
      };
      await store.insertDecision(athleteId, { runId: null, skillId: "moments", kind: "other", suggested: m.idea.hook, why: detail.whyNow, evidence: [{ kind: "fact", factId: row.id }], detail: detail as unknown as Record<string, unknown> });
    }
  }
  const deals: MomentDeal[] = c.fixture.deals.map((d) => {
    const id = randomUUID();
    ids.set(d.key, id);
    return { id, brand: d.brand, category: d.category, status: d.status, termStart: d.term_start ? caseDate(d.term_start, today) : null, termEnd: d.term_end ? caseDate(d.term_end, today) : null, signed: d.signed };
  });
  await store.writeBrief(athleteId, {
    summary: `${name}, ${c.stage.label}.`, sections: [], factIds: [], runId: null, internal: { currentSponsors: [], pastSponsors: [], exclusivityConflicts: (c.fixture.conflicts ?? []).map((x) => ({ ...x, factIds: [] })) },
    display: { stage: { label: c.stage.label, band: c.stage.band as any, confidence: 0.7, why: "From the case.", factIds: [] }, positioning: { from: "", to: "", statement: "", pillars: [], factIds: [] } },
  });
  return { athleteId, store, deals, ids };
}

/** Run one case's scan and record it. Never throws for a model failure: the record says where it stopped. */
export async function runMomentsCase(c: MomentsCase, opts: { mode: "live" | "mock"; today: string }): Promise<MomentsRecord> {
  const seeded = await seedMomentsCase(c, opts.today);
  const { store, athleteId } = seeded;
  const parentRef = `eval:moments:${c.id}`;
  const now = new Date(`${opts.today}T13:00:00.000Z`);
  const horizonEnd = new Date(now.getTime() + 42 * DAY).toISOString().slice(0, 10);
  let status = "error";
  let error: string | undefined;
  try {
    const out = await runMomentsScan({ store, sources: { deals: async () => seeded.deals, preferences: async () => preferencesOf(c, athleteId) }, athleteId, trigger: "schedule", parentRef, now });
    status = out.status === "skipped" ? `skipped:${out.reason}` : out.status;
  } catch (err: any) {
    error = String(err?.message ?? err).slice(0, 500);
  }
  const keyOfId = new Map([...seeded.ids].map(([k, id]) => [id, k]));
  const run = (await store.listRunsSince(athleteId, { since: "1970-01-01T00:00:00.000Z", skillId: "moments" }))[0] ?? null;
  const out = (run?.output ?? {}) as MomentsRunOutput;
  const facts = await store.listFacts(athleteId);
  const moments = facts.filter((f) => !!f.date && ((EVENT_TOPICS as readonly string[]).includes(f.topic ?? "") || f.subject.kind === "event"));
  // The idea bank (always on since 2 Nov 2026) files its entries (detail.kind "idea") beside the moments: graded elsewhere.
  const decisions = (await store.listDecisions(athleteId, { skillId: "moments" })).filter((d) => (d.detail as { kind?: unknown } | null)?.kind !== "idea");
  return {
    caseId: c.id, mode: opts.mode, today: opts.today, horizonEnd, status, ...(error ? { error } : {}),
    run: run ? traceOf(run, parentRef) : null,
    moments: moments.map((f) => ({
      id: f.id, caseKey: keyOfId.get(f.id) ?? null, name: f.subject.name, claim: f.claim, date: f.date, datePrecision: f.datePrecision ?? null,
      status: f.status, topic: f.topic ?? null, sourceUrl: f.source.url ?? null, sourceRef: f.source.ref ?? null, runId: f.runId,
    })),
    candidates: decisions.map((d) => {
      const x = d.detail as unknown as MomentDecisionDetail;
      return {
        id: d.id, factId: x.factId, response: d.response, rank: x.rank, name: x.name, category: x.category, whyNow: x.whyNow,
        idea: { hook: x.idea?.hook ?? "", angle: x.idea?.angle ?? "", format: x.idea?.format ?? "", platform: x.idea?.platform ?? "", timing: x.idea?.timing ?? "" },
        brief: { show: x.brief?.show ?? "", captionAngle: x.brief?.captionAngle ?? "", avoid: x.brief?.avoid ?? "" }, mediaNeeds: x.mediaNeeds ?? "",
      };
    }),
    applied: out.applied ? { written: out.applied.written, refreshed: out.applied.refreshed.map((x) => x.factId), linked: out.applied.linked, retired: out.applied.retired, passed: out.applied.passed } : null,
    held: out.held ?? [],
    internalRefs: [...c.fixture.deals.map((d) => `deals/${seeded.ids.get(d.key)}`), ...c.fixture.facts.map((f) => `memory_facts/${seeded.ids.get(f.key)}`)],
  };
}
