/**
 * lastHero — the Home hero she saw last, so the next launch draws it at once instead of waiting for GET /me/media and a
 * fresh download. Media urls are signed per request (they change every launch); the photo's asset id is the stable
 * key, and MeHero's disk cache (expo-image, cacheKey) serves the bytes from it. Per athlete. A convenience only: when
 * storage is missing or empty the hero waits for the library exactly as before, and the library's choice always wins.
 */

import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface HeroRef { uri: string; key: string }

const keyFor = (athleteId: string) => `nomila:lastHero:${athleteId}`;

export async function readLastHero(athleteId: string): Promise<HeroRef | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(athleteId));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.uri === "string" && typeof v.key === "string" ? { uri: v.uri, key: v.key } : null;
  } catch { return null; }
}

export async function writeLastHero(athleteId: string, hero: HeroRef): Promise<void> {
  try { await AsyncStorage.setItem(keyFor(athleteId), JSON.stringify(hero)); } catch { /* memory only */ }
}

/** The hero to draw: the library's current one when it is known, else the last one remembered for this athlete. */
export function useLastHero(athleteId: string | null | undefined, current: HeroRef | null): HeroRef | null {
  const [stored, setStored] = useState<HeroRef | null>(null);
  useEffect(() => {
    if (!athleteId) return;
    let live = true;
    void readLastHero(athleteId).then((h) => { if (live) setStored(h); });
    return () => { live = false; };
  }, [athleteId]);
  useEffect(() => {
    if (athleteId && current && current.key !== stored?.key) void writeLastHero(athleteId, current);
  }, [athleteId, current?.key, current?.uri]); // eslint-disable-line react-hooks/exhaustive-deps
  return current ?? stored;
}
