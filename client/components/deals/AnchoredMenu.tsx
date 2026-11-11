import React, { useRef, useState } from "react";
import { View, Text, Pressable, Modal, StyleSheet, Dimensions } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Fonts, Colors } from "../../constants/theme";
import type { ActionTone } from "./dealActions";

export interface AnchoredMenuItem {
  key:      string;
  label:    string;
  icon?:    any;          // Feather icon name
  count?:   number;       // right-aligned count (stage dropdown)
  tone?:    ActionTone;   // colors the label/icon (overflow)
  active?:  boolean;      // shows a check (stage dropdown)
  onPress:  () => void;
}

interface AnchoredMenuProps {
  trigger:       (open: boolean) => React.ReactNode;
  items:         AnchoredMenuItem[];
  align?:        "left" | "right";
  minWidth?:     number;
  triggerStyle?: any;
}

const TONE_COLOR: Record<string, string> = {
  accept:    "#1A9960",
  negotiate: Colors.light.primary,
  decline:   "#C2342F",
  neutral:   "#171513",
};

/**
 * A reusable anchored popover menu: the trigger is measured in-window and the
 * menu is positioned just below it (auto-flipping above when the trigger sits
 * low on screen, e.g. the card's ••• overflow). Shared by the stage dropdown
 * and the deal overflow so both behave identically.
 */
export function AnchoredMenu({ trigger, items, align = "left", minWidth = 200, triggerStyle }: AnchoredMenuProps) {
  const [open, setOpen]     = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const ref = useRef<View>(null);

  function openMenu() {
    ref.current?.measureInWindow((x, y, w, h) => { setAnchor({ x, y, w, h }); setOpen(true); });
  }

  const screen = Dimensions.get("window");
  const openAbove = !!anchor && anchor.y > screen.height * 0.55;

  const pos: { top?: number; bottom?: number; left?: number; right?: number } = {};
  if (anchor) {
    if (openAbove) pos.bottom = screen.height - anchor.y + 4;
    else           pos.top    = anchor.y + anchor.h + 4;
    if (align === "right") pos.right = Math.max(8, screen.width - (anchor.x + anchor.w));
    else                   pos.left  = anchor.x;
  }

  return (
    <>
      <Pressable ref={ref} onPress={openMenu} hitSlop={6} style={triggerStyle}>
        {trigger(open)}
      </Pressable>

      <Modal transparent visible={open} animationType="fade" statusBarTranslucent onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        {anchor && (
          <View style={[styles.menu, { minWidth }, pos]}>
            {items.map((it, i) => {
              const color = it.active ? Colors.light.primary : (TONE_COLOR[it.tone ?? "neutral"]);
              return (
                <Pressable
                  key={it.key}
                  style={({ pressed }) => [styles.row, i > 0 && styles.rowDivider, pressed && styles.rowPressed]}
                  onPress={() => { setOpen(false); it.onPress(); }}
                >
                  {it.icon && <Feather name={it.icon} size={16} color={color} />}
                  <Text style={[styles.label, { color }, it.active && styles.labelActive]}>{it.label}</Text>
                  {it.count != null && (
                    <Text style={[styles.count, it.active && styles.countActive]}>{it.count}</Text>
                  )}
                  {it.active && <Feather name="check" size={14} color={Colors.light.primary} />}
                </Pressable>
              );
            })}
          </View>
        )}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "transparent" },
  menu: {
    position: "absolute",
    backgroundColor: Colors.light.card,
    borderRadius: 14,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: Colors.light.borderLight,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
    elevation: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.borderLight },
  rowPressed: { backgroundColor: Colors.light.backgroundDefault },
  label: { flex: 1, fontFamily: Fonts.bodyMedium, fontSize: 15 },
  labelActive: { fontFamily: Fonts.bodySemiBold },
  count: { fontFamily: Fonts.body, fontSize: 13, color: "#9C968D" },
  countActive: { color: Colors.light.primary },
});
