/**
 * SportChips — "What do you play?" inside Mila's chat (design "Sport grid, with icons", approved 23 Oct 2026; NOT wired
 * into the chat yet). The eight common sports (COMMON_SPORTS) as four-column icon chips with the grid's look: the first
 * pick MAIN (solid raspberry, a "Main" badge), the others a raspberry tint and a check. Under them "More sports" opens
 * the full list in a sheet with search, and "Other" opens the same sheet with the search focused; words that match no
 * sport offer "Add … as your sport". Picks the chips do not show (from the sheet, or typed) sit as pills under the chips.
 * The selection rules are the grid's own (lib/onboardingFront): toggleSport, addSport, sportMark.
 *
 *   <SportChips value={sports} onChange={setSports} />
 */
import React, { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Button } from "../ui/Chip";
import { BoldSheet } from "../deals/BoldSheet";
import { PickedPill, SportTile, SPORT_TILE_RADIUS } from "./SportTile";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { COMMON_SPORTS, addSport, filterSports, picksOutside, sportByLabel, sportMark, sportToAdd, toggleSport } from "../../lib/onboardingFront";
import { FRONT_COPY } from "../../screens/onboarding/frontCopy";

export { COMMON_SPORTS };

/** The field's own line shows focus; the browser's focus ring would draw a second box inside it (web only). */
const NO_WEB_OUTLINE = Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {};

const GAP = 6;

export function SportChips({ value, onChange, testID = "sport-chips" }: {
  /** The picks, main first. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  testID?: string;
}) {
  const c = FRONT_COPY.sport;
  const [sheet, setSheet] = useState<null | "more" | "other">(null);
  const toggle = (s: string) => { haptics.select(); onChange(toggleSport(value, s)); };
  const extra = picksOutside(value, COMMON_SPORTS);

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.grid}>
        {COMMON_SPORTS.map((s) => (
          <View key={s} style={styles.cell}>
            <SportTile label={s} icon={sportByLabel(s)?.icon} mark={sportMark(value, s)} mainLabel={c.main} height={60} onPress={() => toggle(s)} testID={`chip-${s}`} />
          </View>
        ))}
      </View>
      {extra.length ? (
        <View style={styles.pills}>
          {extra.map((s) => (
            <PickedPill key={s} label={s} main={sportMark(value, s) === "main"} mainLabel={c.main} removeLabel={c.remove} onRemove={() => toggle(s)} testID={`chip-picked-${s}`} />
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <Pressable onPress={() => setSheet("more")} accessibilityRole="button" style={({ pressed }) => [styles.more, pressed && styles.pressed]} testID="chip-more">
          <MaterialCommunityIcons name="view-grid-outline" size={16} color={Bold.ink} />
          <Text style={styles.moreText}>{c.more}</Text>
        </Pressable>
        <Pressable onPress={() => setSheet("other")} accessibilityRole="button" style={({ pressed }) => [styles.more, pressed && styles.pressed]} testID="chip-other">
          <MaterialCommunityIcons name="magnify" size={16} color={Bold.ink} />
          <Text style={styles.moreText}>{c.otherShort}</Text>
        </Pressable>
      </View>
      {sheet ? <AllSportsSheet value={value} onChange={onChange} focus={sheet === "other"} onClose={() => setSheet(null)} /> : null}
    </View>
  );
}

/** The full list in a sheet: search over every sport, the same tiles, add-your-own, Done. */
export function AllSportsSheet({ value, onChange, focus, onClose }: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Open with the search focused ("Other"). */
  focus?: boolean;
  onClose: () => void;
}) {
  const c = FRONT_COPY.sport;
  const [query, setQuery] = useState("");
  const tiles = filterSports(query);
  const typed = sportToAdd(query);
  const add = () => { if (!typed) return; haptics.select(); onChange(addSport(value, typed)); setQuery(""); };
  return (
    <BoldSheet title={c.allTitle} onClose={onClose} testID="sport-sheet" footer={<Button bold="primary" onPress={onClose} testID="sport-sheet-done">{c.done}</Button>}>
      <View style={[styles.search, !!query.trim() && styles.searchOn]}>
        <MaterialCommunityIcons name="magnify" size={18} color={Bold.mute} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={add}
          autoFocus={focus}
          placeholder={c.other}
          placeholderTextColor={Bold.quiet}
          autoCapitalize="sentences"
          autoCorrect={false}
          maxLength={80}
          style={styles.searchInput}
          accessibilityLabel={c.otherLabel}
          testID="sport-sheet-search"
        />
      </View>
      {tiles.length ? (
        <View style={styles.grid}>
          {tiles.map((s) => (
            <View key={s} style={styles.cell}>
              <SportTile label={s} icon={sportByLabel(s)?.icon} mark={sportMark(value, s)} mainLabel={c.main} onPress={() => { haptics.select(); onChange(toggleSport(value, s)); }} testID={`sheet-${s}`} />
            </View>
          ))}
        </View>
      ) : null}
      {typed ? (
        <Pressable onPress={add} accessibilityRole="button" style={styles.addRow} hitSlop={6} testID="sport-sheet-add">
          <MaterialCommunityIcons name="plus" size={18} color={Bold.act} />
          <Text style={styles.addText} numberOfLines={1}>{c.add(typed)}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.fine}>{c.allFine}</Text>
    </BoldSheet>
  );
}

const styles = StyleSheet.create({
  root:        { gap: 10 },
  grid:        { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -GAP / 2, rowGap: GAP },
  cell:        { width: "25%", paddingHorizontal: GAP / 2 },
  pills:       { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  row:         { flexDirection: "row", gap: 6 },
  more:        { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 38, borderRadius: Bold.radius.pill, borderWidth: 1, borderColor: Bold.line, backgroundColor: Bold.paper },
  moreText:    { ...BoldType.chipLine, color: Bold.ink },
  pressed:     { transform: [{ scale: Bold.pressScale }] },
  search:      { flexDirection: "row", alignItems: "center", gap: 8, height: 44, borderRadius: SPORT_TILE_RADIUS, borderWidth: 1, borderColor: Bold.line, paddingHorizontal: 12 },
  searchOn:    { borderWidth: 1.5, borderColor: Bold.act },
  searchInput: { flex: 1, ...BoldType.chipLine, color: Bold.ink, height: 42, ...NO_WEB_OUTLINE },
  addRow:      { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 },
  addText:     { ...BoldType.link, color: Bold.act, flexShrink: 1 },
  fine:        { ...BoldType.caption, color: Bold.mute },
});
