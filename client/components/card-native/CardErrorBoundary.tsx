import React from "react";
import { View, Text, StyleSheet } from "react-native";

interface Props { children: React.ReactNode }
interface State { hasError: boolean }

/**
 * A single malformed card — a partial or stale `MediaKitData` card whose render reads a field the
 * server didn't populate — must NOT white-screen the whole deck. This boundary catches a render
 * throw in one CardView and degrades to a quiet placeholder, so the rest of the deck still swipes.
 * (React Native error boundaries must be class components — getDerivedStateFromError/componentDidCatch.)
 */
export class CardErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[CardDeck] a card failed to render and was skipped:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.fallback}>
          <Text style={styles.txt}>This card couldn’t be shown.</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  txt:      { color: "#9C968D", fontSize: 14, textAlign: "center" },
});
