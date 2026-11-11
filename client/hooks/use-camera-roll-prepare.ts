/**
 * use-camera-roll-prepare — runs the app-open check (EXPO_PUBLIC_CAMERA_ROLL_INTAKE; client/lib/cameraRollPrepared.ts
 * has the rules it keeps) when the signed-in app mounts and each time it comes back to the front. It never asks for
 * permission and does nothing with the flag off. The offer itself is read with usePreparedReview
 * (client/lib/cameraRollOffer.ts).
 */
import { useEffect } from "react";
import { AppState } from "react-native";
import { CAMERA_ROLL_INTAKE } from "../lib/flags";
import { prepareOnAppOpen } from "../lib/cameraRollPrepared";

export function useCameraRollPrepare(athleteId: string | null | undefined): void {
  useEffect(() => {
    if (!CAMERA_ROLL_INTAKE || !athleteId) return undefined;
    void prepareOnAppOpen(athleteId);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void prepareOnAppOpen(athleteId); });
    return () => sub.remove();
  }, [athleteId]);
}
