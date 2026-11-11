// CareerSheet — the picker behind the Career row on Brand › Facts. Four statuses, one answer;
// Retired asks for the last season. Writes `career_status` through the ledger (a receipt, undo).

import React, { useState } from "react";
import { View, Text, TextInput, StyleSheet } from "react-native";
import { Colors, Fonts, Spacing, BorderRadius } from "../../constants/theme";
import { useWriteRecordField } from "../../hooks/use-athlete-record";
import { haptics } from "../../lib/haptics";
import { Sheet, Pill, Button } from "../ui";

const C = Colors.light;

const STATUSES: Array<{ slug: "active" | "between_teams" | "out_this_season" | "retired"; label: string; hint: string }> = [
  { slug: "active", label: "Playing", hint: "On a roster this season" },
  { slug: "between_teams", label: "Between teams", hint: "Transfer, draft, free agent" },
  { slug: "out_this_season", label: "Out this season", hint: "Injury, redshirt, a year off" },
  { slug: "retired", label: "Retired", hint: "Done competing" },
];

export function CareerSheet({ current, onClose }: {
  current: { status?: string | null; since?: string | null } | null;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<(typeof STATUSES)[number]["slug"]>((current?.status as never) ?? "active");
  const [since, setSince] = useState(current?.since ?? "");
  const write = useWriteRecordField();
  const dirty = status !== (current?.status ?? "active") || (status === "retired" && (since || "") !== (current?.since ?? ""));

  async function save() {
    try {
      await write.mutateAsync({ field: "career_status", value: { status, since: /^\d{4}$/.test(since.trim()) ? since.trim() : null } });
      haptics.success();
      onClose();
    } catch {
      haptics.error();
    }
  }

  return (
    <Sheet onClose={onClose} eyebrow="Career" value="Where are you right now?" keyboard>
      <View style={styles.pills}>
        {STATUSES.map((s) => <Pill key={s.slug} selected={status === s.slug} onPress={() => setStatus(s.slug)}>{s.label}</Pill>)}
      </View>
      <Text style={styles.hint}>{STATUSES.find((s) => s.slug === status)?.hint}</Text>
      {status === "retired" ? (
        <>
          <Text style={styles.label}>Last season</Text>
          <TextInput style={styles.input} value={since} onChangeText={setSince} placeholder="e.g. 2024" placeholderTextColor="#B8B1A8" keyboardType="number-pad" maxLength={4} />
        </>
      ) : null}
      {write.isError ? <Text style={styles.err}>Couldn't save. Try again.</Text> : null}
      <View style={styles.actions}>
        <Button ghost onPress={onClose} disabled={write.isPending}>Back</Button>
        <Button onPress={save} disabled={!dirty} loading={write.isPending}>Save</Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  pills: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm, marginTop: Spacing.sm },
  hint: { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet, marginTop: Spacing.sm },
  label: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: C.textQuiet, marginTop: Spacing.md, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: BorderRadius.xs, paddingHorizontal: 12, paddingVertical: 10, fontFamily: Fonts.body, fontSize: 15, color: C.text, backgroundColor: C.card },
  err: { fontFamily: Fonts.body, fontSize: 12, color: C.error, marginTop: Spacing.sm },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: Spacing.sm, marginTop: Spacing.lg },
});
