// Accordion — a collapsed section card that opens in place (DESIGN.md "Density: collapsed cards, decks and letters").
//
//   <AccordionGroup onOpen={(id, y) => scrollTo(y)}>
//     <Accordion id="pillars" title="What defines you" summary="Historic representation · …" count="3" lead={<Thumbs />}>
//       …the open body…
//     </Accordion>
//   </AccordionGroup>
//
// Head (64 min) + ONE summary line + a count or thumbnails + the chevron; ONE open at a time per group — opening a second
// closes the first, and the group reports the opening card's y so the screen can scroll its head under the top bar. The
// open card's head gets the 2px black rule; the chevron turns 180°. Spring ~250 ms with no bounce past the final height;
// reduced motion ⇒ a 120 ms fade. The head is a button with `expanded` state and announces "<title>, N items".
// Row-level folds inside a body (See all N) stay independent of the accordion. Theme tokens and BoldType roles only.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, LayoutAnimation, AccessibilityInfo, Platform, UIManager, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Whether she asked the OS for reduced motion; false until the OS answers. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setReduced(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => setReduced(!!v));
    return () => { live = false; sub?.remove?.(); };
  }, []);
  return reduced;
}

/** The expand motion: a 250 ms spring (no overshoot), or a 120 ms fade when motion is reduced. */
export function animateExpand(reduced: boolean): void {
  try {
    LayoutAnimation.configureNext(reduced
      ? { duration: 120, create: { type: "linear", property: "opacity" }, update: { type: "linear" }, delete: { type: "linear", property: "opacity" } }
      : { duration: 250, create: { type: "easeInEaseOut", property: "opacity" }, update: { type: "spring", springDamping: 1 }, delete: { type: "easeInEaseOut", property: "opacity" } });
  } catch {
    // Older renderers without layout animation: the card still opens, without the spring.
  }
}

interface GroupState { openId: string | null; toggle: (id: string, y: number) => void }
const Group = createContext<GroupState | null>(null);

export function AccordionGroup({ children, initial = null, onOpen }: { children: React.ReactNode; initial?: string | null; onOpen?: (id: string, y: number) => void }) {
  const reduced = useReducedMotion();
  const [openId, setOpenId] = useState<string | null>(initial);
  const toggle = useCallback((id: string, y: number) => {
    animateExpand(reduced);
    setOpenId((prev) => {
      const next = prev === id ? null : id;
      if (next) onOpen?.(next, y);
      return next;
    });
  }, [reduced, onOpen]);
  return <Group.Provider value={{ openId, toggle }}>{children}</Group.Provider>;
}

export function Accordion({ id, title, summary, count, lead, children, style, testID }: {
  id: string;
  title: string;
  /** ONE line, taken from the section's first line; clipped. */
  summary?: string | null;
  /** A count at the right of the head (a thumbnails strip goes in `lead`). */
  count?: string | number | null;
  /** A tile or a thumbnails strip at the left of the head. */
  lead?: React.ReactNode;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const group = useContext(Group);
  const [local, setLocal] = useState(false);
  const reduced = useReducedMotion();
  const y = useRef(0);
  const open = group ? group.openId === id : local;
  const onLayout = (e: LayoutChangeEvent) => { y.current = e.nativeEvent.layout.y; };
  const onToggle = () => {
    if (group) group.toggle(id, y.current);
    else { animateExpand(reduced); setLocal((v) => !v); }
  };
  const items = count != null && count !== "" ? `, ${count} items` : "";
  return (
    <View style={[styles.card, style]} onLayout={onLayout} testID={testID ?? `accordion-${id}`}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}${items}`}
        style={({ pressed }) => [styles.head, open && styles.headOpen, pressed && styles.pressed]}
        testID={`accordion-head-${id}`}
      >
        {lead ? <View style={styles.lead}>{lead}</View> : null}
        <View style={styles.text}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {summary ? <Text style={styles.summary} numberOfLines={1}>{summary}</Text> : null}
        </View>
        {count != null && count !== "" ? <Text style={styles.count}>{String(count)}</Text> : null}
        <View style={open ? styles.chevronOpen : undefined}><Feather name="chevron-down" size={18} color={Bold.quiet} /></View>
      </Pressable>
      {open ? <View style={styles.body} testID={`accordion-body-${id}`}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card:        { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, overflow: "hidden" },
  head:        { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, minHeight: 64 },
  headOpen:    { borderBottomWidth: 2, borderBottomColor: Bold.ink },
  pressed:     { backgroundColor: Bold.ground },
  lead:        { flexShrink: 0 },
  text:        { flex: 1, minWidth: 0, gap: 2 },
  title:       { ...BoldType.rowTitle, color: Bold.ink },
  summary:     { ...BoldType.rowMeta, color: Bold.mute },
  count:       { ...BoldType.sigValue, color: Bold.ink, fontVariant: ["tabular-nums"] },
  chevronOpen: { transform: [{ rotate: "180deg" }] },
  body:        { padding: 14, gap: 12 },
});
