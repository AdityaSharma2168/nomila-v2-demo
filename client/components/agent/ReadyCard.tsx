/**
 * ReadyCard (agent/1 `ready`) — something Mila made and is ready to review; it lives in Studio. The tile shows the kind
 * (the category-default treatment: black ground, one glyph), "Experimental" when it is an AI image or video, the summary,
 * and Review, which opens the item. No open handler → no button (no dead taps).
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { MilaButton, SoftChip, partStyles } from "./parts";
import { useAgentCardHandlers } from "./handlers";
import { READY_KIND } from "../../lib/agent/cardLogic";
import type { CardOf } from "../../lib/agent/types";

export const KIND_GLYPH: Record<string, string> = {
  deck: "layers", post_kit: "film", page: "globe", visual: "image", media_edit: "image", brief: "file-text", draft: "edit-3", other: "box",
};

export function KindTile({ kind, size = 56 }: { kind: string; size?: number }) {
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: Math.round(size * 0.25) }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Feather name={(KIND_GLYPH[kind] ?? "box") as any} size={Math.round(size * 0.4)} color={Bold.onDark} />
      <View style={styles.tileMark} />
    </View>
  );
}

export function ReadyCard({ card }: { card: CardOf<"ready"> }) {
  const { openLink } = useAgentCardHandlers();
  const p = card.payload;
  const link = card.links[0] ?? { label: "Review", target: { screen: "studio", id: p.itemId } };
  return (
    <View style={styles.card} testID="card-ready">
      <View style={styles.row}>
        <KindTile kind={p.itemKind} />
        <View style={styles.text}>
          <View style={partStyles.row}>
            <Text style={styles.kind}>{READY_KIND[p.itemKind] ?? READY_KIND.other}</Text>
            {p.experimental ? <SoftChip tone="dashed" testID="ready-experimental">Experimental</SoftChip> : null}
          </View>
          <Text style={partStyles.title}>{card.title}</Text>
          <Text style={partStyles.body}>{p.summary}</Text>
        </View>
      </View>
      {openLink ? (
        <MilaButton label={link.label} icon="arrow-right" onPress={() => openLink(link.target, link)} testID="ready-open" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 14 },
  row: { flexDirection: "row", gap: 14, alignItems: "flex-start" },
  text: { flex: 1, gap: 4 },
  kind: { ...BoldType.label, color: Bold.mute },
  tile: { backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tileMark: { position: "absolute", right: -6, bottom: -6, width: 18, height: 18, borderRadius: 9, backgroundColor: Bold.blue },
});
