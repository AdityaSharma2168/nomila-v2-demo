/**
 * cards/kit/ScreenCards — the v2 cards on the app's own screens (design v2.2; EXPO_PUBLIC_MILA_CARDS_V2):
 *
 *   kitBriefingSlots    Home v3: Insight, Idea and Turn-on TAKE the briefing's compact slots in their COLLAPSED form
 *                       (decision 3; homeV3/MilaBriefing briefingLayout), each under Mila's one sentence; today's hero
 *                       stays. A tap opens the detail screen (Home is an app screen); the button acts directly; a
 *                       Turn-on opens its sheet. KitScreenHost gives them the screen's handlers and the kit host.
 *   WhatMilaCanDo       Me › What Mila can do (decision 16): re-exported from WhatMilaCanDo.tsx, which reads
 *                       GET /api/v1/me/mila/capabilities (every built switch, on · paused · off).
 *
 * The briefing reads GET /api/v1/me/mila/cards/surface. A card's link opens its screen through the shell's routes (the same map
 * the chat uses), and "Ask Mila" opens Mila with the words ready.
 */
import React from "react";
import { Image, Linking, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";
import type { MilaCardDto } from "../../../../../shared/milaCards";
import { Bold, BoldType } from "../../../../constants/theme";
import { apiRequest } from "../../../../lib/query-client";
import { chatTargetFor } from "../../../../lib/agent/navigate";
import { navTargetRoute } from "../../../../navigation/shellTabs";
import { AgentCardHandlersProvider, type AgentCardHandlers } from "../../../agent/handlers";
import { CardKitHost, KitCard, type RecordOutcome } from "./index";
import type { BriefSlot } from "../../../homeV3/MilaBriefing";

const MILA_STILL = require("../../../../../assets/mila/mila-still.png");

export interface CardSurfaceData { briefing: MilaCardDto[]; capabilities: MilaCardDto[] }

export function useCardSurface(enabled: boolean) {
  return useQuery<CardSurfaceData>({
    queryKey: ["/api/v1/me/mila/cards/surface"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await (await apiRequest("GET", "/api/v1/me/mila/cards/surface")).json()) as CardSurfaceData,
  });
}

/** Taps that leave a card on an app screen: open its screen; words for Mila go to the host's chat. */
function useScreenHandlers(onAsk?: (text: string) => void): AgentCardHandlers {
  const navigation = useNavigation<any>();
  return {
    reply: (text) => onAsk?.(text),
    prefill: (text) => onAsk?.(text),
    openLink: (target) => {
      const t = chatTargetFor(target);
      if (!t) return;
      // A source's web page opens in the browser, as in the chat.
      if ("url" in t) { void Linking.openURL(t.url).catch(() => {}); return; }
      const r = navTargetRoute(t as never);
      if (r.kind === "none") return;
      if (r.kind === "root") { navigation.navigate(r.screen, r.nested); return; }
      navigation.navigate(r.tab, r.screen ? { screen: r.screen, params: r.params } : undefined);
    },
  };
}

const SAYS: Record<string, string> = { ideas: "Here's one I'd make.", insight: "Something changed in your numbers.", "turn-on": "I can do more for you." };

/** What a card on an app screen needs around it: the screen's handlers and the kit host (surface "screen"). */
export function KitScreenHost({ onAsk, record, children }: { onAsk?: (text: string) => void; record?: RecordOutcome; children: React.ReactNode }) {
  const handlers = useScreenHandlers(onAsk);
  return (
    <AgentCardHandlersProvider value={handlers}>
      <CardKitHost surface="screen" record={record}>{children}</CardKitHost>
    </AgentCardHandlersProvider>
  );
}

/**
 * The v2 cards as Home v3 briefing slots (decision 3): Mila's one sentence and the card, collapsed. They take the
 * briefing's compact slots (homeV3/MilaBriefing briefingLayout); draw them inside a KitScreenHost.
 */
export function kitBriefingSlots(cards: readonly MilaCardDto[]): BriefSlot[] {
  return cards.slice(0, 3).map((d) => ({
    key: d.data.id,
    text: SAYS[d.type] ?? "",
    node: <View testID={`home-v3-kit-${d.type}`}><KitCard dto={d} /></View>,
  }));
}

/** The kit's briefing items on their own (the gallery; Home draws them through MilaBriefing's slots). */
export function KitBriefing({ cards, onAsk, record }: { cards: MilaCardDto[]; onAsk?: (text: string) => void; record?: RecordOutcome }) {
  if (!cards.length) return null;
  return (
    <KitScreenHost onAsk={onAsk} record={record}>
      <View style={s.wrap} testID="home-v3-kit-briefing">
        {kitBriefingSlots(cards).map((slot) => (
          <View key={slot.key} style={s.message}>
            <View style={s.says}><Image source={MILA_STILL} style={s.still} /><Text style={s.bubble}>{slot.text}</Text></View>
            {slot.node}
          </View>
        ))}
      </View>
    </KitScreenHost>
  );
}

/** Me › What Mila can do: every built switch, from GET /me/mila/capabilities (WhatMilaCanDo.tsx). */
export { MeWhatMilaCanDo, WhatMilaCanDo } from "./WhatMilaCanDo";

const s = StyleSheet.create({
  wrap: { gap: 14 },
  message: { gap: 8 },
  says: { flexDirection: "row", alignItems: "center", gap: 8 },
  still: { width: 22, height: 22, borderRadius: 11 },
  bubble: { ...BoldType.read, color: Bold.ink, flex: 1 },
});
