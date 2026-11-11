// YourRatesScreen — "Your rates" on Me (deals design §5c; D9 approved 12 Oct 2026; behind EXPO_PUBLIC_OPPS_V2).
//
// "Mila suggests. You set your minimum." One row per kind of work (shared/deals RATE_TYPES):
//
//   the range    Mila's suggested range as a bar (grey), her minimum as the black tick, its confidence, and "How Mila
//                worked this out" (what it is based on). These are onboarding's validated ranges, stored per rate type
//   Min          her PRIVATE minimum: the cutoff for "below your minimum". Never sent to a brand, never in a draft.
//                Nothing is set for her — "Use $350" fills it from the suggestion only on her tap
//   Bookings     her PUBLIC price per booking format (what a buyer pays), on her live offer; the guard says when a
//                public price sits under her private deal minimum for the same work
//
// GET / PUT /me/rates (RATES_V1). Off → a plain "not ready yet" line. Bold / BoldType only.
import React, { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, SafeAreaView, StatusBar, ActivityIndicator, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { StackHeader } from "../../components/ui/StackHeader";
import { Button, Card, LinkText, SectionHead } from "../../components/ui";
import { usePullRefresh, pullRefresh } from "../../components/ui/PullRefresh";
import { ratesProblems, useRates, useSaveRates, type RateRow, type RatesWrite } from "../../hooks/use-rates";
import { barOf, groupsOf, initialText, parseDollars, ratesNote, suggestedLine, withCommas, writeOf } from "./ratesLogic";
import { openBookDoor } from "../../navigation/meNav";
import type { RateType } from "../../../shared/deals";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";

function RangeBar({ row, minimum }: { row: RateRow; minimum: number | null }) {
  const bar = barOf(row, minimum);
  if (!bar) return null;
  return (
    <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.range, { left: `${bar.from * 100}%`, width: `${Math.max(2, (bar.to - bar.from) * 100)}%` }]} />
      {bar.tick != null ? <View style={[styles.tick, { left: `${bar.tick * 100}%` }]} /> : null}
    </View>
  );
}

function RateLine({ row, text, onText, onSetUp, problem, last }: { row: RateRow; text: string; onText: (t: string) => void; onSetUp: () => void; problem: string | null; last: boolean }) {
  const [open, setOpen] = useState(false);
  const booking = row.group === "booking";
  const typed = parseDollars(text);
  const minimum = !booking && typeof typed === "number" && !Number.isNaN(typed) ? typed : !booking ? row.minimum?.value ?? null : null;
  const s = row.suggested;
  return (
    <View style={[styles.rate, last && styles.rateLast]} testID={`rate-${row.rate_type}`}>
      <View style={styles.rateHead}>
        <View style={styles.rateText}>
          <Text style={styles.rateTitle}>{row.label}</Text>
          {suggestedLine(row) ? <Text style={styles.rateMeta}>{suggestedLine(row)}</Text> : null}
        </View>
        {booking && !row.price ? (
          <LinkText onPress={() => { haptics.tap(); onSetUp(); }} arrow testID={`rate-setup-${row.rate_type}`}>Set a price</LinkText>
        ) : (
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{booking ? "Price" : "Min"}</Text>
            <Text style={styles.dollar}>$</Text>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={(t) => onText(withCommas(t))}
              placeholder="—"
              placeholderTextColor={Bold.quiet}
              keyboardType="decimal-pad"
              accessibilityLabel={booking ? `${row.label}: your public price in dollars` : `${row.label}: your private minimum in dollars`}
              testID={`rate-input-${row.rate_type}`}
            />
          </View>
        )}
      </View>
      <RangeBar row={row} minimum={minimum} />
      {s ? <View style={styles.links}>
        {s ? <LinkText onPress={() => setOpen((o) => !o)} arrow={false} accessibilityLabel={`How Mila worked out ${row.label}`}>{open ? "Hide how Mila worked this out" : "How Mila worked this out"}</LinkText> : null}
        {!booking && s && !text.trim() ? (
          <LinkText onPress={() => { haptics.tap(); onText(String(Math.round(s.low))); }} arrow={false} testID={`rate-use-${row.rate_type}`}>{`Use $${Math.round(s.low).toLocaleString("en-US")}`}</LinkText>
        ) : null}
      </View> : null}
      {open && s ? (
        <View style={styles.how}>
          <Text style={styles.howText}>{`Based on ${s.based_on}.`}</Text>
          {s.drivers.map((d, i) => <Text key={i} style={styles.howText}>{`· ${d}`}</Text>)}
          <Text style={styles.caption}>{`${s.source}${s.shown_at ? ` · ${new Date(s.shown_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}`}</Text>
        </View>
      ) : null}
      {row.guard ? <Text style={styles.guard} testID={`rate-guard-${row.rate_type}`}>{row.guard.line}</Text> : null}
      {problem ? <Text style={styles.problem} accessibilityRole="alert">{problem}</Text> : null}
    </View>
  );
}

export function YourRatesScreen() {
  const navigation = useNavigation<any>();
  const rates = useRates();
  const save = useSaveRates();
  const [edits, setEdits] = useState<Partial<Record<RateType, string>>>({});
  const [invalid, setInvalid] = useState<RateType[]>([]);
  const [saved, setSaved] = useState(false);
  const pull = usePullRefresh(() => rates.refetch());

  const view = rates.data;
  const groups = useMemo(() => (view ? groupsOf(view.rows, view.bookings_enabled) : []), [view]);
  const { body } = useMemo(() => (view ? writeOf(edits, view.rows) : { body: {} as RatesWrite }), [edits, view]);
  const dirty = !!(body.minimums || body.prices) || invalid.length > 0 || Object.keys(edits).some((k) => view && edits[k as RateType] !== initialText(view.rows.find((r) => r.rate_type === k)!));
  const serverProblems = save.isError ? ratesProblems(save.error) : [];
  const problemFor = (rt: RateType) =>
    invalid.includes(rt) ? "A dollar amount above zero." : serverProblems.find((p) => p.rate_type === rt)?.problem ?? null;

  const onSave = async () => {
    if (!view) return;
    const w = writeOf(edits, view.rows);
    setInvalid(w.invalid);
    if (w.invalid.length || (!w.body.minimums && !w.body.prices)) return;
    try {
      await save.mutateAsync(w.body);
      haptics.success();
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch { /* the rows say what to fix */ }
  };

  return (
    <SafeAreaView style={styles.root} testID="your-rates">
      <StatusBar barStyle="dark-content" />
      <StackHeader title="Me" bold />
      <ScrollView contentContainerStyle={styles.in} refreshControl={pullRefresh(pull)} keyboardShouldPersistTaps="handled">
        <View style={styles.titleBlock}>
          <Text style={styles.title} accessibilityRole="header">Your rates</Text>
          <Text style={styles.lede}>Mila suggests. You set your minimum.</Text>
        </View>
        {rates.isLoading ? (
          <View style={styles.center}><ActivityIndicator color={Bold.ink} /></View>
        ) : rates.isError ? (
          <View style={styles.center}>
            <Text style={styles.lede}>Couldn’t load your rates.</Text>
            <LinkText onPress={() => rates.refetch()} arrow={false}>Try again</LinkText>
          </View>
        ) : !view ? (
          <View style={styles.center}><Text style={styles.lede}>Your rates aren’t ready yet. Mila will suggest them here.</Text></View>
        ) : (
          <>
            <Text style={styles.caption}>{ratesNote(view.rows, view.note)}</Text>
            {groups.map((g) => (
              <View key={g.key} style={styles.group}>
                <SectionHead title={g.title} sub={g.sub} />
                <Card bold>
                  {g.rows.map((row, i) => (
                    <RateLine
                      key={row.rate_type}
                      row={row}
                      text={edits[row.rate_type] ?? initialText(row)}
                      onText={(t) => { setSaved(false); setInvalid((v) => v.filter((x) => x !== row.rate_type)); setEdits((e) => ({ ...e, [row.rate_type]: t })); }}
                      onSetUp={() => openBookDoor(navigation)}
                      problem={problemFor(row.rate_type)}
                      last={i === g.rows.length - 1}
                    />
                  ))}
                </Card>
              </View>
            ))}
            {save.isError && !serverProblems.length ? <Text style={styles.problem}>That didn’t save. Try again.</Text> : null}
            <Button bold="primary" onPress={onSave} disabled={!dirty || save.isPending} loading={save.isPending} testID="rates-save">{saved ? "Saved" : "Save"}</Button>
            <Text style={styles.caption}>Your minimums stay private. A booking price applies to new requests only.</Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:       { flex: 1, backgroundColor: Bold.paper },
  in:         { paddingHorizontal: Bold.gutter, paddingBottom: 48, gap: 16 },
  titleBlock: { gap: 4 },
  title:      { ...BoldType.screenTitleSm, color: Bold.ink },
  lede:       { ...BoldType.lede, color: Bold.mute },
  center:     { alignItems: "center", gap: 10, paddingVertical: 40 },
  group:      { gap: 10 },
  rate:       { gap: 8, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  rateLast:   { borderBottomWidth: 0 },
  rateHead:   { flexDirection: "row", alignItems: "center", gap: 12 },
  rateText:   { flex: 1, minWidth: 0, gap: 2 },
  rateTitle:  { ...BoldType.rowTitle, color: Bold.ink },
  rateMeta:   { ...BoldType.rowMeta, color: Bold.mute },
  field:      { flexDirection: "row", alignItems: "center", gap: 4 },
  fieldLabel: { ...BoldType.label, color: Bold.mute, marginRight: 4 },
  dollar:     { ...BoldType.rowTitle, color: Bold.ink },
  input:      { ...BoldType.rowTitle, color: Bold.ink, width: 96, height: 44, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 10 },
  track:      { height: 8, backgroundColor: Bold.ground, borderRadius: 2, overflow: "visible" },
  range:      { position: "absolute", top: 0, bottom: 0, backgroundColor: Bold.quiet, borderRadius: 2 },
  tick:       { position: "absolute", top: -4, width: 3, height: 16, marginLeft: -1, backgroundColor: Bold.ink },
  links:      { flexDirection: "row", flexWrap: "wrap", gap: 18, minHeight: 28, alignItems: "center" },
  how:        { gap: 4, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: Bold.line },
  howText:    { ...BoldType.rowMeta, color: Bold.ink2 },
  caption:    { ...BoldType.caption, color: Bold.mute },
  guard:      { ...BoldType.rowMeta, color: Bold.ink, borderLeftWidth: 3, borderLeftColor: Bold.blue, paddingLeft: 9 },
  problem:    { ...BoldType.caption, color: Bold.ink },
});
