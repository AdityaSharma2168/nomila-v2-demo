/**
 * AskMilaAboutDeal — "Ask Mila" on a deal's detail: opens Ask Mila about THIS deal. The launch seeds the chat context
 * { type: "deal", id: <opportunity id>, brandName }, which the server turns into "OPENED FROM deal <id>" — the deals
 * preamble tells Mila to read that deal first — and the empty state offers the one-deal openers.
 *
 * Shown only when Mila can actually help with a deal: the new agent (AGENT_V3) with her deal tools on
 * (AGENT_DEALS_TOOLS). Otherwise it draws nothing — no dead tap, no promise the chat can't keep.
 */
import React from "react";
import { Pressable, Text, type StyleProp, type TextStyle } from "react-native";
import { openMila } from "../../lib/milaLaunch";
import { AGENT_DEALS_TOOLS, AGENT_V3 } from "../../lib/flags";
import { haptics } from "../../lib/haptics";

export function askMilaAboutDealEnabled(flags = { agentV3: AGENT_V3, dealsTools: AGENT_DEALS_TOOLS }): boolean {
  return flags.agentV3 && flags.dealsTools;
}

/** The launch it makes. Pure: unit-tested. */
export function dealLaunch(opportunityId: string, brandName: string | null | undefined) {
  return { context: { type: "deal" as const, id: opportunityId, ...(brandName?.trim() ? { brandName: brandName.trim() } : {}) } };
}

export function AskMilaAboutDeal({ opportunityId, brandName, textStyle }: { opportunityId: string; brandName?: string | null; textStyle?: StyleProp<TextStyle> }) {
  if (!askMilaAboutDealEnabled()) return null;
  return (
    <Pressable
      onPress={() => { haptics.tap(); openMila(dealLaunch(opportunityId, brandName)); }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`Ask Mila about ${brandName?.trim() || "this deal"}`}
      testID="detail-ask-mila"
    >
      <Text style={textStyle}>Ask Mila</Text>
    </Pressable>
  );
}
