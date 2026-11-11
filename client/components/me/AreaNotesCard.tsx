/**
 * AreaNotesCard — the Scouting report's read in detail (the sheet Me opens from the summary): Working for you · Room to
 * grow · Not on record yet, every note tagged with the M.I.A. area it speaks to. Promoted from the approved prototype
 * (PR #900, client/screens/prototypes/AreaNotesCard.tsx), reading GET /me/scouting's notes (shared/meScouting ScoutNote).
 *
 * The tag is the existing mini ring (components/strategy/GoalVisual MiniRing: only that area's bands lit) and the
 * area · dimension name; strengths and room-to-grow notes carry the dimension's served score as a bar in that
 * dimension's ring tone (colour on screen always means a part of the score, DESIGN.md §1), and a missing item carries
 * the dotted "not yet" track, never a zero. An untagged note (an older read) shows no ring and no bar, never a guess.
 */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Card, Eyebrow } from "../ui";
import { MiniRing } from "../strategy/GoalVisual";
import { DIMENSIONS } from "../../lib/myIntelligenceLogic";
import { Bold, BoldType, Ring, type RingCapital } from "../../constants/theme";
import type { ScoutNote } from "../../../shared/meScouting";

export const AREA_NOTES_COPY = {
  strengths: "Working for you", growth: "Room to grow", missing: "Not on record yet", notYet: "Not on record yet",
} as const;

type Group = "strengths" | "growth" | "missing";
type IconName = React.ComponentProps<typeof Feather>["name"];
const GROUP_ICON: Record<Group, IconName> = { strengths: "trending-up", growth: "arrow-up-right", missing: "help-circle" };

/** The area (capital) a dimension belongs to, its tone, and the two names. Null for an unknown or missing key. */
export function areaOf(dimension: string | null | undefined): { capital: RingCapital; capitalName: string; tone: string; name: string } | null {
  if (!dimension) return null;
  for (const cap of Ring.capitals) {
    const i = (cap.dimensions as readonly string[]).indexOf(dimension);
    if (i >= 0) return { capital: cap.key, capitalName: cap.name, tone: cap.tones[i], name: DIMENSIONS.find((d) => d.key === dimension)?.name ?? dimension };
  }
  return null;
}

export function AreaNotesCard({ notes, scores }: { notes: Record<Group, ScoutNote[]>; scores: Record<string, number | null> }) {
  const groups = (["strengths", "growth", "missing"] as Group[]).filter((g) => notes[g].length);
  if (!groups.length) return null;
  return (
    <Card bold style={styles.card} testID="scout-notes">
      {groups.map((g, gi) => (
        <View key={g} style={[styles.group, gi < groups.length - 1 && styles.groupLine]} testID={`scout-notes-${g}`}>
          <View style={styles.head}>
            <Feather name={GROUP_ICON[g]} size={15} color={Bold.ink} />
            <Eyebrow>{AREA_NOTES_COPY[g]}</Eyebrow>
          </View>
          {notes[g].map((n) => {
            const a = areaOf(n.dimension);
            const score = n.dimension ? scores[n.dimension] ?? null : null;
            return (
              <View key={n.text} style={styles.item} accessibilityLabel={`${a ? `${a.capitalName}, ${a.name}. ` : ""}${n.text}`}>
                {a ? <MiniRing capital={a.capital} size={36} dark={false} /> : <View style={styles.ringGap} />}
                <View style={styles.itemText}>
                  {a ? <Text style={styles.area}>{`${a.capitalName} · ${a.name}`}</Text> : null}
                  <Text style={[styles.text, g === "missing" && styles.textMissing]}>{n.text}</Text>
                  {g === "missing" ? (
                    <View style={styles.barRow}>
                      <View style={[styles.track, styles.trackDotted]} />
                      <Text style={styles.value}>{AREA_NOTES_COPY.notYet}</Text>
                    </View>
                  ) : a && score != null ? (
                    <View style={styles.barRow}>
                      <View style={styles.track}><View style={[styles.fill, { width: `${Math.max(0, Math.min(100, score))}%`, backgroundColor: a.tone }]} /></View>
                      <Text style={styles.value}><Text style={styles.valueStrong}>{Math.round(score)}</Text> of 100</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card:        { marginHorizontal: Bold.gutter, marginTop: 16, paddingHorizontal: 14 },
  group:       { paddingVertical: 14, gap: 12 },
  groupLine:   { borderBottomWidth: 1, borderBottomColor: Bold.line },
  head:        { flexDirection: "row", alignItems: "center", gap: 8 },
  item:        { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  ringGap:     { width: 36 },
  itemText:    { flex: 1, minWidth: 0, gap: 3 },
  area:        { ...BoldType.label, color: Bold.mute },
  text:        { ...BoldType.rowTitle, color: Bold.ink },
  textMissing: { color: Bold.ink2 },
  barRow:      { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4 },
  track:       { flex: 1, height: 6, borderRadius: 1, backgroundColor: Bold.track, overflow: "hidden" },
  trackDotted: { backgroundColor: Bold.paper, borderWidth: 1.5, borderStyle: "dotted", borderColor: Bold.quiet },
  fill:        { height: 6 },
  value:       { ...BoldType.sigMeta, color: Bold.mute, minWidth: 64, textAlign: "right" },
  valueStrong: { ...BoldType.sigValue, color: Bold.ink },
});
