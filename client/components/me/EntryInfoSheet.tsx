// EntryInfoSheet — one knowledge entry's info sheet (What Nomila Knows, the brand letter): the tier in WORDS, the source
// detail, her dispute when she gave one, the public links, and "This isn't right" (POST /me/knowledge/disputes) for an
// entry with no correction field. Shared by KnowsScreen and the brand screen so the ONE verdict control stays one.

import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Linking, TextInput } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useDisputeKnowledgeEntry, type KnowledgeEntry } from "../../hooks/use-me-knowledge";
import { canDispute, entryStateText, tierText } from "../../lib/knowledgeLogic";
import { Chip, Button, Sheet, HerWords } from "../ui";
import { Bold, BoldType } from "../../constants/theme";

export const INFO_COPY = { youSaid: "You said", notRight: "This isn't right", prompt: "What's wrong with it? (optional)" } as const;

export function EntryInfoSheet({ entry, onClose, onSent }: { entry: KnowledgeEntry | null; onClose: () => void; onSent?: (entryId: string) => void }) {
  const dispute = useDisputeKnowledgeEntry();
  const [said, setSaid] = useState("");
  if (!entry) return null;
  const info = entry;
  const send = () => dispute.mutate({ entryId: info.id, said }, { onSuccess: () => { setSaid(""); onSent?.(info.id); onClose(); } });
  return (
    <Sheet onClose={onClose} eyebrow={info.label} value={info.value ?? entryStateText(info)} keyboard headBelow={info.source ? <Chip bold="line">{info.source.label}</Chip> : undefined}>
      <View style={styles.body} testID="knows-info">
        {tierText(info) ? <Text style={styles.strong}>{tierText(info)}</Text> : null}
        {info.status === "disputed" ? <Text style={styles.text}>Sources disagree on this one.</Text> : null}
        {info.stale ? <Text style={styles.text}>This may be out of date.</Text> : null}
        {info.source?.detail ? <Text style={styles.text}>{info.source.detail}</Text> : null}
        {info.yourDispute?.said ? <HerWords label={INFO_COPY.youSaid} text={info.yourDispute.said} /> : null}
        {info.evidence.map((ev) => (
          <Pressable key={ev.url} onPress={() => Linking.openURL(ev.url)} style={styles.link} accessibilityRole="link">
            <Feather name="external-link" size={16} color={Bold.blue} />
            <Text style={styles.linkText} numberOfLines={1}>{ev.domain ?? ev.url}</Text>
          </Pressable>
        ))}
        {!info.evidence.length && !info.source?.detail ? <Text style={styles.text}>{info.source ? "No public link on file for this one." : "Nothing on record yet."}</Text> : null}
        {canDispute(info) ? (
          <View style={styles.disputeBox}>
            <TextInput
              style={styles.input} value={said} onChangeText={setSaid} placeholder={INFO_COPY.prompt} placeholderTextColor={Bold.quiet}
              maxLength={280} multiline accessibilityLabel="What's wrong with it"
            />
            <Button bold="small" onPress={send} loading={dispute.isPending} style={styles.disputeBtn}>{INFO_COPY.notRight}</Button>
            {dispute.isError ? <Text style={styles.error}>{"Couldn't send that. Try again."}</Text> : null}
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body:       { gap: 8, paddingHorizontal: 20, paddingBottom: 12 },
  strong:     { ...BoldType.lede, color: Bold.ink },
  text:       { ...BoldType.lede, color: Bold.mute },
  link:       { flexDirection: "row", alignItems: "center", gap: 6 },
  linkText:   { ...BoldType.link, color: Bold.blue },
  disputeBox: { gap: 8, marginTop: 8 },
  disputeBtn: { alignSelf: "flex-start" },
  input:      { minHeight: 44, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, padding: 8, ...BoldType.body, color: Bold.ink, backgroundColor: Bold.paper },
  error:      { ...BoldType.caption, color: Bold.mute },
});
