/**
 * WhatMilaHasScreen — "Here's what I already have about you." (the agent onboarding front; promoted from the #900
 * prototype). The Mila look: swipeable photo-led cards (corner 18, the photo card's foot scrim, the counter), one per
 * fact Mila holds about the athlete, read from GET /me/agent/onboarding/facts?subject=athlete. Each card carries what
 * kind of fact it is, the fact itself, its source chips, and a tick (that's right) and an edit (fix it in your words).
 * The whole card is the target: a tap anywhere opens it in a sheet with every source and the same tick / edit. The
 * photos are atmosphere (never someone else standing in for the athlete); without one, the card is the dark ground.
 * Facts keep arriving while research runs; the line under Mila says so.
 */
import React, { useState } from "react";
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View, useWindowDimensions,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Photo } from "../../components/ui/Photo";
import { Chip } from "../../components/ui";
import { Frost } from "../../components/mila/Frost";
import { MILA_CARD, MILA_CARD_RADIUS } from "../../components/mila/milaSurface";
import { MilaButton, SourceChip, SoftChip } from "../../components/agent/parts";
import { N } from "../../components/deals/opps/tokens";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import type { OnboardingFact } from "../../lib/onboardingFront";
import { FRONT_COPY, factKind } from "./frontCopy";
import { MilaHead } from "./MilaIntroScreen";

type Answer = "confirm" | "correct";

const GAP = 10;

function TickEdit({ f, answer, onTick, onEdit, onDark }: { f: OnboardingFact; answer: Answer | null; onTick: () => void; onEdit: () => void; onDark?: boolean }) {
  const c = FRONT_COPY.has;
  const ink = onDark ? Bold.onDark : Bold.ink;
  if (answer) {
    return (
      <View style={styles.answered} testID={`has-answered-${f.id}`}>
        <Feather name="check" size={14} color={ink} />
        <Text style={[styles.answeredText, { color: ink }]}>{answer === "confirm" ? c.confirmed : c.fixed}</Text>
      </View>
    );
  }
  return (
    <View style={styles.tickEdit}>
      <Pressable onPress={() => { haptics.select(); onTick(); }} accessibilityRole="button" accessibilityLabel={c.right} hitSlop={6} style={({ pressed }) => [styles.round, onDark && styles.roundOnDark, pressed && styles.pressed]} testID={`has-tick-${f.id}`}>
        <Feather name="check" size={18} color={onDark ? Bold.ink : Bold.onDark} />
      </Pressable>
      <Pressable onPress={() => { haptics.select(); onEdit(); }} accessibilityRole="button" accessibilityLabel={c.fix} hitSlop={6} style={({ pressed }) => [styles.round, styles.roundSoft, pressed && styles.pressed]} testID={`has-edit-${f.id}`}>
        <Feather name="edit-2" size={16} color={Bold.ink} />
      </Pressable>
    </View>
  );
}

export function WhatMilaHasScreen({
  facts, photos = {}, working, onConfirm, onCorrect, onContinue, continuing,
}: {
  facts: OnboardingFact[];
  /** Each card's atmosphere photo by fact id (the shared library, through the picker); none → the dark ground. */
  photos?: Record<string, string>;
  /** Research is still running: more facts will arrive. */
  working?: boolean;
  onConfirm: (factId: string) => Promise<void>;
  onCorrect: (factId: string, words: string) => Promise<void>;
  onContinue: () => void;
  continuing?: boolean;
}) {
  const c = FRONT_COPY.has;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const cardW = Math.min(width, 480) - 40;
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [open, setOpen] = useState<{ id: string; editing: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const opened = open ? facts.find((f) => f.id === open.id) ?? null : null;

  const onEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    setI(Math.max(0, Math.min(facts.length - 1, Math.round(e.nativeEvent.contentOffset.x / (cardW + GAP)))));
  const answer = async (id: string, a: Answer, run: () => Promise<void>) => {
    setBusy(true); setError(false);
    try { await run(); setAnswers((x) => ({ ...x, [id]: a })); setOpen(null); } catch { setError(true); } finally { setBusy(false); }
  };
  const tick = (id: string) => answer(id, "confirm", () => onConfirm(id));
  const edit = (f: OnboardingFact) => { setDraft(f.claim); setError(false); setOpen({ id: f.id, editing: true }); };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={[styles.body, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 40 }]} testID="mila-has">
        <MilaHead size={64} />
        <Text style={styles.milaText}>{c.line}</Text>
        {working ? <Text style={styles.looking} testID="has-looking">{c.looking}</Text> : null}
        {facts.length ? (
          <View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={cardW + GAP} decelerationRate="fast" onMomentumScrollEnd={onEnd} onScrollEndDrag={onEnd} contentContainerStyle={styles.rail} style={styles.railBleed}>
              {facts.map((f) => {
                const photo = photos[f.id] ?? null;
                return (
                  <Pressable
                    key={f.id}
                    onPress={() => { haptics.tap(); setError(false); setOpen({ id: f.id, editing: false }); }}
                    accessibilityRole="button"
                    accessibilityLabel={`${factKind(f)}. ${f.claim}`}
                    style={({ pressed }) => [styles.card, { width: cardW }, pressed && styles.pressed]}
                    testID={`has-card-${f.id}`}
                  >
                    {photo ? <Photo uri={photo} style={StyleSheet.absoluteFill} /> : <View style={[StyleSheet.absoluteFill, styles.blank]} />}
                    <LinearGradient colors={[Bold.scrimClear, Bold.cardScrim]} locations={[0.3, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
                    <View style={styles.foot}>
                      <Chip bold="light">{factKind(f)}</Chip>
                      <Text style={styles.title} numberOfLines={4}>{f.claim}</Text>
                      <View style={styles.sources}>
                        {(f.type === "said" ? [{ label: c.youSaid }] : f.sources).slice(0, 2).map((s, n) => <SourceChip key={`${s.label}-${n}`} source={s} onDark />)}
                      </View>
                      <TickEdit f={f} answer={answers[f.id] ?? null} onTick={() => { void tick(f.id); }} onEdit={() => edit(f)} onDark />
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
            {facts.length > 1 ? (
              <Frost radius={MILA_CARD_RADIUS} style={styles.counter}><Text style={styles.counterText} accessibilityLiveRegion="polite">{c.counter(i + 1, facts.length)}</Text></Frost>
            ) : null}
          </View>
        ) : null}
        {error && !open ? <Text style={styles.error} accessibilityLiveRegion="polite">{c.error}</Text> : null}
        <MilaButton label={c.go} onPress={onContinue} loading={continuing} testID="has-continue" />
      </ScrollView>

      {opened && open ? (
        <KeyboardAvoidingView style={StyleSheet.absoluteFill} behavior={Platform.OS === "ios" ? "padding" : undefined} testID="has-sheet">
          <Pressable style={[StyleSheet.absoluteFill, styles.dim]} onPress={() => setOpen(null)} accessibilityRole="button" accessibilityLabel={c.close} testID="has-sheet-close" />
          <View style={styles.sheetWrap} pointerEvents="box-none">
            <View style={[MILA_CARD, styles.sheet, { marginBottom: insets.bottom + 24 }]} accessibilityViewIsModal>
              <View style={styles.grabber} />
              <View style={styles.sheetHead}><SoftChip>{factKind(opened)}</SoftChip></View>
              {open.editing ? (
                <>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    multiline
                    autoFocus
                    style={styles.input}
                    accessibilityLabel={c.editLabel}
                    testID="has-edit-input"
                  />
                  {error ? <Text style={styles.error}>{c.error}</Text> : null}
                  <View style={styles.sheetActions}>
                    <MilaButton label={c.save} onPress={() => { const w = draft.trim(); if (w) void answer(opened.id, "correct", () => onCorrect(opened.id, w)); }} disabled={!draft.trim() || draft.trim() === opened.claim} loading={busy} flex testID="has-save" />
                    <MilaButton label={c.cancel} tone="soft" onPress={() => setOpen({ id: opened.id, editing: false })} flex />
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.sheetClaim}>{opened.claim}</Text>
                  <View style={styles.sources}>
                    {(opened.type === "said" ? [{ label: c.youSaid }] : opened.sources).map((s, n) => <SourceChip key={`${s.label}-${n}`} source={s} />)}
                  </View>
                  {error ? <Text style={styles.error}>{c.error}</Text> : null}
                  {answers[opened.id] ? <TickEdit f={opened} answer={answers[opened.id]} onTick={() => {}} onEdit={() => {}} /> : (
                    <View style={styles.sheetActions}>
                      <MilaButton label={c.right} icon="check" onPress={() => { void tick(opened.id); }} loading={busy} flex testID="has-sheet-right" />
                      <MilaButton label={c.fix} icon="edit-2" tone="soft" onPress={() => edit(opened)} flex testID="has-sheet-fix" />
                    </View>
                  )}
                </>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root:         { flex: 1, backgroundColor: N.cream100 },
  body:         { paddingHorizontal: 20, gap: 12 },
  pressed:      { transform: [{ scale: Bold.pressScale }] },
  milaText:     { ...BoldType.body, color: Bold.ink, marginTop: 4 },
  looking:      { ...BoldType.rowMeta, color: Bold.mute, marginTop: -6 },
  railBleed:    { marginHorizontal: -20 },
  rail:         { paddingHorizontal: 20, gap: GAP },
  card:         { height: 380, borderRadius: MILA_CARD_RADIUS, overflow: "hidden", backgroundColor: Bold.heroBlank },
  blank:        { backgroundColor: Bold.heroBlank },
  foot:         { position: "absolute", left: 0, right: 0, bottom: 0, padding: 16, gap: 8, alignItems: "flex-start" },
  title:        { ...BoldType.h4, color: Bold.onDark },
  sources:      { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tickEdit:     { flexDirection: "row", gap: 10, marginTop: 4 },
  round:        { width: 44, height: 44, borderRadius: 22, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  roundOnDark:  { backgroundColor: Bold.paper },
  roundSoft:    { backgroundColor: Bold.ground },
  answered:     { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4, minHeight: 44 },
  answeredText: { ...BoldType.rowTitle },
  counter:      { position: "absolute", top: 12, right: 12, paddingHorizontal: 10, paddingVertical: 4 },
  counterText:  { ...BoldType.caption, color: Bold.ink },
  error:        { ...BoldType.caption, color: Bold.ink },
  dim:          { backgroundColor: Bold.scrimMid },
  sheetWrap:    { flex: 1, justifyContent: "flex-end" },
  sheet:        { marginHorizontal: 10, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 18, gap: 12 },
  grabber:      { width: 38, height: 4, borderRadius: 2, backgroundColor: Bold.line, alignSelf: "center", marginBottom: 2 },
  sheetHead:    { flexDirection: "row" },
  sheetClaim:   { ...BoldType.body, color: Bold.ink },
  sheetActions: { flexDirection: "row", gap: 8 },
  input:        { ...BoldType.body, color: Bold.ink, minHeight: 88, borderRadius: Bold.radius.control, borderWidth: 1, borderColor: Bold.line, padding: 12, textAlignVertical: "top" },
});
