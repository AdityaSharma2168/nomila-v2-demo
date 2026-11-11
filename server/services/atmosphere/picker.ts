/**
 * atmosphere/picker.ts — given an athlete, a screen and a slot (type + purpose), return the image that slot shows.
 *
 * Order (DESIGN.md §9: atmosphere, then the category default as the last fallback):
 *   1. the image this slot already shows (placements: chosen once and kept, so a slot is stable);
 *   2. a STORED image for the same purpose that no other slot on this screen shows, chosen deterministically per slot
 *      (a hash of athlete + screen + slot over the stored list), so reuse costs nothing;
 *   3. a fresh one: the cheap model writes 2–4 queries from her sport and data plus the slot's purpose → Pixabay search
 *      (rate-limited, cached 24 h) → download → image check (no person, face, logo, text or watermark; fits the
 *      purpose) → our own stored copy with its credit line, licence, source URL, query, purpose and check result;
 *   4. a generated atmosphere image (the Studio image route on Vertex, about $0.07), checked the same way;
 *   5. the category default (the client draws it: components/strategy/RecommendationVisual.tsx).
 * Every paid step is checked against the caps first (per athlete per day, per athlete in all, everyone per day) and
 * recorded in atmosphere_spend_days after. A refused or failed step falls through to the next; the picker never throws
 * for a provider problem, it answers with the default.
 *
 * Providers are injected (PickerDeps) so tests never reach OpenAI, Pixabay, Vertex or GCS.
 */
import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "../../logger";
import { generate } from "../../studio/router";
import { saveBuffer, signedUrl } from "../../lib/mediaStore";
import { parseImageSize } from "../../studio/imageSize";
import {
  ATMOSPHERE, GENERATED_CREDIT, GENERATED_LICENCE, PIXABAY_LICENCE, SLOT_SHAPE, SLOT_TYPES, pixabayCredit, type SlotType,
} from "./config";
import { checkImage, writeQueries, type AthleteSceneData, type CheckResult, type SlotRequest, type WrittenQueries } from "./model";
import { downloadHit, pixabayConfigured, PixabayRateLimited, searchPixabay, type PixabayHit, type SearchResult } from "./pixabay";
import * as store from "./store";
import type { AtmosphereImageRow } from "../../../shared/schema";

const logger = createLogger("atmosphere/picker");

export interface PickerDeps {
  writeQueries(athlete: AthleteSceneData, slot: SlotRequest, today: string): Promise<WrittenQueries>;
  checkImage(image: { bytes: Buffer; contentType: string }, slot: SlotRequest, query: string): Promise<CheckResult>;
  pixabayConfigured(): boolean;
  searchPixabay(query: string, orientation: "horizontal" | "vertical"): Promise<SearchResult>;
  downloadHit(hit: PixabayHit): Promise<{ bytes: Buffer; contentType: string } | null>;
  generateImage(prompt: string, aspectRatio: string): Promise<{ bytes: Buffer; contentType: string; costMicroUsd: number } | null>;
  saveImage(bytes: Buffer, basePath: string, contentType: string): Promise<{ gcs_path: string; content_type: string; bytes: number } | null>;
  signedUrl(gcsPath: string): Promise<string>;
  now(): Date;
}

async function generateViaStudio(prompt: string, aspectRatio: string) {
  const res = await generate("image.generate", { prompt, aspectRatio, n: 1 }, { provider: "vertex", model: ATMOSPHERE.IMAGE_MODEL });
  const a = res.assets[0];
  if (!a?.bytes) return null;
  // An unpriced generation is counted at the estimate, never at $0.
  const usd = res.cost.unpriced ? ATMOSPHERE.GENERATION_ESTIMATE_MICRO_USD / 1e6 : res.cost.amountUsd;
  return { bytes: a.bytes, contentType: a.mimeType, costMicroUsd: Math.round(usd * 1e6) };
}

export const defaultDeps: PickerDeps = {
  writeQueries, checkImage, pixabayConfigured, searchPixabay, downloadHit,
  generateImage: generateViaStudio,
  saveImage: async (bytes, basePath, contentType) => {
    const r = await saveBuffer(bytes, basePath, contentType);
    return "skipped" in r ? null : r;
  },
  signedUrl: (p) => signedUrl(p, ATMOSPHERE.SIGNED_URL_TTL_MS),
  now: () => new Date(),
};

// ─── Input ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SlotInput {
  /** The slot's stable key on its screen (e.g. "header", "goal:<id>"). */
  key: string;
  type: SlotType;
  purpose: string;
  context?: string | null;
  /** The category the default falls back to (a goal or recommendation domain). Passed back as given. */
  category?: string | null;
}

export class PickerInputError extends Error {}

const KEY_RE = /^[A-Za-z0-9:_.\-]{1,120}$/;

/** The purpose as reuse matches it: lower case, words only, plus the slot's orientation (a portrait slot never reuses a landscape). */
export function purposeKeyOf(type: SlotType, purpose: string): string {
  const words = purpose.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
  return `${SLOT_SHAPE[type].orientation}:${words}`;
}

export function validateSlot(screen: unknown, s: any): { screen: string; slot: SlotInput } {
  if (typeof screen !== "string" || !KEY_RE.test(screen)) throw new PickerInputError("screen must be 1–120 letters, digits or : _ . -");
  if (!s || typeof s !== "object") throw new PickerInputError("each slot must be an object");
  if (typeof s.key !== "string" || !KEY_RE.test(s.key)) throw new PickerInputError("slot.key must be 1–120 letters, digits or : _ . -");
  if (!(SLOT_TYPES as readonly string[]).includes(s.type)) throw new PickerInputError(`slot.type must be one of ${SLOT_TYPES.join(", ")}`);
  if (typeof s.purpose !== "string" || !s.purpose.trim() || s.purpose.length > 200) throw new PickerInputError("slot.purpose must be 1–200 characters");
  if (s.context != null && (typeof s.context !== "string" || s.context.length > 300)) throw new PickerInputError("slot.context must be at most 300 characters");
  if (s.category != null && (typeof s.category !== "string" || s.category.length > 60)) throw new PickerInputError("slot.category must be at most 60 characters");
  return { screen, slot: { key: s.key, type: s.type, purpose: s.purpose.trim(), context: s.context?.trim() || null, category: s.category ?? null } };
}

// ─── Output ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * No credit line and no source link: owner decision 10 Oct 2026, the app shows no photographer credit anywhere. Credit,
 * licence and source stay in the table for our records only.
 */
export type PickResult =
  | { key: string; kind: "image"; imageId: string; url: string; width: number | null; height: number | null }
  | { key: string; kind: "default"; category: string | null; reason: string };

async function asImage(key: string, row: AtmosphereImageRow, deps: PickerDeps): Promise<PickResult> {
  return { key, kind: "image", imageId: row.id, url: await deps.signedUrl(row.gcs_path!), width: row.width, height: row.height };
}

/** Deterministic per slot: the same athlete, screen and slot pick the same index of the same stored list. */
export function slotIndex(athleteId: string, screen: string, slotKey: string, n: number): number {
  const h = createHash("sha256").update(`${athleteId}|${screen}|${slotKey}`).digest();
  return h.readUInt32BE(0) % n;
}

// ─── Caps ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a paid step of `microUsd` may not run now, or null when it may. */
export function capRefusal(s: store.SpendState, microUsd: number, opts: { generation?: boolean } = {}): string | null {
  if (opts.generation && s.generationsToday >= ATMOSPHERE.GENERATIONS_PER_ATHLETE_DAY) return "generation_cap";
  if (s.athleteToday + microUsd > ATMOSPHERE.ATHLETE_DAY_CAP_MICRO_USD) return "athlete_day_cap";
  if (s.athleteTotal + microUsd > ATMOSPHERE.ATHLETE_TOTAL_CAP_MICRO_USD) return "athlete_total_cap";
  if (s.everyoneToday + microUsd > ATMOSPHERE.DAY_CAP_MICRO_USD) return "day_cap";
  return null;
}

// ─── Fill: find, check and store one new image for a purpose ──────────────────────────────────────────────────────

const queryCache = new Map<string, { at: number; q: WrittenQueries }>();
const inflight = new Map<string, Promise<string>>();

/** Tests: forget cached queries and in-flight fills. */
export function resetPickerState(): void { queryCache.clear(); inflight.clear(); }

/** Fetch one new accepted image for (athlete, purpose). Returns "ok" or why it stopped. Shared by concurrent callers. */
function fillOnce(athleteId: string, slot: SlotInput, purposeKey: string, deps: PickerDeps): Promise<string> {
  const k = `${athleteId}|${purposeKey}`;
  const running = inflight.get(k);
  if (running) return running;
  const p = fill(athleteId, slot, purposeKey, deps)
    .catch((err) => { logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "atmosphere fill failed"); return "error"; })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

async function fill(athleteId: string, slot: SlotInput, purposeKey: string, deps: PickerDeps): Promise<string> {
  const now = deps.now();
  const scene = await store.readAthleteScene(athleteId);
  if (!scene) return "no_athlete";
  const shape = SLOT_SHAPE[slot.type];
  const req: SlotRequest = { type: slot.type, purpose: slot.purpose, context: slot.context ?? null };

  // 1. The queries (cached per athlete + purpose for a day, so a slot that found nothing does not pay again at once).
  let written = queryCache.get(`${athleteId}|${purposeKey}`);
  if (!written || now.getTime() - written.at > ATMOSPHERE.PIXABAY_CACHE_MS) {
    const refused = capRefusal(await store.readSpend(athleteId, now), ATMOSPHERE.MODEL_CALL_ESTIMATE_MICRO_USD);
    if (refused) return refused;
    const q = await deps.writeQueries(scene, req, now.toISOString().slice(0, 10));
    await store.addSpend(athleteId, now, { microUsd: q.cost.microUsd, modelCalls: 1 });
    written = { at: now.getTime(), q };
    queryCache.set(`${athleteId}|${purposeKey}`, written);
  }
  const { queries, imagePrompt } = written.q;

  const record = async (base: Omit<store.NewAtmosphereImage, "status" | "gcs_path" | "check_result" | "reject_reason" | "athlete_id" | "slot_type" | "purpose" | "purpose_key">, img: { bytes: Buffer; contentType: string }, check: CheckResult, extraCost: number) => {
    const common = {
      ...base, athlete_id: athleteId, slot_type: slot.type, purpose: slot.purpose, purpose_key: purposeKey,
      check_result: { ...check.answer, model: check.model, skill_version: check.skillVersion },
      cost_micro_usd: check.cost.microUsd + extraCost,
    };
    if (!check.accepted) {
      await store.insertImage({ ...common, status: "rejected", gcs_path: null, reject_reason: check.rejectReason ?? "rejected" });
      return false;
    }
    const saved = await deps.saveImage(img.bytes, `athletes/${athleteId}/atmosphere/${randomUUID()}`, img.contentType);
    if (!saved) return false;
    const size = parseImageSize(img.bytes);
    const row = await store.insertImage({
      ...common, status: "accepted", gcs_path: saved.gcs_path, content_type: saved.content_type, bytes: saved.bytes,
      width: size?.width ?? null, height: size?.height ?? null, reject_reason: null,
    });
    return !!row;
  };

  // 2. Pixabay.
  let stop = "no_match";
  if (deps.pixabayConfigured() && queries.length) {
    const seen = await store.seenSourceIds(athleteId);
    let checks = 0;
    outer: for (const query of queries) {
      let result: SearchResult;
      try {
        result = await deps.searchPixabay(query, shape.orientation);
      } catch (err) {
        if (err instanceof PixabayRateLimited) { stop = "pixabay_rate_limited"; break; }
        logger.warn({ athleteId, error: String((err as Error)?.message ?? err).slice(0, 120) }, "pixabay search failed");
        continue;
      }
      if (!result.cached) await store.addSpend(athleteId, now, { pixabayCalls: 1 });
      for (const hit of result.hits) {
        if (seen.has(String(hit.id))) continue;
        if (checks >= ATMOSPHERE.MAX_CHECKS_PER_SLOT) { stop = "check_limit"; break outer; }
        const refused = capRefusal(await store.readSpend(athleteId, now), ATMOSPHERE.MODEL_CALL_ESTIMATE_MICRO_USD);
        if (refused) return refused;
        const img = await deps.downloadHit(hit);
        seen.add(String(hit.id));
        if (!img) continue;
        checks++;
        const check = await deps.checkImage(img, req, query);
        await store.addSpend(athleteId, now, { microUsd: check.cost.microUsd, modelCalls: 1 });
        const ok = await record({
          source: "pixabay", source_id: String(hit.id), source_url: hit.pageURL,
          credit: pixabayCredit(hit.user), licence: PIXABAY_LICENCE, query,
        }, img, check, 0);
        if (ok) return "ok";
      }
    }
  } else if (!deps.pixabayConfigured()) {
    stop = "pixabay_not_configured";
  }

  // 3. Generation, the fallback.
  if (!imagePrompt) return stop;
  const refused = capRefusal(await store.readSpend(athleteId, now), ATMOSPHERE.GENERATION_ESTIMATE_MICRO_USD + ATMOSPHERE.MODEL_CALL_ESTIMATE_MICRO_USD, { generation: true });
  if (refused) return refused;
  const gen = await deps.generateImage(imagePrompt, shape.aspectRatio);
  if (!gen) return "generation_failed";
  await store.addSpend(athleteId, now, { microUsd: gen.costMicroUsd, generations: 1 });
  const check = await deps.checkImage(gen, req, imagePrompt);
  await store.addSpend(athleteId, now, { microUsd: check.cost.microUsd, modelCalls: 1 });
  const ok = await record({
    source: "generated", source_id: null, source_url: null, credit: GENERATED_CREDIT, licence: GENERATED_LICENCE, query: imagePrompt,
  }, gen, check, gen.costMicroUsd);
  return ok ? "ok" : "generation_rejected";
}

// ─── Pick ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function chooseStored(athleteId: string, screen: string, slot: SlotInput, purposeKey: string, deps: PickerDeps): Promise<PickResult | null> {
  // Two tries: a concurrent pick on the same screen can take the chosen image between the read and the insert.
  for (let attempt = 0; attempt < 2; attempt++) {
    const list = await store.reusableImages(athleteId, purposeKey, screen);
    if (!list.length) return null;
    const row = list[slotIndex(athleteId, screen, slot.key, list.length)];
    if (await store.placeImage(athleteId, screen, slot.key, row.id)) return asImage(slot.key, row, deps);
    const placed = await store.placedImage(athleteId, screen, slot.key);
    if (placed) return asImage(slot.key, placed, deps);
  }
  return null;
}

export async function pickSlot(athleteId: string, screen: string, slot: SlotInput, deps: PickerDeps = defaultDeps): Promise<PickResult> {
  const placed = await store.placedImage(athleteId, screen, slot.key);
  if (placed) return asImage(slot.key, placed, deps);

  const purposeKey = purposeKeyOf(slot.type, slot.purpose);
  const stored = await chooseStored(athleteId, screen, slot, purposeKey, deps);
  if (stored) return stored;

  const why = await fillOnce(athleteId, slot, purposeKey, deps);
  const fresh = await chooseStored(athleteId, screen, slot, purposeKey, deps);
  if (fresh) return fresh;
  return { key: slot.key, kind: "default", category: slot.category ?? null, reason: why === "ok" ? "taken" : why };
}

/** Several slots of one screen, in order, so each sees the ones before it and no image repeats on the screen. */
export async function pickScreen(athleteId: string, screen: string, slots: SlotInput[], deps: PickerDeps = defaultDeps): Promise<PickResult[]> {
  const out: PickResult[] = [];
  for (const s of slots) {
    try {
      out.push(await pickSlot(athleteId, screen, s, deps));
    } catch (err: any) {
      logger.warn({ athleteId, screen, slot: s.key, error: String(err?.message ?? err).slice(0, 200) }, "atmosphere pick failed");
      out.push({ key: s.key, kind: "default", category: s.category ?? null, reason: "error" });
    }
  }
  return out;
}
