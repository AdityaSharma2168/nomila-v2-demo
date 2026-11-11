// The bottom menu (DESIGN.md "Shell", look B). One component for both shells; which five tabs it draws is whatever the
// navigator registered (client/navigation/shellTabs.ts). Five tabs, Feather 22 and a 10px label; active = ink, inactive
// = quiet grey, no colour. Mila is the centre button, lifted 26, and it opens Ask Mila — the Mila tab's own screen, so
// this bar stays under the chat (Muse); while the keyboard is up there it steps aside (`hideOnKeyboard`). The
// shell draws Mila herself there — her IDLE avatar only, a soft 50 circle with no ring or ink edge (owner's Muse
// direction, 8 Oct 2026).

import React, { useEffect, useState } from "react";
import { View, Pressable, StyleSheet, Text, Image, AccessibilityInfo, AppState, Keyboard, Platform } from "react-native";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { barTabsFor, type TabConfig } from "../../navigation/shellTabs";
import { AGENT_V3, HOME_V3 } from "../../lib/flags";
import { MilaAvatar } from "../mila/MilaAvatar";
import { useMilaUnread } from "../../lib/milaUnread";
import { SOFT_LIFT } from "../mila/softLift";

const MILA_STILL = require("../../../assets/mila/mila-still.png");
const MILA_SIZE = 50;

/**
 * Mila in the centre of the bar: her idle loop while she may move, otherwise her still. She only plays when the app is
 * foregrounded, reduce-motion is off and `active` (the Ask Mila overlay is closed) — so only one Mila video ever plays,
 * and the player is unmounted, not just paused, while the overlay has her. Hidden from screen readers: the button
 * around her announces "Ask Mila", not "Mila is idle".
 */
export function TabMila({ active }: { active: boolean }) {
  // null = OS setting not yet read; she shows her still until it is known.
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const [appActive, setAppActive] = useState(AppState.currentState !== "background");

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (mounted) setReduceMotion(v); })
      .catch(() => { if (mounted) setReduceMotion(false); });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { mounted = false; sub.remove(); };
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setAppActive(s === "active"));
    return () => sub.remove();
  }, []);

  const moving = active && appActive && reduceMotion === false;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
      {moving ? (
        <MilaAvatar state="idle" size={MILA_SIZE} active />
      ) : (
        <Image source={MILA_STILL} style={styles.milaStill} accessibilityIgnoresInvertColors testID="tab-mila-still" />
      )}
    </View>
  );
}

/** Whether the software keyboard is up. iOS says so before it moves (will*), Android only once it has (did*). */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const a = Keyboard.addListener(show, () => setVisible(true));
    const b = Keyboard.addListener(hide, () => setVisible(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  return visible;
}

export function TabBar({
  state, navigation, onOpenSearchAsk, milaActive = true, hideOnKeyboard = false,
}: Pick<BottomTabBarProps, "state" | "navigation"> & {
  onOpenSearchAsk: () => void;
  /** False while Ask Mila is open (she is on screen there), so the bar's Mila holds her still. */
  milaActive?: boolean;
  /** True on Ask Mila: the bar steps aside while the keyboard is up (the composer sits on the keyboard) and returns
   *  when it is put away — as in Muse. Other screens keep the bar as it always was. */
  hideOnKeyboard?: boolean;
}) {
  const keyboardUp = useKeyboardVisible();
  // EXPO_PUBLIC_MILA_PROACTIVE: a message Mila started is waiting unread (0, no dot, with the flag off).
  const milaUnread = useMilaUnread();
  if (hideOnKeyboard && keyboardUp) return null;
  const tabs: TabConfig[] = barTabsFor(AGENT_V3, HOME_V3);
  return (
    <View style={styles.tabBar} testID="shell-tab-bar">
      {state.routes.map((route, index) => {
        const config    = tabs.find((t) => t.name === route.name);
        if (!config) return null;
        const isFocused = state.index === index;

        if (config.isCenter) {
          return (
            <Pressable
              key={route.key}
              style={styles.centerTab}
              onPress={() => { haptics.press(); onOpenSearchAsk(); }}
              accessibilityRole="button"
              accessibilityState={{ selected: isFocused }}
              accessibilityLabel={milaUnread > 0 ? "Ask Mila, new message from Mila" : "Ask Mila"}
            >
              <View style={[styles.centerLift, styles.milaBtn]} testID="tab-mila">
                <TabMila active={milaActive} />
                {/* DESIGN.md: --act is the "needs you" badge colour; a dot, no number (one quiet signal). */}
                {milaUnread > 0 ? <View style={styles.unreadDot} testID="tab-mila-unread" /> : null}
              </View>
              {config.label ? <Text style={[styles.tabLabel, (!HOME_V3 || isFocused) && styles.tabLabelActive]}>{config.label}</Text> : null}
            </Pressable>
          );
        }

        const onPress = () => {
          if (!isFocused) haptics.select(); // tactile tick on every tab switch, app-wide
          const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) navigation.navigate(route.name);
        };

        return (
          <Pressable
            key={route.key}
            style={styles.tab}
            onPress={onPress}
            accessibilityRole="tab"
            accessibilityState={{ selected: isFocused }}
            accessibilityLabel={config.label}
          >
            <Feather name={config.icon as any} size={22} color={isFocused ? Bold.ink : Bold.quiet} />
            <Text style={[styles.tabLabel, isFocused && styles.tabLabelActive]}>{config.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection:   "row",
    alignItems:      "flex-end",
    backgroundColor: Bold.paper,
    borderTopWidth:  1,
    borderTopColor:  Bold.line,
    paddingBottom:   18,
    paddingTop:      8,
    paddingHorizontal: 6,
  },
  tab: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "center",
    gap:            3,
    minHeight:      44,
  },
  tabLabel: {
    ...BoldType.tab,
    color: Bold.quiet,
  },
  tabLabelActive: { color: Bold.ink },
  centerTab: {
    flex:           1,
    alignItems:     "center",
    justifyContent: "flex-end",
    gap:            2,
  },
  centerLift: {
    width:           50,
    height:          50,
    borderRadius:    25,
    alignItems:      "center",
    justifyContent:  "center",
    marginTop:       -26,
    marginBottom:    2,
  },
  // Mila (the shell): no ring, no ink edge — only the Muse overlay's very soft lift (none on Android, where elevation
  // would draw a hard grey ring). The paper fill shows only for the instant before her image paints.
  milaBtn: {
    ...SOFT_LIFT,
    backgroundColor: Bold.paper,
  },
  unreadDot: {
    position:        "absolute",
    top:             0,
    right:           0,
    width:           12,
    height:          12,
    borderRadius:    6,
    backgroundColor: Bold.act,
    borderWidth:     2,
    borderColor:     Bold.paper,
  },
  milaStill: {
    width:        MILA_SIZE,
    height:       MILA_SIZE,
    borderRadius: MILA_SIZE / 2,
  },
});
