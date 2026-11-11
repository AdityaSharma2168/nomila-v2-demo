/**
 * MilaChatMenu — the one frosted menu at the top left of Ask Mila (owner direction, 8 Oct 2026: "much like Muse").
 *
 * Muse keeps a single round menu button on the left, her avatar and name in the middle, and one action on the right.
 * Saved chats, New chat and Delete this chat used to be four square buttons beside a title; they live here now, in a
 * small frosted popover that drops from the menu button. Each row keeps the accessibility label its old button had.
 *
 * The popover sits over a near-clear scrim (a tap outside closes it). It fades in, or simply appears under reduce
 * motion. Frost carries the glass, the corner and the soft lift — no border, no ink outline (DESIGN.md, Mila exception).
 */
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { N, oppsFont } from "../deals/opps/tokens";
import { Frost } from "./Frost";

const MENU_RADIUS = 20;

export type MilaChatMenuAction = "history" | "new" | "delete";

interface Item {
  action: MilaChatMenuAction;
  icon: React.ComponentProps<typeof Feather>["name"];
  label: string;
  hint: string;
}

const ITEMS: Item[] = [
  { action: "history", icon: "clock",   label: "Saved chats",      hint: "Opens your past conversations to reopen one" },
  { action: "new",     icon: "edit",    label: "New chat",         hint: "Starts a fresh conversation and clears the screen" },
  { action: "delete",  icon: "trash-2", label: "Delete this chat", hint: "Deletes this conversation with Mila after you confirm" },
];

export function MilaChatMenu({
  visible,
  top,
  canDelete,
  onClose,
  onPick,
}: {
  visible: boolean;
  /** Where the popover's top edge sits (just under the menu button). */
  top: number;
  /** Delete only when there is something on screen to delete. */
  canDelete: boolean;
  onClose: () => void;
  onPick: (action: MilaChatMenuAction) => void;
}) {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (mounted) setReduceMotion(v); })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // iOS cannot present a sheet (Saved chats) or an alert (Delete) while this Modal is still dismissing, so there the
  // picked action runs from onDismiss; elsewhere (no onDismiss) it runs straight away.
  const pendingRef = useRef<MilaChatMenuAction | null>(null);
  const pick = (action: MilaChatMenuAction) => {
    onClose();
    if (Platform.OS === "ios") pendingRef.current = action;
    else onPick(action);
  };
  const onDismiss = () => {
    const action = pendingRef.current;
    pendingRef.current = null;
    if (action) onPick(action);
  };

  const items = ITEMS.filter((i) => i.action !== "delete" || canDelete);
  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? "none" : "fade"} onRequestClose={onClose} onDismiss={onDismiss}>
      <View style={styles.root}>
        <Pressable style={[StyleSheet.absoluteFill, styles.scrim]} onPress={onClose} accessibilityLabel="Close menu" />
        <Frost radius={MENU_RADIUS} style={[styles.menu, { top }]} testID="mila-chat-menu">
          {items.map((it) => (
            <Pressable
              key={it.action}
              onPress={() => pick(it.action)}
              accessibilityRole="menuitem"
              accessibilityLabel={it.label}
              accessibilityHint={it.hint}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
              <Feather name={it.icon} size={17} color={N.ink700} />
              <Text style={styles.rowText}>{it.label}</Text>
            </Pressable>
          ))}
        </Frost>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Near clear: the menu is a light popover, not a curtain.
  scrim: { backgroundColor: "rgba(26,26,26,0.06)" },
  menu: {
    position: "absolute",
    left: 16,
    minWidth: 210,
    paddingVertical: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 16,
  },
  rowText: { fontFamily: oppsFont(600), fontSize: 15, color: N.ink900 },
});
