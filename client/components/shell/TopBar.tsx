// The shell's top bar, on every main tab screen (DESIGN.md "Shell", look B): NOMILA wordmark (900, .34em) at left; at
// right the settings gear (Settings, pushed above the tabs) and her avatar (Me, pushed above the tabs). On a hero it is
// white over the top scrim; on a white screen, black.
//
//   <TopBar />                 on the page (Strategy, Opportunities, Studio): sits above the screen's own title row
//   <TopBarActions onHero />   gear + avatar only, for a photo hero's own top row (Home: MeHero draws the wordmark and
//                              takes these as its right slot)
//   withTopBar(Screen)         a tab's root screen with the bar above it; the screen renders exactly as it does alone
//
// Dimensions follow the drawing: 52 high, 16 side gutter, the gear at 20, the avatar at 28. Theme tokens only.

import React from "react";
import { View, Text, Pressable, StyleSheet, SafeAreaView } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { haptics } from "../../lib/haptics";
import { openSettings } from "../../navigation/meNav";
import { MeAvatar } from "../me/MeAvatarButton";
import { Bold, BoldType } from "../../constants/theme";

const AVATAR = 28;

export function TopBarActions({ onHero }: { onHero?: boolean }) {
  const navigation = useNavigation();
  return (
    <View style={styles.actions}>
      <Pressable
        onPress={() => { haptics.press(); openSettings(navigation); }}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Open Settings"
        style={({ pressed }) => [styles.gear, pressed && styles.pressed]}
      >
        <Feather name="settings" size={20} color={onHero ? Bold.onDark : Bold.ink} />
      </Pressable>
      <MeAvatar size={AVATAR} onHero={onHero} />
    </View>
  );
}

export function TopBar() {
  return (
    <View style={styles.bar} testID="shell-top-bar">
      <Text style={styles.wordmark}>NOMILA</Text>
      <TopBarActions />
    </View>
  );
}

/** A tab root with the top bar above it. The screen keeps its own SafeAreaView; nested, it adds no second inset. */
export function withTopBar<P extends object>(Screen: React.ComponentType<P>): React.ComponentType<P> {
  function WithTopBar(props: P) {
    return (
      <SafeAreaView style={styles.safe}>
        <TopBar />
        <View style={styles.body}><Screen {...props} /></View>
      </SafeAreaView>
    );
  }
  WithTopBar.displayName = `withTopBar(${Screen.displayName ?? Screen.name ?? "Screen"})`;
  return WithTopBar;
}

const styles = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: Bold.paper },
  body:     { flex: 1 },
  bar:      { height: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Bold.gutter, backgroundColor: Bold.paper },
  wordmark: { ...BoldType.wordmark, color: Bold.ink },
  actions:  { flexDirection: "row", alignItems: "center", gap: 14 },
  gear:     { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  pressed:  { opacity: 0.7 },
});
