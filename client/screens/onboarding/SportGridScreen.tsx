/**
 * SportGridScreen — "What do you play?" (the agent onboarding front; design "Sport grid, with icons", approved 23 Oct
 * 2026). Four columns of icon tiles (components/onboarding/SportTile) from the ONE sport list (shared/sports.ts), sized
 * so all 25 and "Other" fit above the pinned Continue on a 390 × 844 phone (smaller phones scroll). Multi-select: the
 * first pick is MAIN (solid raspberry, a "Main" badge), the others a raspberry tint and a check, and turning the main
 * one off promotes the next pick. "Other" is a search: typing filters the tiles, and words that match no tile offer
 * "Add … as your sport" (typed alone and never added, they still count, so Continue never drops them). A typed sport
 * shows as a pill under the field. When the athlete's name is not known yet, one name field sits above the grid.
 */
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Button } from "../../components/ui";
import { PickedPill, SportTile, SPORT_TILE_RADIUS } from "../../components/onboarding/SportTile";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { addSport, filterSports, picksOutside, sportByLabel, sportMark, sportToAdd, sportsToSave, toggleSport } from "../../lib/onboardingFront";
import { FRONT_COPY } from "./frontCopy";

export function SportGridScreen({
  onContinue, busy, error, askName = false, initial = [],
}: {
  /** The sports, main first, and the name typed here (null when the grid did not ask). */
  onContinue: (v: { sports: string[]; name: string | null }) => void;
  busy?: boolean;
  error?: boolean;
  askName?: boolean;
  initial?: string[];
}) {
  const c = FRONT_COPY.sport;
  const insets = useSafeAreaInsets();
  const [picked, setPicked] = useState<string[]>(initial);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const typed = sportToAdd(query);
  const sports = sportsToSave(picked, typed);
  const ready = sports.length > 0 && (!askName || !!name.trim()) && !busy;
  const mainIsOther = !picked.length && !!typed;
  const tiles = filterSports(query);
  const own = picksOutside(picked);
  const toggle = (s: string) => { haptics.select(); setPicked((p) => toggleSport(p, s)); };
  const add = () => { if (!typed) return; haptics.select(); setPicked((p) => addSport(p, typed)); setQuery(""); };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar barStyle="dark-content" />
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.body, { paddingTop: insets.top + 12 }]} keyboardShouldPersistTaps="handled" testID="sport-grid">
        <Text style={styles.wordmark}>NOMILA</Text>
        {askName ? (
          <View style={styles.nameBlock}>
            <Text style={styles.label} nativeID="front-name-label">{c.nameLabel}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={c.namePlaceholder}
              placeholderTextColor={Bold.quiet}
              autoCapitalize="words"
              autoComplete="name"
              maxLength={80}
              style={styles.input}
              accessibilityLabel={c.nameLabel}
              testID="sport-name-input"
            />
          </View>
        ) : null}
        <Text style={styles.title} accessibilityRole="header">{c.title}</Text>
        <Text style={styles.lede}>{c.lede}</Text>
        <View style={styles.grid}>
          {tiles.map((s) => (
            <View key={s} style={styles.cell}>
              <SportTile label={s} icon={sportByLabel(s)?.icon} mark={sportMark(picked, s)} mainLabel={c.main} onPress={() => toggle(s)} testID={`sport-${s}`} />
            </View>
          ))}
        </View>
        <View style={[styles.other, !!query.trim() && styles.otherOn]}>
          <MaterialCommunityIcons name="magnify" size={18} color={query.trim() ? Bold.ink2 : Bold.quiet} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={add}
            placeholder={c.other}
            placeholderTextColor={Bold.quiet}
            autoCapitalize="sentences"
            autoCorrect={false}
            returnKeyType={typed ? "done" : "search"}
            maxLength={80}
            style={styles.otherInput}
            accessibilityLabel={c.otherLabel}
            testID="sport-other-input"
          />
          {mainIsOther ? <View style={styles.mainInline} testID="sport-main-badge-other"><Text style={styles.mainInlineText}>{c.main}</Text></View> : null}
        </View>
        {typed ? (
          <Pressable onPress={add} accessibilityRole="button" style={styles.addRow} hitSlop={6} testID="sport-other-add">
            <MaterialCommunityIcons name="plus" size={18} color={Bold.act} />
            <Text style={styles.addText} numberOfLines={1}>{c.add(typed)}</Text>
          </Pressable>
        ) : null}
        {own.length ? (
          <View style={styles.pills}>
            {own.map((s) => (
              <PickedPill key={s} label={s} main={sportMark(picked, s) === "main"} mainLabel={c.main} removeLabel={c.remove} onRemove={() => toggle(s)} testID={`sport-picked-${s}`} />
            ))}
          </View>
        ) : null}
      </ScrollView>
      <View style={[styles.foot, { paddingBottom: insets.bottom + 12 }]}>
        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{c.error}</Text> : null}
        <Button
          bold="primary"
          onPress={() => { if (ready) onContinue({ sports, name: askName ? name.replace(/\s+/g, " ").trim() : null }); }}
          disabled={!ready}
          loading={busy}
          testID="sport-continue"
        >
          {sports.length > 1 ? `${c.go} · ${sports.length}` : c.go}
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
}

/** The field's own line shows focus; the browser's focus ring would draw a second box inside it (web only). */
const NO_WEB_OUTLINE = Platform.OS === "web" ? ({ outlineStyle: "none", outlineWidth: 0 } as object) : {};

const GAP = 5;

const styles = StyleSheet.create({
  root:           { flex: 1, backgroundColor: Bold.paper },
  scroll:         { flex: 1 },
  body:           { paddingHorizontal: Bold.gutter, paddingBottom: 12, gap: 8 },
  wordmark:       { ...BoldType.wordmark, color: Bold.ink, marginBottom: 10 },
  nameBlock:      { gap: 8, marginBottom: 8 },
  label:          { ...BoldType.h4, color: Bold.ink },
  input:          { ...BoldType.body, color: Bold.ink, height: 48, borderRadius: Bold.radius.control, borderWidth: 1, borderColor: Bold.line, paddingHorizontal: 14 },
  title:          { ...BoldType.screenTitleSm, color: Bold.ink },
  lede:           { ...BoldType.lede, color: Bold.mute, marginBottom: 4 },
  // Four columns, GAP apart: each cell is a quarter with half a gap either side, the row pulled out by half a gap.
  grid:           { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -GAP / 2, rowGap: GAP },
  cell:           { width: "25%", paddingHorizontal: GAP / 2 },
  other:          { flexDirection: "row", alignItems: "center", gap: 8, height: 44, marginTop: 2, borderRadius: SPORT_TILE_RADIUS, borderWidth: 1, borderStyle: "dashed", borderColor: Bold.quiet, paddingHorizontal: 12 },
  otherOn:        { borderStyle: "solid", borderWidth: 1.5, borderColor: Bold.act },
  otherInput:     { flex: 1, ...BoldType.chipLine, color: Bold.ink, height: 42, ...NO_WEB_OUTLINE },
  mainInline:     { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, backgroundColor: Bold.act },
  mainInlineText: { ...BoldType.chip, color: Bold.onAct },
  addRow:         { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  addText:        { ...BoldType.link, color: Bold.act, flexShrink: 1 },
  pills:          { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  foot:           { paddingHorizontal: Bold.gutter, paddingTop: 8, gap: 8, backgroundColor: Bold.paper },
  error:          { ...BoldType.caption, color: Bold.ink },
});
