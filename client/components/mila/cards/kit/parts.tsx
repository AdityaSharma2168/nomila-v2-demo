/**
 * cards/kit/parts — the shared anatomy of every v2 card (design "Mila card designs" v2.2, "The card system v2"):
 *
 *   CardFrame   the surface: paper, corner 18, no border, the two-layer CARD_LIFT (Android: the hairline), media clipped
 *               to the top corners. Its body is one pressable (expand in chat, open the detail on a screen).
 *   CardMedia   the ONE image, in a named size (band 132 · bandSm 96 · thumb 4:5 · promo · tile 58×70): a chart drawn
 *               here from the stored figures, a LogoMark (or a stack of up to 3), a brand cover, the athlete's photo
 *               or clip frame (only while the screen's face budget allows), atmosphere — never a broken image: a
 *               missing picture draws the ground band with the card's glyph.
 *   KindChip    the frosted chip top-left on the image ("Insight", "Idea").
 *   AskMila     Mila's own action: the frosted pill with her 26 still and "Ask Mila" in ink (decision 9).
 *   Receipt     after a tap: an ink tick 22 + a past-tense line (+ one link), no live control left.
 *   SourceChip  a domain chip with its favicon (LogoMark 16) and a count; a tap opens its page (http(s) only) through
 *               the host's openLink.
 *
 * Only theme tokens (Bold, BoldType) and the one raspberry (Bold.act).
 */
import React from "react";
import { Image, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { CardMedia as Media } from "../../../../../shared/milaCards";
import { Bold, BoldType } from "../../../../constants/theme";
import { haptics } from "../../../../lib/haptics";
import { useAgentCardHandlers } from "../../../agent/handlers";
import { LogoMark } from "../../../ui/LogoMark";
import { Photo } from "../../../ui/Photo";
import { CARD_LIFT } from "../../softLift";
import { useFaceAllowed } from "./host";

const MILA_STILL = require("../../../../../assets/mila/mila-still.png");
export const CARD_RADIUS = 18;
type IconName = React.ComponentProps<typeof Feather>["name"];

export function CardFrame({ children, style, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View style={[styles.frame, style]} testID={testID}>
      <View style={styles.clip}>{children}</View>
    </View>
  );
}

/** The card's body: one tap target (expand in chat, open on a screen). */
export function CardBody({ onPress, label, expanded, children, style, testID }: { onPress?: () => void; label: string; expanded?: boolean; children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  if (!onPress) return <View style={style} testID={testID}>{children}</View>;
  return (
    <Pressable
      onPress={() => { haptics.tap(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={expanded == null ? undefined : { expanded }}
      style={({ pressed }) => [style, pressed && styles.pressed]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

export function KindChip({ label, onGround }: { label: string; onGround?: boolean }) {
  return (
    <View style={[styles.kind, onGround && styles.kindOnGround]} pointerEvents="none">
      <Text style={styles.kindText}>{label}</Text>
    </View>
  );
}

export type MediaShape = "band" | "bandSm" | "thumb" | "promo" | "tile";
const SHAPE: Record<MediaShape, ViewStyle> = {
  band: { height: 132 },
  bandSm: { height: 96 },
  thumb: { aspectRatio: 4 / 5 },
  promo: { height: 200 },
  tile: { width: 58, height: 70, borderRadius: 10 },
};

/**
 * A chart from stored figures, drawn here (never an image file). Legible at a glance: the series in ink (earlier points
 * at a soft ink, the latest solid and marked), the big number and the delta as an ink pill. The band gives the bars most
 * of the slot; the 58x70 tile shows the delta over the bars.
 */
function Chart({ chart, compact }: { chart: NonNullable<Media["chart"]>; compact: boolean }) {
  const max = Math.max(...chart.points.map((p) => Math.abs(p)), 1);
  const bars = (
    <View style={[styles.bars, compact ? styles.barsTile : styles.barsBand]} testID="card-chart-bars">
      {chart.points.map((p, i) => {
        const on = i === chart.highlight;
        return (
          <View key={i} style={styles.barCol}>
            {on && !compact ? <View style={styles.barDot} /> : null}
            <View style={[styles.bar, { height: `${Math.max(10, (Math.abs(p) / max) * 100)}%` as unknown as number }, on ? styles.barOn : null]} testID={on ? "card-chart-latest" : undefined} />
          </View>
        );
      })}
    </View>
  );
  if (compact) {
    return (
      <View style={[StyleSheet.absoluteFill, styles.chartWrapTile]}>
        <Text style={styles.chartDelta} numberOfLines={1} adjustsFontSizeToFit>{chart.delta ?? chart.big}</Text>
        {bars}
      </View>
    );
  }
  return (
    <View style={[StyleSheet.absoluteFill, styles.chartWrap]}>
      <View style={styles.stat}>
        <Text style={styles.statBig} numberOfLines={1}>{chart.big}</Text>
        {chart.delta ? <View style={styles.statDelta}><Text style={styles.statDeltaText}>{chart.delta}</Text></View> : null}
      </View>
      {bars}
    </View>
  );
}

function LogoStack({ media, size }: { media: Media; size: number }) {
  const list = media.brands?.length ? media.brands : media.brand ? [media.brand] : [];
  return (
    <View style={styles.stack}>
      {list.map((b, i) => (
        <View key={`${b.name}${i}`} style={[i > 0 && { marginLeft: -size * 0.25 }, styles.stackRing]}>
          <LogoMark logoUrl={b.logoUrl} domain={b.domain} name={b.name} size={size} />
        </View>
      ))}
    </View>
  );
}

export function CardMedia({ media, shape, kindLabel, faceKey, glyph = "image", overlay, testID }: {
  media: Media;
  shape: MediaShape;
  kindLabel?: string;
  /** The face budget's key for this image (decision 13). */
  faceKey: string;
  /** The fallback's glyph, and a capability's mark on atmosphere. */
  glyph?: IconName;
  overlay?: React.ReactNode;
  testID?: string;
}) {
  const allowed = useFaceAllowed(faceKey, media.hasFace);
  // A picture that fails to load (a signed URL past its hour on a reopened chat, a cover gone) draws the fallback: never
  // a broken image.
  const [failed, setFailed] = React.useState(false);
  const tile = shape === "tile";
  const isPhoto = media.kind === "athlete_photo" || media.kind === "content_thumb" || media.kind === "atmosphere" || media.kind === "brand_cover";
  const showPhoto = isPhoto && !!media.url && allowed && !failed;
  return (
    <View
      style={[styles.media, SHAPE[shape], !showPhoto && styles.mediaGround]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={media.alt}
      testID={testID ?? `card-media-${media.kind}`}
    >
      {media.kind === "chart" && media.chart ? <Chart chart={media.chart} compact={tile} /> : null}
      {showPhoto ? <Photo uri={media.url!} cacheKey={media.mediaId ?? media.atmosphereId ?? null} style={StyleSheet.absoluteFill} accessibilityLabel={media.alt} onError={() => setFailed(true)} /> : null}
      {media.kind === "brand_logo" ? <View style={styles.center}><LogoStack media={media} size={tile ? 36 : 56} /></View> : null}
      {media.kind === "platform_mark" ? <View style={styles.center}><LogoMark platform={media.platform ?? null} name={media.alt} size={tile ? 36 : 56} /></View> : null}
      {media.kind === "brand_cover" && media.brand ? <View style={styles.coverLogo}><LogoMark logoUrl={media.brand.logoUrl} domain={media.brand.domain} name={media.brand.name} size={40} /></View> : null}
      {isPhoto && !showPhoto ? (
        <View style={styles.center} testID={!allowed ? "card-media-face-held" : "card-media-fallback"}>
          <View style={styles.glyphTile}><Feather name={glyph} size={tile ? 18 : 24} color={Bold.ink} /></View>
        </View>
      ) : null}
      {overlay}
      {kindLabel && !tile ? <KindChip label={kindLabel} onGround={!showPhoto} /> : null}
    </View>
  );
}

/** Mila's frosted pill (decision 9): frosted even when it is a card's only button, so raspberry always means "waits on you". */
export function AskMila({ onPress, label = "Ask Mila", testID = "card-ask-mila" }: { onPress: () => void; label?: string; testID?: string }) {
  return (
    <Pressable onPress={() => { haptics.press(); onPress(); }} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.ask, pressed && styles.pressed]} testID={testID}>
      <Image source={MILA_STILL} style={styles.askAvatar} accessibilityIgnoresInvertColors />
      <Text style={styles.askText}>{label}</Text>
    </Pressable>
  );
}

export function Receipt({ line, sub, link, testID = "card-receipt" }: { line: string; sub?: string | null; link?: { label: string; onPress: () => void } | null; testID?: string }) {
  return (
    <View style={styles.receipt} testID={testID} accessibilityLiveRegion="polite">
      <View style={styles.tick}><Feather name="check" size={12} color={Bold.onAct} /></View>
      <View style={styles.receiptBody}>
        <Text style={styles.receiptLine}>{line}</Text>
        {sub ? <Text style={styles.meta}>{sub}</Text> : null}
        {link ? <Pressable onPress={link.onPress} accessibilityRole="link" hitSlop={8}><Text style={styles.receiptLink}>{link.label}</Text></Pressable> : null}
      </View>
    </View>
  );
}

const siteOf = (url?: string | null) => { if (!url) return null; try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; } };

/** Only a web page opens from a chip: http(s), never another scheme. */
const webUrl = (url?: string | null) => { if (!url) return null; try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null; } catch { return null; } };

export function SourceChip({ label, url, site, more = 0 }: { label: string; url?: string | null; site?: string | null; more?: number }) {
  const { openLink } = useAgentCardHandlers();
  const domain = site || siteOf(url);
  const href = webUrl(url);
  const chip = (
    <>
      <LogoMark domain={domain} name={label} size={16} />
      <Text style={styles.srcText} numberOfLines={1}>{domain ?? label}{more > 0 ? ` +${more}` : ""}</Text>
    </>
  );
  if (!href || !openLink) return <View style={styles.src} testID="card-source">{chip}</View>;
  // On web the chip is a real <a href target=_blank> (react-native-web renders a View with href as an anchor), so it can be
  // middle-clicked or copied; a plain click still goes through openLink, so the default navigation is prevented.
  const webLink = Platform.OS === "web" ? ({ href, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } } as object) : {};
  return (
    <Pressable {...webLink} onPress={(e) => { (e as unknown as { preventDefault?: () => void })?.preventDefault?.(); haptics.tap(); openLink({ url: href }); }} accessibilityRole="link" accessibilityLabel={`${label}, open ${domain ?? "the source"}`}
      hitSlop={8} style={({ pressed }) => [styles.src, pressed && styles.pressed]} testID="card-source">
      {chip}
    </Pressable>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return <Feather name={open ? "chevron-up" : "chevron-down"} size={16} color={Bold.quiet} testID="card-chevron" />;
}

export const styles = StyleSheet.create({
  frame: {
    backgroundColor: Bold.paper, borderRadius: CARD_RADIUS, ...CARD_LIFT,
    ...(Platform.OS === "android" ? { borderWidth: StyleSheet.hairlineWidth, borderColor: Bold.line } : null),
  },
  clip: { borderRadius: CARD_RADIUS, overflow: "hidden" },
  pressed: { opacity: 0.92 },
  body: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 16, gap: 6 },
  headline: { ...BoldType.cardHeadline, color: Bold.ink },
  line: { ...BoldType.cardLine, color: Bold.ink2 },
  meta: { ...BoldType.cardMeta, color: Bold.mute },
  acts: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 },
  exp: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line, marginTop: 10, paddingTop: 10, gap: 8 },
  tiles: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, backgroundColor: Bold.ground, borderRadius: 12, paddingVertical: 9, paddingHorizontal: 10 },
  tileK: { ...BoldType.label, fontSize: 10, color: Bold.mute },
  tileV: { ...BoldType.cellValue, fontSize: 18, color: Bold.ink },
  tileD: { ...BoldType.caption, fontSize: 11.5, color: Bold.mute },
  row: { flexDirection: "row", gap: 12, alignItems: "center", paddingHorizontal: 14, paddingVertical: 12 },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  media: { position: "relative", overflow: "hidden", backgroundColor: Bold.ground },
  mediaGround: { backgroundColor: Bold.ground },
  center: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  glyphTile: { width: 44, height: 44, borderRadius: 12, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: Bold.line },
  coverLogo: { position: "absolute", left: 14, bottom: 12 },
  kind: {
    position: "absolute", left: 10, top: 10, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 9, backgroundColor: "rgba(255,255,255,0.88)",
    ...(Platform.OS === "web" ? ({ backdropFilter: "blur(10px)" } as object) : null),
  },
  kindOnGround: { backgroundColor: Bold.paper },
  kindText: { ...BoldType.cardKind, color: Bold.ink },
  chartWrap: { paddingHorizontal: 14, paddingBottom: 14, paddingTop: 14 },
  chartWrapTile: { paddingHorizontal: 7, paddingTop: 7, paddingBottom: 8 },
  chartDelta: { ...BoldType.chipLine, fontSize: 14, lineHeight: 16, fontWeight: "900", letterSpacing: -0.2, color: Bold.ink },
  stat: { position: "absolute", left: 14, bottom: 16, zIndex: 2, maxWidth: "38%" },
  statBig: { ...BoldType.cardBig, color: Bold.ink },
  statDelta: { alignSelf: "flex-start", marginTop: 6, backgroundColor: Bold.ink, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  statDeltaText: { ...BoldType.chipLine, fontSize: 13, lineHeight: 15, fontWeight: "800", color: Bold.paper },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 5 },
  barsBand: { position: "absolute", right: 14, bottom: 16, top: 40, width: "56%" },
  barsTile: { flex: 1, marginTop: 5, gap: 3 },
  barCol: { flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center" },
  bar: { alignSelf: "stretch", borderRadius: 3, backgroundColor: Bold.ink, opacity: 0.22 },
  barOn: { opacity: 1 },
  barDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Bold.ink, marginBottom: 4 },
  stack: { flexDirection: "row" },
  stackRing: { borderRadius: 12, borderWidth: 2, borderColor: Bold.paper },
  ask: {
    height: 44, borderRadius: 22, paddingLeft: 9, paddingRight: 16, flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "rgba(255,255,255,0.72)",
    ...(Platform.select({ web: { boxShadow: "0px 4px 16px rgba(26,26,26,0.10)", backdropFilter: "blur(20px)" } as object, ios: { shadowColor: "#1A1A1A", shadowOpacity: 0.1, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } }, default: { borderWidth: StyleSheet.hairlineWidth, borderColor: Bold.line } }) as object),
  },
  askAvatar: { width: 26, height: 26, borderRadius: 13 },
  askText: { ...BoldType.rowTitle, fontSize: 14, lineHeight: 18, color: Bold.ink },
  receipt: { flexDirection: "row", gap: 10, alignItems: "flex-start", marginTop: 6 },
  tick: { width: 22, height: 22, borderRadius: 11, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center", marginTop: 1 },
  receiptBody: { flex: 1, gap: 2 },
  receiptLine: { ...BoldType.rowTitle, fontSize: 14, color: Bold.ink },
  receiptLink: { ...BoldType.link, fontSize: 12, color: Bold.ink, textDecorationLine: "underline" },
  src: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", borderRadius: 999, backgroundColor: Bold.ground, paddingVertical: 3, paddingLeft: 4, paddingRight: 9 },
  srcText: { ...BoldType.cardMeta, fontWeight: "600", color: Bold.ink2 },
  fullBtn: { alignSelf: "stretch" },
});
