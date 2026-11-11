import React, { useMemo, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Dimensions,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import { Image } from "expo-image";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { BrandLogo } from "../BrandLogo";
import { type DealItem } from "./DealCard";
import { Bold, Fonts, Colors } from "../../constants/theme";
import { cachedSource } from "../../lib/imageCache";
import { SourceLinks } from "../ui/SourceLinks";

// ─────────────────────────────────────────────────────────────────────────────
// BrandDeckHero — the Airbnb-style swipeable brand story that sits above the deal
// detail. Each card is backed by a real brand photo (deal.brandImages, ranked) with
// the info on a frosted panel for legibility; missing photos degrade to a brand-tinted
// panel, and cards with no data are simply not built (card 1 identity is always shown).
//
// Cards, in order (data-driven):
//   1 · identity   — always (logo · brand · category)
//   2 · about      — brandDescription / brandSummary
//   3 · athletes   — brandKnownPartnerships (chips)
//   4 · audience   — brandAudienceSummary + brandSportCategories
//   5 · fit        — sport / audience / diversification rating pills
// ─────────────────────────────────────────────────────────────────────────────

const { width: SCREEN_W } = Dimensions.get("window");

// Full-bleed pages, no peek. The swipe affordance is the "1 / 4" counter chip in the
// bottom-right corner (Airbnb's grammar) — a peeking neighbour left square gaps at the
// rounded corners of the sheet below and made the hero read as a carousel of cards
// rather than one photo running edge to edge.
const CARD_W = SCREEN_W;
// Taller than the visible area on purpose: the content sheet overlaps the bottom of the
// photo by its corner radius, so the photo has to extend past where the sheet begins or
// the crop eats into the image and the sheet's rounded corners expose the page ground.
export const BRAND_HERO_HEIGHT = 372;

/**
 * How far the detail sheet rises OVER the deck (DealDetailScreen's sheet.marginTop).
 *
 * It lives here because the deck is what has to survive it: anything anchored to the
 * bottom of a card sits under the sheet unless it clears this. The identity pill did
 * exactly that — bottom-anchored with 16px of padding against a 30px overlap, so its
 * lower edge was cut off by the white.
 *
 * DealDetailScreen imports this rather than repeating the number, so the two cannot
 * drift apart.
 */
export const SHEET_OVERLAP = 30;

// On the dark hero: white for a good fit, muted white for fair (never a ring colour — those mean the score; 23 Oct 2026).
const RATING_COLOR: Record<string, string> = {
  poor: "#E87070",
  fair: Bold.onDarkMute,
  good: Bold.onDark,
  great: Bold.onDark,
};

const TINTS: [string, string][] = [
  ["#3A3227", "#6E5B3E"],
  ["#26332C", "#3E5A48"],
  ["#33262B", "#5A3E4C"],
  ["#262E3A", "#3E4E6E"],
  ["#332C26", "#5A4A3E"],
];

type Card =
  | { kind: "identity" }
  | { kind: "about"; text: string; sources: Array<{ url: string; title?: string | null }> }
  | { kind: "athletes"; items: string[] }
  | { kind: "audience"; text?: string; chips: string[] }
  | { kind: "fit"; ratings: { label: string; rating: string; value: string }[] };

export interface BrandDeckHeroProps {
  deal: DealItem;
  brandDisplayName: string;
}

export function BrandDeckHero({ deal, brandDisplayName }: BrandDeckHeroProps) {
  const C = Colors.light; // light only (one look, Oct 2026)
  const styles = useMemo(() => createStyles(), []);
  const [index, setIndex] = useState(0);

  const cards = useMemo<Card[]>(() => buildCards(deal), [deal]);
  const images = deal.brandImages ?? (deal.brandCover ? [deal.brandCover] : []);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / CARD_W);
    setIndex((prev) => (prev === i ? prev : i));
  }, []);

  return (
    <View style={[styles.wrap, { height: BRAND_HERO_HEIGHT }]}>
      <FlatList
        data={cards}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, i) => `deck-${i}`}
        onMomentumScrollEnd={onScroll}
        renderItem={({ item, index: i }) => (
          <BrandCard
            card={item}
            image={images[i] ?? null}
            tint={TINTS[i % TINTS.length]}
            brandDisplayName={brandDisplayName}
            brandCategory={deal.brandCategory}
            deal={deal}
            styles={styles}
          />
        )}
      />

      {/* Position counter only, bottom-right — Airbnb's grammar. The dot row moved out:
          it duplicated the counter, and at the top it collided with the floating back /
          save controls now sitting over the photo. */}
      {cards.length > 1 ? (
        <View style={styles.controls} pointerEvents="none">
          <View style={styles.counter}>
            <Text style={styles.counterText}>{index + 1} / {cards.length}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ─── One card ────────────────────────────────────────────────────────────────

function BrandCard({
  card,
  image,
  tint,
  brandDisplayName,
  brandCategory,
  deal,
  styles,
}: {
  card: Card;
  image: string | null;
  tint: [string, string];
  brandDisplayName: string;
  brandCategory?: string;
  deal: DealItem;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.card}>
      {image ? (
        <Image source={cachedSource(image)} style={StyleSheet.absoluteFill} cachePolicy="memory-disk" contentFit="cover" transition={220} />
      ) : (
        <LinearGradient colors={tint} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      )}
      {/* legibility scrim — heavier at the bottom where content sits */}
      <LinearGradient
        colors={["rgba(0,0,0,0.05)", "rgba(0,0,0,0.30)", "rgba(0,0,0,0.72)"]}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {card.kind === "identity" ? (
        <View style={styles.identityWrap}>
          <BlurView intensity={26} tint="light" style={styles.idPill}>
            <View style={styles.idLogo}>
              <BrandLogo brandName={deal.brandName} brandDomain={deal.brandDomain} size={22} borderRadius={6} />
            </View>
            {/* Brand + category on ONE line, the way the collapsed card renders it
                ("POPMART via Tec-Do" there, "POPMART · Toys" here). The nested Text
                flows inline so numberOfLines={1} truncates the whole line together.
                Stacking them made the pill two rows tall, which both disagreed with the
                card it expands from and pushed its own bottom edge under the sheet. */}
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.idName} numberOfLines={1}>
                {brandDisplayName}
                {brandCategory ? <Text style={styles.idCat}> · {brandCategory}</Text> : null}
              </Text>
            </View>
          </BlurView>
        </View>
      ) : (
        <View style={styles.panelWrap}>
          <BlurView intensity={34} tint="dark" style={styles.panel}>
            <Text style={styles.panelLabel}>{cardLabel(card, brandDisplayName)}</Text>
            <CardBody card={card} styles={styles} />
          </BlurView>
        </View>
      )}
    </View>
  );
}

function CardBody({ card, styles }: { card: Card; styles: ReturnType<typeof createStyles> }) {
  switch (card.kind) {
    case "about":
      return (
        <View style={{ gap: 8 }}>
          <Text style={styles.aboutText} numberOfLines={4}>{card.text}</Text>
          <SourceLinks sources={card.sources} onDark testID="brand-about-sources" />
        </View>
      );
    case "athletes":
      return (
        <View style={styles.chipRow}>
          {card.items.slice(0, 9).map((name, i) => (
            <View key={i} style={styles.athleteChip}>
              <Text style={styles.athleteChipText}>{name}</Text>
            </View>
          ))}
        </View>
      );
    case "audience":
      return (
        <View style={{ gap: 8 }}>
          {card.text ? <Text style={styles.aboutText} numberOfLines={3}>{card.text}</Text> : null}
          {card.chips.length ? (
            <View style={styles.chipRow}>
              {card.chips.map((c, i) => (
                <View key={i} style={styles.sportChip}>
                  <Text style={styles.sportChipText}>{c}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      );
    case "fit":
      return (
        <View style={{ gap: 7 }}>
          {card.ratings.map((r, i) => (
            <View key={i} style={styles.fitRow}>
              <View style={[styles.fitDot, { backgroundColor: RATING_COLOR[r.rating] ?? Bold.onDarkMute }]} />
              <Text style={styles.fitLabel}>{r.label}</Text>
              <Text style={styles.fitValue}>{r.value}</Text>
            </View>
          ))}
        </View>
      );
    default:
      return null;
  }
}

// ─── Data → cards ────────────────────────────────────────────────────────────

function buildCards(deal: DealItem): Card[] {
  const cards: Card[] = [{ kind: "identity" }];

  const about = deal.brandDescription || deal.brandSummary;
  // brandDescription is research (sources linked); brandSummary is the deal's own read of the thread (no web sources).
  if (about) cards.push({ kind: "about", text: about, sources: deal.brandDescription ? deal.brandSources ?? [] : [] });

  if ((deal.brandKnownPartnerships?.length ?? 0) > 0) {
    cards.push({ kind: "athletes", items: deal.brandKnownPartnerships! });
  }

  const sports = deal.brandSportCategories ?? [];
  if (deal.brandAudienceSummary || sports.length) {
    cards.push({ kind: "audience", text: deal.brandAudienceSummary, chips: sports });
  }

  const ratings: { label: string; rating: string; value: string }[] = [];
  if (deal.brandSportFit) ratings.push({ label: "Sport fit", rating: deal.brandSportFit.rating, value: deal.brandSportFit.label });
  if (deal.brandAudienceFit) ratings.push({ label: "Audience fit", rating: deal.brandAudienceFit.rating, value: deal.brandAudienceFit.label });
  if (deal.brandDiversification) ratings.push({ label: "Diversification", rating: deal.brandDiversification.rating, value: deal.brandDiversification.label });
  if (ratings.length) cards.push({ kind: "fit", ratings });

  return cards;
}

function cardLabel(card: Card, brand: string): string {
  switch (card.kind) {
    case "about": return `About ${brand}`;
    case "athletes": return "Athletes they work with";
    case "audience": return "Their audience";
    case "fit": return "Fit for you";
    default: return "";
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function createStyles() {
  return StyleSheet.create({
    wrap: { width: SCREEN_W, backgroundColor: "#0E0D0B" },
    // Square, full-bleed: the content sheet below supplies the rounded edge by sitting
    // ON TOP of the photo. Rounding the photo too left white square corners showing
    // through where the two radii didn't coincide.
    card: { width: CARD_W, height: BRAND_HERO_HEIGHT, justifyContent: "flex-end" },

    // identity (card 1)
    // Bottom padding clears the sheet, which rises SHEET_OVERLAP over the deck — without
    // it the pill's lower edge is simply covered by the white.
    identityWrap: { padding: 16, paddingBottom: 16 + SHEET_OVERLAP },
    idPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      alignSelf: "flex-start",
      paddingVertical: 7,
      paddingHorizontal: 10,
      borderRadius: 999,
      overflow: "hidden",
      backgroundColor: "rgba(255,255,255,0.32)",
      maxWidth: SCREEN_W - 32,
    },
    idLogo: { width: 22, height: 22, borderRadius: 6, overflow: "hidden", backgroundColor: "#fff" },
    idName: { fontFamily: Fonts.bodyBold, fontSize: 16, color: "#0E0D0B" },
    // Inline continuation of idName — no own line-height, or it would reintroduce the
    // second row it was moved out of.
    idCat: { fontFamily: Fonts.bodyMedium, fontSize: 11.5, color: "#3A352E" },

    // info panel (cards 2-5)
    panelWrap: { padding: 14 },
    panel: {
      borderRadius: 16,
      overflow: "hidden",
      paddingVertical: 13,
      paddingHorizontal: 14,
      gap: 8,
      backgroundColor: "rgba(20,18,16,0.42)",
    },
    panelLabel: {
      fontFamily: Fonts.bodySemiBold,
      fontSize: 10,
      letterSpacing: 0.8,
      textTransform: "uppercase",
      color: "rgba(255,255,255,0.72)",
    },
    aboutText: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 19, color: "#F4F1EC" },

    chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    athleteChip: {
      backgroundColor: "rgba(255,255,255,0.16)",
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    athleteChipText: { fontFamily: Fonts.bodyMedium, fontSize: 11.5, color: "#F4F1EC" },
    sportChip: {
      backgroundColor: "rgba(255,255,255,0.18)",
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    sportChipText: { fontFamily: Fonts.bodyMedium, fontSize: 11.5, color: "#DCEBFF" },

    fitRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    fitDot: { width: 8, height: 8, borderRadius: 4 },
    fitLabel: { flex: 1, fontFamily: Fonts.bodyMedium, fontSize: 12.5, color: "rgba(255,255,255,0.82)" },
    fitValue: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, color: "#FFFFFF" },

    // controls
    // Bottom-right, lifted clear of the content sheet that overlaps the photo's lower
    // edge by 30px — 38 left the chip only 8px of daylight above the sheet.
    controls: {
      position: "absolute",
      bottom: 48,
      right: 14,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
    },
    counter: {
      backgroundColor: "rgba(0,0,0,0.4)",
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    counterText: { fontFamily: Fonts.bodySemiBold, fontSize: 10.5, color: "#fff" },
  });
}
