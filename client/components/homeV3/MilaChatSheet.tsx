// Mila's chat opened IN PLACE over Home v3: the existing Ask Mila chat (screens/MilaSearchOverlay) as a frosted
// half-sheet (presentation "sheet"; drag up for full screen, down or a tap above it for Home). Seeded by what was tapped:
// a briefing chip's ask (SENT for her — "Draft a reply to …"; anything that would go out still waits for her Send), a
// draft in the composer (not sent), or the saved chat a suggestion lives in. It is the SAME conversation as the Mila
// tab: whichever surface is shown catches up with what the other said (useMilaChat's shared thread). A nav-chip in the
// chat closes the sheet and lands where the Mila tab's chips land (shellTabs.navTargetRoute).

import React from "react";
import { useNavigation } from "@react-navigation/native";
import { MilaSearchOverlay, type MilaNavTarget } from "../../screens/MilaSearchOverlay";
import { navTargetRoute } from "../../navigation/shellTabs";

export interface ChatSeed { draft?: string; conversationId?: string; prompt?: string }

export function MilaChatSheet({ seed, onClose }: { seed: ChatSeed | null; onClose: () => void }) {
  const navigation = useNavigation<any>();
  const onNavigate = (target: MilaNavTarget) => {
    onClose();
    const r = navTargetRoute(target);
    if (r.kind === "none") return;
    if (r.kind === "root") { navigation.navigate(r.screen, r.nested); return; }
    navigation.navigate(r.tab, r.screen ? { screen: r.screen, params: r.params } : undefined);
  };
  return (
    <MilaSearchOverlay
      visible={!!seed}
      presentation="sheet"
      onClose={onClose}
      onNavigate={onNavigate}
      initialContext={{ type: "brand" }}
      initialPrompt={seed?.prompt}
      initialDraft={seed?.draft}
      initialConversationId={seed?.conversationId}
    />
  );
}
