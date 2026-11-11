/**
 * CapabilityCard (agent/1 `capability`, #890) — "What I can do for you": one entry point (deals, decks, content, the
 * public card, bookings, a shop…) with Mila's one-line pitch for this athlete. The whole tile starts it: the tap is
 * recorded (an action on the turn route, when there is one) and the host opens its screen or starts it in Mila. A
 * capability whose skill isn't live yet says "Coming soon" and is not a button. CapabilityGrid lays them two across.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { useAgentCardHandlers } from "./handlers";
import type { CardOf } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

export const CAPABILITY_COPY = { start: "Start", soon: "Coming soon" } as const;

/** A generic glyph by keyword in the capability's id; anything else gets a neutral one. */
export function capabilityGlyph(id: string): string {
  const k = id.toLowerCase();
  const table: Array<[string, string]> = [
    ["deal", "briefcase"], ["pitch", "layers"], ["deck", "layers"], ["content", "film"], ["post", "film"], ["card", "user"],
    ["page", "globe"], ["profile", "user"], ["booking", "calendar"], ["shop", "shopping-bag"], ["rate", "dollar-sign"],
    ["money", "dollar-sign"], ["pay", "dollar-sign"], ["media", "image"], ["goal", "target"], ["inbox", "mail"],
  ];
  return table.find(([w]) => k.includes(w))?.[1] ?? "zap";
}

export function CapabilityCard({ card }: { card: CardOf<"capability"> }) {
  const { act, startCapability } = useAgentCardHandlers();
  const { capability: c, pitch } = card.payload;
  const live = c.available && !!startCapability;
  const body = (
    <>
      <View style={[styles.glyph, !c.available && styles.glyphOff]}><Feather name={capabilityGlyph(c.id) as any} size={18} color={Bold.onDark} /></View>
      <Text style={styles.title}>{c.label}</Text>
      <Text style={styles.line}>{pitch}</Text>
      {live ? (
        <View style={styles.start}>
          <Text style={styles.startText}>{CAPABILITY_COPY.start}</Text>
          <Feather name="arrow-right" size={14} color={Bold.blue} />
        </View>
      ) : !c.available ? (
        <Text style={styles.soon}>{CAPABILITY_COPY.soon}</Text>
      ) : null}
    </>
  );
  if (!live) return <View style={styles.card} testID="card-capability">{body}</View>;
  return (
    <Pressable
      onPress={() => {
        haptics.press();
        if (act) void act([{ type: "capability", capabilityId: c.id }]).catch(() => {});
        startCapability!(c);
      }}
      accessibilityRole="button"
      accessibilityLabel={`${c.label}. ${pitch}. ${CAPABILITY_COPY.start}`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      testID="card-capability"
    >
      {body}
    </Pressable>
  );
}

export function CapabilityGrid({ cards }: { cards: Array<CardOf<"capability">> }) {
  return (
    <View style={styles.grid} testID="capability-grid">
      {cards.map((c) => (
        <View key={c.id} style={styles.cell}>
          <CapabilityCard card={c} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  cell: { flexBasis: "47%", flexGrow: 1 },
  card: { ...MILA_CARD, padding: 14, gap: 6, flex: 1, minHeight: 150 },
  pressed: { transform: [{ scale: Bold.pressScale }] },
  glyph: { width: 36, height: 36, borderRadius: 18, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  glyphOff: { backgroundColor: Bold.quiet },
  title: { ...BoldType.h4, color: Bold.ink },
  line: { ...BoldType.caption, color: Bold.ink2, flex: 1 },
  soon: { ...BoldType.caption, color: Bold.mute },
  start: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  startText: { ...BoldType.link, color: Bold.blue },
});
