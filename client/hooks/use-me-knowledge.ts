// Concept 0.4 Slice 1 reads (server/routes/meKnowledge.ts):
//
//   GET /api/v1/me/overview   → useMeOverview()    the Me identity header + what Nomila knows, per category
//   GET /api/v1/me/knowledge  → useMeKnowledge()   key facts + categories, every entry with its source (knowledge/3: + tier,
//                                                   logoDomain, meta, her dispute)
//   POST /api/v1/me/knowledge/disputes → useDisputeKnowledgeEntry()   "This isn't right" for an entry with no correction field
//
// Both keys sit under ["me", …], so a record write (useWriteRecordField invalidates ["me"]) refreshes them.

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import { useMyMedia } from "./use-media-library";
import { eligibleStoryPhotos, meImagery, type StoryPhoto } from "../lib/myStoryLogic";

export type SourceKey = "you" | "proof" | "inbox" | "connected" | "official" | "researched" | "inferred";
export interface KnowledgeSource { key: SourceKey; label: string; detail: string | null }
export type EntryState = "present" | "unknown" | "unavailable" | "not_yet_computed";
export type CorrectShape = "text" | "list" | "voice" | "teams" | "career";

export interface KnowledgeEntry {
  id: string;
  label: string;
  value: string | null;
  state: EntryState;
  source: KnowledgeSource | null;
  status: "current" | "historical" | "disputed" | null;
  stale: boolean;
  at: string | null;
  evidence: Array<{ url: string; domain: string | null }>;
  correct: { field: string; shape: CorrectShape; label: string; raw?: unknown } | null;
  /** knowledge/3: how firmly Nomila holds it (the admissibility policy's tier); null on an empty entry or an older server. */
  tier?: KnowledgeTier | null;
  /** knowledge/3: a domain for the team / school / brand logo. Presentation only. */
  logoDomain?: string | null;
  /** The brand's stored logo (inbox_brands.logo_url, from brand research) when Nomila holds one. Presentation only. */
  logoUrl?: string | null;
  /** knowledge/3: the fact / evidence row behind it. */
  ref?: { kind: "fact" | "evidence"; id: string } | null;
  /** knowledge/3: she said "This isn't right" (her words when she gave them). */
  yourDispute?: { said: string | null; at: string | null } | null;
  /** knowledge/3: structured parts for the career timeline and honours. */
  meta?: { org?: string | null; orgKind?: string | null; span?: string | null; role?: string | null; year?: number | null } | null;
  /** (Density pass) a brand entry's inbox_brands id and research, for the brand deck. Presentation only; absent on an older server. */
  brandId?: number | null;
  brandProfile?: BrandProfile | null;
}
/** What Nomila's brand research holds about a brand, as stored (server views/knowledge BrandProfile). */
export interface BrandProfile {
  category: string | null;
  description: string | null;
  audienceSummary: string | null;
  sportCategories: string[];
  knownAthletePartnerships: string[];
  coverUrl: string | null;
  images: string[];
  /** The pages brand research's web search saw, shown as links (absent on an older server). */
  sources?: Array<{ url: string; title: string | null }>;
}
export type KnowledgeTier = "established" | "reported" | "unconfirmed";
export interface KnowledgeSection { key: string; title: string; entries: KnowledgeEntry[] }
export type CategoryKey = "athletics" | "partnerships" | "media" | "interests" | "academics" | "business";
export interface KnowledgeCategory {
  key: CategoryKey;
  title: string;
  blurb: string;
  state: "present" | "unknown" | "unavailable";
  count: number | null;
  bySource: Partial<Record<SourceKey, number>>;
  sections: KnowledgeSection[];
}
export interface MeIdentity {
  displayName: string;
  fullName: string;
  photoUrl: string | null;
  primary: { label: string; org: string | null; orgKind: string | null; sport: string | null; source: KnowledgeSource | null } | null;
  facts: string[];
  /** knowledge/2.1: her nationality from canonical facts; null (or absent from an older server) when none. */
  nationality?: string | null;
  /** knowledge/2.1: her role on the current primary affiliation (e.g. Captain); null when absent. */
  role?: string | null;
}
export interface AthleteKnowledge {
  version: string;
  athleteId: string;
  builtAt: string;
  /** Last research that refreshed something shown; null = never (render as unknown, never as a date). Not rendered in Slice 1. */
  researchAsOf: string | null;
  identity: MeIdentity;
  keyFacts: KnowledgeEntry[];
  categories: KnowledgeCategory[];
  total: number;
  bySource: Partial<Record<SourceKey, number>>;
  omitted: { legacyValues: number };
}
export interface MeOverview {
  version: string;
  athleteId: string;
  identity: MeIdentity;
  knows: { total: number; categories: Array<{ key: CategoryKey; title: string; count: number | null; state: KnowledgeCategory["state"] }> };
  /** Slice 2 (O-10): the entry into My Intelligence, from the same state function as GET /me/intelligence (knowledge/2). */
  intelligence: MyIntelligenceEntry;
  story: { status: "coming" };
}
/** Mirrors server/services/intelligence/views/myIntelligence.ts `PageState` (my-intelligence/0.1). */
export type MyIntelligencePageState =
  | "identity_ambiguous" | "identity_failed" | "identity_pending" | "identity_not_started"
  | "updating" | "no_assessment" | "insufficient" | "assessed_partial" | "assessed";
/** `score` is null whenever the page would show none (no read, or a read withheld under an identity hold). */
export interface MyIntelligenceEntry {
  status: "ready"; pageState: MyIntelligencePageState; score: number | null; evidenceAsOf: string | null;
  /** True while the shown read is a new-agent athlete's preliminary M.I.A. preview; null/absent otherwise. */
  preliminary?: boolean | null;
  /** The score shown is her LAST read, kept while her public profile is unconfirmed on the latest check. */
  identityUnconfirmed?: boolean;
}

async function getJson<T>(route: string): Promise<T> {
  const res = await apiRequest("GET", route);
  return res.json() as Promise<T>;
}

export function useMeOverview(enabled = true) {
  return useQuery<MeOverview>({ queryKey: ["me", "overview"], queryFn: () => getJson<MeOverview>("/api/v1/me/overview"), staleTime: 30_000, enabled });
}

export function useMeKnowledge(enabled = true) {
  return useQuery<AthleteKnowledge>({ queryKey: ["me", "knowledge"], queryFn: () => getJson<AthleteKnowledge>("/api/v1/me/knowledge"), staleTime: 30_000, enabled });
}

/** "This isn't right" (knowledge/3): stored as her dispute; the entry then reads unconfirmed. Refreshes every ["me"] read. */
export function useDisputeKnowledgeEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entryId: string; said?: string }) => {
      const res = await apiRequest("POST", "/api/v1/me/knowledge/disputes", { entryId: input.entryId, ...(input.said?.trim() ? { said: input.said.trim() } : {}) });
      return res.json() as Promise<{ ok: true; entryId: string; assertedId: string; target: string }>;
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["me"] }); },
  });
}

/** Enough eligible photos to fill every slot a screen has (a hero, a strip, the doors, the pillars), cheaply: one page. */
export const ME_POOL_LIMIT = 40;

/**
 * Her eligible photos, in the library's order (GET /me/media, hero-first when the server sends `top`), through My
 * Story's eligibility rules (lib/myStoryLogic `eligibleStoryPhotos`: hers, connected or uploaded, never a reject or a
 * poster / captioned frame). The ONE pool every photo screen picks from — a screen hands it to `meImagery(pool, screen)`
 * or `storyImagery(pool, n)`, which choose that screen's hero and its distinct tiles. The sign-in avatar
 * (athletes.photo_url) is only the fallback — it is a small profile thumbnail, not a hero image.
 */
export function useMePool(limit = ME_POOL_LIMIT): StoryPhoto[] {
  const media = useMyMedia("photos");
  return useMemo(() => {
    const first = media.data?.pages[0];
    return eligibleStoryPhotos([...(first?.top ?? []), ...(first?.items ?? [])]).slice(0, limit);
  }, [media.data, limit]);
}

/** Home's ordering of the pool, HERO FIRST — index 0 is the one photo the Home hero and the avatar share. */
export function useMePhotos(limit = 4) {
  const pool = useMePool();
  return useMemo(() => meImagery(pool, "home").ordered.slice(0, limit), [pool, limit]);
}
