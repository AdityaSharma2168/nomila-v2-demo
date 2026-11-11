/**
 * cards/kit/KitGallery — DEV ONLY (the agent gallery, /agent-gallery?s=cards-v2-*): each v2 card on its own, as it sits
 * in the chat (Mila's one lead-in sentence, then the card), collapsed or expanded, with taps answered locally (a fake
 * recorder: nothing reaches the server). The design page's own examples (fixtures.ts), all fictional.
 */
import React from "react";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { Bold, BoldType } from "../../../../constants/theme";
import { AgentCardHandlersProvider } from "../../../agent/handlers";
import { CardKitHost, KitCard, ConnectSheet, type RecordOutcome, type CardSurface } from "./index";
import { FIXTURE_LOGOS, KIT_FIXTURES, ME_CAPABILITIES_FIXTURE, type KitFixtureKey } from "./fixtures";

const MILA_STILL = require("../../../../../assets/mila/mila-still.png");

const ASK: Partial<Record<KitFixtureKey, string>> = { ideas: "What should I post this week?", "turn-on": "I never know what to post after a game.", answer: "Is Cobaltwave Hydration legit? Who have they worked with?" };
const LEAD: Record<KitFixtureKey, string> = {
  insight: "Something's changed in your reels.", ideas: "Your home opener is Saturday. Here's one I'd make.", "turn-on": "I can help with that.",
  once: "", answer: "Here's what I found.", deal: "Northpeak wants two reels.", "deals-list": "Two deals are open.",
};
const RECEIPT: Record<string, string> = { asked: "Asked Mila.", saved: "Saved.", idea_used: "Draft started in Studio. Nothing is posted until you tap Post.", enabled: "On. Turn it off any time in Me.", rule: "Saved as your rule." };
export const galleryRecord: RecordOutcome = async (o) => (o.outcome === "seen" ? "" : RECEIPT[o.action ?? ""] ?? "OK, not now.");

export function KitGalleryPage({ card, expanded = false, surface = "chat" }: { card: KitFixtureKey; expanded?: boolean; surface?: CardSurface }) {
  const dto = KIT_FIXTURES[card];
  const sheetOpen = card === "turn-on" && expanded;
  return (
    <AgentCardHandlersProvider value={{ reply: () => {}, prefill: () => {}, openLink: () => {} }}>
      <CardKitHost surface={surface} record={galleryRecord}>
        <ScrollView style={g.page} contentContainerStyle={g.content} testID={`kit-gallery-${card}-${expanded ? "expanded" : "collapsed"}`}>
          {ASK[card] ? <View style={g.bub}><Text style={g.bubText}>{ASK[card]}</Text></View> : null}
          <View style={g.ml}><Image source={MILA_STILL} style={g.still} /><Text style={g.mlText}>Mila</Text></View>
          {LEAD[card] ? <Text style={g.ans}>{LEAD[card]}</Text> : null}
          {sheetOpen && dto.type === "turn-on" ? (
            <ConnectSheet inline visible f={dto.data.fields} onTurnOn={() => {}} onNotNow={() => {}} onNever={() => {}} onClose={() => {}} />
          ) : <KitCard dto={dto} initialExpanded={expanded} />}
        </ScrollView>
      </CardKitHost>
    </AgentCardHandlersProvider>
  );
}

/**
 * Today's Home briefing for the gallery (made up): an offer as the hero, then a post and a moment as compact cards.
 * With the v2 cards on, they take the compact slots (homeV3/MilaBriefing briefingLayout), so the post and the moment
 * move into "2 more" — the hero is drawn exactly as today.
 */
export const GALLERY_BRIEFING = {
  messages: [
    {
      id: "offer:g1", kind: "offer" as const, text: "Morning, Sam — Northpeak wants two reels.",
      card: { name: "Northpeak Apparel", title: "Two reels for the fall drop", meta: "Paid content" },
      item: {
        id: "offer:g1", circle: "offers" as const, kicker: "Waiting on you", title: "Two reels for the fall drop", line: null,
        action: { label: "Open", target: { screen: "opportunity" as const, opportunityId: "o1", dealId: null } },
        logoUrl: FIXTURE_LOGOS.north, logoDomain: "northpeak.example", brandName: "Northpeak Apparel", brandColor: "#1E2A24",
        poster: { name: "Northpeak", amount: "$1,400", ask: "two reels" },
      },
      open: { kind: "open" as const, target: { screen: "opportunity" as const, opportunityId: "o1", dealId: null } },
      chips: [{ label: "Draft a reply", act: { kind: "ask" as const, prompt: "Draft a reply to Northpeak" }, primary: true }],
    },
    {
      id: "week:g2", kind: "post" as const, text: "Your reel for Wednesday is ready.",
      card: { name: null, title: "Warm-up routine", meta: "Wed · Reel" },
      item: { id: "week:g2", circle: "week" as const, kicker: "Wed · Reel", title: "Warm-up routine", line: null, action: { label: "Open", target: { screen: "post_kit" as const, id: "k1" } } },
      open: { kind: "open" as const, target: { screen: "post_kit" as const, id: "k1" } }, chips: [],
    },
    {
      id: "moment:g3", kind: "moment" as const, text: "Your home opener is Saturday.",
      card: { name: null, title: "Home opener", meta: "Sat 8 Nov" },
      item: { id: "moment:g3", circle: "moments" as const, kicker: "Sat 8 Nov", title: "Home opener", line: null, action: { label: "Open", target: { screen: "mila" as const } } },
      open: { kind: "open" as const, target: { screen: "mila" as const } }, chips: [],
    },
  ],
  overflow: 0,
};

/**
 * The cards on the app screens they appear on (PR B), as those screens draw them: Home v3's briefing (today's hero,
 * then the v2 cards in the compact slots), Me › What Mila can do, and All deals' rows as the shared row card (no
 * buttons). Home is the real MilaBriefing; the other screens' surrounding chrome is not drawn here.
 */
export function KitScreenPage({ screen, meSheet }: { screen: "home" | "me" | "all-deals"; /** Me: a row whose Turn-on sheet starts open. */ meSheet?: string }) {
  const { KitScreenHost, kitBriefingSlots, WhatMilaCanDo } = require("./ScreenCards") as typeof import("./ScreenCards");
  const { MilaBriefing } = require("../../../homeV3/MilaBriefing") as typeof import("../../../homeV3/MilaBriefing");
  const { DealRow } = require("./DealRowCard") as typeof import("./DealRowCard");
  const rows = KIT_FIXTURES["deals-list"].type === "deals-list" ? KIT_FIXTURES["deals-list"].data.fields.items : [];
  if (screen === "home") {
    return (
      <ScrollView style={g.page} contentContainerStyle={g.homeContent} testID="kit-screen-home">
        <Text style={[g.screenTitle, g.homeTitle]}>Home</Text>
        <KitScreenHost record={galleryRecord}>
          <MilaBriefing briefing={GALLERY_BRIEFING as never} onOpen={() => {}} onChip={() => {}} onMore={() => {}}
            slots={kitBriefingSlots([KIT_FIXTURES.ideas, KIT_FIXTURES.insight])} />
        </KitScreenHost>
      </ScrollView>
    );
  }
  return (
    <ScrollView style={g.page} contentContainerStyle={g.content} testID={`kit-screen-${screen}`}>
      <Text style={g.screenTitle}>{screen === "me" ? "Me" : "All deals"}</Text>
      {/* Me: one capability not yet on, and the same one as it reads once on (with its Turn off; nothing is sent here). */}
      {/* Me: draft replies on one inbox, one capability on, one paused, the rest off (taps answered locally). */}
      {screen === "me" ? <WhatMilaCanDo capabilities={ME_CAPABILITIES_FIXTURE} setChoice={async () => true} openSheetFor={meSheet} /> : null}
      {screen === "all-deals" ? rows.map((r) => (
        <View key={r.opportunityId} style={g.listRow}>
          <DealRow brand={r.brand} meta={r.stage} headline={`${r.brand.name} · ${r.moneyLine}`} sub={[r.typeLabel, r.lastActivity].filter(Boolean).join(" · ")} />
        </View>
      )) : null}
    </ScrollView>
  );
}

const g = StyleSheet.create({
  screenTitle: { ...BoldType.screenTitleSm, color: Bold.ink, marginBottom: 4 },
  listRow: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Bold.line },
  page: { flex: 1, backgroundColor: Bold.paper },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  homeContent: { paddingTop: 16, paddingBottom: 48 },
  homeTitle: { marginHorizontal: 16 },
  bub: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: Bold.ink, borderRadius: 16, borderBottomRightRadius: 4, paddingVertical: 10, paddingHorizontal: 14 },
  bubText: { ...BoldType.read, fontSize: 14.5, color: Bold.onDark },
  ml: { flexDirection: "row", alignItems: "center", gap: 8 },
  still: { width: 22, height: 22, borderRadius: 11 },
  mlText: { ...BoldType.rowTitle, fontSize: 13, color: Bold.ink },
  ans: { ...BoldType.read, fontSize: 15, lineHeight: 23, color: Bold.ink },
});
