/**
 * agent/postKit/testRows.ts — library rows and plan actions for the post-kit suites and the post-kit eval: rows in the
 * exact shape the caster's predicate loads (studio/agent/cast.ts CastableRow), with neutral, made-up tags. Test data
 * only: no athlete, sport, school or brand of the real world.
 */
import type { ActionDecisionDetail } from "../../../shared/plan";
import type { CastableRow } from "../../studio/agent/cast";
import { setGeminiClient } from "../geminiProvider";
import { unfencedInput } from "../../testUtils/agentModel";
import type { PostKitMedia } from "./build";

/**
 * A library port over an in-memory library: athlete id → rows. `search` returns the athlete's rows in library order
 * (or `order` when given) and records every call; `load` answers only the athlete's own ids, as the predicate does.
 */
export function fakeMedia(library: Map<string, CastableRow[]>, opts: {
  order?: (athleteId: string) => string[];
  /** When a row's tags were written; default: one second apart from 1 Jan 2026, in library order. */
  taggedAt?: (row: CastableRow, index: number) => string;
} = {}) {
  const tagTime = opts.taggedAt ?? ((_r: CastableRow, i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString());
  const calls: Array<{ athleteId: string; brief: string; clipsFirst: boolean; excludeBrands: string[]; k: number }> = [];
  const media: PostKitMedia = {
    async search(athleteId, brief, o) {
      calls.push({ athleteId, brief, ...o });
      const ids = opts.order ? opts.order(athleteId) : (library.get(athleteId) ?? []).map((r) => r.id);
      return ids.slice(0, o.k * 2);
    },
    async load(athleteId, ids) {
      const mine = library.get(athleteId) ?? [];
      return new Map(mine.filter((r) => ids.includes(r.id)).map((r) => [r.id, r]));
    },
    async newlyTagged(athleteId, after, limit) {
      return (library.get(athleteId) ?? [])
        .map((row, i) => ({ row, taggedAt: tagTime(row, i) }))
        .sort((a, b) => a.taggedAt.localeCompare(b.taggedAt) || a.row.id.localeCompare(b.row.id))
        .filter((p) => !after || p.taggedAt > after.at || (p.taggedAt === after.at && p.row.id > after.id))
        .slice(0, limit);
    },
    async urls(r) {
      return { thumbUrl: r.gcsPath ? `https://signed.example/${r.gcsPath}` : null, videoUrl: r.videoPath ? `https://signed.example/${r.videoPath}` : null };
    },
  };
  return { media, calls };
}

/**
 * A Gemini client that answers each structured call with `answer(input)` (the call's input JSON, parsed) and records
 * every request. Usage is fixed (2,000 in, 200 out) so the cost is known. Restore with `setGeminiClient(null)`.
 */
export function fakeGemini(answer: (input: any, skillId: string) => unknown) {
  const calls: Array<{ skillId: string; input: any }> = [];
  setGeminiClient({
    models: {
      generateContentStream: async (params) => {
        const input = JSON.parse(unfencedInput(params.contents?.[0]?.parts?.[0]?.text ?? "{}"));
        const skillId = /# Skill: (\S+) v/.exec(String(params.config?.systemInstruction ?? ""))?.[1] ?? "";
        calls.push({ skillId, input });
        const text = JSON.stringify(answer(input, skillId));
        return (async function* () {
          yield { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 200 } };
        })();
      },
    },
  });
  return calls;
}

/** The C-refs (or A-refs) in a call's candidate lines whose description contains `words`. */
export const refsWith = (lines: Array<{ ref: string; description: string }>, words: string): string[] =>
  lines.filter((l) => l.description.includes(words)).map((l) => l.ref);

let n = 0;

/** One library row. A photo of the athlete, tagged, brand-safe, from their camera — unless `over` says otherwise. */
export function row(over: Partial<CastableRow> & { vision?: Record<string, unknown> | null } = {}): CastableRow {
  n += 1;
  const { vision: visionOver, ...rest } = over;
  const id = rest.id ?? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const vision = visionOver === null ? null : {
    athlete_present: true, subject: "the_athlete", athlete_prominence: 0.8, shot_type: "action",
    description: "the athlete mid-stride on an outdoor track", brands_visible: [], aesthetic_quality: 0.8, brand_safe: true,
    content_flags: {}, setting: "outdoor track", attire: "training kit", vibe: "focused", hero_suitability: 0.7,
    disposition: "as_is", edit_note: "", reason: "clear action shot",
    ...(visionOver ?? {}),
  };
  const mediaType = rest.mediaType ?? "photo";
  return {
    id,
    athletePresent: vision && typeof vision.athlete_present === "boolean" ? vision.athlete_present : null,
    gcsPath: `athletes/test/${id}.jpg`,
    videoPath: mediaType === "clip" ? `athletes/test/${id}.mp4` : null,
    provenanceSignal: null,
    vision,
    provenance: "camera",
    platform: "studio",
    mediaType,
    durationSeconds: mediaType === "clip" ? 20 : null,
    beats: [],
    editNote: null,
    identityBound: null,
    meta: false,
    ...rest,
  };
}

/** A clip of `durationSeconds` with these beats ([start, end, words]) and, optionally, stored camera cuts. */
export function clip(durationSeconds: number, beats: Array<[number, number, string]> = [], shots?: number[], over: Partial<CastableRow> = {}): CastableRow {
  return row({
    mediaType: "clip", durationSeconds,
    beats: beats.map(([startSec, endSec, description]) => ({ startSec, endSec, description, camera: "", motion: "" })),
    ...(shots ? { shots } : {}),
    ...over,
  });
}

/** A plan action of kind post, as apply.ts writes it. */
export function postAction(over: Partial<ActionDecisionDetail> = {}): ActionDecisionDetail {
  return {
    kind: "post", what: "Training clip", button: "post", dueOn: null, event: null,
    deliverable: {
      type: "post_brief", title: "Training clip",
      body: "Caption: The work nobody sees. Early sessions add up. #training #process\nShots: a sprint start, a hard rep, the walk back.",
      target: null, platform: "instagram", thread: null, connector: null,
    },
    state: "to_start",
    ...over,
  };
}
