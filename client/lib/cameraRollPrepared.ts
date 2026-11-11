/**
 * cameraRollPrepared — the app-open check (EXPO_PUBLIC_CAMERA_ROLL_INTAKE; design "Media Intake Plan", option c).
 *
 * When the app opens (or comes back to the front) and she has ALREADY granted photo access, the phone looks at the
 * newest items on her camera roll. If at least a few are new since her last review, it prepares a review the same way
 * "Add from camera roll" does — small previews only, scored by the server — and keeps the result on the phone. Mila then
 * offers it in one tap, already scored; the review opens on that result.
 *
 * THE RULES IT KEEPS:
 *   • never asks for permission — getPermissionsAsync only; no access (or "selected photos only"), no look
 *   • on-device items only: nothing is downloaded from iCloud just to make a preview she didn't ask for
 *   • only while the app is open (JS on the foreground, no background task, no new native build)
 *   • only previews leave the phone; nothing full-size until she ticks it and taps Import
 *   • at most once every 6 hours per athlete, at most PREPARE_SCAN items, and only when PREPARE_MIN_NEW are new — so
 *     the server's daily preview cap is never the brake
 *   • a prepared review is offered for 20 hours (its previews live a day on the server); then it is discarded
 *   • items a check scored and found nothing worth keeping in are remembered, so the next check doesn't pay for them again
 *
 * Kept per athlete in AsyncStorage (on the phone only). Losing it is harmless: the next check prepares again.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import * as MediaLibrary from "expo-media-library/legacy";
import { CAMERA_ROLL_INTAKE } from "./flags";
import { loadReviewedIds } from "./reviewed-assets";
import { PREPARE_MIN_NEW, PREPARE_SCAN, preparedFresh, shouldCheck } from "./cameraRollIntakeLogic";
import { discardReview, isScreenshot, runCameraRollReview } from "../hooks/use-camera-roll-review";
import { currentOffer, setOffer, type PreparedReview } from "./cameraRollOffer";

export type { PreparedReview };

const preparedKey = (athleteId: string) => `nomila.cameraRoll.prepared.${athleteId}`;
const lastCheckKey = (athleteId: string) => `nomila.cameraRoll.lastCheck.${athleteId}`;
const checkedKey = (athleteId: string) => `nomila.cameraRoll.checked.${athleteId}`;
const MAX_CHECKED = 2000;

let running: Promise<PrepareResult> | null = null;
/** The athlete the offer belongs to — the offer is cleared when another athlete signs in. */
let offerFor: string | null = null;

function notify(athleteId: string, p: PreparedReview | null): void {
  offerFor = athleteId;
  setOffer(p);
}

async function readJson<T>(key: string): Promise<T | null> {
  try { const raw = await AsyncStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
async function writeJson(key: string, v: unknown): Promise<void> {
  try { await AsyncStorage.setItem(key, JSON.stringify(v)); } catch { /* best effort */ }
}

/** The prepared review, when there is a fresh one. A stale one is discarded (server previews too) and forgotten. */
export async function loadPrepared(athleteId: string, now: number = Date.now()): Promise<PreparedReview | null> {
  const p = await readJson<PreparedReview>(preparedKey(athleteId));
  if (!p?.outcome?.sessionId) return null;
  if (preparedFresh(p.createdAt, now)) return p;
  await clearPrepared(athleteId, { discard: true, stale: p });
  return null;
}

/** Forget the prepared review — after she imported from it or cancelled it (`discard` deletes its previews too). */
export async function clearPrepared(athleteId: string, opts: { discard?: boolean; stale?: PreparedReview } = {}): Promise<void> {
  const p = opts.stale ?? (await readJson<PreparedReview>(preparedKey(athleteId)));
  if (opts.discard && p?.outcome?.sessionId) await discardReview(p.outcome.sessionId);
  try { await AsyncStorage.removeItem(preparedKey(athleteId)); } catch { /* best effort */ }
  notify(athleteId, null);
}

export type PrepareResult = "off" | "no_permission" | "ready" | "too_soon" | "nothing_new" | "nothing_worth" | "failed";

/**
 * The app-open check. Safe to call on every open and every return to the foreground: it decides for itself whether to
 * look. Never throws.
 */
export function prepareOnAppOpen(athleteId: string | null | undefined, now: number = Date.now()): Promise<PrepareResult> {
  if (!CAMERA_ROLL_INTAKE || Platform.OS === "web" || !athleteId) return Promise.resolve("off");
  running ??= prepare(athleteId, now).catch(() => "failed" as const).finally(() => { running = null; });
  return running;
}

async function prepare(athleteId: string, now: number): Promise<PrepareResult> {
  // Another athlete signed in on this phone: the last one's offer is not hers to see.
  if (offerFor !== null && offerFor !== athleteId) notify(athleteId, null);
  // Never ask: the check only runs on access she already gave.
  const perm = await MediaLibrary.getPermissionsAsync();
  if (!perm.granted) return "no_permission";
  // "Selected photos only" (iOS limited, Android 14 partial): she chose what Nomila sees, so a quiet "what's new" check
  // has nothing new to find — and on iOS the first library read of each launch pops the system's "select more photos"
  // sheet, which must never happen on an app open she didn't aim at the camera roll. Her own review still works.
  if (perm.accessPrivileges === "limited") return "no_permission";

  const existing = await loadPrepared(athleteId, now);
  if (existing) { notify(athleteId, existing); return "ready"; }
  if (!shouldCheck(now, await readJson<number>(lastCheckKey(athleteId)), false)) return "too_soon";
  await writeJson(lastCheckKey(athleteId), now);

  const reviewed = await loadReviewedIds(athleteId);
  const checked = new Set(await readJson<string[]>(checkedKey(athleteId)) ?? []);
  const seen = new Set([...reviewed, ...checked]);
  // A free look first: are there enough new items to be worth a preview at all?
  const page = await MediaLibrary.getAssetsAsync({
    first: PREPARE_SCAN,
    mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
  });
  const fresh = page.assets.filter((a) => !seen.has(a.id) && !isScreenshot(a));
  if (fresh.length < PREPARE_MIN_NEW) return "nothing_new";

  const outcome = await runCameraRollReview({ reviewedIds: seen, kind: "all", since: "last_review", scanLimit: PREPARE_SCAN, onDeviceOnly: true }, () => false, true);
  if (!outcome.keep.length) {
    // Nothing worth offering: delete the previews now, and don't pay to look at these again.
    await discardReview(outcome.sessionId);
    const ids = [...outcome.more, ...outcome.drop].map((p) => p.asset.id);
    await writeJson(checkedKey(athleteId), [...checked, ...ids].slice(-MAX_CHECKED));
    return "nothing_worth";
  }
  const prepared: PreparedReview = { createdAt: now, outcome };
  await writeJson(preparedKey(athleteId), prepared);
  notify(athleteId, prepared);
  return "ready";
}

/** The prepared review held in memory for an athlete (null for anyone else). */
export const preparedNow = (athleteId: string): PreparedReview | null => (offerFor === athleteId ? currentOffer() : null);
