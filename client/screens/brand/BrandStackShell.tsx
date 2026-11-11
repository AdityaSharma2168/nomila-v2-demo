// The frame every pushed Brand screen (Deck, Score, Rates) shares: safe area, the kit's
// StackHeader, a scroll view with pull-to-refresh. Keeps the three screens identical at the top.

import React from "react";
import { View, StyleSheet, SafeAreaView, StatusBar, ScrollView, RefreshControl } from "react-native";
import { Colors, Spacing } from "../../constants/theme";
import { StackHeader } from "../../components/ui";

const C = Colors.light;

export function BrandStackShell({ title, right, children, dark, refreshing, onRefresh }: {
  title:       string;
  right?:      React.ReactNode;
  children:    React.ReactNode;
  dark?:       boolean;
  refreshing?: boolean;
  onRefresh?:  () => void;
}) {
  return (
    <SafeAreaView style={[styles.safe, dark && styles.safeDark]}>
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} backgroundColor={dark ? C.backgroundRoot : C.backgroundRoot} />
      <StackHeader title={title} right={right} dark={dark} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={onRefresh ? (
          <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={C.primary} colors={[C.primary]} />
        ) : undefined}
      >
        {children}
        <View style={{ height: Spacing["4xl"] }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: C.backgroundRoot },
  safeDark: { backgroundColor: Colors.dark.backgroundRoot },
  scroll:   { flex: 1 },
  content:  { paddingBottom: Spacing.xl },
});
