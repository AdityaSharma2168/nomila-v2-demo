/**
 * The onboarding conversation's cards, drawn from agent/1's onboarding kinds exactly as #890 defines them:
 *
 *   reveal         "Here's what I found": the headline on the black card, then each highlight with its sources
 *   insight        an early read (brand · strength · gap · timing · opportunity), sourced
 *   consent        how Mila works: fixed terms from the server, Agree / Not now
 *   age-band       optional, gates nothing: the athlete picks a band or skips
 *
 * Every answer goes out as an action on the turn route through the host's `act` handler; without one the card is
 * read-only (no dead taps). "How I got this" opens the run's facts and reasoning wherever the card carries a runId.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { Eyebrow, HOME_BLOCK, HOME_CARD, MilaButton, SettledLine, SourceChip, partStyles } from "./parts";
import { HowPanel } from "./HowIGotThis";
import { useAgentCardHandlers } from "./handlers";
import type { AgeBand, CardOf, CardSource, InsightCardPayload } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

export const ONBOARDING_CARD_COPY = {
  found: "Here's what I found",
  standing: "Where you stand",
  windows: "Timely windows",
  quick: "Quick question",
  angle: {
    brand: "Your brand",
    strength: "A strength",
    gap: "A gap to close",
    timing: "Good timing",
    opportunity: "An opening",
  } satisfies Record<InsightCardPayload["angle"], string>,
  agree: "Agree",
  notNow: "Not now",
  agreed: "Thanks. You can read this again in Settings.",
  notYet: "No problem. I'll ask again before I do anything that needs it.",
  skip: "Skip",
  ageSaved: "Got it.",
  ageSkipped: "Skipped. You can tell me any time.",
  error: "That didn't save. Try again.",
} as const;

function Sources({ sources, onDark }: { sources: CardSource[]; onDark?: boolean }) {
  if (!sources.length) return null;
  return (
    <View style={partStyles.wrap}>
      {sources.slice(0, 3).map((s, i) => <SourceChip key={`${i}-${s.label}`} source={s} onDark={onDark} square testID="onb-source" />)}
      {sources.length > 3 ? <Text style={[partStyles.caption, onDark && { color: Bold.onDarkMute }]}>{`+${sources.length - 3}`}</Text> : null}
    </View>
  );
}

// ─── reveal ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function RevealCard({ card }: { card: CardOf<"reveal"> }) {
  const p = card.payload;
  return (
    <View style={styles.reveal} testID="card-reveal">
      <View style={styles.revealHead}>
        <Eyebrow onDark>{card.title || ONBOARDING_CARD_COPY.found}</Eyebrow>
        <Text style={styles.revealHeadline} accessibilityRole="header">{p.headline}</Text>
      </View>
      <View style={styles.revealBody}>
        {p.highlights.map((h, i) => (
          <View key={`${i}-${h.text}`} style={[styles.highlight, i > 0 && styles.rule]} testID="reveal-highlight">
            <Text style={styles.num}>{String(i + 1).padStart(2, "0")}</Text>
            <View style={styles.flex}>
              <Text style={styles.highlightText}>{h.text}</Text>
              <Sources sources={h.sources} />
            </View>
          </View>
        ))}
        {p.standing ? (
          <View style={[styles.section, styles.rule]} testID="reveal-standing">
            <Text style={styles.sectionLabel}>{ONBOARDING_CARD_COPY.standing}</Text>
            <Text style={styles.standing}>{p.standing.text}</Text>
            <Sources sources={p.standing.sources} />
          </View>
        ) : null}
        {p.windows?.length ? (
          <View style={[styles.section, styles.rule]} testID="reveal-windows">
            <Text style={styles.sectionLabel}>{ONBOARDING_CARD_COPY.windows}</Text>
            {p.windows.map((w, i) => (
              <View key={`${i}-${w.text}`} style={styles.window} testID="reveal-window">
                <View style={styles.windowMark} />
                <View style={styles.flex}>
                  <Text style={styles.windowText}>{w.text}</Text>
                  <Sources sources={w.sources} />
                </View>
              </View>
            ))}
          </View>
        ) : null}
        <HowPanel runId={card.runId} />
      </View>
    </View>
  );
}

// ─── quick question (agent/1, #891) ─────────────────────────────────────────────────────────────────────────────

/** Mila's quick question (during the research wait or later): tap an option, or answer in the composer. */
export function QuickQuestionCard({ card }: { card: CardOf<"quick-question"> }) {
  const { reply } = useAgentCardHandlers();
  const p = card.payload;
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <View style={styles.card} testID="card-quick-question">
      <Text style={styles.angle}>{ONBOARDING_CARD_COPY.quick}</Text>
      <Text style={partStyles.h4}>{p.question}</Text>
      {p.why ? <Text style={partStyles.caption}>{p.why}</Text> : null}
      {picked ? (
        <SettledLine text={picked} testID="quick-answered" />
      ) : reply && p.options.length ? (
        <View style={partStyles.wrap}>
          {p.options.map((o) => (
            <Pressable
              key={o}
              onPress={() => { haptics.select(); setPicked(o); reply(o); }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.option, pressed && styles.pressed]}
              testID="quick-option"
            >
              <Text style={styles.optionText}>{o}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ─── insight ────────────────────────────────────────────────────────────────────────────────────────────────────

const ANGLE_GLYPH: Record<InsightCardPayload["angle"], string> = {
  brand: "star", strength: "trending-up", gap: "target", timing: "clock", opportunity: "zap",
};

export function InsightCard({ card }: { card: CardOf<"insight"> }) {
  const p = card.payload;
  const timely = p.angle === "timing" || p.angle === "opportunity";
  return (
    <View style={styles.homeCard} testID={`card-insight-${p.angle}`}>
      <View style={partStyles.row}>
        <View style={[styles.glyph, timely && styles.glyphBlue]}><Feather name={ANGLE_GLYPH[p.angle] as any} size={14} color={Bold.onDark} /></View>
        <Text style={[styles.angle, timely && { color: Bold.blue }]}>{ONBOARDING_CARD_COPY.angle[p.angle]}</Text>
      </View>
      <Text style={styles.insight}>{p.text}</Text>
      <Sources sources={p.sources} />
      <HowPanel runId={card.runId} />
    </View>
  );
}

// ─── consent ────────────────────────────────────────────────────────────────────────────────────────────────────

export function ConsentCard({ card }: { card: CardOf<"consent"> }) {
  const { act } = useAgentCardHandlers();
  const p = card.payload;
  const [done, setDone] = useState<"agree" | "not_now" | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const answer = async (response: "agree" | "not_now") => {
    if (!act) return;
    setBusy(true); setFailed(false);
    try { await act([{ type: "consent", consentId: p.consentId, response }], { reply: true }); haptics.success(); setDone(response); }
    catch { setFailed(true); haptics.error(); }
    finally { setBusy(false); }
  };
  return (
    <View style={styles.card} testID="card-consent">
      <Text style={partStyles.title}>{p.title}</Text>
      <View style={styles.points}>
        {p.points.map((pt) => (
          <View key={pt} style={styles.point}>
            <Feather name="check" size={15} color={Bold.ink} style={styles.pointIcon} />
            <Text style={[partStyles.body, styles.flex]}>{pt}</Text>
          </View>
        ))}
      </View>
      {done ? (
        <SettledLine text={done === "agree" ? ONBOARDING_CARD_COPY.agreed : ONBOARDING_CARD_COPY.notYet} icon={done === "agree" ? "check" : "clock"} testID="consent-done" />
      ) : act ? (
        <>
          {failed ? <Text style={partStyles.error}>{ONBOARDING_CARD_COPY.error}</Text> : null}
          <View style={partStyles.actions}>
            {p.buttons.includes("agree") ? <MilaButton label={ONBOARDING_CARD_COPY.agree} onPress={() => { void answer("agree"); }} loading={busy} flex testID="consent-agree" /> : null}
            {p.buttons.includes("not_now") ? <MilaButton label={ONBOARDING_CARD_COPY.notNow} tone="soft" onPress={() => { void answer("not_now"); }} disabled={busy} testID="consent-not-now" /> : null}
          </View>
        </>
      ) : null}
    </View>
  );
}

// ─── age band ───────────────────────────────────────────────────────────────────────────────────────────────────

export function AgeBandCard({ card }: { card: CardOf<"age-band"> }) {
  const { act } = useAgentCardHandlers();
  const p = card.payload;
  const [picked, setPicked] = useState<AgeBand | "skipped" | null>(null);
  const [failed, setFailed] = useState(false);
  const pick = async (value: AgeBand) => {
    if (!act) return;
    setFailed(false);
    try { await act([{ type: "age_band", value }]); haptics.success(); setPicked(value); }
    catch { setFailed(true); haptics.error(); }
  };
  return (
    <View style={styles.card} testID="card-age-band">
      <Text style={partStyles.h4}>{p.question}</Text>
      {picked ? (
        <SettledLine text={picked === "skipped" ? ONBOARDING_CARD_COPY.ageSkipped : ONBOARDING_CARD_COPY.ageSaved} testID="age-done" />
      ) : act ? (
        <>
          {failed ? <Text style={partStyles.error}>{ONBOARDING_CARD_COPY.error}</Text> : null}
          <View style={styles.choices} accessibilityRole="radiogroup">
            {p.options.map((o) => (
              <Pressable
                key={o.value}
                onPress={() => { haptics.select(); void pick(o.value); }}
                accessibilityRole="radio"
                accessibilityState={{ checked: false }}
                style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
                testID={`age-${o.value}`}
              >
                <Text style={styles.choiceText}>{o.label}</Text>
              </Pressable>
            ))}
          </View>
          {/* Optional: skipping records nothing and gates nothing. */}
          <MilaButton label={ONBOARDING_CARD_COPY.skip} tone="quiet" onPress={() => setPicked("skipped")} testID="age-skip" />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { ...MILA_CARD, padding: 16, gap: 12 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },

  homeCard: { ...HOME_CARD, padding: 14, gap: 12 },
  reveal: { ...HOME_CARD, overflow: "hidden" },
  revealHead: { ...HOME_BLOCK, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, padding: 18, gap: 12 },
  revealHeadline: { ...BoldType.displaySm, color: Bold.onDark },
  revealBody: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  highlight: { flexDirection: "row", gap: 12, paddingVertical: 14 },
  num: { ...BoldType.sigValue, color: Bold.blue, width: 24, marginTop: 2 },
  highlightText: { ...BoldType.rowTitle, color: Bold.ink, marginBottom: 8 },

  glyph: { width: 24, height: 24, borderRadius: Bold.radius.control, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  glyphBlue: { backgroundColor: Bold.blue },
  angle: { ...BoldType.label, color: Bold.mute },
  insight: { ...BoldType.headedTitle, color: Bold.ink },

  points: { gap: 8 },
  point: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  pointIcon: { marginTop: 3 },

  section: { gap: 8, paddingVertical: 14 },
  sectionLabel: { ...BoldType.label, color: Bold.mute },
  standing: { ...BoldType.read, color: Bold.ink },
  window: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  windowMark: { width: 8, height: 8, borderRadius: 1, backgroundColor: Bold.blue, marginTop: 7 },
  windowText: { ...BoldType.rowTitle, color: Bold.ink, marginBottom: 6 },
  option: { backgroundColor: Bold.ground, borderRadius: 17, paddingHorizontal: 14, height: 36, justifyContent: "center" },
  optionText: { ...BoldType.chipLine, color: Bold.ink },
  choices: { flexDirection: "row", gap: 8 },
  choice: { flex: 1, height: 44, borderRadius: 22, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  choiceText: { ...BoldType.rowTitle, color: Bold.ink },
  pressed: { transform: [{ scale: Bold.pressScale }] },
});
