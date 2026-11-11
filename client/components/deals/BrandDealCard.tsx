import React, { useMemo } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { Feather } from "@expo/vector-icons";
import { BrandLogo } from "../BrandLogo";
import { PlatformIcon } from "../PlatformIcon";
import {
  CATEGORY_CONFIG,
  STATUS_CONFIG,
  SOURCE_LABEL,
  type DealItem,
  type DealSource,
} from "./DealCard";
import { Fonts, Colors, Spacing, BorderRadius } from "../../constants/theme";
import { cachedSource } from "../../lib/imageCache";

// ─────────────────────────────────────────────────────────────────────────────
// BrandDealCard — the redesigned "Explore All" card: a brand-led surface.
//
// It composes the two approved pieces of the redesign: the brand IMAGE with a
// frosted-pill identity (the deal-detail hero's first card, collapsed), stacked
// over the collapsed-card CONTENT order — one-liner → summary → chips + score.
//
// Brand identity lives on the image, so it is never repeated in the body. When
// no brand cover exists yet (research/backfill hasn't run), the image band
// degrades to a deterministic brand-tinted gradient; the card stays legible.
// Tapping opens the pushed Deal Detail (no inline expand, no action bar here).
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  PAID: "Paid",
  MEDIA: "Media",
  EDITORIAL: "Product review",
  GIFTING: "Gifting",
};

// Deterministic 2-stop gradient for the no-image band (mirrors BrandLogo's hashed fallback feel).
const TINTS: [string, string][] = [
  ["#E7D9C4", "#B49A6E"],
  ["#DCE6E0", "#8FB0A0"],
  ["#E6D6DA", "#B98AA0"],
  ["#D9E0EA", "#8FA6C6"],
  ["#EADFCE", "#C6A878"],
  ["#E3DCEA", "#9E8CC0"],
];
function tintFor(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

export interface BrandDealCardProps {
  deal: DealItem;
  onPress: () => void;
}

export function BrandDealCard({ deal, onPress }: BrandDealCardProps) {
  const C = Colors.light; // light only (one look, Oct 2026)
  const styles = useMemo(() => createStyles(C), [C]);

  const cat = CATEGORY_CONFIG[deal.category] ?? CATEGORY_CONFIG.PAID;
  const statusLabel = STATUS_CONFIG[deal.status]?.label ?? deal.status.toUpperCase();

  // Same via-agency display rule as DealCard / DealDetailScreen.
  const brandDisplayName =
    deal.viaAgency && deal.agencyName && !deal.advertiser
      ? "Brand TBD"
      : deal.advertiser ?? deal.brandName;

  const offerLine = deal.offerDisplay ?? deal.offerAmount ?? null;
  const tint = tintFor(deal.brandName || deal.id);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.94 }]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${brandDisplayName} deal`}
    >
      {/* ── Brand image band + frosted-pill identity ── */}
      <View style={styles.band}>
        {deal.brandCover ? (
          <Image source={cachedSource(deal.brandCover)} style={StyleSheet.absoluteFill} cachePolicy="memory-disk" contentFit="cover" transition={200} />
        ) : (
          <LinearGradient colors={tint} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        )}
        {/* bottom scrim keeps the identity pill legible over any photo */}
        <LinearGradient
          colors={["transparent", "rgba(0,0,0,0.28)"]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <BlurView intensity={60} tint="light" style={styles.idPill}>
          <View style={styles.idLogo}>
            <BrandLogo brandName={deal.brandName} brandDomain={deal.brandDomain} size={24} borderRadius={7} />
          </View>
          {/* Agency provenance rides the identity pill, as it does on DealCard: an
              advertiser reached through an agency reads "POPMART via Tec-Do", never the
              agency alone. This line was lost when Explore All moved to this card. */}
          <Text style={styles.idName} numberOfLines={1}>
            {brandDisplayName}
            {deal.viaAgency && deal.agencyName && !!deal.advertiser ? (
              <Text style={styles.idVia}> via {deal.agencyName}</Text>
            ) : null}
          </Text>
          {deal.brandCategory ? (
            <Text style={styles.idCat} numberOfLines={1}>· {deal.brandCategory}</Text>
          ) : null}
        </BlurView>
      </View>

      {/* ── Content: one-liner → summary → chips + score ── */}
      <View style={styles.body}>
        {offerLine ? (
          <Text style={styles.oneLiner} numberOfLines={1}>{offerLine}</Text>
        ) : (
          <Text style={styles.noOffer}>No offer stated yet</Text>
        )}

        {deal.aiSummary ? (
          <Text style={styles.summary} numberOfLines={2}>{deal.aiSummary}</Text>
        ) : null}

        <View style={styles.foot}>
          <View style={styles.chips}>
            <View style={styles.statusPill}>
              <Text style={styles.statusPillText}>{statusLabel}</Text>
            </View>
            <View style={[styles.catChip, { backgroundColor: cat.color + "1A" }]}>
              <Feather name={cat.icon} size={10} color={cat.color} />
              <Text style={[styles.catChipText, { color: cat.color }]}>
                {CATEGORY_LABEL[deal.category] ?? deal.category}
              </Text>
            </View>
            <View style={styles.source}>
              <PlatformIcon platform={deal.source} color={C.textMuted} size={11} />
              <Text style={styles.sourceText} numberOfLines={1}>
                {SOURCE_LABEL[deal.source as DealSource] ?? deal.source} · {deal.timeAgo}
              </Text>
            </View>
            {deal.groupSize && deal.groupSize > 1 ? (
              <View style={styles.linkedChip}>
                <Feather name="link-2" size={9} color={C.textMuted} />
                <Text style={styles.linkedText}>{deal.groupSize}</Text>
              </View>
            ) : null}
          </View>

        </View>
      </View>
    </Pressable>
  );
}

type Palette = (typeof Colors)["light"] | (typeof Colors)["dark"];

function createStyles(C: Palette) {
  return StyleSheet.create({
    // Separating a white card from a near-white ground (#FFFFFF on the ground — a 1.5%
    // step) can't be done with a tint, so three neutral devices do it together:
    //   · a hairline in the FULL border token (Bold.line), not borderLight,
    //     which was itself near-invisible against the card
    //   · a soft drop shadow for lift, offset downward so the edge reads as an object
    //     sitting on the page rather than a rectangle drawn on it
    //   · generous space between cards, so the gap itself separates
    // No colour is introduced — the whole effect is edge, shadow and air.
    card: {
      backgroundColor: C.card,
      borderRadius: 22,
      // A full 1px (not hairline) in the darker border token. At hairline width on a
      // retina screen this edge renders sub-pixel and effectively disappears against a
      // white card — which is what made consecutive cards read as one column.
      borderWidth: 1,
      borderColor: C.border,
      overflow: "hidden",
      marginHorizontal: Spacing.lg,
      marginBottom: Spacing.lg + 6,
      // Deeper and further offset: the shadow, not the border, is what actually reads as
      // separation at a glance, and a 1.5% card-to-ground step gives it nothing to work
      // with unless it is pronounced.
      shadowColor: "#171513",
      shadowOpacity: 0.16,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
      elevation: 7,
    },

    // Image band — taller so a real brand photo has room to read as a photo rather
    // than a strip of colour.
    band: {
      height: 132,
      backgroundColor: C.backgroundSecondary,
      justifyContent: "flex-end",
    },
    // Identity pill: near-opaque white over the blur so the brand name is legible on
    // ANY cover (dark photos were washing out a 34%-alpha pill), with a hairline and
    // a soft shadow to lift it off busy imagery.
    idPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      alignSelf: "flex-start",
      margin: 10,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: BorderRadius.full,
      overflow: "hidden",
      backgroundColor: "rgba(255,255,255,0.82)",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "rgba(255,255,255,0.9)",
      shadowColor: "#000",
      shadowOpacity: 0.16,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
      elevation: 3,
    },
    idLogo: {
      width: 24,
      height: 24,
      borderRadius: 7,
      overflow: "hidden",
      backgroundColor: "#fff",
    },
    idName: {
      fontFamily: Fonts.bodyBold,
      fontSize: 15,
      letterSpacing: -0.2,
      color: "#0E0D0B",
      maxWidth: 180,
    },
    idVia: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 12.5,
      color: "#4A443C",
    },
    idCat: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 12,
      color: "#4A443C",
      flexShrink: 1,
    },

    // Content
    body: {
      paddingHorizontal: Spacing.md,
      paddingTop: 9,
      paddingBottom: Spacing.md,
      gap: 5,
    },
    oneLiner: {
      fontFamily: Fonts.display,
      fontSize: 15,
      color: C.text,
      letterSpacing: -0.2,
    },
    noOffer: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 12.5,
      color: C.textMuted,
      fontStyle: "italic",
    },
    summary: {
      fontFamily: Fonts.body,
      fontSize: 12.5,
      color: C.textSecondary,
      lineHeight: 18,
    },

    // Foot: chips (left) + score (right)
    foot: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      gap: 10,
      marginTop: 3,
    },
    chips: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 6,
    },
    statusPill: {
      backgroundColor: C.text,
      borderRadius: BorderRadius.full,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    statusPillText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 9.5,
      letterSpacing: 0.5,
      color: C.card,
    },
    catChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      borderRadius: BorderRadius.full,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    catChipText: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 10.5,
    },
    source: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      flexShrink: 1,
    },
    sourceText: {
      fontFamily: Fonts.bodyMedium,
      fontSize: 11,
      color: C.textMuted,
      flexShrink: 1,
    },
    linkedChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      backgroundColor: C.backgroundSecondary,
      borderRadius: BorderRadius.full,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    linkedText: { fontFamily: Fonts.bodySemiBold, fontSize: 10, color: C.textMuted },
  });
}
