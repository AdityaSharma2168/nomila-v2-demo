// Concept 0.4 · the client's view of GET /me/story (IdentityIntelligenceView identity-intelligence/0.2; pure, no fetch)
// and what Me shows from it. See hooks/use-me-story.ts for the read and lib/myStoryLogic.ts for My Story's composition.
//
//   Me's quoted line   essence — the long form when there is one, else the short form
//   the line under it  positioning.desired, verbatim (her own positioning goal or direction) when she has one; else
//                      positioning.current, short form
// Nothing here says "verified"; the learning state is unchanged.

export type MeStoryPageState = "unavailable" | "learning" | "updating" | "ready";

/** A basis reference as served: `kind` plus the id-ish fields of that kind (id · key · source · snapshotId · platform). */
export type MeStoryBasisRef = { kind: string } & Record<string, string>;
/** `strength` as served: established · reported · athlete_approved. Never shown on the face of a screen. */
export interface MeStoryForm { short: string; long: string; pinned?: boolean; basis?: MeStoryBasisRef[]; strength?: string | null }
export interface MeStorySynth { text: string; basis: MeStoryBasisRef[]; strength: string | null }
export type MeStoryChapter = MeStorySynth;
export interface MeStoryPillar { key: string; label: string; definition: string; proof: string[]; basis: MeStoryBasisRef[]; strength: string | null }
export interface MeStoryProof { key: string; kind: string | null; text: string; basis: MeStoryBasisRef[]; strength: string | null }
export interface MeStoryDirection { value: string; objectiveId: string | null; domain: string | null; athleteAuthored: boolean; basis: MeStoryBasisRef[] }
/** Her words, verbatim (the server's athleteStatements projection). `citedBy` names the story objects whose basis cites it. */
export interface MeStoryStatement {
  id: string;
  text: string;
  truncated: boolean;
  provenance: "her_own" | "source_read";
  medium: string;
  source: { outlet: string | null; title: string | null; platform: string | null; url: string | null };
  topics: string[];
  at: string | null;
  intent: boolean;
  citedBy: string[];
}

export interface MeStory {
  pageState: MeStoryPageState;
  essence: MeStoryForm | null;
  positioning: { current: MeStoryForm | null; desired: { value: string; source?: string | null; basis?: MeStoryBasisRef[] } | null };
  throughline: MeStoryForm | null;
  standsFor: MeStoryForm | null;
  pillars: MeStoryPillar[];
  /** What sets her apart, as Identity Intelligence holds it (text + basis + strength): "What makes you marketable" reads these. */
  differentiators: MeStorySynth[];
  proofPoints: MeStoryProof[];
  signatureMoments: MeStoryProof[];
  chapters: { origin: MeStoryChapter | null; rise: MeStoryChapter | null; defining: MeStoryChapter | null; now: MeStoryChapter | null };
  direction: MeStoryDirection[];
  imageGap: MeStorySynth | null;
  athleteStatements: MeStoryStatement[];
}

export const EMPTY_STORY: MeStory = {
  pageState: "unavailable", essence: null, positioning: { current: null, desired: null }, throughline: null, standsFor: null, pillars: [], differentiators: [], proofPoints: [], signatureMoments: [],
  chapters: { origin: null, rise: null, defining: null, now: null }, direction: [], imageGap: null, athleteStatements: [],
};

/** The quiet line Me shows while there is no story to show (learning, unavailable, or no route yet). No invented copy. */
export const STORY_LEARNING_LINE = "Nomila is still putting your story together.";

const text = (s: unknown): string | null => (typeof s === "string" && s.trim() ? s.trim() : null);

/** Me's two lines only when the page is ready and has at least one of them; otherwise not ready (the learning line). */
export function meStoryModel(story: Pick<MeStory, "pageState" | "essence" | "positioning"> | null | undefined): { ready: boolean; identity: string | null; positioning: string | null } {
  if (!story || story.pageState !== "ready") return { ready: false, identity: null, positioning: null };
  const identity = text(story.essence?.long) ?? text(story.essence?.short);
  const positioning = text(story.positioning?.desired?.value) ?? text(story.positioning?.current?.short);
  return { ready: !!(identity || positioning), identity, positioning };
}
