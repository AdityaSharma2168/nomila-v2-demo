// The sheet behind a record row. Three doors, per the approved Brand tab design:
//
//   Change     — type the value yourself (PUT /me/record/:field, source=settings, a receipt)
//   Tell Mila  — open the chat with the field as context and a draft in the composer
//   History    — every receipt for this field, newest first, with Undo on the latest
//
// A found fact (class year from research) is editable too — the athlete's word wins; the found
// value stays in history. Non-editable rows say where the fact came from and, when there is one,
// link to the screen that owns it. On the kit: Sheet, SheetDoor, Button, Chip.

import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, TextInput, ActivityIndicator, ScrollView } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts, Spacing, BorderRadius } from "../../constants/theme";
import { useRecordHistory, useUndoRecordWrite, useWriteRecordField, type RecordEntry } from "../../hooks/use-athlete-record";
import { formatAgo, sourceLine, tellMilaDraft, toEditText, toWriteValue } from "../../lib/recordLogic";
import { openMila } from "../../lib/milaLaunch";
import { haptics } from "../../lib/haptics";
import { Sheet, SheetDoor, Button } from "../ui";
import { KindChip } from "./RecordRow";

const C = Colors.light;
type Mode = "menu" | "change" | "history";

function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (Array.isArray(o.list)) return o.list.join(", ");
    if (o.voice && typeof o.voice === "object") return String((o.voice as Record<string, unknown>).tone ?? "voice");
    return JSON.stringify(v);
  }
  return String(v);
}

const sourceWords = (source: string | null) =>
  source === "settings" ? "you typed it" : source === "onboarding" ? "you told Mila" : source === "voice" ? "you said it" : source ?? "chat";

export function RecordSheet({ entry, onClose, onLink }: {
  entry:   RecordEntry | null;
  onClose: () => void;
  onLink?: (link: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("menu");
  const [text, setText] = useState("");
  const write = useWriteRecordField();
  const undo  = useUndoRecordWrite();
  const history = useRecordHistory(mode === "history" && entry ? entry.field : null);

  useEffect(() => {
    if (entry) { setMode("menu"); setText(toEditText(entry)); write.reset(); undo.reset(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.field]);

  const canEdit = !!entry?.editable && entry.shape !== "voice" && entry.shape !== "teams" && entry.shape !== "career";
  const dirty = useMemo(() => !!entry && text.trim() !== toEditText(entry).trim(), [entry, text]);

  if (!entry) return null;

  async function save() {
    if (!entry) return;
    try { await write.mutateAsync({ field: entry.field, value: toWriteValue(entry.shape, text) }); haptics.success(); onClose(); }
    catch { haptics.error(); }
  }
  async function clear() {
    if (!entry) return;
    try { await write.mutateAsync({ field: entry.field, value: "" }); haptics.success(); onClose(); }
    catch { haptics.error(); }
  }
  function tellMila() {
    if (!entry) return;
    onClose();
    openMila({ context: { type: "record", id: entry.field }, draft: tellMilaDraft(entry) });
  }

  const latestUndoable = history.data?.items.find((i) => i.reversible && !i.undone_at) ?? null;

  return (
    <Sheet
      onClose={onClose}
      eyebrow={entry.label}
      value={entry.value ?? "Not yet"}
      keyboard={mode === "change"}
      headBelow={
        <View style={styles.headRow}>
          <KindChip kind={entry.kind} />
          <Text style={styles.source}>{sourceLine(entry)}</Text>
        </View>
      }
    >
      {mode === "menu" && (
        <View>
          {canEdit && <SheetDoor icon={<Feather name="edit-2" size={16} color={C.text} />} title="Change" subtitle={entry.shape === "list" ? "Type a list, comma-separated" : "Type it yourself"} onPress={() => setMode("change")} />}
          {entry.editable && <SheetDoor icon={<Feather name="message-circle" size={16} color={C.text} />} title="Tell Mila" subtitle="Say it in your own words" onPress={tellMila} />}
          {entry.editable && <SheetDoor icon={<Feather name="clock" size={16} color={C.text} />} title="History" subtitle="Every change, and undo the last one" onPress={() => setMode("history")} />}
          {!entry.editable && (
            <Text style={styles.readOnly}>
              {entry.kind === "proof"
                ? "This comes from a deal you accepted, so it can't be typed over."
                : entry.kind === "made"
                  ? "Mila made this from what she knows about you. It updates on its own."
                  : "This is read from your connected accounts and research. It can't be typed over."}
            </Text>
          )}
          {entry.link && onLink && (
            <SheetDoor icon={<Feather name="arrow-up-right" size={16} color={C.text} />} title={`Open ${entry.link}`} onPress={() => { onClose(); onLink(entry.link!); }} divider />
          )}
        </View>
      )}

      {mode === "change" && (
        <View style={styles.editBox}>
          <TextInput
            style={[styles.input, entry.shape === "list" && styles.inputTall]}
            value={text}
            onChangeText={setText}
            placeholder={entry.shape === "list" ? "One, two, three" : `Your ${entry.label.toLowerCase()}`}
            placeholderTextColor="#B8B1A8"
            autoFocus
            multiline={entry.shape === "list"}
            returnKeyType="done"
            onSubmitEditing={entry.shape === "list" ? undefined : save}
          />
          {write.isError && <Text style={styles.err}>Couldn't save. Try again.</Text>}
          <View style={styles.editActions}>
            {entry.value ? (
              <Pressable style={styles.clearBtn} onPress={clear} disabled={write.isPending}>
                <Text style={styles.clearText}>Clear</Text>
              </Pressable>
            ) : <View />}
            <View style={styles.actionsRight}>
              <Button ghost onPress={() => setMode("menu")} disabled={write.isPending}>Back</Button>
              <Button onPress={save} disabled={!dirty} loading={write.isPending}>Save</Button>
            </View>
          </View>
        </View>
      )}

      {mode === "history" && (
        <View style={styles.historyBox}>
          {history.isLoading && <ActivityIndicator size="small" color={C.primary} style={{ paddingVertical: Spacing.lg }} />}
          {history.data && history.data.items.length === 0 && (
            <Text style={styles.readOnly}>No changes yet. What's here came from signup or research.</Text>
          )}
          <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false}>
            {history.data?.items.map((i) => (
              <View key={i.agent_action_id} style={[styles.hItem, !!i.undone_at && styles.hItemUndone]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.hTo}>{showValue(i.to)}</Text>
                  <Text style={styles.hMeta}>
                    {showValue(i.from) === "—" ? "added" : `was ${showValue(i.from)}`}
                    {" · "}{sourceWords(i.source)}
                    {i.at ? ` · ${formatAgo(i.at)}` : ""}
                    {i.undone_at ? " · undone" : ""}
                  </Text>
                </View>
                {latestUndoable?.agent_action_id === i.agent_action_id && (
                  <Button ghost small loading={undo.isPending} onPress={async () => {
                    try { await undo.mutateAsync({ agentActionId: i.agent_action_id, field: entry.field }); haptics.success(); onClose(); }
                    catch { haptics.error(); }
                  }}>Undo</Button>
                )}
              </View>
            ))}
          </ScrollView>
          <View style={styles.historyFoot}>
            <Button ghost small onPress={() => setMode("menu")}>Back</Button>
          </View>
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  headRow:      { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  source:       { fontFamily: Fonts.body, fontSize: 12, color: C.textQuiet },
  readOnly:     { fontFamily: Fonts.body, fontSize: 13, color: C.textQuiet, lineHeight: 19, paddingVertical: Spacing.md },
  editBox:      { paddingTop: Spacing.md, gap: Spacing.sm },
  input:        { borderWidth: 1, borderColor: C.border, borderRadius: BorderRadius.xs, paddingHorizontal: 14, paddingVertical: 12, fontFamily: Fonts.body, fontSize: 16, color: C.text },
  inputTall:    { minHeight: 84, textAlignVertical: "top" },
  err:          { fontFamily: Fonts.body, fontSize: 12, color: C.error },
  editActions:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  actionsRight: { flexDirection: "row", gap: Spacing.sm },
  clearBtn:     { paddingVertical: 10, paddingHorizontal: 4 },
  clearText:    { fontFamily: Fonts.bodyMedium, fontSize: 14, color: C.error },
  historyBox:   { paddingTop: Spacing.sm },
  historyFoot:  { alignItems: "flex-end", marginTop: Spacing.sm },
  hItem:        { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderLight },
  hItemUndone:  { opacity: 0.5 },
  hTo:          { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: C.text },
  hMeta:        { fontFamily: Fonts.body, fontSize: 11, color: C.textQuiet, marginTop: 2 },
});
