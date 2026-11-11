/**
 * StyleReferenceList — the references she has already had read, to pick one as a look (PR 18).
 *
 * ONLY already-read references (ADI-GO18 G8). Reading a new one is the Brand post screen's job, and nothing
 * here spends. The server refuses an unread one anyway, with "Still reading this reference": that refusal is
 * the invariant, and this list is only a convenience.
 *
 * What she picks shapes the LOOK through its reading. The picture itself is never sent to the model, which is
 * what separates this from the "A look" tag that was removed because faces leaked (ReferencePicker.tsx).
 */
import React from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import {
  useStyleReferences,
  type StyleReferenceRow,
} from "../../hooks/use-studio-edits";

export function StyleReferenceList({
  onPick,
  selectedAssetId = null,
}: {
  onPick: (row: StyleReferenceRow) => void;
  selectedAssetId?: string | null;
}) {
  const q = useStyleReferences(true);
  if (q.isLoading) return <ActivityIndicator color={Colors.light.textMuted} />;
  if (q.isError)
    return (
      <Text style={styles.note}>
        {"Couldn't load your references right now."}
      </Text>
    );
  const rows = q.data?.references ?? [];
  if (!rows.length)
    return (
      <Text style={styles.note} testID="style-refs-empty">
        No references read yet. Add one from a brand post, then it shows up
        here.
      </Text>
    );
  return (
    <View style={styles.list} testID="style-refs">
      {rows.map((r) => {
        const on = r.assetId === selectedAssetId;
        return (
          <Pressable
            key={r.assetId}
            style={[styles.row, on && styles.rowOn]}
            onPress={() => onPick(r)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Use this look. ${r.caption}`}
          >
            {r.thumbUrl ? (
              <Image source={{ uri: r.thumbUrl }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]}>
                <Feather
                  name="aperture"
                  size={18}
                  color={Colors.light.textMuted}
                />
              </View>
            )}
            <Text style={styles.caption} numberOfLines={3}>
              {r.caption}
            </Text>
            {on ? (
              <Feather name="check" size={16} color={Colors.light.primary} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
  },
  rowOn: { borderColor: Colors.light.primary },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.backgroundTertiary,
  },
  thumbEmpty: { alignItems: "center", justifyContent: "center" },
  caption: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.text,
  },
  note: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.textMuted,
  },
});
