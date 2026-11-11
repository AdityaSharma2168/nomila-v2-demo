/**
 * ResearchActivityCard (proposed `research-activity`) — the wait made watchable (owner-approved reveal design): what Mila
 * is reading right now (the site's mark through the favicon chain, and its domain), running counts, and discoveries that
 * pop in as they're found (each a short line with its source) — from #891's ResearchEvents, through the adapter. Mila's
 * questions during the wait are her own quick-question cards.
 *
 * Motion: a discovery fades and rises in once (250 ms), the "now" dot pulses only while reading; under reduce motion
 * everything is simply there. Nothing loops once research is done.
 */
import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { LogoMark } from "../ui/LogoMark";
import { useReducedMotion } from "../ui/Accordion";
import { SourceChip, partStyles } from "./parts";
import type { CardOf } from "../../lib/agent/types";

export const ACTIVITY_COPY = {
  reading: (domain: string) => `Reading ${domain}…`,
  done: "Done looking. Here's what I found.",
  failed: "I couldn't finish looking you up.",
  counts: (c: { sources: number; finds: number }) =>
    [`${c.sources} ${c.sources === 1 ? "source" : "sources"}`, `${c.finds} ${c.finds === 1 ? "find" : "finds"}`].join(" · "),
  found: "Found",
} as const;

function NowDot({ live }: { live: boolean }) {
  const reduced = useReducedMotion();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!live || reduced) { v.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.3, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [live, reduced, v]);
  return <Animated.View style={[styles.dot, !live && styles.dotDone, { opacity: v }]} />;
}

/** One discovery, popping in once on arrival. */
function Discovery({ d }: { d: CardOf<"research-activity">["payload"]["discoveries"][number] }) {
  const reduced = useReducedMotion();
  const v = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { v.setValue(1); return; }
    Animated.timing(v, { toValue: 1, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
  }, [reduced, v]);
  return (
    <Animated.View
      style={[styles.discovery, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }]}
      accessibilityLiveRegion="polite"
      testID="activity-discovery"
    >
      <Text style={styles.foundWord}>{ACTIVITY_COPY.found}</Text>
      <View style={styles.flex}>
        <Text style={styles.discoveryText}>{d.text}</Text>
        <View style={partStyles.wrap}>
          <SourceChip source={d.source} />
        </View>
      </View>
    </Animated.View>
  );
}

export function ResearchActivityCard({ card }: { card: CardOf<"research-activity"> }) {
  const p = card.payload;
  const live = p.state === "running";
  return (
    <View style={styles.card} testID="card-research-activity">
      <View style={styles.now}>
        <NowDot live={live && !!p.reading} />
        {live && p.reading ? (
          <>
            <LogoMark bold name={p.reading.domain} domain={p.reading.domain} size={24} />
            <Text style={styles.reading} numberOfLines={1} accessibilityLiveRegion="polite" testID="activity-reading">{ACTIVITY_COPY.reading(p.reading.domain)}</Text>
          </>
        ) : (
          <Text style={styles.reading}>{p.state === "failed" ? ACTIVITY_COPY.failed : p.state === "done" ? ACTIVITY_COPY.done : card.title}</Text>
        )}
      </View>
      <Text style={styles.counts} testID="activity-counts">{ACTIVITY_COPY.counts(p.counts)}</Text>

      {p.discoveries.length ? (
        <View style={styles.discoveries}>
          {p.discoveries.slice(-5).map((d) => <Discovery key={d.id} d={d} />)}
        </View>
      ) : null}

    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { ...MILA_CARD, padding: 16, gap: 10 },
  now: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 28 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Bold.blue },
  dotDone: { backgroundColor: Bold.ink },
  reading: { ...BoldType.rowTitle, color: Bold.ink, flex: 1 },
  counts: { ...BoldType.caption, color: Bold.mute },
  discoveries: { gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line, paddingTop: 10 },
  discovery: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  foundWord: { ...BoldType.label, color: Bold.blue, width: 48, marginTop: 3 },
  discoveryText: { ...BoldType.rowTitle, color: Bold.ink, marginBottom: 6 },
});
