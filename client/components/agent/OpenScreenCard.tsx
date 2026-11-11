/**
 * OpenScreenCard (agent/1 `open-screen`) — Mila points to one screen (Home, your goals or one goal, Me, your scouting
 * report or one section of it, What Nomila knows) and one tap opens it. The server only ever names a screen from its
 * fixed allow-list (shared/agent.ts OPEN_SCREENS); the host maps it to a route. No open handler → no button.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { MILA_CARD } from "../mila/milaSurface";
import { MilaButton, partStyles } from "./parts";
import { useAgentCardHandlers } from "./handlers";
import type { CardOf } from "../../lib/agent/types";

export function OpenScreenCard({ card }: { card: CardOf<"open-screen"> }) {
  const { openLink } = useAgentCardHandlers();
  const p = card.payload;
  const link = card.links[0] ?? { label: `Open ${p.label}`, target: { screen: p.screen, ...(p.id ? { id: p.id } : {}) } };
  return (
    <View style={styles.card} testID="card-open-screen">
      <Text style={partStyles.title}>{card.title}</Text>
      {p.why ? <Text style={partStyles.body}>{p.why}</Text> : null}
      {openLink ? <MilaButton label={link.label} icon="arrow-right" onPress={() => openLink(link.target, link)} testID="open-screen-open" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 10 },
});
