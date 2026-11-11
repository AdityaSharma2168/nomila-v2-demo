/**
 * cameraRollOffer — the in-memory half of the app-open check (EXPO_PUBLIC_CAMERA_ROLL_INTAKE): which review is prepared
 * for the signed-in athlete right now, and who wants to know. No native module and no storage here, so a screen can
 * show Mila's offer without loading the camera-roll machinery; client/lib/cameraRollPrepared.ts fills it.
 */
import { useEffect, useState } from "react";
import type { ReviewOutcome } from "../hooks/use-camera-roll-review";

export interface PreparedReview {
  createdAt: number;
  outcome: ReviewOutcome;
}

type Listener = (p: PreparedReview | null) => void;
const listeners = new Set<Listener>();
let current: PreparedReview | null = null;

/** Set (or clear) the prepared review, and tell every listener. */
export function setOffer(p: PreparedReview | null): void {
  current = p;
  for (const l of listeners) l(p);
}

export const currentOffer = (): PreparedReview | null => current;

export function subscribeOffer(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The prepared review, or null — what Mila's one-tap offer reads. */
export function usePreparedReview(): PreparedReview | null {
  const [p, setP] = useState<PreparedReview | null>(current);
  useEffect(() => subscribeOffer(setP), []);
  return p;
}
