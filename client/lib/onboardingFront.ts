/**
 * onboardingFront — the agent onboarding FRONT (EXPO_PUBLIC_AGENT_V3 here, AGENT_ONBOARDING on the server): sign-in,
 * the sport grid, "Is this you?", Mila's intro and "What Mila already has". The pure rules (no React) and the one
 * public read the app makes before anyone is signed in.
 *
 * The front only shows when BOTH flags are on: the app's build flag, and the server's answer to
 * GET /api/v1/public/onboarding-front. No answer (an older server, no network) keeps today's flow.
 */
import { getApiUrl } from "./query-client";
import { SPORTS, type Sport } from "../../shared/sports";
import { ONBOARDING_INTERESTS, interestActionId } from "../../shared/onboardingInterests";
import type { OnboardingAction } from "./agent/types";

export interface SigninPhoto { id: string; url: string }
export interface OnboardingFront {
  agentOnboarding: boolean;
  signinPhotos: SigninPhoto[];
  /** Whether the front offers "Use email instead" (the 6-digit email code; the server's EMAIL_CODE_SIGNIN and email delivery). */
  emailSignIn: boolean;
}

export const FRONT_OFF: OnboardingFront = { agentOnboarding: false, signinPhotos: [], emailSignIn: false };

/** The server's answer; FRONT_OFF on any failure (today's flow). */
export async function fetchOnboardingFront(fetchImpl: typeof fetch = fetch): Promise<OnboardingFront> {
  try {
    const res = await fetchImpl(new URL("/api/v1/public/onboarding-front", getApiUrl()).toString());
    if (!res.ok) return FRONT_OFF;
    const body = (await res.json()) as Partial<OnboardingFront>;
    const photos = Array.isArray(body.signinPhotos)
      ? body.signinPhotos.filter((p): p is SigninPhoto => !!p && typeof p.id === "string" && typeof p.url === "string")
      : [];
    const on = body.agentOnboarding === true;
    return { agentOnboarding: on, signinPhotos: on ? photos : [], emailSignIn: on && body.emailSignIn === true };
  } catch {
    return FRONT_OFF;
  }
}

let frontOnce: Promise<OnboardingFront> | null = null;
/** The answer, asked once per app launch (the sign-in screen and the sign-up gate share it). */
export function loadOnboardingFront(): Promise<OnboardingFront> {
  frontOnce ??= fetchOnboardingFront();
  return frontOnce;
}
/** Tests only: forget the launch's answer. */
export function resetOnboardingFront(): void { frontOnce = null; }

// ─── The sport grid ───────────────────────────────────────────────────────────────────────────────────────────────

/** The grid's tiles, in the shared list's order (shared/sports.ts — the one list). */
export const SPORT_TILES: readonly string[] = SPORTS.map((s) => s.label);

/**
 * Tap a sport: on → added at the end; off → removed. The FIRST pick is the main sport, so turning off the main one
 * promotes the next pick by construction.
 */
export function toggleSport(picked: readonly string[], sport: string): string[] {
  const key = sport.trim().toLowerCase();
  return picked.some((p) => p.toLowerCase() === key) ? picked.filter((p) => p.toLowerCase() !== key) : [...picked, sport.trim()];
}

/**
 * The sports to save, main first: the tiles picked, then the "Other" field's words (a sport outside the list) when
 * typed. A typed sport that names a tile is that tile. Duplicates ignored.
 */
export function sportsToSave(picked: readonly string[], other: string): string[] {
  const typed = other.replace(/\s+/g, " ").trim().slice(0, 80);
  const tile = typed ? SPORT_TILES.find((t) => t.toLowerCase() === typed.toLowerCase()) : undefined;
  const all = typed ? [...picked, tile ?? typed] : [...picked];
  return all.filter((s, i) => all.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i);
}

/** "Main" sits on the first pick; the others carry a check. */
export function sportMark(picked: readonly string[], sport: string): "main" | "check" | null {
  const i = picked.findIndex((p) => p.toLowerCase() === sport.toLowerCase());
  return i === 0 ? "main" : i > 0 ? "check" : null;
}

const words = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** "Other" is a search: the tiles whose label holds the typed words (case and spacing ignored); every tile when empty. */
export function filterSports(query: string, tiles: readonly string[] = SPORT_TILES): string[] {
  const q = words(query);
  return q ? tiles.filter((t) => t.toLowerCase().includes(q)) : [...tiles];
}

/**
 * The typed sport "Other" would add: the search's words when they match no tile (the "Add … as your sport" action),
 * else "" — while the words still find a tile it is a search, not a sport. sportsToSave takes this as its `other`.
 */
export function sportToAdd(query: string, tiles: readonly string[] = SPORT_TILES): string {
  return filterSports(query, tiles).length ? "" : query.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Add a typed sport to the picks (at the end; a tile's own name is that tile); never a duplicate. */
export function addSport(picked: readonly string[], typed: string): string[] {
  return sportsToSave(picked, typed);
}

/** The picks a surface shows no tile for (a typed sport; in the chat, a sport picked from the full list): drawn as pills. */
export function picksOutside(picked: readonly string[], shown: readonly string[] = SPORT_TILES): string[] {
  const on = new Set(shown.map((s) => s.toLowerCase()));
  return picked.filter((p) => !on.has(p.toLowerCase()));
}

/** Mila's chat shows these eight as chips (the most common college sports); "More sports" opens the full list. */
export const COMMON_SPORTS: readonly string[] = ["Football", "Basketball", "Soccer", "Baseball", "Softball", "Volleyball", "Track and field", "Swimming"];

/** The shared list's entry for a tile label (its id and icon); undefined for a typed sport. */
export function sportByLabel(label: string): Sport | undefined {
  return SPORTS.find((s) => s.label.toLowerCase() === label.toLowerCase());
}

// ─── Mila's intro ─────────────────────────────────────────────────────────────────────────────────────────────────

export function toggleKey(picked: readonly string[], key: string): string[] {
  return picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key];
}

/** The intro's picks as the turn's existing `capability` actions (each saved as a "said" fact), in the grid's order. */
export function interestActions(picked: readonly string[]): OnboardingAction[] {
  return ONBOARDING_INTERESTS.filter((i) => picked.includes(i.key)).map((i) => ({ type: "capability" as const, capabilityId: interestActionId(i) }));
}

/** The athlete's name for the onboarding start: the profile's first and last name, else null (the grid asks). */
export function profileName(a: { firstName: string | null; lastName: string | null } | null | undefined): string | null {
  const n = [a?.firstName, a?.lastName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return n || null;
}

// ─── Where the front is, after the start ─────────────────────────────────────────────────────────────────────────

/** After the start: Mila's intro, then what she already has, then the conversation. Kept per onboarding run. */
export type FrontStage = "intro" | "has" | "done";
export const FRONT_STAGES: readonly FrontStage[] = ["intro", "has", "done"];

export function nextStage(s: FrontStage): FrontStage {
  return s === "intro" ? "has" : "done";
}

// ─── What Mila already has ───────────────────────────────────────────────────────────────────────────────────────

/** One fact as GET /me/agent/onboarding/facts?subject=athlete serves it (server/agent/onboarding/service.ts). */
export interface OnboardingFact {
  id: string;
  claim: string;
  type: string;
  status: string;
  date: string | null;
  topic: string | null;
  sources: Array<{ label: string; url?: string }>;
  sensitivity?: "care" | "none";
}

/**
 * The cards, in the order they read best: what was FOUND first (that is what "already has" means), newest first; then
 * the athlete's own words. A private ("care") fact never gets a photo card.
 */
/** At most this many cards ask the picker for a photo (its limit per call). */
export const MAX_PHOTO_SLOTS = 12;

/** What a fact card's atmosphere photo should suit (the picker's goal-domain purposes), from the fact's research topic. */
export function photoPurpose(topic: string | null): "performance" | "audience" | "commercial" | "impact" | "positioning" {
  const t = topic ?? "";
  if (["career", "competition", "achievement", "stats", "upcoming"].includes(t)) return "performance";
  if (["social", "audience_growth", "engagement", "demographics", "media", "conversation"].includes(t)) return "audience";
  if (["sponsor", "business", "commerce"].includes(t)) return "commercial";
  if (t === "cause") return "impact";
  return "positioning";
}

/** The picker's slots for the cards (atmosphere, never the athlete: these cards are about facts, not their photos). */
export function factPhotoSlots(cards: readonly OnboardingFact[]) {
  return cards.slice(0, MAX_PHOTO_SLOTS).map((f) => ({ key: `fact:${f.id}`, type: "section_header" as const, purpose: photoPurpose(f.topic) }));
}

export function factCards(facts: readonly OnboardingFact[]): OnboardingFact[] {
  const shown = facts.filter((f) => f.status !== "removed" && f.sensitivity !== "care");
  const rank = (f: OnboardingFact) => (f.type === "said" ? 1 : 0);
  return [...shown].sort((a, b) => rank(a) - rank(b) || (b.date ?? "").localeCompare(a.date ?? ""));
}
