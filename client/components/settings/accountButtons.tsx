/**
 * accountButtons — the two buttons Settings › Account's sheets add to the shared Button: the error-red destructive
 * action (the red Settings already uses for Disconnect and Sign out) and the soft grey secondary ("Close", "Keep my
 * account"). Full-width, 48 high, pill, the Bold button type.
 */
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType, Colors } from "../../constants/theme";
import { Button } from "../ui";

export const DANGER = Colors.light.error;

export function DangerButton({ children, onPress, disabled, loading, testID }: {
  children: string; onPress: () => void; disabled?: boolean; loading?: boolean; testID?: string;
}) {
  return (
    <Button bold="primary" onPress={onPress} disabled={disabled} loading={loading} style={[styles.danger, loading && styles.sending]} testID={testID}
      accessibilityLabel={children}>{children}</Button>
  );
}

export function SoftButton({ children, onPress, disabled, loading, testID }: {
  children: string; onPress: () => void; disabled?: boolean; loading?: boolean; testID?: string;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      style={({ pressed }) => [styles.soft, off && styles.off, pressed && !off && styles.pressed]}
      onPress={() => { haptics.press(); onPress(); }}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off }}
      testID={testID}
    >
      {loading ? <ActivityIndicator size="small" color={Bold.ink} /> : <Text style={styles.softText}>{children}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  danger:   { backgroundColor: DANGER, height: Bold.button, alignSelf: "stretch", marginTop: 10 },
  /** Sending: the button stays full red with its spinner (only "off" before DELETE is typed is pale). */
  sending:  { opacity: 1 },
  soft:     { height: Bold.button, borderRadius: Bold.radius.pill, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center", alignSelf: "stretch", marginTop: 10 },
  softText: { ...BoldType.button, color: Bold.ink },
  off:      { opacity: 0.5 },
  pressed:  { transform: [{ scale: Bold.pressScale }] },
});
