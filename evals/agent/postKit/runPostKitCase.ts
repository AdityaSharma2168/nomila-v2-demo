/**
 * evals/agent/postKit/runPostKitCase.ts — one post-kit case through the REAL builder (server/agent/postKit/build.ts
 * buildPostKit): the in-memory store, the case's made-up library behind the library port, and either the case's
 * scripted re-rank (--mock: a fake Gemini client, no provider) or the post-kit/match skill's own model (live: Gemini
 * Flash on Vertex, about half a cent a case). Never a database.
 */
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { Preference } from "../../../shared/agent";
import { setGeminiClient } from "../../../server/agent/geminiProvider";
import { buildPostKit } from "../../../server/agent/postKit/build";
import { MATCH_SKILL_ID } from "../../../server/agent/postKit/config";
import { clip, fakeGemini, fakeMedia, postAction, row } from "../../../server/agent/postKit/testRows";
import { createMemoryStore } from "../../../server/agent/research/store";
import { SPORTSWEAR_BRANDS } from "../../../server/studio/agent/brands";
import type { CastableRow } from "../../../server/studio/agent/cast";
import type { PostKitCase, PostKitCaseAsset, PostKitCaseRecord } from "./types";

export const EVAL_ATHLETE_ID = "00000000-0000-4000-8000-0000000000e1";

/** "$partner" / "$rival" → the caster's closed sportswear list (studio/agent/brands.ts), so no case names a brand. */
export function resolveBrand(name: string): string {
  if (name === "$partner") return SPORTSWEAR_BRANDS[0].name;
  if (name === "$rival") return SPORTSWEAR_BRANDS[1].name;
  return name;
}

/** The case's library as the caster's predicate would load it, with stable ids (one per key). */
export function libraryOf(c: PostKitCase): { rows: CastableRow[]; keyOf: Record<string, string> } {
  const keyOf: Record<string, string> = {};
  const rows = c.library.map((a: PostKitCaseAsset, i) => {
    const id = `00000000-0000-4000-9000-${String(i + 1).padStart(12, "0")}`;
    keyOf[id] = a.key;
    const vision = {
      description: a.description, shot_type: a.shot_type ?? "action", setting: a.setting ?? "", vibe: a.vibe ?? "", attire: a.attire ?? "",
      athlete_present: a.athlete_present ?? true, brand_safe: a.brand_safe ?? true, brands_visible: (a.brands ?? []).map(resolveBrand),
    };
    const over = { id, vision, provenance: a.provenance ?? "camera" } as Partial<CastableRow> & { vision: Record<string, unknown> };
    return a.kind === "clip" ? clip(a.duration ?? 10, a.beats ?? [], a.shots, over) : row(over);
  });
  return { rows, keyOf };
}

export async function runPostKitCase(c: PostKitCase, mode: "mock" | "live"): Promise<PostKitCaseRecord> {
  const t0 = Date.now();
  const store = createMemoryStore();
  const A = EVAL_ATHLETE_ID;
  const { rows, keyOf } = libraryOf(c);
  const keyByDescription = new Map(c.library.map((a) => [a.description, a.key]));
  const calls = mode === "mock"
    ? fakeGemini((input) => {
      const refOf = (key: string) => input.candidates.find((x: { ref: string; description: string }) => keyByDescription.get(x.description) === key)?.ref;
      const picks = (c.mock.none_fit ? [] : c.mock.picks)
        .map((p) => ({ ref: refOf(p.key), segment: p.segment === undefined ? "" : `S${p.segment}`, reason: "scripted" }))
        .filter((p): p is { ref: string; segment: string; reason: string } => !!p.ref);
      return { picks, none_fit: picks.length === 0, none_fit_reason: picks.length ? "" : "Nothing in the library shows this.", look_preset: c.mock.look ?? "natural", music_mood: c.mock.mood ?? "none" };
    })
    : null;
  try {
    const goal = await store.insertGoal(A, { text: "Grow my audience", source: "said", decisionId: null });
    const detail: ActionDecisionDetail = postAction({ what: c.post.what });
    detail.deliverable = { ...detail.deliverable, title: c.post.what, body: c.post.body, platform: c.post.platform, target: c.post.partner ? { subjectKind: "brand", name: resolveBrand(c.post.partner) } : null };
    const m = c.post.moment;
    if (m) {
      const [fact] = await store.insertFacts(A, [{ subject: { kind: "event", name: m.name }, claim: `${m.name} is coming up.`, type: "found", source: { url: "https://example.org/moment" }, date: m.date, confidence: 0.9, runId: null }]);
      await store.insertDecision(A, {
        runId: null, skillId: "moments", kind: "other", suggested: m.name, why: "eval", evidence: [{ kind: "fact", factId: fact.id }],
        detail: { kind: "moment", idea: { hook: m.hook, format: m.format, platform: c.post.platform, timing: "before it" }, brief: { show: m.show, captionAngle: m.captionAngle, avoid: m.avoid }, mediaNeeds: m.mediaNeeds },
      });
      detail.event = { factId: fact.id, label: m.name, date: m.date, precision: "day" };
    }
    const d = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "action", suggested: c.post.what, why: "eval", evidence: [], detail: detail as unknown as Record<string, unknown>, goalId: goal.id });
    const prefs: Preference[] = c.never?.length
      ? [{ id: "p1", athleteId: A, kind: "avoid", statement: `Never use: ${c.never.join(", ")}`, source: "said", status: "active", runId: null, createdAt: new Date().toISOString() }]
      : [];
    const outcome = await buildPostKit({ store, media: fakeMedia(new Map([[A, rows]])).media, preferences: async () => prefs }, A, d.id, { trigger: "event", parentRef: null });
    const after = (await store.getDecision(A, d.id))!.detail as unknown as ActionDecisionDetail;
    const runs = await store.listRunsSince(A, { since: new Date(0).toISOString(), skillId: MATCH_SKILL_ID });
    const shown = runs.flatMap((r) => r.evidenceRead.filter((e) => e.kind === "record").map((e) => keyOf[(e as { id: string }).id]));
    return {
      caseId: c.id, mode, outcome, kit: after.prepared?.postKit ?? null, keyOf, shown,
      calls: calls ? calls.length : runs.length, costMicroUsd: runs.reduce((n, r) => n + r.cost.microUsd, 0), latencyMs: Date.now() - t0,
    };
  } catch (err: any) {
    return { caseId: c.id, mode, outcome: null, kit: null, keyOf, shown: [], calls: calls?.length ?? 0, costMicroUsd: 0, latencyMs: Date.now() - t0, error: String(err?.message ?? err).slice(0, 300) };
  } finally {
    if (calls) setGeminiClient(null);
  }
}
