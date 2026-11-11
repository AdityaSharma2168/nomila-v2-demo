// Serious offers — her side of the Partner door's refundable hold (design-public-card-v3 §6a, owner decision 8 Oct 2026).
//
//   <SeriousOffersSection items onOpenItem />   the board's FIRST section: requests whose brand placed a live hold, each
//                                               with its "Verified · $X held" badge and one line (days left to reply, or
//                                               "Replied · the hold counts toward the first payment if you agree").
//                                               Renders nothing when the flag is off or there are none.
//   <SeriousOfferSettings />                    (SeriousOfferSettings.tsx) her switch and amount.
//
// Self-contained on purpose: the Opportunities container and Me are another track's (app layout B). Mount points:
// SeriousOffersSection right under the board's header (already wired in OpportunityBoard.tsx, one line), and
// SeriousOfferSettings inside "Your public card" on Me once that section ships.
//
// Look B (DESIGN.md): white cards with a 1px line, black and white with the one blue, sharp corners, Outfit.
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Card } from "../ui/Card";
import { SectionHead } from "../ui/Bold";
import { LogoMark } from "../ui/LogoMark";
import { Bold, BoldType } from "../../constants/theme";
import { PARTNER_INTAKE } from "../../lib/flags";

/** What GET /me/opportunities carries for a request from her public card (server/services/partner/prequal.ts). */
export interface SeriousOfferBadgeData {
  amount_cents: number;
  state: "held" | "credited";
  badge: string;
  line: string;
  release_at: string | null;
  replied: boolean;
}

export interface SeriousOfferItem {
  opportunity_id: string;
  brand: { name: string; safe_logo_url: string | null };
  partner_request?: { kind_label: string; serious_offer: SeriousOfferBadgeData | null } | null;
}

export const SERIOUS_OFFER_COPY = {
  section: "Serious offers",
  sectionSub: "Brands that added a refundable hold. A hold never buys a yes.",
  settingsTitle: "Serious offers",
  settingsSub: "Brands can add a refundable hold",
  amount: "Hold amount",
  explain: "You never receive a hold by itself. It is released if you decline or don't reply within 6 days. If you agree a deal, it counts toward the brand's first payment.",
  others: "Requests without a hold still reach you, under your other opportunities.",
} as const;

export function SeriousOffersSection<T extends SeriousOfferItem>({ items, onOpenItem, enabled = PARTNER_INTAKE }: {
  items: T[] | undefined;
  onOpenItem: (item: T) => void;
  enabled?: boolean;
}) {
  const live = (items ?? []).filter((i) => i.partner_request?.serious_offer?.state === "held");
  if (!enabled || live.length === 0) return null;
  return (
    <View style={styles.section} testID="serious-offers">
      <SectionHead title={`${SERIOUS_OFFER_COPY.section} · ${live.length}`} sub={SERIOUS_OFFER_COPY.sectionSub} />
      <Card bold>
        {live.map((it, i) => {
          const so = it.partner_request!.serious_offer!;
          return (
            <Pressable key={it.opportunity_id} onPress={() => onOpenItem(it)} style={[styles.row, i === live.length - 1 && styles.last]}
                       accessibilityRole="button" accessibilityLabel={`${it.brand.name}. ${so.badge}. ${so.line}`} testID={`serious-offer-${it.opportunity_id}`}>
              <LogoMark logoUrl={it.brand.safe_logo_url} name={it.brand.name} size={36} />
              <View style={styles.rowTxt}>
                <View style={styles.titleRow}>
                  <Text style={styles.rowT} numberOfLines={1}>{it.brand.name}</Text>
                  <View style={styles.badge}><Feather name="check" size={11} color={Bold.onDark} /><Text style={styles.badgeT}>{so.badge}</Text></View>
                </View>
                {it.partner_request?.kind_label ? <Text style={styles.rowM} numberOfLines={1}>{it.partner_request.kind_label}</Text> : null}
                <Text style={so.replied ? styles.rowM : styles.rowBlue} numberOfLines={2}>{so.line}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Bold.quiet} />
            </Pressable>
          );
        })}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section:   { marginTop: 8, gap: 10, marginBottom: 8 },
  row:       { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  last:      { borderBottomWidth: 0 },
  rowTxt:    { flex: 1, gap: 2 },
  titleRow:  { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  rowT:      { ...BoldType.rowTitle, color: Bold.ink, flexShrink: 1 },
  rowM:      { ...BoldType.rowMeta, color: Bold.mute },
  rowBlue:   { ...BoldType.rowMeta, color: Bold.blue },
  badge:     { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: Bold.ink, borderRadius: Bold.radius.chip, paddingHorizontal: 6, height: Bold.chip },
  badgeT:    { ...BoldType.chip, color: Bold.onDark },
});
