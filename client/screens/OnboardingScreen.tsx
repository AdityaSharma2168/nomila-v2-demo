/**
 * OnboardingScreen.tsx — the first entry: Mila, full screen, nothing else.
 *
 * RootGate renders this instead of the tabs while the athlete's onboarding run is waiting on
 * them (see use-onboarding-run). It is the Ask Mila overlay in its `onboarding` variant — same
 * chat, same voice bar, same widgets — with the close, history and new-chat controls hidden,
 * launched with context {type: "onboarding", id: runId} so the server appends the first-entry
 * block and offers the onboarding tools, and auto-opened with "Hi Mila." so Mila speaks first.
 *
 * It ends when the run does: the receipt card reports `next: "done"` (a door chosen in words) or
 * a door button is tapped. Either way onDone(door) tells the launcher which way to open the app.
 */

import React from "react";
import { MilaSearchOverlay } from "./MilaSearchOverlay";
import type { OnboardingDoor } from "../hooks/use-onboarding-run";

export function OnboardingScreen({
  runId,
  onDone,
}: {
  runId: string;
  onDone: (door: OnboardingDoor | null) => void;
}) {
  return (
    <MilaSearchOverlay
      visible
      variant="onboarding"
      onClose={() => { /* no close during the first entry — the run ends it */ }}
      initialContext={{ type: "onboarding", id: runId }}
      initialPrompt="Hi Mila."
      onOnboardingDone={onDone}
    />
  );
}
