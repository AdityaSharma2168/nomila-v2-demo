/**
 * cards/kit/OnceQuestion — Mila asks once and the answer becomes their standing rule (design v2.2 "One-time question";
 * extends quick-question with `once`, decision 11). NO card surface: it sits inside Mila's message (Muse's inline
 * choice) — the brands' logos and the context in the head (a tap expands "why I'm asking"), the question in Mila's
 * reading text, 2–4 full-width DASHED rows and "Something else…", which puts "<topic>: " in the composer for their own
 * words. A row saves its rule (receipt "Saved as your rule" + the rule + "Change it any time in Me"). No Skip: no
 * answer counts as not now.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MilaCardDto } from "../../../../../shared/milaCards";
import { Bold, BoldType } from "../../../../constants/theme";
import { haptics } from "../../../../lib/haptics";
import { useAgentCardHandlers } from "../../../agent/handlers";
import { LogoMark } from "../../../ui/LogoMark";
import { useCardHost, useExpand, useSeen } from "./host";
import { Chevron, Receipt, styles } from "./parts";

type Q = Extract<MilaCardDto, { type: "quick-question" }>["data"];

export function OnceQuestion({ data, initialExpanded = false }: { data: Q; initialExpanded?: boolean }) {
  const f = data.fields;
  const once = f.once!;
  const host = useCardHost();
  const h = useAgentCardHandlers();
  const [open, toggle] = useExpand(data.id, initialExpanded);
  const [picked, setPicked] = useState<number | null>(null);
  const [saved, setSaved] = useState<{ line: string; rule: string } | null>(once.answered ? { line: "Saved as your rule.", rule: once.answered.rule } : null);
  useSeen("once", once.decisionId);
  const brands = f.media?.brands?.length ? f.media.brands : f.media?.brand ? [f.media.brand] : [];
  const pick = async (ix: number) => {
    if (saved) return;
    haptics.select();
    setPicked(ix);
    const r = await host.record({ card: "once", ref: once.decisionId, outcome: "accepted", action: "rule", choice: ix });
    if (r == null) { setPicked(null); return; }
    setSaved({ line: r || "Saved as your rule.", rule: once.choices[ix].rule });
  };
  const somethingElse = () => {
    h.prefill?.(once.prefill);
    void host.record({ card: "once", ref: once.decisionId, outcome: "edited" });
  };
  return (
    <View style={q.wrap} testID={`card-once-${open ? "expanded" : "collapsed"}`}>
      {brands.length || f.context ? (
        <Pressable onPress={toggle} accessibilityRole="button" accessibilityLabel={`${f.context ?? "Why I'm asking"}, ${open ? "collapse" : "why I'm asking"}`} accessibilityState={{ expanded: open }} style={q.head} testID="card-once-head">
          {brands.length ? (
            <View style={styles.stack}>
              {brands.map((b, i) => <View key={b.name} style={[i > 0 && { marginLeft: -8 }, styles.stackRing]}><LogoMark logoUrl={b.logoUrl} domain={b.domain} name={b.name} size={30} /></View>)}
            </View>
          ) : null}
          <Text style={q.context} numberOfLines={1}>{open ? "Why I'm asking" : f.context ?? "Why I'm asking"}</Text>
          <Chevron open={open} />
        </Pressable>
      ) : null}
      {open ? (
        <View style={q.why} testID="card-once-why">
          {brands.map((b) => <Text key={b.name} style={styles.meta}>{b.name}</Text>)}
          {f.why ? <Text style={styles.line}>{f.why}</Text> : null}
          <Text style={styles.line}>Your answer becomes a rule in Me. I'll handle the next one the same way.</Text>
        </View>
      ) : null}
      <Text style={q.question}>{f.question}</Text>
      <View style={q.opts}>
        {once.choices.map((c, i) => (
          <Pressable key={c.label} onPress={() => void pick(i)} disabled={!!saved} accessibilityRole="button" accessibilityLabel={c.label} accessibilityState={{ selected: picked === i, disabled: !!saved }}
            style={({ pressed }) => [q.opt, picked === i && q.optPicked, pressed && styles.pressed]} testID={`card-once-option-${i}`}>
            <Text style={[q.optText, picked === i && q.optTextPicked]}>{c.label}</Text>
          </Pressable>
        ))}
        {!saved ? (
          <Pressable onPress={somethingElse} accessibilityRole="button" accessibilityLabel="Something else" style={({ pressed }) => [q.opt, pressed && styles.pressed]} testID="card-once-else">
            <Text style={[q.optText, q.optElse]}>Something else…</Text>
          </Pressable>
        ) : null}
      </View>
      {saved ? <Receipt line={saved.line} sub={saved.rule} link={{ label: "Change it any time in Me", onPress: () => h.openLink?.({ screen: "knows" } as never) }} />
        : <Text style={styles.meta}>I'll save your answer as a rule and won't ask again.</Text>}
    </View>
  );
}

const q = StyleSheet.create({
  wrap: { gap: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "flex-start" },
  context: { ...BoldType.rowTitle, color: Bold.ink, flexShrink: 1 },
  why: { gap: 4, backgroundColor: Bold.ground, borderRadius: 12, padding: 12 },
  question: { ...BoldType.read, fontSize: 15, lineHeight: 23, color: Bold.ink },
  opts: { gap: 8 },
  opt: { minHeight: 46, borderWidth: 1.5, borderStyle: "dashed", borderColor: Bold.quiet, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, justifyContent: "center" },
  optPicked: { borderStyle: "solid", borderColor: Bold.act, backgroundColor: Bold.actSoft },
  optText: { ...BoldType.cardOption, color: Bold.ink },
  optTextPicked: { color: Bold.act },
  optElse: { color: Bold.mute },
});
