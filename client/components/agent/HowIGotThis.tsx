/**
 * How I got this — the facts Mila used (each with its type mark and a tappable source) and her reasoning in plain words,
 * built from the run's trace. Visible to the athlete (owner, 9 Oct 2026).
 *
 *   HowPanel        the expandable panel: a quiet "How I got this" row that opens in place. Given the payload it draws it;
 *                   given only a runId it fetches the payload on first open (loading and error states included).
 *   HowIGotThisCard the agent/1 card kind: the same panel as its own Mila card.
 *
 * Expand: the kit's spring (ui/Accordion animateExpand) or a 120 ms fade under reduce motion.
 */
import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import { animateExpand, useReducedMotion } from "../ui/Accordion";
import { MILA_CARD } from "../mila/milaSurface";
import { FactMark, SourceChip, partStyles } from "./parts";
import { useHowIGotThis } from "../../lib/agent/hooks";
import type { CardOf, HowIGotThisCardPayload } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

export const HOW_COPY = {
  title: "How I got this",
  why: "Why",
  used: "What I used",
  summary: (facts: number, sources: number) =>
    `${facts} ${facts === 1 ? "fact" : "facts"} from ${sources} ${sources === 1 ? "source" : "sources"}`,
  loading: "Getting the details…",
  error: "Couldn't load this right now.",
  retry: "Try again",
} as const;

function sourceCount(p: HowIGotThisCardPayload): number {
  return new Set(p.facts.map((f) => f.source.url ?? f.source.label)).size;
}

function HowBody({ payload, onDark }: { payload: HowIGotThisCardPayload; onDark?: boolean }) {
  const ink = onDark ? Bold.onDark : Bold.ink;
  return (
    <View style={styles.body} testID="how-body">
      <Text style={[styles.label, onDark && { color: Bold.onDarkLabel }]}>{HOW_COPY.why}</Text>
      <Text style={[styles.why, { color: onDark ? Bold.onDarkSoft : Bold.ink2 }]}>{payload.why}</Text>
      <Text style={[styles.label, styles.usedLabel, onDark && { color: Bold.onDarkLabel }]}>{HOW_COPY.used}</Text>
      {payload.facts.map((f, i) => (
        <View key={`${i}-${f.claim}`} style={[styles.fact, i > 0 && [styles.factRule, onDark && { borderTopColor: Bold.lineOnDark }]]} testID="how-fact">
          <Text style={[styles.claim, { color: ink }]}>{f.claim}</Text>
          <View style={partStyles.wrap}>
            <FactMark type={f.type} onDark={onDark} />
            <SourceChip source={f.source} onDark={onDark} testID="how-source" />
          </View>
        </View>
      ))}
    </View>
  );
}

/** The expandable "How I got this". Pass `payload`, or `runId` to fetch it on first open. */
export function HowPanel({
  payload, runId, onDark, initiallyOpen = false, testID = "how-panel",
}: {
  payload?: HowIGotThisCardPayload | null;
  runId?: string | null;
  onDark?: boolean;
  initiallyOpen?: boolean;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(initiallyOpen);
  // Fetch only when it is opened and the card did not bring the payload with it.
  const fetched = useHowIGotThis(open && !payload ? runId ?? null : null);
  const data = payload ?? fetched.data ?? null;
  if (!payload && !runId) return null;

  const toggle = () => { haptics.select(); animateExpand(reduced); setOpen((o) => !o); };
  const fg = onDark ? Bold.blueOnDark : Bold.blue;
  return (
    <View testID={testID}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={HOW_COPY.title}
        hitSlop={8}
        style={({ pressed }) => [styles.head, pressed && { opacity: 0.7 }]}
        testID={`${testID}-toggle`}
      >
        <Text style={[styles.headText, { color: fg }]}>{HOW_COPY.title}</Text>
        {data && !open ? (
          <Text style={[styles.headMeta, onDark && { color: Bold.onDarkMute }]} numberOfLines={1}>
            {HOW_COPY.summary(data.facts.length, sourceCount(data))}
          </Text>
        ) : null}
        <Feather name={open ? "chevron-up" : "chevron-down"} size={16} color={fg} />
      </Pressable>
      {open ? (
        data ? (
          <HowBody payload={data} onDark={onDark} />
        ) : fetched.isError ? (
          <View style={[partStyles.row, styles.state]}>
            <Text style={[partStyles.caption, onDark && { color: Bold.onDarkMute }]}>{HOW_COPY.error}</Text>
            <Pressable onPress={() => { void fetched.refetch(); }} accessibilityRole="button" hitSlop={10} testID={`${testID}-retry`}>
              <Text style={[styles.headText, { color: fg }]}>{HOW_COPY.retry}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[partStyles.row, styles.state]} testID={`${testID}-loading`}>
            <ActivityIndicator size="small" color={onDark ? Bold.onDark : Bold.ink} />
            <Text style={[partStyles.caption, onDark && { color: Bold.onDarkMute }]}>{HOW_COPY.loading}</Text>
          </View>
        )
      ) : null}
    </View>
  );
}

/** agent/1 `how-i-got-this`: the panel as its own card, opened by default (it was asked for). */
export function HowIGotThisCard({ card }: { card: CardOf<"how-i-got-this"> }) {
  return (
    <View style={styles.card} testID="card-how-i-got-this">
      <HowPanel payload={card.payload} initiallyOpen />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, paddingHorizontal: 16, paddingVertical: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  headText: { ...BoldType.link },
  headMeta: { ...BoldType.caption, color: Bold.mute, flex: 1 },
  body: { paddingBottom: 12, gap: 6 },
  label: { ...BoldType.label, color: Bold.mute },
  usedLabel: { marginTop: 10 },
  why: { ...BoldType.read },
  fact: { gap: 6, paddingVertical: 8 },
  factRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },
  claim: { ...BoldType.rowTitle },
  state: { paddingBottom: 12 },
});
