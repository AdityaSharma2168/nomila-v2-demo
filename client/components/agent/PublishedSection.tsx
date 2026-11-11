/**
 * PublishedSection (EXPO_PUBLIC_AGENT_V3) — on Me: what the athlete has published (pages, decks that went out, posts),
 * the same items as the Studio library's "Published", so what's public shows where their public self lives. Renders
 * nothing while loading, on error, or when nothing is published (no placeholder rows, DESIGN.md §12b).
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Bold, BoldType } from "../../constants/theme";
import { Card } from "../ui";
import { useAuth } from "../../lib/auth-context";
import { useStudioItems } from "../../lib/agent/hooks";
import { openAgentTarget } from "../../lib/agent/navigate";
import { StudioRow } from "../../screens/agent/StudioLibraryScreen";

export const PUBLISHED_COPY = { title: "Published", lede: "What's public under your name." } as const;

export function PublishedSection() {
  const navigation = useNavigation<any>();
  const { athlete } = useAuth();
  const q = useStudioItems(athlete?.id ? String(athlete.id) : undefined);
  const items = (q.data ?? []).filter((i) => i.status === "published");
  if (!items.length) return null;
  return (
    <View style={styles.wrap} testID="me-published">
      <Text style={styles.title}>{PUBLISHED_COPY.title}</Text>
      <Text style={styles.lede}>{PUBLISHED_COPY.lede}</Text>
      <Card bold style={styles.card}>
        {items.map((it, i) => (
          <StudioRow key={it.id} item={it} last={i === items.length - 1} onOpen={it.open ? () => openAgentTarget(navigation, it.open!) : null} />
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: Bold.gutter, marginTop: 20, gap: 4 },
  title: { ...BoldType.section, color: Bold.ink },
  lede: { ...BoldType.lede, color: Bold.mute },
  card: { marginTop: 8 },
});
