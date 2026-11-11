/**
 * ProgressCard (agent/1 `progress`) — a worker building something: the title, "Step n of N · what it's doing", and the
 * bar drawn as N segments (one per step), so the steps and the progress read as one thing. With `steps` (the onboarding
 * research run reports named steps) each step is listed with its state.
 *
 * Motion: the fill eases to its new length (250 ms) and a small "now" dot pulses ONLY while a step runs; under reduce
 * motion the fill jumps and the dot is still. A failed run says so and, given a retry, offers it.
 */
import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import { useReducedMotion } from "../ui/Accordion";
import { MILA_CARD } from "../mila/milaSurface";
import { MilaButton, partStyles } from "./parts";
import { progressFraction, progressLine } from "../../lib/agent/cardLogic";
import type { ProgressCardPayload, ResearchStep } from "../../lib/agent/types";

export const PROGRESS_COPY = {
  failed: "Couldn't finish this.",
  /** A plan refresh that did not finish (refresh_plan's card, payload.planRunId): it may have written part of the plan. */
  planFailed: "I couldn't finish updating your plan. Goals shows the latest I have; ask me again in a bit.",
  retry: "Try again",
  leave: "You can leave. I'll tell you here when it's ready.",
} as const;

function PulseDot({ running }: { running: boolean }) {
  const reduced = useReducedMotion();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!running || reduced) { v.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 0.35, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [running, reduced, v]);
  return <Animated.View style={[styles.dot, { opacity: v }]} testID={running ? "progress-dot-running" : "progress-dot"} />;
}

function Bar({ of, fraction, failed }: { of: number; fraction: number; failed: boolean }) {
  const reduced = useReducedMotion();
  const w = useRef(new Animated.Value(fraction)).current;
  useEffect(() => {
    if (reduced) { w.setValue(fraction); return; }
    Animated.timing(w, { toValue: fraction, duration: 250, easing: Easing.out(Easing.ease), useNativeDriver: false }).start();
  }, [fraction, reduced, w]);
  const n = Math.max(1, Math.min(of, 12));
  return (
    <View style={styles.bar} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }} testID="progress-bar">
      {/* The track as N segments; the fill runs over them, clipped by the bar. */}
      <View style={styles.segments}>
        {Array.from({ length: n }, (_, i) => <View key={i} style={styles.segment} />)}
      </View>
      <Animated.View
        style={[styles.fill, failed && styles.fillFailed, { width: w.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]}
      />
      <View style={styles.gaps} pointerEvents="none">
        {Array.from({ length: n - 1 }, (_, i) => <View key={i} style={[styles.gap, { left: `${((i + 1) / n) * 100}%` }]} />)}
      </View>
    </View>
  );
}

const STEP_ICON: Record<ResearchStep["state"], string> = { pending: "circle", running: "loader", done: "check", failed: "x" };

export function ProgressView({
  title, payload, steps, onRetry, note, testID = "card-progress",
}: {
  title: string;
  payload: ProgressCardPayload;
  steps?: ResearchStep[];
  onRetry?: () => void;
  note?: string | null;
  testID?: string;
}) {
  const failed = payload.state === "failed";
  const running = payload.state === "running";
  return (
    <View style={styles.card} testID={testID}>
      <View style={partStyles.row}>
        <PulseDot running={running} />
        <Text style={[partStyles.h4, styles.flex]} accessibilityRole="header">{title}</Text>
        {payload.state === "done" ? <Feather name="check" size={16} color={Bold.ink} /> : null}
      </View>
      <Bar of={payload.of} fraction={progressFraction(payload)} failed={failed} />
      <Text style={partStyles.caption} accessibilityLiveRegion="polite" testID="progress-line">{progressLine(payload)}</Text>
      {steps?.length ? (
        <View style={styles.steps} testID="progress-steps">
          {steps.map((s, i) => (
            <View key={`${i}-${s.label}`} style={styles.step} accessibilityLabel={`${s.label}, ${s.state}`}>
              <View style={[styles.stepIcon, s.state === "done" && styles.stepDone, s.state === "running" && styles.stepRunning]}>
                {s.state === "pending" ? null : <Feather name={STEP_ICON[s.state] as any} size={11} color={s.state === "running" ? Bold.blue : Bold.onDark} />}
              </View>
              <Text style={[styles.stepText, s.state === "pending" && { color: Bold.quiet }]}>{s.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {failed ? (
        <View style={partStyles.row}>
          <Text style={[partStyles.body, styles.flex]}>{payload.planRunId ? PROGRESS_COPY.planFailed : PROGRESS_COPY.failed}</Text>
          {onRetry ? <MilaButton label={PROGRESS_COPY.retry} tone="soft" onPress={onRetry} testID="progress-retry" /> : null}
        </View>
      ) : running && note !== null ? (
        <Text style={partStyles.caption}>{note ?? PROGRESS_COPY.leave}</Text>
      ) : null}
    </View>
  );
}

export function ProgressCard({ card, onRetry }: { card: { title: string; payload: ProgressCardPayload }; onRetry?: () => void }) {
  return <ProgressView title={card.title} payload={card.payload} steps={card.payload.steps} onRetry={onRetry} />;
}

const BAR_H = 6;
const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 10 },
  flex: { flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Bold.blue },
  bar: { height: BAR_H, borderRadius: BAR_H / 2, overflow: "hidden", backgroundColor: Bold.track },
  segments: { ...StyleSheet.absoluteFill, flexDirection: "row" },
  segment: { flex: 1 },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: Bold.blue, borderRadius: BAR_H / 2 },
  fillFailed: { backgroundColor: Bold.quiet },
  gaps: { ...StyleSheet.absoluteFill },
  gap: { position: "absolute", top: 0, bottom: 0, width: 2, marginLeft: -1, backgroundColor: Bold.paper },
  steps: { gap: 8, marginTop: 2 },
  step: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepIcon: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: Bold.line, alignItems: "center", justifyContent: "center" },
  stepDone: { backgroundColor: Bold.ink, borderColor: Bold.ink },
  stepRunning: { borderColor: Bold.blue },
  stepText: { ...BoldType.read, color: Bold.ink, flex: 1 },
});
