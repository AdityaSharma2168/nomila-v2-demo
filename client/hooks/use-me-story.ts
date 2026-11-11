// Concept 0.4 · My Story read (GET /api/v1/me/story, IdentityIntelligenceView identity-intelligence/0.2).
//
// The endpoint is optional for this client: a server without it answers 404, and a server with it but the feature off
// answers { pageState: "unavailable" }. Both read as "unavailable" here, never as an error, so Me shows its quiet
// learning line rather than a failure. The parse is lenient: every part is taken as served when it has the shape the
// contract gives it, and dropped (null / []) otherwise, so an older server never breaks the screen. story_arc is never read.
//
// What is typed is exactly what My Story composes (lib/myStoryLogic.ts): the hero statement (throughline → essence →
// positioning.current), the pillars with their proof, the differentiators (My Intelligence's "What makes you
// marketable"), the four chapters, what she stands for, her direction, the image gap, and her verbatim statements
// (athleteStatements, the server's presentation projection). Nothing here rewrites text.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import {
  EMPTY_STORY, type MeStory, type MeStoryBasisRef, type MeStoryChapter, type MeStoryDirection, type MeStoryForm, type MeStoryPillar, type MeStoryProof, type MeStoryStatement, type MeStorySynth,
} from "../lib/meStoryLogic";

export type { MeStory } from "../lib/meStoryLogic";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const basis = (v: unknown): MeStoryBasisRef[] =>
  Array.isArray(v)
    ? v.map(obj).filter((x): x is Raw => !!x && typeof x.kind === "string").map((x) => Object.fromEntries(Object.entries(x).filter(([, val]) => typeof val === "string")) as MeStoryBasisRef)
    : [];

const form = (v: unknown): MeStoryForm | null => {
  const o = obj(v);
  if (!o || (typeof o.short !== "string" && typeof o.long !== "string")) return null;
  return { short: typeof o.short === "string" ? o.short : "", long: typeof o.long === "string" ? o.long : "", basis: basis(o.basis), strength: str(o.strength), ...(o.pinned ? { pinned: true } : {}) };
};
const synth = (v: unknown): MeStorySynth | null => {
  const o = obj(v);
  const text = o ? str(o.text) : null;
  return o && text ? { text, basis: basis(o.basis), strength: str(o.strength) } : null;
};
const chapter = (v: unknown): MeStoryChapter | null => synth(v);   // `athleteFacingText` (pre-#754 rows) is never read: `text` always
const pillar = (v: unknown): MeStoryPillar | null => {
  const o = obj(v);
  const key = o ? str(o.key) : null; const label = o ? str(o.label) : null;
  return o && key && label ? { key, label, definition: str(o.definition) ?? "", proof: strs(o.proof), basis: basis(o.basis), strength: str(o.strength) } : null;
};
const proof = (v: unknown): MeStoryProof | null => {
  const o = obj(v);
  const key = o ? str(o.key) : null; const text = o ? str(o.text) : null;
  return o && key && text ? { key, kind: str(o.kind), text, basis: basis(o.basis), strength: str(o.strength) } : null;
};
const direction = (v: unknown): MeStoryDirection | null => {
  const o = obj(v);
  const value = o ? str(o.value) : null;
  return o && value ? { value, objectiveId: str(o.objectiveId), domain: str(o.domain), athleteAuthored: o.athleteAuthored === true, basis: basis(o.basis) } : null;
};
const statement = (v: unknown): MeStoryStatement | null => {
  const o = obj(v);
  const id = o ? str(o.id) : null; const text = o ? str(o.text) : null;
  if (!o || !id || !text) return null;
  const src = obj(o.source) ?? {};
  return {
    id, text, truncated: o.truncated === true, provenance: o.provenance === "source_read" ? "source_read" : "her_own", medium: str(o.medium) ?? "other",
    source: { outlet: str(src.outlet), title: str(src.title), platform: str(src.platform), url: str(src.url) },
    topics: strs(o.topics), at: str(o.at), intent: o.intent === true, citedBy: strs(o.citedBy),
  };
};
const list = <T>(v: unknown, one: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.map(one).filter((x): x is T => x !== null) : []);

export function parseMeStory(body: unknown): MeStory {
  const b = obj(body);
  if (!b) return EMPTY_STORY;
  const pageState = b.pageState === "ready" || b.pageState === "learning" || b.pageState === "updating" ? b.pageState : "unavailable";
  const pos = obj(b.positioning) ?? {};
  const desired = obj(pos.desired);
  const ch = obj(b.chapters) ?? {};
  return {
    pageState,
    essence: form(b.essence),
    positioning: {
      current: form(pos.current),
      desired: desired && str(desired.value) ? { value: desired.value as string, source: str(desired.source), basis: basis(desired.basis) } : null,
    },
    throughline: form(b.throughline),
    standsFor: form(b.standsFor),
    pillars: list(b.pillars, pillar),
    differentiators: list(b.differentiators, synth),
    proofPoints: list(b.proofPoints, proof),
    signatureMoments: list(b.signatureMoments, proof),
    chapters: { origin: chapter(ch.origin), rise: chapter(ch.rise), defining: chapter(ch.defining), now: chapter(ch.now) },
    direction: list(b.direction, direction),
    imageGap: synth(b.imageGap),
    athleteStatements: list(b.athleteStatements, statement),
  };
}

export async function fetchMeStory(): Promise<MeStory> {
  try {
    const res = await apiRequest("GET", "/api/v1/me/story");
    return parseMeStory(await res.json());
  } catch (e) {
    // apiRequest throws "<status>: <body>". A missing route is "not here yet", not a failure.
    if (e instanceof Error && e.message.startsWith("404")) return EMPTY_STORY;
    throw e;
  }
}

export function useMeStory(enabled = true) {
  return useQuery<MeStory>({ queryKey: ["me", "story"], queryFn: fetchMeStory, staleTime: 60_000, retry: false, enabled });
}
