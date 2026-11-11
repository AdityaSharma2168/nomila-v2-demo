/**
 * Scouting — the Scouting report, in ONE place: inline on Me (AGENT_V3), under her public page. Promoted from the
 * approved prototype (PR #900, client/screens/prototypes/ScoutingReport.tsx), now reading GET /me/scouting (scouting/1,
 * shared/meScouting.ts) and nothing else. Compact, so Me scrolls little; each section's detail opens in a sheet
 * (ScoutingSheetBody inside DetailSheet), never a second copy of the screen.
 *
 *   Head              "Your scouting report", the positioning statement, "<stage> · <band>", the identity line
 *   M.I.A.            the ring with the number inside, "Your marketability", the read's one line → My Intelligence
 *   The read          Working for you (top two) · Room to grow (top two) side by side, each dot in its area's ring tone
 *                     (grey when the note is untagged); the foot counts what isn't on record yet → sheet "notes", which
 *                     opens with the biggest upside and risk, then every tagged note
 *   What defines you  Today → Where you're headed in plain sentences (her input is woven in, never labelled), the pillars
 *                     as a rail of small ATMOSPHERE tiles (the category default while the picker has none) → sheet "defines"
 *   Your brands       Current and Past logo rows ("Since <year>" / "confirmed <date>" in the sheet); conflicts → "brands"
 *   Knows door        What Nomila knows: "<n> facts · <n> couldn't confirm" → What Nomila knows
 *
 * Every section card opens on a tap anywhere on it (DESIGN.md §11, the whole card is the target); its link is a cue.
 */
import React from "react";
import { View, Text, ScrollView, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { IntelligenceRing } from "../intelligence/IntelligenceRing";
import { Card, Eyebrow, IconTile, LinkText, LogoMark, Row, SectionHead } from "../ui";
import { Bold, BoldType } from "../../constants/theme";
import { ringBands } from "../../lib/myIntelligenceLogic";
import { brandSpan, knowsLine, sentence, stageLine } from "../../lib/frontDoorLogic";
import { AreaNotesCard, areaOf } from "./AreaNotesCard";
import { AtmosphereSlot } from "../frontDoor/Atmosphere";
import type { ScoutBrand, ScoutConflict, ScoutingReport, ScoutNote } from "../../../shared/meScouting";

export const SCOUT_COPY = {
  title: "Your scouting report",
  mia: "Your marketability",
  working: "Working for you",
  growth: "Room to grow",
  notYet: (n: number) => `${n} ${n === 1 ? "thing" : "things"} not on record yet`,
  detail: "See the detail",
  defines: "What defines you",
  from: "Today",
  to: "Where you're headed",
  pillars: "Your pillars",
  brands: "Your brands",
  current: "Current",
  past: "Past",
  unclear: "Not clear yet",
  noCurrent: "None yet",
  all: "See all",
  knows: "What Nomila knows",
  notesSheet: "Your read in detail",
  upside: "Biggest upside",
  risk: "Biggest risk",
} as const;

export type ScoutSheet = "notes" | "defines" | "brands";
export const SHEET_TITLE: Record<ScoutSheet, string> = { notes: SCOUT_COPY.notesSheet, defines: SCOUT_COPY.defines, brands: SCOUT_COPY.brands };

/** Pillar atmosphere, by pillar key (the picker's images; none → the category default). */
export type PillarImages = Record<string, { url: string; credit: string } | undefined>;

/** "Brand A and Brand B sell in the same category. Rules out Brand C." */
export const conflictLine = (c: Pick<ScoutConflict, "what" | "blocks">) => `${sentence(c.what)}${c.blocks.length ? ` Rules out ${c.blocks.join(", ")}.` : ""}`;

/** The dimension scores the read's bars draw (0–100), by dimension key. */
export function dimensionScores(r: ScoutingReport): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const d of r.mia?.assessment?.dimensions ?? []) out[d.key] = d.score;
  return out;
}

const dotTone = (n: ScoutNote) => areaOf(n.dimension)?.tone ?? Bold.quiet;

export function ScoutingInline({ report, pillarImages = {}, onSheet, onIntelligence }: {
  report: ScoutingReport;
  pillarImages?: PillarImages;
  onSheet: (s: ScoutSheet) => void;
  onIntelligence: () => void;
}) {
  const r = report;
  const mia = r.mia;
  const n = r.notes;
  const d = r.defines;
  const stage = r.hero.stage ? stageLine(r.hero.stage) : null;
  const a = mia?.assessment ?? null;
  const line = a?.summary ?? mia?.label ?? null;

  return (
    <View testID="me-scouting">
      <View style={styles.head}>
        <SectionHead title={SCOUT_COPY.title} />
        {r.hero.statement ? <Text style={styles.statement} testID="scout-statement">{r.hero.statement}</Text> : null}
        {stage ? <Text style={styles.stage} testID="scout-stage">{stage}</Text> : null}
        {r.hero.identity.line ? <Text style={styles.stage} testID="scout-identity">{r.hero.identity.line}</Text> : null}
      </View>

      {/* ── M.I.A., compact ── */}
      {mia && mia.score != null ? (
        <Pressable onPress={onIntelligence} accessibilityRole="button" accessibilityLabel={`${SCOUT_COPY.mia}, ${mia.score} of 850${line ? `. ${line}` : ""}`} style={({ pressed }) => [styles.mia, pressed && styles.pressed]} testID="scout-mia">
          <IntelligenceRing score={mia.score} bands={a ? ringBands(a as any) : undefined} size={64} />
          <View style={styles.miaText}>
            <Eyebrow>{SCOUT_COPY.mia}</Eyebrow>
            {line ? <Text style={styles.miaLine} numberOfLines={3}>{line}</Text> : null}
          </View>
          <Feather name="chevron-right" size={18} color={Bold.quiet} />
        </Pressable>
      ) : null}

      {/* ── the read: working for you · room to grow, side by side ── */}
      {n ? (
        <Pressable onPress={() => onSheet("notes")} accessibilityRole="button" accessibilityLabel={`${SCOUT_COPY.working} and ${SCOUT_COPY.growth}. ${SCOUT_COPY.detail}`} style={({ pressed }) => [pressed && styles.pressed]} testID="scout-notes-summary">
          <Card bold style={styles.card}>
            <View style={styles.cols}>
              {([["working", n.workingForYou], ["growth", n.roomToGrow]] as const).map(([k, list], i) => (
                <View key={k} style={[styles.col, i > 0 && styles.colLine]} testID={`scout-${k}`}>
                  <Eyebrow>{SCOUT_COPY[k]}</Eyebrow>
                  {list.slice(0, 2).map((x) => (
                    <View key={x.text} style={styles.noteRow}>
                      <View style={[styles.dot, { backgroundColor: dotTone(x) }]} />
                      <Text style={styles.noteText} numberOfLines={3}>{x.text}</Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
            <View style={styles.foot}>
              <Text style={styles.footText} testID="scout-not-yet">{SCOUT_COPY.notYet(n.notOnRecordCount)}</Text>
              <LinkText onPress={() => onSheet("notes")}>{SCOUT_COPY.detail}</LinkText>
            </View>
          </Card>
        </Pressable>
      ) : null}

      {/* ── what defines you: today → where you're headed, the pillars as a rail ── */}
      {d ? (
        <Pressable onPress={() => onSheet("defines")} accessibilityRole="button" accessibilityLabel={`${SCOUT_COPY.defines}. ${SCOUT_COPY.all}`} style={({ pressed }) => [pressed && styles.pressed]} testID="scout-defines-open">
          <Card bold style={styles.card} testID="scout-defines">
            <View style={styles.cardHead}>
              <Eyebrow>{SCOUT_COPY.defines}</Eyebrow>
              <LinkText onPress={() => onSheet("defines")}>{SCOUT_COPY.all}</LinkText>
            </View>
            {d.today ? <Text style={styles.line}><Text style={styles.lineLabel}>{`${SCOUT_COPY.from}  `}</Text>{sentence(d.today)}</Text> : null}
            {d.headed ? <Text style={styles.line} testID="scout-to"><Text style={styles.lineLabel}>{`${SCOUT_COPY.to}  `}</Text>{sentence(d.headed)}</Text> : null}
            {d.pillars.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail} style={styles.railBleed}>
                {d.pillars.map((p) => (
                  <View key={p.key} style={styles.pillar} testID={`scout-pillar-${p.key}`}>
                    <AtmosphereSlot image={pillarImages[p.key]} domain="positioning" height={PILLAR_H} style={styles.pillarImg} testID={`scout-pillar-img-${p.key}`} />
                    <Text style={styles.pillarLabel} numberOfLines={1}>{p.label}</Text>
                  </View>
                ))}
              </ScrollView>
            ) : <View style={styles.pad} />}
          </Card>
        </Pressable>
      ) : null}

      {/* ── your brands: two horizontal logo rows ── */}
      <Pressable onPress={() => onSheet("brands")} accessibilityRole="button" accessibilityLabel={SCOUT_COPY.brands} style={({ pressed }) => [pressed && styles.pressed]} testID="scout-brands">
        <Card bold style={styles.card}>
          <View style={styles.cardHead}>
            <Eyebrow>{SCOUT_COPY.brands}</Eyebrow>
            <LinkText onPress={() => onSheet("brands")}>{SCOUT_COPY.all}</LinkText>
          </View>
          <LogoRow label={SCOUT_COPY.current} brands={r.brands.current} empty={SCOUT_COPY.noCurrent} testID="scout-brands-current" />
          {r.brands.past.length ? <LogoRow label={SCOUT_COPY.past} brands={r.brands.past} testID="scout-brands-past" /> : null}
          {r.conflicts.map((c) => (
            <View key={c.what} style={styles.conflict} testID="scout-conflict">
              <Feather name="alert-circle" size={14} color={Bold.ink} />
              <Text style={styles.conflictText} numberOfLines={2}>{conflictLine(c)}</Text>
            </View>
          ))}
          {r.conflicts.length ? null : <View style={styles.pad} />}
        </Card>
      </Pressable>
    </View>
  );
}

function LogoRow({ label, brands, empty, testID }: { label: string; brands: ScoutBrand[]; empty?: string; testID?: string }) {
  return (
    <View style={styles.logoRow} testID={testID}>
      <Text style={styles.logoLabel}>{label}</Text>
      {brands.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.logos}>
          {brands.map((b) => <LogoMark key={b.name} bold logoUrl={b.logoUrl} domain={b.logoDomain} name={b.name} size={40} />)}
        </ScrollView>
      ) : empty ? <Text style={styles.empty}>{empty}</Text> : null}
    </View>
  );
}

/** A section's detail, in the sheet. */
export function ScoutingSheetBody({ kind, report, pillarImages = {}, now = new Date() }: { kind: ScoutSheet; report: ScoutingReport; pillarImages?: PillarImages; now?: Date }) {
  const r = report;
  if (kind === "notes") {
    const ru = r.riskUpside ?? null;
    return (
      <View>
        {ru ? (
          <Card bold style={styles.upside} testID="scout-upside-risk">
            <View style={styles.upCol}><Eyebrow>{SCOUT_COPY.upside}</Eyebrow><Text style={styles.upText}>{sentence(ru.upside)}</Text></View>
            <View style={styles.upRule} />
            <View style={styles.upCol}><Eyebrow>{SCOUT_COPY.risk}</Eyebrow><Text style={styles.upText}>{sentence(ru.risk)}</Text></View>
          </Card>
        ) : null}
        {r.notes ? <AreaNotesCard notes={r.notes.detail} scores={dimensionScores(r)} /> : null}
      </View>
    );
  }
  if (kind === "defines") {
    const d = r.defines;
    return (
      <View style={styles.sheetBody}>
        {d?.today ? <View style={styles.block}><Eyebrow>{SCOUT_COPY.from}</Eyebrow><Text style={styles.blockText}>{sentence(d.today)}</Text></View> : null}
        {d?.headed ? <View style={styles.block}><Eyebrow>{SCOUT_COPY.to}</Eyebrow><Text style={styles.blockStrong}>{sentence(d.headed)}</Text></View> : null}
        {d?.pillars.length ? <Eyebrow>{SCOUT_COPY.pillars}</Eyebrow> : null}
        {(d?.pillars ?? []).map((p) => (
          <View key={p.key} style={styles.pillarRow}>
            <AtmosphereSlot image={pillarImages[p.key]} domain="positioning" height={64} style={styles.pillarThumb} />
            <View style={styles.pillarRowText}>
              <Text style={styles.pillarRowTitle}>{p.label}</Text>
              {p.definition ? <Text style={styles.blockText}>{p.definition}</Text> : null}
            </View>
          </View>
        ))}
      </View>
    );
  }
  const groups: [string, ScoutBrand[]][] = [[SCOUT_COPY.current, r.brands.current], [SCOUT_COPY.past, r.brands.past], [SCOUT_COPY.unclear, r.brands.unclear]];
  return (
    <View style={styles.sheetBodyRows} testID="scout-brands-sheet">
      {groups.map(([label, list]) => list.length ? (
        <View key={label}>
          <Eyebrow style={styles.sheetEyebrow}>{label}</Eyebrow>
          {list.map((b, i) => <Row bold key={b.name} leading={<LogoMark bold logoUrl={b.logoUrl} domain={b.logoDomain} name={b.name} size={40} />} value={b.name} meta={brandSpan(b, now) ?? undefined} last={i === list.length - 1} />)}
        </View>
      ) : null)}
      {r.conflicts.map((c) => (
        <View key={c.what} style={[styles.conflict, styles.sheetConflict]}><Feather name="alert-circle" size={15} color={Bold.ink} /><Text style={styles.conflictText}>{conflictLine(c)}</Text></View>
      ))}
    </View>
  );
}

/** The door to What Nomila knows. The whole row is the target. */
export function KnowsDoor({ facts, unconfirmed, onPress }: { facts: number; unconfirmed: number; onPress: () => void }) {
  return (
    <Card bold style={styles.card} testID="me-knows-door">
      <Row bold leading={<IconTile icon="book-open" bold="black" />} value={SCOUT_COPY.knows} meta={knowsLine(facts, unconfirmed)} onPress={onPress} accessibilityLabel={SCOUT_COPY.knows} last />
    </Card>
  );
}

const PILLAR_W = 132;
const PILLAR_H = 72;

const styles = StyleSheet.create({
  pressed:       { transform: [{ scale: Bold.pressScale }] },
  head:          { paddingHorizontal: Bold.gutter, marginTop: 22, gap: 4 },
  statement:     { ...BoldType.statement, color: Bold.ink, marginTop: 4 },
  stage:         { ...BoldType.rowMeta, color: Bold.mute },
  mia:           { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: Bold.gutter, marginTop: 12, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card },
  miaText:       { flex: 1, minWidth: 0, gap: 2 },
  miaLine:       { ...BoldType.rowMeta, color: Bold.ink2 },
  card:          { marginHorizontal: Bold.gutter, marginTop: 10 },
  cols:          { flexDirection: "row" },
  col:           { flex: 1, padding: 12, gap: 8 },
  colLine:       { borderLeftWidth: 1, borderLeftColor: Bold.line },
  noteRow:       { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  dot:           { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  noteText:      { flex: 1, ...BoldType.rowMeta, color: Bold.ink },
  foot:          { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: Bold.line },
  footText:      { flex: 1, ...BoldType.caption, color: Bold.mute },
  cardHead:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 12, paddingBottom: 6 },
  line:          { ...BoldType.rowMeta, color: Bold.ink, paddingHorizontal: 12, paddingBottom: 4 },
  lineLabel:     { ...BoldType.label, color: Bold.mute },
  pad:           { height: 8 },
  railBleed:     { marginTop: 6 },
  rail:          { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  pillar:        { width: PILLAR_W, gap: 4 },
  pillarImg:     { width: PILLAR_W, borderRadius: Bold.radius.card },
  pillarLabel:   { ...BoldType.h4, color: Bold.ink, textTransform: "uppercase" },
  logoRow:       { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 6 },
  logoLabel:     { ...BoldType.label, color: Bold.mute, width: 64 },
  logos:         { gap: 8 },
  empty:         { ...BoldType.rowMeta, color: Bold.mute },
  conflict:      { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12 },
  conflictText:  { flex: 1, ...BoldType.caption, color: Bold.ink2 },
  upside:        { flexDirection: "row", gap: 14, padding: 14, marginHorizontal: Bold.gutter, marginTop: 16 },
  upCol:         { flex: 1, gap: 6 },
  upRule:        { width: 1, backgroundColor: Bold.line },
  upText:        { ...BoldType.rowMeta, color: Bold.ink2 },
  sheetBody:     { paddingHorizontal: Bold.gutter, paddingTop: 14, gap: 12 },
  sheetBodyRows: { paddingTop: 6 },
  sheetEyebrow:  { paddingHorizontal: Bold.gutter, paddingTop: 12 },
  sheetConflict: { paddingHorizontal: Bold.gutter, paddingTop: 12 },
  block:         { gap: 4 },
  blockText:     { ...BoldType.body, color: Bold.ink2 },
  blockStrong:   { ...BoldType.goalSm, color: Bold.ink },
  pillarRow:     { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  pillarThumb:   { width: 96, borderRadius: Bold.radius.card },
  pillarRowText: { flex: 1, gap: 2 },
  pillarRowTitle:{ ...BoldType.h4, color: Bold.ink, textTransform: "uppercase" },
});
