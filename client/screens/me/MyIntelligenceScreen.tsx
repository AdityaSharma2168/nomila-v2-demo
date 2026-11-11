// Concept 0.4 · "My Intelligence" (DESIGN.md "My Intelligence", look B) — her M.I.A., decisive, not a dashboard. Reads
// GET /me/intelligence (my-intelligence/0.2) and GET /me/story (the differentiators the marketable rows read).
//
// Answers five questions and nothing else on the face:
//   Hero          her photo and "My Intelligence" in display caps, nothing more — the read is given ONCE, on the card below
//   Score card    the white card overlapping the hero: the ring with the number inside (each band a dimension's stored
//                 contribution) · Your marketability · Nomila's served read (strongest / thinnest, in words) · the read
//                 date · one quiet confidence line ("Why?" → the stored explanation, in a sheet) · the capital legend
//   Marketable    "What makes you marketable": Identity Intelligence's differentiators, up to three, each with where it
//                 comes from. Body text — never a quote, never an M.I.A. number, never a brand paired with a score
//   Signals       "Biggest strengths" · "Growth areas": her strongest / weakest NON-IMPUTED sub-signals, three each, a
//                 bar and the value; strengths in ink, growth in the one blue — never red, never "holding you back"
//   Help          "Help Nomila understand you better": only gaps SHE can resolve — her own open requests (a contract →
//                 AddContractSheet, a document or an answer → Mila) and imputed signals connecting would measure (→
//                 Connections; never offered when an insights account is already connected). Never a counterparty's
//                 request, never health.
//   Doors         What to do next (→ Strategy › Plan, with the waiting count) · Explore all 8 dimensions (the areas
//                 list, sub-signals and evidence inside) · Your platforms, measured (the measured level)
//
// Presentational only: every selection rule lives in lib/myIntelligenceLogic (ringBands, signalPicks, marketableRows,
// helpRows); pageState, State's conclusions and withholding come from the server. Movement renders nothing. BoldType
// roles and kit tiles only.

import React, { useState } from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MeStackParamList } from "../../navigation/MainTabNavigator";
import { leaveMeTo, openSettings } from "../../navigation/meNav";
import { openMila } from "../../lib/milaLaunch";
import { useMePool } from "../../hooks/use-me-knowledge";
import { useMeStory } from "../../hooks/use-me-story";
import { useConnections } from "../../hooks/use-connections";
import { useMeIntelligence, type MyIntelligenceAssessment, type MyIntelligenceView } from "../../hooks/use-me-intelligence";
import {
  COPY, IDENTITY_UNCONFIRMED_LINE, confidenceLine, confidenceWord, helpRows, marketableRows, meAnswer, nextCount, pageModel, readDate, ringBands, signalPicks,
  type HelpRow, type MarketableRow, type PageModel, type SignalPick,
} from "../../lib/myIntelligenceLogic";
import { connectedPlatformIds } from "../../lib/strategyLogic";
import { meImagery, photoUri } from "../../lib/myStoryLogic";
import { MeHero } from "../../components/me/MeHero";
import { ProvenanceGlyph } from "../../components/me/ProvenanceGlyph";
import { IntelligenceRing, RingLegend } from "../../components/intelligence/IntelligenceRing";
import { ConfidenceLine } from "../../components/intelligence/ConfidenceLine";
import { Card, Row, Chip, Button, Sheet, SheetDoor, IconTile, Eyebrow, RuledHead } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";

const AddContractSheet = React.lazy(() => import("../../components/deals/AddContractSheet").then((m) => ({ default: m.AddContractSheet })));

type NavProp = NativeStackNavigationProp<MeStackParamList, "Intelligence">;
type Feathers = React.ComponentProps<typeof Feather>["name"];

// Eyebrows are sentence case in copy; the eyebrow role sets them in capitals.
export const SECTION = {
  score: "Your marketability",
  marketable: "What makes you marketable",
  strengths: "Biggest strengths",
  growth: "Growth areas",
  help: "Help Nomila understand you better",
  next: { title: "What to do next", meta: "Recommendations waiting for you", waiting: (n: number) => `${n} waiting` },
  explore: { title: "Explore all 8 dimensions", meta: "Scores, signals and sources" },
  platforms: { title: "Your platforms, measured", meta: "What your accounts report, with dates" },
} as const;

export function MyIntelligenceScreen() {
  const navigation = useNavigation<NavProp>();
  const q = useMeIntelligence();
  const v = q.data;
  const pool = useMePool();
  const heroPhoto = meImagery(pool, "intelligence").hero;
  const photo = photoUri(heroPhoto);
  const [sheet, setSheet] = useState<null | "confidence" | "how">(null);
  const [contractFor, setContractFor] = useState<string | null>(null);

  if (!v) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        {q.isError ? (
          <View style={styles.centerText}>
            <Text style={styles.msgTitle}>{COPY.loadErrorTitle}</Text>
            <Button bold="small" onPress={() => q.refetch()}>Try again</Button>
          </View>
        ) : <ActivityIndicator color={Bold.ink} />}
      </SafeAreaView>
    );
  }

  const m = pageModel(v);
  const a = v.assessment;
  const onHelp = (r: HelpRow) => {
    if (r.kind === "add_contract") setContractFor(r.requestId ?? "");
    else if (r.kind === "connect") openSettings(navigation);
    else openMila({ context: { type: "brand" }, draft: r.draft ?? undefined });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={Bold.ink} />}
      >
        {/* S8 with last-good data: keep the page, say so. */}
        {q.isError ? (
          <View style={styles.banner}><Feather name="wifi-off" size={16} color={Bold.mute} /><Text style={styles.bannerText}>{COPY.loadErrorTitle}. {COPY.loadErrorBody}</Text></View>
        ) : null}

        <MeHero
          photoUrl={photo}
          photoKey={heroPhoto?.asset_id}
          onBack={() => navigation.goBack()}
          minHeight={m.mode === "read" ? 250 : 300}
          title={COPY.heroTitle}
          style={m.mode === "read" ? styles.heroRead : undefined}
          subtitle={m.mode === "read" ? null
            : <View style={styles.msgBlock}>
                <IconTile icon={m.icon as Feathers} size={44} bold="black" />
                <Text style={styles.msgTitleOnHero}>{m.title}</Text>
                {m.body.map((b) => <Text key={b} style={styles.msgBodyOnHero}>{b}</Text>)}
              </View>}
        />

        {m.mode === "read" && a ? (
          <ReadBody
            v={v} a={a} m={m}
            onConfidence={() => setSheet("confidence")}
            onHelp={onHelp}
            onNext={() => leaveMeTo(navigation, "Strategy", "StrategyRoot")}
            onExplore={() => navigation.navigate("IntelligenceAreas")}
            onPlatforms={() => navigation.navigate("Platforms")}
            onConnect={() => openSettings(navigation)}
          />
        ) : null}

        {/* Before the first read the measured door stays reachable: connected accounts' numbers show as soon as they
            are fetched and never wait on the M.I.A. */}
        {m.mode === "message" ? (
          <View style={[styles.body, styles.earlyDoors]}>
            <Card bold style={styles.doors}>
              <Row bold leading={<IconTile icon="bar-chart-2" bold="black" />} value={SECTION.platforms.title} meta={SECTION.platforms.meta} onPress={() => navigation.navigate("Platforms")} accessibilityLabel={SECTION.platforms.title} last />
            </Card>
          </View>
        ) : null}
      </ScrollView>

      {sheet === "confidence" && a ? (
        <Sheet onClose={() => setSheet(null)} eyebrow="How sure Nomila is" value={confidenceWord(a.overall.level) ?? "Not stated"}>
          <View style={styles.sheetBody}>
            {a.overall.explanation ? <Text style={styles.sheetText}>{a.overall.explanation}</Text> : null}
            {a.notes.evaluationRisks.length ? (
              <>
                <Eyebrow style={styles.sheetLabel}>Where it's limited</Eyebrow>
                {a.notes.evaluationRisks.map((r) => <Text key={r} style={styles.sheetBullet}>· {r}</Text>)}
              </>
            ) : null}
            <Text style={styles.sheetQuiet}>{COPY.interpretationNote}</Text>
          </View>
          <SheetDoor icon={<Feather name="info" size={16} color={Bold.ink} />} title={COPY.howTitle} subtitle="What it uses, and what it doesn't yet" onPress={() => setSheet("how")} divider />
        </Sheet>
      ) : null}
      {sheet === "how" ? (
        <Sheet onClose={() => setSheet(null)} title={COPY.howTitle} footer={a?.versions.methodology ? `Method ${a.versions.methodology}` : undefined}>
          <View style={styles.sheetBody}>
            <Text style={styles.sheetText}>{COPY.howUses}</Text>
            {a ? <Text style={styles.sheetText}>Read on {readDate(a.evidenceAsOf)}.</Text> : null}
            <Text style={styles.sheetText}>{COPY.howMovement}</Text>
          </View>
        </Sheet>
      ) : null}
      {contractFor !== null ? (
        <React.Suspense fallback={null}>
          <AddContractSheet visible onClose={() => setContractFor(null)} onCreated={() => setContractFor(null)} requestId={contractFor || undefined} />
        </React.Suspense>
      ) : null}
    </SafeAreaView>
  );
}

// ── the read ──────────────────────────────────────────────────────────────────

function ReadBody({ v, a, m, onConfidence, onHelp, onNext, onExplore, onPlatforms, onConnect }: {
  v: MyIntelligenceView; a: MyIntelligenceAssessment; m: Extract<PageModel, { mode: "read" }>;
  onConfidence: () => void; onHelp: (r: HelpRow) => void;
  onNext: () => void; onExplore: () => void; onPlatforms: () => void; onConnect: () => void;
}) {
  const story = useMeStory().data ?? null;
  const connections = useConnections();
  const conf = confidenceLine(a.overall.level);
  const read = meAnswer(a);
  const rows = marketableRows(story);
  const picks = signalPicks(a);
  const help = helpRows(v, connectedPlatformIds(connections.connections));
  const waiting = nextCount(v);
  const bands = m.early ? undefined : ringBands(a);

  return (
    <View style={styles.body}>
      {/* ── the score card: the number lives in the ring, once. DARK, like Me's M.I.A. card (the one look). ── */}
      <Card bold style={styles.scoreCard} testID="intelligence-score-card">
        <View style={styles.scoreRow}>
          <IntelligenceRing score={a.score} size={132} dark glow quiet={m.early} bands={bands} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Eyebrow onDark>{`${SECTION.score}${m.early ? ` · ${COPY.earlyRead}` : ""}`}</Eyebrow>
            {read && !m.early ? <Text style={[styles.read, styles.onDarkSoft]} testID="intelligence-read">{read}</Text> : null}
            <Text style={[styles.asOf, styles.onDarkMute]}>{`Read ${readDate(a.evidenceAsOf)}`}</Text>
            {v.identityUnconfirmed ? <Text style={[styles.asOf, styles.onDarkMute]} testID="intelligence-identity-unconfirmed">{IDENTITY_UNCONFIRMED_LINE}</Text> : null}
          </View>
        </View>
        {conf ? <ConfidenceLine text={`${conf}.`} onWhy={onConfidence} onDark testID="intelligence-confidence" /> : null}
        {bands && bands.length ? <RingLegend dark style={styles.legend} /> : null}
        {m.lines.map((l) => (
          <View key={l} style={styles.quietLine}><Feather name="clock" size={16} color={Bold.onDarkMute} /><Text style={[styles.quietText, styles.onDarkMute]}>{l}</Text></View>
        ))}
        {m.insufficientBody ? (
          <View style={{ marginTop: 12, gap: 8 }}>
            <Text style={[styles.msgBody, styles.onDarkSoft]}>{m.insufficientBody}</Text>
            <Button bold="primary" onPress={onConnect} style={{ alignSelf: "flex-start" }}>{COPY.connect}</Button>
          </View>
        ) : null}
        {m.reasonsMissing ? <Text style={[styles.quietNote, styles.onDarkMute]}>{COPY.reasonsNotSaved}</Text> : null}
      </Card>

      {/* ── what makes you marketable ── */}
      {rows.length ? (
        <Card bold style={styles.sect} testID="intelligence-marketable">
          <RuledHead title={SECTION.marketable} />
          {rows.map((r, i) => <MarketableRowView key={r.key} row={r} last={i === rows.length - 1} />)}
        </Card>
      ) : null}

      {/* ── biggest strengths · growth areas ── */}
      {picks.strengths.length || picks.growth.length ? (
        <Card bold style={styles.sigs} testID="intelligence-signals">
          <SignalColumn title={SECTION.strengths} picks={picks.strengths} tone="ink" />
          <SignalColumn title={SECTION.growth} picks={picks.growth} tone="blue" />
        </Card>
      ) : null}

      {/* ── help Nomila understand you better ── */}
      {help.length ? (
        <Card bold style={styles.sect} testID="intelligence-help">
          <RuledHead title={SECTION.help} />
          {help.map((r, i) => (
            <View key={`${r.kind}:${r.requestId ?? ""}`} style={[styles.helpRow, i === help.length - 1 && styles.last]}>
              <IconTile icon={r.kind === "add_contract" ? "file-text" : r.kind === "connect" ? "link" : "activity"} bold="black" />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.helpTitle}>{r.title}</Text>
                <Text style={styles.helpMeta} numberOfLines={2}>{r.meta}</Text>
              </View>
              <Button bold="small" onPress={() => onHelp(r)} accessibilityLabel={`${r.action}: ${r.title}`}>{r.action}</Button>
            </View>
          ))}
        </Card>
      ) : null}

      {/* ── the doors ── */}
      <Card bold style={styles.doors}>
        <Row
          bold
          leading={<IconTile icon="target" bold="black" />}
          value={SECTION.next.title} meta={SECTION.next.meta}
          trailing={waiting > 0 ? <Chip bold="blue">{SECTION.next.waiting(waiting)}</Chip> : undefined}
          onPress={onNext} accessibilityLabel={SECTION.next.title}
        />
        <Row bold leading={<IconTile icon="layers" bold="black" />} value={SECTION.explore.title} meta={SECTION.explore.meta} onPress={onExplore} accessibilityLabel={SECTION.explore.title} />
        <Row bold leading={<IconTile icon="bar-chart-2" bold="black" />} value={SECTION.platforms.title} meta={SECTION.platforms.meta} onPress={onPlatforms} accessibilityLabel={SECTION.platforms.title} last />
      </Card>
    </View>
  );
}

/** One differentiator: the black star tile, the text in body (never her quote style), a caption with its provenance. */
function MarketableRowView({ row, last }: { row: MarketableRow; last: boolean }) {
  return (
    <View style={[styles.mk, last && styles.last]} testID={`marketable-${row.key}`}>
      <IconTile icon="star" bold="black" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.mkText}>{row.text}</Text>
        <View style={styles.mkSource}><ProvenanceGlyph kind={row.glyph} size={12} /><Text style={styles.mkSourceText}>{row.sourceLine}</Text></View>
      </View>
    </View>
  );
}

function SignalColumn({ title, picks, tone }: { title: string; picks: SignalPick[]; tone: "ink" | "blue" }) {
  const fill = tone === "ink" ? Bold.ink : Bold.blue;
  return (
    <View style={styles.sigCol} testID={`signals-${tone}`}>
      <Eyebrow>{title}</Eyebrow>
      {picks.map((p) => (
        <View key={p.key} style={styles.sig} accessibilityLabel={`${p.label}, ${Math.round(p.value)} of 100${p.sourceWord ? `, ${p.sourceWord}` : ""}`}>
          <Text style={styles.sigLabel} numberOfLines={2}>{p.label}</Text>
          <View style={styles.sigTrack}><View style={[styles.sigFill, { width: `${Math.max(0, Math.min(100, p.value))}%`, backgroundColor: fill }]} /></View>
          <Text style={styles.sigMeta}><Text style={styles.sigValue}>{Math.round(p.value)}</Text>{p.sourceWord ? ` · ${p.sourceWord}` : ""}</Text>
        </View>
      ))}
      {!picks.length ? <Text style={styles.sigMeta}>Nothing to show yet.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: Bold.paper },
  center:        { alignItems: "center", justifyContent: "center" },
  centerText:    { alignItems: "center", gap: 8, paddingHorizontal: 20 },
  content:       { paddingBottom: 40 },
  banner:        { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: Bold.gutter, marginTop: 8, marginBottom: 8, padding: 8, borderRadius: Bold.radius.control, backgroundColor: Bold.ground },
  bannerText:    { flex: 1, ...BoldType.caption, color: Bold.mute },
  heroRead:      { paddingBottom: 30 },
  msgBlock:      { gap: 6, paddingBottom: 12 },
  msgTitleOnHero:{ ...BoldType.goal, color: Bold.onDark },
  msgBodyOnHero: { ...BoldType.heroLineSmall, color: Bold.onDarkSoft },
  msgTitle:      { ...BoldType.h4, color: Bold.ink, marginBottom: 6, textAlign: "left" },
  msgBody:       { ...BoldType.lede, color: Bold.ink2 },

  body:          { paddingHorizontal: Bold.gutter, gap: 14 },
  scoreCard:     { marginTop: -30, paddingHorizontal: 16, paddingVertical: 14, gap: 8, backgroundColor: Bold.ink, borderColor: Bold.ink },
  onDarkSoft:    { color: Bold.onDarkSoft },
  onDarkMute:    { color: Bold.onDarkMute },
  scoreRow:      { flexDirection: "row", alignItems: "center", gap: 14 },
  read:          { ...BoldType.read, color: Bold.ink2 },
  asOf:          { ...BoldType.caption, color: Bold.mute },
  legend:        { marginTop: 4 },
  quietLine:     { flexDirection: "row", gap: 6, alignItems: "flex-start" },
  quietText:     { flex: 1, ...BoldType.lede, color: Bold.mute },
  quietNote:     { ...BoldType.lede, color: Bold.mute },

  sect:          { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6 },
  // marketable
  mk:            { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Bold.line },
  last:          { borderBottomWidth: 0 },
  mkText:        { ...BoldType.body, color: Bold.ink2 },
  mkSource:      { flexDirection: "row", alignItems: "center", gap: 2, marginTop: 2 },
  mkSourceText:  { flex: 1, ...BoldType.caption, color: Bold.mute },

  // signals
  sigs:          { flexDirection: "row", gap: 14, padding: 14 },
  sigCol:        { flex: 1, gap: 10 },
  sig:           { gap: 5 },
  sigLabel:      { ...BoldType.sigLabel, color: Bold.ink },
  sigTrack:      { height: 6, borderRadius: 1, backgroundColor: Bold.ground, overflow: "hidden" },
  sigFill:       { height: 6 },
  sigMeta:       { ...BoldType.sigMeta, color: Bold.mute },
  sigValue:      { ...BoldType.sigValue, color: Bold.ink },

  // help
  helpRow:       { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: Bold.line },
  helpTitle:     { ...BoldType.rowTitle, color: Bold.ink },
  helpMeta:      { ...BoldType.rowMeta, color: Bold.mute },

  doors:         {},
  earlyDoors:    { marginTop: 14 },

  sheetBody:     { gap: 8, paddingBottom: 8 },
  sheetText:     { ...BoldType.body, color: Bold.ink2 },
  sheetLabel:    { marginTop: 8 },
  sheetBullet:   { ...BoldType.lede, color: Bold.ink2 },
  sheetQuiet:    { ...BoldType.caption, color: Bold.mute, marginTop: 4 },
});
