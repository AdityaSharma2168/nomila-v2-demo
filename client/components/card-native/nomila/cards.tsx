/**
 * nomila look — every card type (owner decision, 23 Oct 2026). The default look, and the fallback for any card a
 * look has not drawn and for a deck saved with a retired look, so a Nomila deck is 100% Nomila. Mirrors
 * server/services/themes/nomila.ts card for card (same layout, same roles, same one-raspberry rule).
 */
import React, { useEffect } from "react";
import { View, Text, Image, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { LinearGradient } from "expo-linear-gradient";
import Animated from "react-native-reanimated";
import { Rise, RiseText, AnimatedBar, CountUp, useRiseKey } from "../Chrome";
import { NomilaMark } from "../../book/mark";
import { IntelligenceRing } from "../../intelligence/IntelligenceRing";
import { BoldType } from "../../../constants/theme";
import { NM, NomilaPaper, NomilaPhoto, NLabel, NChip, Cobrand } from "./Chrome";
import type {
  CardProps, CoverCardData, IndexCardData, AudienceCardData, ContentCardData, VideoCardData, WhyFitsCardData,
  StoryCardData, ValuesCardData, AchievementsCardData, FitCardData, CampaignConceptCardData, ActivationPlanCardData,
  SignatureIdeaCardData,
} from "../types";

/** A long display line steps down so it never runs off the card (same rule as the web look). */
function fitSize(text: string, max: number, min: number, fits: number): number {
  const n = String(text ?? "").length;
  return n <= fits ? max : Math.max(min, Math.round(max * Math.sqrt(fits / n)));
}

// ── cover: full-bleed photo, the cardmark over a giant black-weight name ─────────────────────────────
export function NomilaCoverCard({ data, active }: CardProps<CoverCardData>) {
  const name = data.nameLines.join(" ").trim();
  const size = fitSize(name, 64, 40, 12);
  return (
    <NomilaPhoto uri={data.image} active={active}>
      <Rise delay={20} style={s.cardmark}>
        <NomilaMark size={24} dark />
        <Text style={s.cardmarkLabel}>Nomila · Nomi Card</Text>
      </Rise>
      <RiseText delay={90} style={[s.coverName, { fontSize: size, lineHeight: Math.round(size * 0.92) }]}>
        {data.nameLines.join("\n")}
      </RiseText>
      {!!data.hook && <RiseText delay={160} style={s.coverHook}>{data.hook}</RiseText>}
      {!!data.meta && <RiseText delay={220} style={s.coverMeta}>{data.meta}</RiseText>}
      {data.stats?.length > 0 && (
        <Rise delay={280} style={s.coverStats}>
          {data.stats.map((st, i) => (
            <View key={st.label} style={[s.cs, i > 0 && s.csSep]}>
              <Text style={s.csValue}>{st.value}</Text>
              <Text style={s.csLabel}>{st.label}</Text>
            </View>
          ))}
        </Rise>
      )}
    </NomilaPhoto>
  );
}

// ── index: the dark M.I.A. card with the ring ─────────────────────────────────────────────────────────
export function NomilaIndexCard({ data, active }: CardProps<IndexCardData>) {
  const playKey = useRiseKey(active);
  return (
    <View style={[s.frame, { backgroundColor: NM.ink }]}>
      <Animated.ScrollView style={StyleSheet.absoluteFill} contentContainerStyle={s.indexContent} showsVerticalScrollIndicator={false}>
        <View key={playKey} style={s.indexInner}>
          <NLabel onDark>{data.eyebrow}</NLabel>
          <Rise delay={80} style={s.ringWrap}>
            <IntelligenceRing score={data.value} size={188} dark glow outOf={`of ${data.max}`} />
          </Rise>
          {!!data.verdict && <RiseText delay={160} style={s.indexVerdict}>{data.verdict}</RiseText>}
          <RiseText delay={220} style={s.indexNote}>M.I.A. — Nomila's read of her marketability, out of {data.max}.</RiseText>
          <Rise delay={280} style={s.indexMark}>
            <NomilaMark size={18} dark />
            <Text style={s.indexMarkText}>Nomila</Text>
          </Rise>
        </View>
      </Animated.ScrollView>
    </View>
  );
}

// ── audience: a photo band over the white panel; ink bars on the grey track ──────────────────────────
export function NomilaAudienceCard({ data, active }: CardProps<AudienceCardData>) {
  const playKey = useRiseKey(active);
  const ages = data.ages ?? [];
  const maxAge = Math.max(1, ...ages.map((a) => a.pct));
  const plats = (data.platforms ?? []).filter((p) => p.pct > 0);
  const charted = ages.length > 0 || plats.length > 0;
  const geo = charted ? data.geo.slice(0, 3) : data.geo;
  const genders = (data.genders ?? []).map((g) => `${g.pct}% ${g.label.toLowerCase()}`).join(" · ");
  return (
    <View style={[s.frame, s.paperFrame]}>
      <View style={s.audPhoto}>
        {data.bg ? <Image source={{ uri: data.bg }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <LinearGradient colors={["rgba(0,0,0,0.4)", "rgba(0,0,0,0)"]} locations={[0, 0.45]} style={StyleSheet.absoluteFill} />
        <View style={s.audChip}><NChip tone="white">{data.eyebrow}</NChip></View>
      </View>
      <Animated.ScrollView style={s.audPanel} contentContainerStyle={s.audPanelContent} showsVerticalScrollIndicator={false}>
        <View key={playKey}>
          <Rise delay={60} style={s.audBig}>
            {data.share != null ? <CountUp value={data.share} active={active} suffix="%" style={s.audShare} /> : null}
            <Text style={s.audHeadline}>{data.headline}</Text>
          </Rise>
          {!!genders && <RiseText delay={90} style={s.caption}>{genders}</RiseText>}
          {!!data.sub && <NLabel delay={120} style={s.labelSm}>{data.sub}</NLabel>}
          {ages.length > 0 && (
            <Rise delay={160}>
              <Text style={[s.labelSmText]}>Age</Text>
              <View style={s.ages}>
                {ages.map((a) => (
                  <View key={a.label} style={s.ageCol}>
                    <Text style={s.ageVal}>{a.pct}%</Text>
                    <View style={[s.ageBar, { height: `${Math.max(4, Math.round((a.pct / maxAge) * 100))}%` }]} />
                    <Text style={s.ageLabel}>{a.label}</Text>
                  </View>
                ))}
              </View>
            </Rise>
          )}
          {geo.length > 0 && (
            <Rise delay={200} style={s.bars}>
              {geo.map((g, i) => (
                <View key={g.label} style={s.barRow}>
                  <Text style={s.barLabel} numberOfLines={1}>{g.label}</Text>
                  <View style={{ flex: 1 }}>
                    <AnimatedBar pct={g.pct ?? 0} active={active} delay={300 + i * 110} height={6} color={NM.ink} track={NM.track} />
                  </View>
                  <Text style={s.barValue}>{g.pct == null ? "" : `${Math.round(g.pct)}%`}</Text>
                </View>
              ))}
            </Rise>
          )}
          <Rise delay={260} style={s.footRow}>
            {charted && plats.length > 0 ? (
              <View style={{ flex: 1 }}>
                <View style={s.pbar}>
                  {plats.map((p, i) => <View key={p.label} style={{ width: `${p.pct}%`, backgroundColor: PLAT[Math.min(i, 3)] }} />)}
                </View>
                <View style={s.plab}>
                  {plats.map((p, i) => (
                    <View key={p.label} style={s.plabItem}>
                      <View style={[s.pdot, { backgroundColor: PLAT[Math.min(i, 3)] }]} />
                      <Text style={s.plabText}>{p.label} {compactN(p.n)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : data.stats.map((st, i) => (
              <View key={st.k} style={[s.fs, i > 0 && s.fsSep]}>
                <Text style={s.fsValue}>{st.n}</Text>
                <Text style={s.fsLabel}>{st.k}</Text>
              </View>
            ))}
          </Rise>
        </View>
      </Animated.ScrollView>
    </View>
  );
}
const PLAT = [NM.ink, "#6B6B6B", "#9A9A98", "#CFCFCC"];
const compactN = (n: number): string =>
  (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n)).replace(/\.0([KM])$/, "$1");

// ── content: the stat, the note and the tiles (the #1 post takes the one raspberry) ──────────────────
export function NomilaContentCard({ data, active }: CardProps<ContentCardData>) {
  const tiles = data.tiles;
  return (
    <NomilaPaper active={active}>
      <NLabel>{data.eyebrow}</NLabel>
      {!!data.heroStat?.value && (
        <Rise delay={60} style={s.heroStat}>
          <Text style={s.heroStatValue}>{data.heroStat.value}</Text>
          <Text style={s.heroStatLabel}>{data.heroStat.label}</Text>
        </Rise>
      )}
      {!!data.note && <RiseText delay={90} style={s.contentNote}>{data.note}</RiseText>}
      <Rise delay={150} style={s.tiles}>
        {tiles.map((t, i) => (
          <View key={i} style={[s.tile, tiles.length === 3 && i === 0 ? s.tileWide : s.tileHalf]}>
            {t.image ? <Image source={{ uri: t.image }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
            <LinearGradient colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.78)"]} locations={[0.45, 1]} style={StyleSheet.absoluteFill} />
            {i === 0 && <View style={s.rank}><NChip tone="act">#1 post</NChip></View>}
            <View style={s.tileStat}>
              <Text style={s.tileValue}>{t.stat}</Text>
              <Text style={s.tileLabel}>views</Text>
            </View>
          </View>
        ))}
      </Rise>
    </NomilaPaper>
  );
}

// ── video: the clip full-bleed, the line at the foot ─────────────────────────────────────────────────
export function NomilaVideoCard({ data, active }: CardProps<VideoCardData>) {
  const playKey = useRiseKey(active);
  const player = useVideoPlayer(data.videoUrl, (p) => { p.loop = true; p.muted = true; });
  useEffect(() => { if (active) player.play(); else player.pause(); }, [active, player]);
  return (
    <View style={[s.frame, { backgroundColor: NM.blank }]}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {data.posterUrl && !active
          ? <Image source={{ uri: data.posterUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          : <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />}
      </View>
      <View style={s.motionDot} />
      <LinearGradient colors={["rgba(0,0,0,0.35)", "rgba(0,0,0,0)", "rgba(0,0,0,0.82)"]} locations={[0, 0.38, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <Animated.ScrollView style={StyleSheet.absoluteFill} contentContainerStyle={s.videoContent} showsVerticalScrollIndicator={false}>
        <View key={playKey}>
          <NLabel onDark>{data.eyebrow}</NLabel>
          <RiseText delay={80} style={s.photoLine}>{data.note}</RiseText>
        </View>
      </Animated.ScrollView>
    </View>
  );
}

// ── numbered list (why she fits, all year): the first number takes the raspberry ────────────────────
function NumList({ rows }: { rows: Array<{ head: string; aud?: string; body: string }> }) {
  return (
    <View style={s.numList}>
      {rows.map((r, i) => (
        <Rise key={i} delay={160 + i * 60} style={s.numRow}>
          <Text style={[s.numN, i === 0 && { color: NM.act }]}>{String(i + 1).padStart(2, "0")}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.numHead}>{r.head}{r.aud ? <Text style={s.numAud}>{"  "}{r.aud}</Text> : null}</Text>
            <Text style={s.numBody}>{r.body}</Text>
          </View>
        </Rise>
      ))}
    </View>
  );
}

export function NomilaWhyFitsCard({ data, active }: CardProps<WhyFitsCardData>) {
  return (
    <NomilaPaper active={active} watermark>
      <Cobrand brand={data.brand} />
      <NLabel delay={30}>{data.eyebrow}</NLabel>
      <RiseText delay={80} style={s.lead}>{data.lead}</RiseText>
      <NumList rows={data.reasons.map((r) => ({ head: r.head, body: r.insight }))} />
      <RiseText delay={420} style={[s.caption, s.footLine]}>
        {data.brand.name}{data.brand.category ? ` · ${data.brand.category}` : ""} · {data.confidence.level === "inferred" ? "inferred from public signals" : "matched by Nomila"}
      </RiseText>
    </NomilaPaper>
  );
}

export function NomilaActivationPlanCard({ data, active }: CardProps<ActivationPlanCardData>) {
  return (
    <NomilaPaper active={active} watermark>
      <NLabel>{data.eyebrow}</NLabel>
      <RiseText delay={80} style={s.lead}>{data.lead}</RiseText>
      <NumList rows={data.buckets.map((b) => ({ head: b.label, aud: b.audience, body: b.line }))} />
      {!!data.close && <RiseText delay={420} style={[s.caption, s.footLine]}>{data.close}</RiseText>}
    </NomilaPaper>
  );
}

// ── story: the timeline; "now" takes the raspberry dot ──────────────────────────────────────────────
export function NomilaStoryCard({ data, active }: CardProps<StoryCardData>) {
  return (
    <NomilaPaper active={active} watermark>
      <NLabel>{data.eyebrow}</NLabel>
      <View style={s.rail}>
        {data.beats.map((b, i) => (
          <Rise key={`${b.year}-${i}`} delay={90 + i * 60} style={s.beat}>
            <Text style={s.beatYear}>{b.year}</Text>
            <View style={s.beatDotCol}>
              <View style={[s.beatDot, b.current && s.beatDotNow]} />
              {i < data.beats.length - 1 ? <View style={s.beatLine} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: 12 }}>
              <Text style={s.beatWhere}>{b.where}</Text>
              <Text style={s.beatText}>{b.line}</Text>
            </View>
          </Rise>
        ))}
      </View>
      {!!data.close && <RiseText delay={420} style={[s.lead, s.close]}>{data.close}</RiseText>}
    </NomilaPaper>
  );
}

// ── values: the statement in caps, the planks as grey tiles ─────────────────────────────────────────
export function NomilaValuesCard({ data, active }: CardProps<ValuesCardData>) {
  const size = fitSize(data.statement, 24, 18, 60);
  return (
    <NomilaPaper active={active} watermark>
      <NLabel>{data.eyebrow}</NLabel>
      <RiseText delay={80} style={[s.statement, { fontSize: size, lineHeight: Math.round(size * 1.08) }]}>{data.statement}</RiseText>
      <View style={s.planks}>
        {data.planks.map((p, i) => (
          <Rise key={p.name} delay={140 + i * 60} style={s.plank}>
            <Text style={s.plankName}>{p.name}</Text>
            {!!p.line && <Text style={s.plankLine}>{p.line}</Text>}
          </Rise>
        ))}
      </View>
      {!!data.note && <RiseText delay={420} style={[s.caption, s.footLine]}>{data.note}</RiseText>}
      {data.confidence.level === "self_reported" && (
        <RiseText delay={440} style={[s.caption, { marginTop: 6 }]}>Self-declared — the athlete's own words, not a Nomila claim.</RiseText>
      )}
    </NomilaPaper>
  );
}

// ── achievements: the hero entry on a grey tile with the raspberry badge, then the rows ─────────────
export function NomilaAchievementsCard({ data, active }: CardProps<AchievementsCardData>) {
  return (
    <NomilaPaper active={active} watermark>
      <NLabel>{data.eyebrow}</NLabel>
      <Rise delay={80} style={s.achHero}>
        {!!data.heroEntry.badge && <View style={{ marginBottom: 10 }}><NChip tone="act">{data.heroEntry.badge}</NChip></View>}
        <Text style={s.achName}>{data.heroEntry.name}</Text>
        <Text style={s.caption}>{[data.heroEntry.year, data.heroEntry.detail].filter(Boolean).join(" · ")}</Text>
      </Rise>
      <View style={s.recRows}>
        {data.entries.map((e, i) => (
          <Rise key={`${e.year}-${e.name}`} delay={150 + i * 50} style={[s.recRow, i === data.entries.length - 1 && s.recRowLast]}>
            <Text style={s.recYear}>{e.year}</Text>
            <Text style={s.recName}>{e.name}</Text>
            {!!e.level && <Text style={s.recLevel}>{e.level}</Text>}
          </Rise>
        ))}
      </View>
      {!!data.footnote && <RiseText delay={420} style={[s.caption, s.footLine]}>{data.footnote}</RiseText>}
    </NomilaPaper>
  );
}

// ── fit: her photo, the line in caps, white chips and the raspberry "Partner with" pill ─────────────
export function NomilaFitCard({ data, active, onShare, firstName = "her" }: CardProps<FitCardData> & { onShare?: () => void; firstName?: string }) {
  const size = fitSize(data.lead, 28, 20, 40);
  return (
    <NomilaPhoto uri={data.image} active={active} scrim="deep">
      <NLabel onDark>{data.eyebrow}</NLabel>
      <RiseText delay={80} style={[s.photoTitle, { fontSize: size, lineHeight: Math.round(size * 1.02) }]}>{data.lead}</RiseText>
      {data.tags.length > 0 && (
        <Rise delay={150} style={s.chips}>
          {data.tags.map((t) => <NChip key={t} tone="white">{t}</NChip>)}
        </Rise>
      )}
      <Rise delay={220}>
        <Pressable style={s.cta} onPress={onShare} accessibilityRole="button">
          <Feather name="send" size={16} color={NM.onDark} />
          <Text style={s.ctaText}>Partner with {firstName}</Text>
        </Pressable>
        <Text style={[s.caption, s.onDarkCaption, { textAlign: "center", marginTop: 10 }]}>Share this Nomi Card by text or email</Text>
      </Rise>
    </NomilaPhoto>
  );
}

// ── the brand creative cards: the concept (with the lockup) and the signature idea ──────────────────
function IdeaCard({ data, active, image, brand }: {
  data: { eyebrow: string; title: string; line: string; lineEmphasis: string; facets: string[]; note: string };
  active: boolean; image: string | null | undefined; brand: { name: string; logo?: string | null } | null;
}) {
  const size = fitSize(data.title, 34, 22, 24);
  return (
    <NomilaPhoto uri={image} active={active} scrim="deep" top={brand ? <Cobrand brand={brand} onDark /> : undefined}>
      <NLabel onDark>{data.eyebrow}</NLabel>
      <RiseText delay={80} style={[s.photoTitle, { fontSize: size, lineHeight: Math.round(size * 1.0) }]}>{data.title}</RiseText>
      <RiseText delay={140} style={s.photoLine}>
        {data.line} <Text style={s.photoLineEm}>{data.lineEmphasis}</Text>
      </RiseText>
      {data.facets.length > 0 && (
        <Rise delay={200} style={s.chips}>{data.facets.map((f) => <NChip key={f} tone="white">{f}</NChip>)}</Rise>
      )}
      {!!data.note && <RiseText delay={260} style={[s.caption, s.onDarkCaption, { marginTop: 12 }]}>{data.note}</RiseText>}
    </NomilaPhoto>
  );
}

export function NomilaCampaignConceptCard({ data, active }: CardProps<CampaignConceptCardData>) {
  return <IdeaCard data={data} active={active} image={data.image ?? data.brandImage ?? null} brand={data.brand} />;
}

export function NomilaSignatureIdeaCard({ data, active }: CardProps<SignatureIdeaCardData>) {
  return <IdeaCard data={data} active={active} image={data.image} brand={null} />;
}

const s = StyleSheet.create({
  frame: { flex: 1, borderRadius: NM.radius, overflow: "hidden" },
  paperFrame: { backgroundColor: NM.paper, borderWidth: 1, borderColor: NM.line },
  caption: { ...BoldType.caption, color: NM.mute },
  onDarkCaption: { color: NM.onDarkLabel },
  footLine: { marginTop: 18 },
  labelSm: { marginTop: 12 },
  labelSmText: { ...BoldType.label, color: NM.mute, marginTop: 12 },
  lead: { ...BoldType.goal, fontSize: 20, lineHeight: 25, color: NM.ink, marginTop: 10 },
  close: { marginTop: 16, fontSize: 18, lineHeight: 23 },
  statement: { ...BoldType.statement, color: NM.ink, marginTop: 10 },
  photoTitle: { ...BoldType.displaySm, color: NM.onDark, marginTop: 10 },
  photoLine: { ...BoldType.heroLine, color: NM.onDark, marginTop: 10 },
  photoLineEm: { ...BoldType.heroLine, fontFamily: "Outfit_900Black", fontWeight: "900", textDecorationLine: "underline", color: NM.onDark },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 14 },

  cardmark: { flexDirection: "row", alignItems: "center", gap: 9, marginBottom: 10 },
  cardmarkLabel: { ...BoldType.label, letterSpacing: 2.8, color: NM.onDark },
  coverName: { ...BoldType.display, color: NM.onDark, letterSpacing: -2 },
  coverHook: { ...BoldType.heroLine, color: NM.onDark, marginTop: 12, maxWidth: 300 },
  coverMeta: { ...BoldType.label, color: NM.onDarkLabel, marginTop: 14 },
  coverStats: { flexDirection: "row", marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.2)" },
  cs: { flex: 1 },
  csSep: { paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: "rgba(255,255,255,0.2)" },
  csValue: { ...BoldType.cellValue, color: NM.onDark },
  csLabel: { ...BoldType.outOf, color: NM.onDarkMute, marginTop: 4 },

  indexContent: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 22, paddingVertical: 36 },
  indexInner: { alignItems: "center" },
  ringWrap: { marginTop: 22 },
  indexVerdict: { ...BoldType.goal, fontSize: 20, lineHeight: 25, color: NM.onDark, textAlign: "center", marginTop: 22, maxWidth: 290 },
  indexNote: { ...BoldType.caption, color: NM.onDarkLabel, textAlign: "center", marginTop: 10, maxWidth: 260 },
  indexMark: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22 },
  indexMarkText: { ...BoldType.wordmark, textTransform: "uppercase", color: NM.onDark },

  audPhoto: { height: "36%", backgroundColor: NM.blank, overflow: "hidden" },
  audChip: { position: "absolute", top: 30, left: 22 },
  audPanel: { flex: 1 },
  audPanelContent: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 24 },
  audBig: { flexDirection: "row", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
  audShare: { ...BoldType.bigNumber, fontSize: 60, lineHeight: 58, color: NM.ink },
  audHeadline: { ...BoldType.section, color: NM.ink, flexShrink: 1 },
  ages: { flexDirection: "row", height: 64, gap: 6, alignItems: "flex-end", marginTop: 6 },
  ageCol: { flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center" },
  ageVal: { ...BoldType.outOf, letterSpacing: 0, color: NM.ink, marginBottom: 2 },
  ageBar: { width: "100%", borderTopLeftRadius: 4, borderTopRightRadius: 4, backgroundColor: NM.ink, maxHeight: 40 },
  ageLabel: { ...BoldType.outOf, letterSpacing: 0, color: NM.mute, marginTop: 3 },
  bars: { marginTop: 12, gap: 8 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  barLabel: { ...BoldType.caption, fontFamily: "Outfit_600SemiBold", fontWeight: "600", color: NM.ink2, width: 72 },
  barValue: { ...BoldType.sigValue, color: NM.ink, width: 38, textAlign: "right" },
  footRow: { flexDirection: "row", marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: NM.line },
  fs: { flex: 1 },
  fsSep: { paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: NM.line },
  fsValue: { ...BoldType.cellValue, color: NM.ink },
  fsLabel: { ...BoldType.outOf, color: NM.mute, marginTop: 4 },
  pbar: { flexDirection: "row", height: 8, borderRadius: 99, overflow: "hidden", backgroundColor: NM.track },
  plab: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 7 },
  plabItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  pdot: { width: 8, height: 8, borderRadius: 2 },
  plabText: { ...BoldType.outOf, color: NM.ink },

  heroStat: { flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 12 },
  heroStatValue: { ...BoldType.bigNumber, fontSize: 44, lineHeight: 46, color: NM.ink },
  heroStatLabel: { ...BoldType.label, color: NM.mute },
  contentNote: { ...BoldType.heroLine, color: NM.ink, marginTop: 8 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  tile: { height: 150, borderRadius: NM.radius, overflow: "hidden", backgroundColor: NM.ground },
  tileHalf: { width: "48.5%" },
  tileWide: { width: "100%", height: 170 },
  rank: { position: "absolute", top: 8, left: 8 },
  tileStat: { position: "absolute", left: 10, right: 8, bottom: 9 },
  tileValue: { ...BoldType.cellValue, fontSize: 24, lineHeight: 25, color: NM.onDark },
  tileLabel: { ...BoldType.outOf, color: "rgba(255,255,255,0.75)", marginTop: 2 },

  videoContent: { flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 22, paddingTop: 40, paddingBottom: 28 },
  motionDot: { position: "absolute", top: 28, right: 22, zIndex: 7, width: 9, height: 9, borderRadius: 4.5, backgroundColor: NM.act },

  numList: { marginTop: 18, gap: 14 },
  numRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  numN: { ...BoldType.h4, fontFamily: "Outfit_900Black", fontWeight: "900", color: NM.ink, width: 24 },
  numHead: { ...BoldType.h4, color: NM.ink },
  numAud: { ...BoldType.outOf, color: NM.mute },
  numBody: { ...BoldType.lede, color: NM.ink2, marginTop: 2 },

  rail: { marginTop: 16 },
  beat: { flexDirection: "row", gap: 10 },
  beatYear: { ...BoldType.h4, fontFamily: "Outfit_900Black", fontWeight: "900", color: NM.ink, width: 44 },
  beatDotCol: { width: 14, alignItems: "center", paddingTop: 5 },
  beatDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: NM.line },
  beatDotNow: { backgroundColor: NM.act, borderWidth: 3, borderColor: NM.actSoft, width: 14, height: 14, borderRadius: 7 },
  beatLine: { flex: 1, width: 1, backgroundColor: NM.line, marginTop: 4 },
  beatWhere: { ...BoldType.outOf, color: NM.mute },
  beatText: { ...BoldType.rowTitle, fontFamily: "Outfit_600SemiBold", fontWeight: "600", color: NM.ink, marginTop: 2 },

  planks: { marginTop: 16, gap: 8 },
  plank: { backgroundColor: NM.ground, borderRadius: NM.radius, paddingHorizontal: 14, paddingVertical: 12 },
  plankName: { ...BoldType.h4, color: NM.ink },
  plankLine: { ...BoldType.lede, color: NM.ink2, marginTop: 2 },

  achHero: { marginTop: 14, backgroundColor: NM.ground, borderRadius: NM.radius, padding: 14 },
  achName: { ...BoldType.screenTitleSm, fontSize: 24, lineHeight: 25, color: NM.ink, marginBottom: 6 },
  recRows: { marginTop: 12 },
  recRow: { flexDirection: "row", alignItems: "baseline", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: NM.line },
  recRowLast: { borderBottomWidth: 1, borderBottomColor: NM.line },
  recYear: { ...BoldType.sigValue, color: NM.ink, width: 46 },
  recName: { ...BoldType.rowTitle, fontFamily: "Outfit_600SemiBold", fontWeight: "600", fontSize: 14, color: NM.ink, flex: 1 },
  recLevel: { ...BoldType.outOf, color: NM.mute },

  cta: { marginTop: 18, height: 48, borderRadius: 999, backgroundColor: NM.act, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 },
  ctaText: { ...BoldType.button, color: NM.onDark },
});
