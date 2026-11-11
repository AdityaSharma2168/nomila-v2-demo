/**
 * atmosphere/config.ts — the flag, the env names and the caps for atmosphere imagery (DESIGN.md §9, owner decision
 * 10 Oct 2026: the app must not look like the athlete's photo gallery; everything not about the athlete gets an
 * atmosphere image: venues, surfaces, equipment, light, texture; never a person, a logo or text).
 *
 * ATMOSPHERE_IMAGERY — the picker route answers only when this is exactly "true". Off in dev and prod
 * (gcp/cloud-run-*.yaml, pinned by atmosphereFlag.test.ts). While it is off nothing in this folder runs: no model
 * call, no Pixabay call, no generation, no write.
 *
 * Getters, so env is read at call time (tests and late env injection rely on that, as in agent/config.ts).
 */

import { readCap, readPrice } from "../../lib/spendCap";

/* The three spend caps below are clamped (lib/spendCap.ts) to 10× their defaults: 5 / 20 / 100 USD. */
/** The env var the Pixabay key is read from. The owner creates the Secret Manager secret of the same name. */
export const PIXABAY_KEY_ENV = "PIXABAY_API_KEY";

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Non-negative: "0" is a real value here (it switches a paid step off). */
function nonNegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const micro = (usd: number) => Math.round(usd * 1_000_000);

export function atmosphereEnabled(): boolean {
  return process.env.ATMOSPHERE_IMAGERY === "true";
}

export const ATMOSPHERE = {
  /** Per athlete per UTC day (USD → micro-dollars): model calls + generations. "0" stops all paid work for everyone. */
  get ATHLETE_DAY_CAP_MICRO_USD(): number { return micro(readCap("ATMOSPHERE_ATHLETE_DAY_CAP_USD", 0.5, 5, { allowZero: true })); },
  /** Per athlete, all time. Atmosphere is a small library per athlete that is reused, so this stays low. */
  get ATHLETE_TOTAL_CAP_MICRO_USD(): number { return micro(readCap("ATMOSPHERE_ATHLETE_TOTAL_CAP_USD", 2, 20, { allowZero: true })); },
  /** Every athlete together, per UTC day. */
  get DAY_CAP_MICRO_USD(): number { return micro(readCap("ATMOSPHERE_DAY_CAP_USD", 10, 100, { allowZero: true })); },
  /** Generated fallbacks per athlete per UTC day (each about $0.07). "0" = never generate. */
  get GENERATIONS_PER_ATHLETE_DAY(): number { return Math.floor(readCap("ATMOSPHERE_GENERATIONS_PER_ATHLETE_DAY", 3, 30, { allowZero: true })); },
  /** Candidates the image check looks at for one slot before giving up on Pixabay. */
  get MAX_CHECKS_PER_SLOT(): number { return Math.floor(positive("ATMOSPHERE_MAX_CHECKS_PER_SLOT", 6)); },
  /** Pixabay requests per rolling window, per process (the API allows 100 per 60 s per key; Cloud Run runs ≤ 3). */
  get PIXABAY_MAX_REQUESTS(): number { return Math.floor(positive("ATMOSPHERE_PIXABAY_MAX_REQUESTS", 30)); },
  get PIXABAY_WINDOW_MS(): number { return Math.floor(positive("ATMOSPHERE_PIXABAY_WINDOW_MS", 60_000)); },
  /** Pixabay's API terms require search results to be cached for 24 hours. */
  get PIXABAY_CACHE_MS(): number { return Math.floor(positive("ATMOSPHERE_PIXABAY_CACHE_MS", 24 * 60 * 60_000)); },
  /** Results asked for per query (Pixabay accepts 3–200). */
  get PIXABAY_PER_PAGE(): number { return Math.min(200, Math.max(3, Math.floor(positive("ATMOSPHERE_PIXABAY_PER_PAGE", 20)))); },
  /** The generation fallback's model (the Studio image route's Vertex model id). */
  get IMAGE_MODEL(): string { return process.env.ATMOSPHERE_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image"; },
  /** Quoted before a generation runs, so a cap is checked against it (the Studio price: ~1120 tokens × $0.00006). */
  get GENERATION_ESTIMATE_MICRO_USD(): number { return micro(readPrice("ATMOSPHERE_GENERATION_ESTIMATE_USD", 0.07, 0.035)); },
  /** Reserved before a cheap-tier model call (query writing or one image check); the real cost is recorded after. */
  get MODEL_CALL_ESTIMATE_MICRO_USD(): number { return micro(readPrice("ATMOSPHERE_MODEL_CALL_ESTIMATE_USD", 0.002, 0.001)); },
  /** How long a signed read URL handed to a screen lives. */
  get SIGNED_URL_TTL_MS(): number { return Math.floor(positive("ATMOSPHERE_SIGNED_URL_TTL_MS", 6 * 60 * 60_000)); },
} as const;

/** Where an atmosphere image is used. Each has an aspect the search and the generation aim for. */
export const SLOT_TYPES = ["section_header", "empty_state", "goal", "suggestion", "pitch", "thin_profile"] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export const SLOT_SHAPE: Record<SlotType, { orientation: "horizontal" | "vertical"; aspectRatio: string }> = {
  section_header: { orientation: "horizontal", aspectRatio: "16:9" },
  empty_state:    { orientation: "horizontal", aspectRatio: "4:3" },
  goal:           { orientation: "horizontal", aspectRatio: "4:3" },
  suggestion:     { orientation: "horizontal", aspectRatio: "4:3" },
  pitch:          { orientation: "horizontal", aspectRatio: "16:9" },
  thin_profile:   { orientation: "vertical",   aspectRatio: "3:4" },
};

/** The credit line and licence stored with each image. */
export const PIXABAY_LICENCE = "pixabay-content-license";
export const GENERATED_LICENCE = "generated";
export const GENERATED_CREDIT = "Image generated for Nomila";
export const pixabayCredit = (user: string) => `Photo: ${user || "Pixabay contributor"} / Pixabay`;
