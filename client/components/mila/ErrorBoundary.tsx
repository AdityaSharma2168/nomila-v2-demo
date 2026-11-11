import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { MILA_CARD } from "./milaSurface";

// The app's FIRST error boundary. Deliberately generic + reusable: it wraps any
// subtree whose render could throw and replaces the throw with a small inline
// fallback instead of white-screening the surrounding UI.
//
// Today it guards Mila's model-chosen widgets (the model picks the widget type,
// so a malformed/unknown shape must fail soft). PR-7's approval cards render
// through the same boundary — do NOT couple it to deal/score.

interface Props {
  children: React.ReactNode;
  /** Custom fallback node. When provided, it replaces the default card. */
  fallback?: React.ReactNode;
  /**
   * Render-prop fallback that receives the caught error — use when the fallback
   * needs the message (e.g. a full-screen "couldn't open" state that shows why).
   * Takes precedence over `fallback`.
   */
  renderError?: (error: Error | null) => React.ReactNode;
  /** Text for the default fallback card. */
  label?: string;
  /** Called once when a render throws (logging / telemetry). Never rethrows. */
  onError?: (error: Error) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    // Widget render error only — no PII. Log and move on; never rethrow.
    console.warn("[mila] ErrorBoundary caught:", error?.message);
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.renderError) return this.props.renderError(this.state.error);
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <View style={styles.card}>
        <Feather
          name="alert-circle"
          size={14}
          color={Colors.light.textSecondary}
        />
        <Text style={styles.text}>
          {this.props.label ?? "Couldn't display this card"}
        </Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    // A light Mila card with the soft lift, no border (milaSurface).
    ...MILA_CARD,
  },
  text: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: Colors.light.textSecondary,
  },
});
