/**
 * athlete-selection — Phase A Step 3b (plan §3b §10). A user who holds more than one athlete membership must name the
 * athlete on every request (`X-Athlete-Id`); the server never picks the first row. The selection lives here in memory
 * and, when a storage exists, in AsyncStorage; the request helpers read it. Nothing here is authority: the server
 * validates the id against the user's memberships and answers 403 for one she does not hold.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "nomila:selectedAthleteId";
let selected: string | null = null;
let loaded = false;

export async function loadSelectedAthlete(): Promise<string | null> {
  if (loaded) return selected;
  loaded = true;
  try { selected = (await AsyncStorage.getItem(KEY)) || null; } catch { selected = null; }
  return selected;
}

export function getSelectedAthlete(): string | null { return selected; }

export async function setSelectedAthlete(id: string | null): Promise<void> {
  selected = id; loaded = true;
  try { if (id) await AsyncStorage.setItem(KEY, id); else await AsyncStorage.removeItem(KEY); } catch { /* memory only */ }
}

/** The header to add to every authenticated request, or nothing when no selection was ever needed. */
export function athleteHeader(): Record<string, string> {
  return selected ? { "X-Athlete-Id": selected } : {};
}
