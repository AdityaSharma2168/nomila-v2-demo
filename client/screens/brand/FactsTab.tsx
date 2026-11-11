// Brand › Facts — the athlete record, six groups, every fact with who it came from. Tapping a
// row opens RecordSheet (Change · Tell Mila · History). Rows that belong to another screen
// (score, deals, connections) link out. On the kit: one Card per group, Rows inside.

import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { useAthleteRecord, type RecordEntry, type RecordGroup } from "../../hooks/use-athlete-record";
import { RecordRow } from "../../components/record/RecordRow";
import { RecordSheet } from "../../components/record/RecordSheet";
import { TeamSheet, type TeamDraft } from "../../components/record/TeamSheet";
import { CareerSheet } from "../../components/record/CareerSheet";
import { groupSummary } from "../../lib/recordLogic";
import { Card, Button } from "../../components/ui";

const C = Colors.light;

const GROUP_BLURB: Record<RecordGroup["key"], string> = {
  who:         "The basics a brand checks first.",
  teams:       "Who you play for, now and before.",
  want:        "What you told Mila you're after.",
  story:       "The raw material Mila writes your story from.",
  found:       "What research turned up. Correct anything that's off.",
  numbers:     "Read from your accounts and the score. Not typed.",
  connections: "Where your numbers come from.",
};

export function FactsTab({ onLink }: { onLink: (link: string) => void }) {
  const { data, isLoading, isError, refetch } = useAthleteRecord();
  const [open, setOpen] = useState<RecordEntry | null>(null);
  // The two structured editors: a team row (or the add row) and the career picker.
  const [teamEdit, setTeamEdit] = useState<{ teams: TeamDraft[]; index: number | null } | null>(null);
  const [careerEdit, setCareerEdit] = useState<{ status?: string | null; since?: string | null } | null | false>(false);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" color={C.primary} />
        <Text style={styles.muted}>Reading your record…</Text>
      </View>
    );
  }
  if (isError || !data) {
    return (
      <View style={styles.center}>
        <Feather name="alert-circle" size={20} color={C.error} />
        <Text style={styles.muted}>Couldn't load your record</Text>
        <Button ghost small onPress={() => refetch()}>Retry</Button>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.legend}>
        <Text style={styles.legendText}>
          <Text style={styles.legendStrong}>{data.counts.said}</Text> you said ·{" "}
          <Text style={styles.legendStrong}>{data.counts.found}</Text> found ·{" "}
          <Text style={styles.legendStrong}>{data.counts.made}</Text> Mila made ·{" "}
          <Text style={styles.legendStrong}>{data.counts.proof}</Text> proof
        </Text>
        <Text style={styles.legendSub}>Your word always wins. Tap a fact to change it, tell Mila, or see its history.</Text>
      </View>

      {data.groups.map((g) => {
        const sum = groupSummary(g);
        return (
          <View key={g.key} style={styles.group}>
            <View style={styles.groupHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.groupTitle}>{g.title}</Text>
                <Text style={styles.groupBlurb}>{GROUP_BLURB[g.key]}</Text>
              </View>
              <Text style={styles.groupCount}>{sum.text}</Text>
            </View>
            <Card style={styles.card}>
              {g.entries.map((e, i) => (
                <RecordRow
                  key={e.field}
                  entry={e}
                  last={i === g.entries.length - 1}
                  onPress={(entry) => {
                    if (entry.link && !entry.editable && entry.actions.length <= 1) { onLink(entry.link); return; }
                    if (entry.shape === "teams") {
                      const raw = (entry.raw ?? {}) as { index?: number | null; teams?: TeamDraft[] };
                      setTeamEdit({ teams: raw.teams ?? [], index: raw.index ?? null });
                      return;
                    }
                    if (entry.shape === "career") {
                      setCareerEdit((entry.raw as { status?: string | null; since?: string | null } | undefined) ?? null);
                      return;
                    }
                    setOpen(entry);
                  }}
                />
              ))}
            </Card>
          </View>
        );
      })}

      <RecordSheet entry={open} onClose={() => setOpen(null)} onLink={onLink} />
      {teamEdit ? <TeamSheet teams={teamEdit.teams} index={teamEdit.index} onClose={() => setTeamEdit(null)} /> : null}
      {careerEdit !== false ? <CareerSheet current={careerEdit} onClose={() => setCareerEdit(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:         { paddingBottom: Spacing.lg },
  center:       { alignItems: "center", gap: Spacing.sm, paddingVertical: Spacing["4xl"] },
  muted:        { fontFamily: Fonts.body, fontSize: 14, color: C.textQuiet },
  legend:       { paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, paddingBottom: Spacing.md, gap: 4 },
  legendText:   { fontFamily: Fonts.body, fontSize: 13, color: C.textQuiet },
  legendStrong: { fontFamily: Fonts.bodySemiBold, color: C.text },
  legendSub:    { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet, lineHeight: 17 },
  group:        { marginTop: Spacing.md },
  groupHead:    { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: Spacing.xl, paddingBottom: Spacing.sm, gap: Spacing.md },
  groupTitle:   { fontFamily: Fonts.headingSemiBold, fontSize: 16, color: C.text },
  groupBlurb:   { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet, marginTop: 1 },
  groupCount:   { fontFamily: Fonts.bodyMedium, fontSize: 12, color: C.textQuiet },
  card:         { marginHorizontal: Spacing.xl },
});
