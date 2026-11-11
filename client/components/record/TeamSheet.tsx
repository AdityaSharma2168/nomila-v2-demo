// TeamSheet — the team editor behind a row in Brand › Facts › Your teams (design page: Athlete
// Affiliations). One sheet for add, change, make primary, mark as ended and remove.
//
// It edits the WHOLE list and saves it as the athlete's said list (PUT /me/record/affiliations),
// so keeping a found team is how she confirms it, and removing one is her word too. Built from the
// kit: Sheet, Pill, Button. Sport-neutral: kinds are organisation kinds, never a sport.

import React, { useMemo, useState } from "react";
import { View, Text, TextInput, StyleSheet, ScrollView } from "react-native";
import { Colors, Fonts, Spacing, BorderRadius } from "../../constants/theme";
import { useWriteRecordField } from "../../hooks/use-athlete-record";
import { haptics } from "../../lib/haptics";
import { Sheet, Pill, Button } from "../ui";

const C = Colors.light;

export interface TeamDraft {
  org: string;
  kind: "school" | "club" | "pro" | "national" | "olympic";
  level?: string | null;
  conference?: string | null;
  role?: string | null;
  position?: string | null;
  /** "YYYY" or ISO date; null = unknown. */
  from?: string | null;
  /** "YYYY" or ISO date; null = current. */
  to?: string | null;
  primary?: boolean;
  /** Provenance of the row as read; informational. */
  fact?: "said" | "found" | "proof";
}

const KINDS: Array<{ key: TeamDraft["kind"]; label: string }> = [
  { key: "school", label: "School" },
  { key: "club", label: "Club" },
  { key: "pro", label: "Pro" },
  { key: "national", label: "National team" },
  { key: "olympic", label: "Olympic" },
];

const year = (v: string | null | undefined) => (v ? v.slice(0, 4) : "");
const yearOrNull = (v: string) => (/^\d{4}$/.test(v.trim()) ? v.trim() : null);

export function TeamSheet({ teams, index, onClose }: {
  /** The athlete's whole list as the record returned it. */
  teams: TeamDraft[];
  /** Row being edited, or null to add one. */
  index: number | null;
  onClose: () => void;
}) {
  const adding = index === null;
  const base: TeamDraft = adding
    ? { org: "", kind: "school", level: null, conference: null, role: null, position: null, from: null, to: null, primary: teams.every((t) => t.to) }
    : teams[index];
  const [org, setOrg] = useState(base.org);
  const [kind, setKind] = useState<TeamDraft["kind"]>(base.kind);
  const [level, setLevel] = useState(base.level ?? "");
  const [conference, setConference] = useState(base.conference ?? "");
  const [role, setRole] = useState(base.role ?? "");
  const [position, setPosition] = useState(base.position ?? "");
  const [from, setFrom] = useState(year(base.from));
  const [to, setTo] = useState(year(base.to));
  const [primary, setPrimary] = useState(!!base.primary);
  const write = useWriteRecordField();

  const current = !yearOrNull(to);
  const draft = useMemo<TeamDraft>(() => ({
    org: org.trim(), kind, level: level.trim() || null, conference: conference.trim() || null,
    role: role.trim() || null, position: position.trim() || null,
    from: yearOrNull(from), to: yearOrNull(to), primary: current && primary,
  }), [org, kind, level, conference, role, position, from, to, primary, current]);
  const canSave = draft.org.length > 1 && !write.isPending;

  async function saveList(list: TeamDraft[]) {
    try {
      // The server keeps exactly one primary among current teams; we send the intent.
      const clean = list.map(({ fact: _fact, ...t }) => t);
      await write.mutateAsync({ field: "affiliations", value: clean as unknown as Record<string, unknown>[] });
      haptics.success();
      onClose();
    } catch {
      haptics.error();
    }
  }
  const save = () => {
    const next = [...teams];
    if (adding) next.push(draft); else next[index] = draft;
    if (draft.primary) next.forEach((t, i) => { if (i !== (adding ? next.length - 1 : index)) t.primary = false; });
    return saveList(next);
  };
  const markEnded = () => {
    const next = [...teams];
    next[index!] = { ...draft, to: String(new Date().getFullYear()), primary: false };
    return saveList(next);
  };
  const remove = () => saveList(teams.filter((_, i) => i !== index));

  return (
    <Sheet
      onClose={onClose}
      eyebrow={adding ? "Add a team" : base.to ? "Team · past" : "Team · current"}
      value={adding ? "Who do you play for?" : base.org}
      keyboard
    >
      <ScrollView style={{ maxHeight: 420 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Text style={styles.label}>Organisation</Text>
        <TextInput style={styles.input} value={org} onChangeText={setOrg} placeholder="The team, school or programme" placeholderTextColor="#B8B1A8" autoFocus={adding} />

        <Text style={styles.label}>Kind</Text>
        <View style={styles.pills}>
          {KINDS.map((k) => <Pill key={k.key} selected={kind === k.key} onPress={() => setKind(k.key)}>{k.label}</Pill>)}
        </View>

        <View style={styles.two}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Level</Text>
            <TextInput style={styles.input} value={level} onChangeText={setLevel} placeholder={kind === "school" ? "D1, D3, high school…" : kind === "national" ? "senior, U-20…" : "league or tier"} placeholderTextColor="#B8B1A8" />
          </View>
          {kind === "school" ? (
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Conference</Text>
              <TextInput style={styles.input} value={conference} onChangeText={setConference} placeholder="e.g. ACC" placeholderTextColor="#B8B1A8" />
            </View>
          ) : null}
        </View>

        <View style={styles.two}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Position</Text>
            <TextInput style={styles.input} value={position} onChangeText={setPosition} placeholder="Your position" placeholderTextColor="#B8B1A8" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Role</Text>
            <TextInput style={styles.input} value={role} onChangeText={setRole} placeholder="captain, starter…" placeholderTextColor="#B8B1A8" />
          </View>
        </View>

        <View style={styles.two}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>From (year)</Text>
            <TextInput style={styles.input} value={from} onChangeText={setFrom} placeholder="2023" placeholderTextColor="#B8B1A8" keyboardType="number-pad" maxLength={4} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>To (year)</Text>
            <TextInput style={styles.input} value={to} onChangeText={setTo} placeholder="Still there" placeholderTextColor="#B8B1A8" keyboardType="number-pad" maxLength={4} />
          </View>
        </View>

        {current ? (
          <View style={[styles.pills, { marginTop: Spacing.md }]}>
            <Pill selected={primary} onPress={() => setPrimary((p) => !p)}>{primary ? "Primary team ✓" : "Make primary"}</Pill>
            <Text style={styles.hint}>The team a brand reads first.</Text>
          </View>
        ) : null}

        {write.isError ? <Text style={styles.err}>Couldn't save. Try again.</Text> : null}
      </ScrollView>

      <View style={styles.actions}>
        <View style={styles.actionsLeft}>
          {!adding && !base.to ? <Button ghost small onPress={markEnded} disabled={write.isPending}>Mark as ended</Button> : null}
          {!adding ? <Button ghost small onPress={remove} disabled={write.isPending}>Remove</Button> : null}
        </View>
        <Button onPress={save} disabled={!canSave} loading={write.isPending}>Save</Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: Fonts.bodyMedium, fontSize: 12, color: C.textQuiet, marginTop: Spacing.md, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: C.border, borderRadius: BorderRadius.xs, paddingHorizontal: 12, paddingVertical: 10, fontFamily: Fonts.body, fontSize: 15, color: C.text, backgroundColor: C.card },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm, alignItems: "center" },
  two: { flexDirection: "row", gap: Spacing.md },
  hint: { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet },
  err: { fontFamily: Fonts.body, fontSize: 12, color: C.error, marginTop: Spacing.sm },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: Spacing.md, gap: Spacing.sm },
  actionsLeft: { flexDirection: "row", gap: Spacing.sm },
});
