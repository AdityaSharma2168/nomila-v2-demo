/**
 * reviewed-assets — the local memory of which camera-roll photos have already been through
 * "Review my camera roll".
 *
 * ON THE PHONE, ON PURPOSE. These are ids of photos the athlete did NOT import — the whole point of
 * the flow is that they never became rows on our side, so the record of "we already looked at this
 * one" cannot live on our side either. It is a plain AsyncStorage list keyed per athlete (the same
 * persistence the mute list uses — client/components/deals/people/muteStore.ts), so a second run
 * only scores the photos she has taken since the first, which is what keeps a rescan cheap.
 *
 * Losing it is harmless: the worst case is that a rescan looks at everything again and she sees the
 * same suggestions. So there is no migration, no server sync and no error surfaced to the UI.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const key = (athleteId: string) => `nomila.cameraRoll.reviewed.${athleteId}`;

/** Cap the stored list — a very old roll should not grow an unbounded key. Newest ids win. */
const MAX_IDS = 5000;

export async function loadReviewedIds(athleteId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(key(athleteId));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** Union `ids` into the stored list. Called with BOTH the keepers and the drops after an import. */
export async function markReviewed(athleteId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const existing = await loadReviewedIds(athleteId);
    for (const id of ids) existing.add(id);
    const next = Array.from(existing).slice(-MAX_IDS);
    await AsyncStorage.setItem(key(athleteId), JSON.stringify(next));
  } catch {
    // best effort — see the header
  }
}

/** "Start over" — forget everything we've looked at for this athlete. */
export async function clearReviewed(athleteId: string): Promise<void> {
  try { await AsyncStorage.removeItem(key(athleteId)); } catch { /* best effort */ }
}
