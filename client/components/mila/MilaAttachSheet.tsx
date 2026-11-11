/**
 * MilaAttachSheet — what the ＋ in the Mila composer opens.
 *
 * Same shape as Studio's AttachSheet ("Add something", role tiles) so the app has one grammar
 * for adding things, but Mila's own four, because Mila attaches things to READ where Studio
 * attaches things to generate from:
 *
 *   Photo or video   → the camera roll; saved to the media library, sent with the message
 *   Product          → the camera roll; saved to the library TAGGED for Studio, sent with the message
 *   Contract         → the existing contract sheet: upload → read → review → save (a tap saves)
 *   Search the web   → prefills the composer; Mila grounds the answer with a live search
 *
 * Search lives here on purpose: none of the major assistants put a magnifier in a chat input,
 * so the composer stopped looking like a search box and search became one thing you can add.
 *
 * Look (owner direction, 8 Oct 2026, "much like Muse"; DESIGN.md §16): a frosted sheet (Frost) that floats a little
 * off the screen's edges over a light dim, its tiles light cards with the soft lift (milaSurface) — no outlines, no
 * pink, nothing dark.
 */

import React from "react";
import { View, Text, Modal, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { HapticPressable } from "../HapticPressable";
import { N, oppsFont } from "../deals/opps/tokens";
import { Frost } from "./Frost";
import { MILA_CARD } from "./milaSurface";

/** The sheet's corner — larger than a card's, so the glass reads as the container. */
const SHEET_RADIUS = 28;

export type MilaAttachKind = "photo" | "product" | "contract" | "search";

const TILES: {
  kind: MilaAttachKind;
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  note: string;
}[] = [
  { kind: "photo",    icon: "image",     label: "Photo or video", note: "From your camera roll" },
  { kind: "product",  icon: "tag",       label: "Product",        note: "The piece itself, for Studio" },
  { kind: "contract", icon: "file-text", label: "Contract",       note: "A PDF or a photo of it" },
  { kind: "search",   icon: "globe",     label: "Search the web", note: "Ask with a live search" },
];

export function MilaAttachSheet({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (kind: MilaAttachKind) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
      <Pressable style={[StyleSheet.absoluteFill, styles.scrim]} onPress={onClose} accessibilityLabel="Close" />
      <Frost radius={SHEET_RADIUS} style={styles.sheet} testID="mila-attach-sheet">
        <View style={styles.grabber} />
        <Text style={styles.title}>Add something</Text>
        <View style={styles.tiles}>
          {TILES.map((t) => (
            <HapticPressable
              key={t.kind}
              style={styles.tile}
              onPress={() => { onClose(); onPick(t.kind); }}
              accessibilityRole="button"
              accessibilityLabel={`${t.label}. ${t.note}`}
            >
              <View style={styles.tileIcon}>
                <Feather name={t.icon} size={20} color={N.ink700} />
              </View>
              <Text style={styles.tileLabel}>{t.label}</Text>
              <Text style={styles.tileNote}>{t.note}</Text>
            </HapticPressable>
          ))}
        </View>
      </Frost>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  // A light dim (ink at 16%), not a dark curtain: the frosted sheet still reads as glass.
  scrim: { backgroundColor: "rgba(26,26,26,0.16)" },
  // Frost carries the glass, the corner and the soft lift; it floats 10 off the edges.
  sheet: {
    marginHorizontal: 10, marginBottom: 24,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 18,
  },
  grabber: { width: 38, height: 4, borderRadius: 99, backgroundColor: N.cream400, alignSelf: "center", marginBottom: 14 },
  title: { fontFamily: oppsFont(800), fontSize: 19, letterSpacing: -0.3, color: N.ink900, marginBottom: 12 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: {
    ...MILA_CARD,
    width: "48%", flexGrow: 1, minWidth: 0, alignItems: "center",
    paddingVertical: 15, paddingHorizontal: 10,
  },
  tileIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: N.cream200, alignItems: "center", justifyContent: "center" },
  tileLabel: { fontFamily: oppsFont(700), fontSize: 13, color: N.ink900, marginTop: 9, textAlign: "center" },
  tileNote: { fontFamily: oppsFont(400), fontSize: 11, lineHeight: 14, color: N.ink500, marginTop: 4, textAlign: "center" },
});
