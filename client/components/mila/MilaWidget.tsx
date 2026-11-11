import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { Feather } from "@expo/vector-icons";
import { DealCard, type DealItem, type DealStatus } from "../deals/DealCard";
import { ErrorBoundary } from "./ErrorBoundary";
import { MilaReplyWidget } from "./MilaReplyWidget";
import { MilaOnboardingWidget } from "./MilaOnboardingWidget";
import { MilaGoalWidget } from "./MilaGoalWidget";
import { MilaShopWidget } from "./MilaShopWidget";
import { haptics } from "../../lib/haptics";
import { Colors, Fonts, Spacing, BorderRadius } from "../../constants/theme";
import { SOFT_LIFT } from "./softLift";
import type {
  MilaWidget as MilaWidgetType,
  DealCardWidgetData,
  DealListWidgetData,
} from "../../hooks/use-mila-chat";

// Inline chat cards. The model chooses the widget type, so every render path
// here sits under an ErrorBoundary (see MilaWidget below) and tolerates missing
// fields — a malformed widget must fail soft, never crash the conversation.

const VALID_STATUS = new Set<DealStatus>([
  "detected",
  "pending",
  "negotiating",
  "accepted",
  "completed",
  "rejected",
]);

// ─── deal_card → DealCard ─────────────────────────────────────────────────────

function DealCardWidget({
  data,
  onReply,
  onOpenDeal,
}: {
  data: DealCardWidgetData;
  onReply?: (brandName: string) => void;
  /** Tapping the card opens the deal (it used to give press feedback and do nothing). */
  onOpenDeal?: (dealId: string) => void;
}) {
  // verdict + scoreNumeric are always NULL now (the deal score is gone — 0088) and
  // pass through as null, so DealCard shows an em-dash + "Not scored yet". source/sourceType/aiSummary aren't sourced from the deal row
  // (thread text stays in Mila's prose), so they keep neutral defaults: no
  // summary block renders and the source falls back to email.
  const deal: DealItem = {
    id: data.id,
    brandName: data.brandName,
    brandDomain: data.brandDomain,
    category: data.category,
    status: VALID_STATUS.has(data.status as DealStatus)
      ? (data.status as DealStatus)
      : "detected",
    verdict: data.verdict,
    source: "gmail",
    sourceType: "Email",
    score: data.scoreNumeric,
    timeAgo: data.timeAgo,
    aiSummary: "",
    offerDisplay: data.offerAmount ?? undefined,
  };
  // Read-only in chat: collapsed (skips the thread fetch) and its resolved action
  // bar is SUPPRESSED — DealCard's built-in Reply opens an in-card composer that
  // only renders once expanded, so in the always-collapsed chat card it's a dead
  // button. Instead, when a reply handler is wired, we show a Reply CTA that reuses
  // the ask-chip pipeline: it asks Mila to draft the reply, which renders a
  // reply_action card inline (draft_reply resolves thread/platform server-side, so
  // this card carries nothing new). No handler → no CTA, so no dead button ships.
  return (
    <View style={styles.dealWrap}>
      <DealCard
        deal={deal}
        isExpanded={false}
        onToggleExpand={() => { if (onOpenDeal && data.id) { haptics.tap(); onOpenDeal(data.id); } }}
        hideActionsWhenCollapsed
      />
      {onReply && (
        <Pressable
          style={({ pressed }) => [
            styles.replyCta,
            pressed && { opacity: 0.85 },
          ]}
          onPress={() => {
            haptics.press();
            // brandName originates from brand email data. It becomes a chat prompt,
            // so bound it — single line, capped — so a hostile display name can't
            // smuggle multi-line instructions into the turn. (Even unbounded, no
            // destructive tool is reachable and sending still needs a deliberate
            // tap, but keep the surface tight.)
            const safeBrand =
              data.brandName.replace(/\s+/g, " ").trim().slice(0, 80) ||
              "this brand";
            onReply(safeBrand);
          }}
          accessibilityRole="button"
        >
          <Feather
            name="corner-up-left"
            size={14}
            color={Colors.light.text}
          />
          <Text style={styles.replyCtaText}>Draft a reply</Text>
        </Pressable>
      )}
    </View>
  );
}

// ─── deal_list → stack of DealCard ────────────────────────────────────────────

function DealListWidget({
  data,
  onReply,
}: {
  data: DealListWidgetData;
  onReply?: (brandName: string) => void;
}) {
  // Pure positional map: each DealCardWidget closes over its OWN item, so its
  // Reply CTA submits that card's brand (DealCardWidget derives safeBrand from
  // data.brandName). No shared/hoisted brand — card N can only ever submit N's.
  return (
    <View style={styles.dealListWrap}>
      {data.deals.map((d) => (
        <DealCardWidget key={d.id} data={d} onReply={onReply} />
      ))}
    </View>
  );
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export function MilaWidget({
  widget,
  onReply,
  onOpenDeal,
  onOnboardingDone,
}: {
  widget: MilaWidgetType;
  /** deal_card: the card's tap opens the deal. Absent → the card stays read-only. */
  onOpenDeal?: (dealId: string) => void;
  // Wired by the chat screen to the ask-chip send pipeline. Only the deal_card
  // uses it (its Reply CTA); absent → the CTA doesn't render.
  onReply?: (brandName: string) => void;
  // onboarding_update only: the first entry is over (door tapped, or finished in
  // words). The onboarding screen closes itself off this.
  onOnboardingDone?: (door: "profile" | "deals" | null) => void;
}) {
  return (
    <ErrorBoundary>
      {widget.type === "deal_card" ? (
        <DealCardWidget data={widget.data} onReply={onReply} onOpenDeal={onOpenDeal} />
      ) : widget.type === "deal_list" ? (
        <DealListWidget data={widget.data} onReply={onReply} />
      ) : widget.type === "reply_action" ? (
        <MilaReplyWidget data={widget.data} />
      ) : widget.type === "onboarding_update" ? (
        <MilaOnboardingWidget data={widget.data} onDone={onOnboardingDone} />
      ) : widget.type === "goal_change" ? (
        <MilaGoalWidget data={widget.data} />
      ) : widget.type === "shop_item" ? (
        <MilaShopWidget data={widget.data} />
      ) : null}
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  dealWrap: { gap: Spacing.sm },
  dealListWrap: { gap: Spacing.md },
  replyCta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    alignSelf: "flex-start",
    minWidth: 120,
    height: 40,
    paddingHorizontal: 16,
    // A soft white chip lifted off the cream — no outline, no accent colour.
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.card,
    ...SOFT_LIFT,
  },
  replyCtaText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    color: Colors.light.text,
  },
});
