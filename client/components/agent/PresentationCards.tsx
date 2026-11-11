/**
 * The agency presentation — how Mila first shows the athlete what she found, the way a top sports agency would pitch it
 * (owner direction, 9 Oct 2026). Proposed additive card kinds (lib/agent/types.ts):
 *
 * (The reveal moment's idea, highlights, standing and windows are agent/1's reveal card; rate ranges are agent/1's too.)
 *   positioning  from → to, the statement, three pillars
 *   partners     partner categories, real logos where known (LogoMark chain; initials otherwise)
 *   play         the ONE thing to do now; Start opens it in Mila
 *   unconfirmed  what Mila couldn't confirm, each with its fix: connect a service, or tell Mila
 * (The onboarding kinds — reveal, insight, fact-review, goal-proposal, capability, consent, age-band — are agent/1's own,
 * from #890: OnboardingCards.tsx, FactReviewCard.tsx, GoalCards.tsx, CapabilityCard.tsx.)
 *
 * Every fact keeps its type mark and source; every read keeps "How I got this". Voice: confident, concise, "you".
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Bold, BoldType } from "../../constants/theme";
import { Button } from "../ui";
import { LogoMark } from "../ui/LogoMark";
import { Eyebrow, FactMark, HOME_BLOCK, HOME_CARD, SourceChip as Chip, partStyles } from "./parts";
import { HowPanel } from "./HowIGotThis";
import { useAgentCardHandlers } from "./handlers";
import { connectorName, formatMoney } from "../../lib/agent/cardLogic";
import type { CardOf } from "../../lib/agent/types";

/** Sources on the presentation cards: look B's square corner. */
const Source = (props: React.ComponentProps<typeof Chip>) => <Chip square {...props} />;

export const PRESENTATION_COPY = {
  from: "From",
  to: "To",
  soWhat: "So what",
  whyNow: "Why now",
  firstSteps: "First steps",
  start: "Start",
  tell: "Tell Mila",
  connect: (service: string) => `Connect ${service}`,
  nudge: "Connect or tell me, and I'll fill these in.",
} as const;

function SoWhat({ text, onDark }: { text: string | null; onDark?: boolean }) {
  if (!text) return null;
  return (
    <View style={styles.soWhat} testID="so-what">
      <Feather name="arrow-right" size={15} color={onDark ? Bold.blueOnDark : Bold.blue} style={styles.soWhatIcon} />
      <Text style={[styles.soWhatText, onDark && { color: Bold.onDark }]}>{text}</Text>
    </View>
  );
}

// ─── positioning ────────────────────────────────────────────────────────────────────────────────────────────────

export function PositioningCard({ card }: { card: CardOf<"positioning"> }) {
  const p = card.payload;
  return (
    <View style={styles.card} testID="card-positioning">
      <Eyebrow>{card.title}</Eyebrow>
      <View style={styles.fromTo} accessible accessibilityLabel={`From ${p.from}, to ${p.to}`}>
        <View style={styles.from}>
          <Text style={styles.ftLabel}>{PRESENTATION_COPY.from}</Text>
          <Text style={styles.fromText}>{p.from}</Text>
        </View>
        <View style={styles.ftArrow}><Feather name="arrow-down" size={16} color={Bold.ink} /></View>
        <View style={styles.to}>
          <Text style={[styles.ftLabel, { color: Bold.onDarkLabel }]}>{PRESENTATION_COPY.to}</Text>
          <Text style={styles.toText}>{p.to}</Text>
        </View>
      </View>
      <Text style={styles.statement}>{p.statement}</Text>
      <View style={styles.pillars}>
        {p.pillars.map((pl, i) => (
          <View key={pl.title} style={[styles.pillar, i > 0 && styles.pillarRule]} testID="pillar">
            <Text style={styles.pillarNum}>{String(i + 1).padStart(2, "0")}</Text>
            <View style={styles.flex}>
              <Text style={partStyles.h4}>{pl.title}</Text>
              <Text style={partStyles.caption}>{pl.line}</Text>
            </View>
          </View>
        ))}
      </View>
      <HowPanel payload={p.how} runId={card.runId} />
    </View>
  );
}

// ─── partners ───────────────────────────────────────────────────────────────────────────────────────────────────

export function PartnersCard({ card }: { card: CardOf<"partners"> }) {
  return (
    <View style={styles.card} testID="card-partners">
      <Eyebrow>{card.title}</Eyebrow>
      {card.payload.categories.map((c, i) => (
        <View key={c.category} style={[styles.category, i > 0 && styles.categoryRule]} testID="partner-category">
          <Text style={partStyles.h4}>{c.category}</Text>
          <Text style={partStyles.caption}>{c.why}</Text>
          {c.brands.length ? (
            <View style={styles.logos}>
              {c.brands.map((b) => (
                <View key={b.name} style={styles.logo}>
                  <LogoMark bold name={b.name} domain={b.domain} logoUrl={b.logoUrl} size={36} />
                  <Text style={styles.logoName} numberOfLines={1}>{b.name}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ))}
      <HowPanel payload={card.payload.how} runId={card.runId} />
    </View>
  );
}

// ─── play ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function PlayCard({ card }: { card: CardOf<"play"> }) {
  const { startWorkflow } = useAgentCardHandlers();
  const p = card.payload;
  return (
    <View style={styles.card} testID="card-play">
      <View style={partStyles.row}>
        <View style={styles.playDot} />
        <Text style={[styles.eyebrowBlue]}>{card.title}</Text>
      </View>
      <Text style={styles.playMove} accessibilityRole="header">{p.move}</Text>
      <View style={styles.whyNow}>
        <Text style={styles.ftLabel}>{PRESENTATION_COPY.whyNow}</Text>
        <Text style={partStyles.body}>{p.whyNow}</Text>
      </View>
      {p.steps.length ? (
        <View style={styles.steps}>
          {p.steps.map((s, i) => (
            <View key={s} style={styles.stepRow}>
              <View style={styles.stepNum}><Text style={styles.stepNumText}>{i + 1}</Text></View>
              <Text style={[partStyles.body, styles.flex]}>{s}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {startWorkflow ? <Button bold="primary" onPress={() => startWorkflow(p.startPrompt)} testID="play-start">{PRESENTATION_COPY.start}</Button> : null}
      <HowPanel payload={p.how} runId={card.runId} />
    </View>
  );
}

// ─── unconfirmed ────────────────────────────────────────────────────────────────────────────────────────────────

export function UnconfirmedCard({ card }: { card: CardOf<"unconfirmed"> }) {
  const { connect, prefill } = useAgentCardHandlers();
  return (
    <View style={styles.card} testID="card-unconfirmed">
      <Eyebrow>{card.title}</Eyebrow>
      <Text style={partStyles.body}>{PRESENTATION_COPY.nudge}</Text>
      {card.payload.items.map((it) => {
        const fix = it.fix;
        const btn =
          fix.kind === "connect"
            ? connect ? <Button bold="small" onPress={() => { void connect(fix.connectorId); }} testID="unconfirmed-connect">{PRESENTATION_COPY.connect(fix.service)}</Button> : null
            : prefill ? <Button bold="small" onPress={() => prefill(fix.prompt)} testID="unconfirmed-tell">{PRESENTATION_COPY.tell}</Button> : null;
        return (
          <View key={it.what} style={styles.unItem} testID="unconfirmed-item">
            <View style={styles.unRow}>
              <View style={styles.notYet} />
              <Text style={[partStyles.h4, styles.flex]}>{it.what}</Text>
            </View>
            {btn}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { ...HOME_CARD, padding: 14, gap: 12 },

  soWhat: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingTop: 2 },
  soWhatIcon: { marginTop: 3 },
  soWhatText: { ...BoldType.read, color: Bold.ink, flex: 1 },



  fromTo: { gap: 0 },
  from: { backgroundColor: Bold.ground, borderRadius: Bold.radius.control, padding: 12, gap: 2 },
  fromText: { ...BoldType.rowTitle, color: Bold.ink2 },
  ftArrow: { alignSelf: "center", paddingVertical: 4 },
  to: { backgroundColor: Bold.ink, borderRadius: Bold.radius.control, padding: 12, gap: 2 },
  toText: { ...BoldType.headedTitle, color: Bold.onDark },
  ftLabel: { ...BoldType.label, color: Bold.mute },
  statement: { ...BoldType.heroLine, color: Bold.ink },
  pillars: { gap: 0 },
  pillar: { flexDirection: "row", gap: 12, paddingVertical: 10, alignItems: "flex-start" },
  pillarRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },
  pillarNum: { ...BoldType.sigValue, color: Bold.blue, width: 24 },


  category: { gap: 6, paddingVertical: 4 },
  categoryRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line, paddingTop: 12 },
  logos: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 4 },
  logo: { alignItems: "center", gap: 4, width: 64 },
  logoName: { ...BoldType.caption, color: Bold.ink2, textAlign: "center" },

  playDot: { width: 8, height: 8, borderRadius: 1, backgroundColor: Bold.blue },
  eyebrowBlue: { ...BoldType.label, color: Bold.blue },
  playMove: { ...BoldType.glanceTitle, color: Bold.ink },
  whyNow: { backgroundColor: Bold.ground, borderRadius: Bold.radius.control, padding: 12, gap: 4 },
  steps: { gap: 8 },
  stepRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  stepNum: { width: 22, height: 22, borderRadius: Bold.radius.control, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center", marginTop: 1 },
  stepNumText: { ...BoldType.buttonSmall, color: Bold.onDark, letterSpacing: 0 },

  unItem: { gap: 8, paddingTop: 4 },
  unRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  notYet: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderStyle: "dotted", borderColor: Bold.mute },

  whenChip: { backgroundColor: Bold.blue, borderRadius: Bold.radius.chip, paddingHorizontal: 8, paddingVertical: 3 },
  confChip: { borderWidth: 1, borderColor: Bold.ink, borderRadius: Bold.radius.chip, paddingHorizontal: 6, paddingVertical: 2 },
  confText: { ...BoldType.chipLine, color: Bold.ink },
  rate: { gap: 4, paddingTop: 4 },
  sharpenRow: { gap: 8 },
  rateHead: { flexDirection: "row", alignItems: "baseline", gap: 12 },
  rateValue: { ...BoldType.cellValue, color: Bold.ink },
  whenChipText: { ...BoldType.chipLine, color: Bold.onDark },
});

// ─── rate-ranges (agent/1, #891) ────────────────────────────────────────────────────────────────────────────────

export const RATES_COPY = {
  drivers: "What moves it",
  confidence: { low: "Low confidence", medium: "Medium confidence", high: "High confidence" },
  sharpenWith: (service: string) => `Connect ${service} to sharpen`,
  connectAny: "Connect an account",
  connectAnyAsk: "Help me connect an account.",
} as const;

/** "$200–1,200" — the range in the item's currency, small and large alike. */
export function formatRange(low: number, high: number, currency: string): string {
  const one = (n: number) => formatMoney(Math.round(n * 100), currency);
  if (low === high) return one(low);
  const hi = one(high);
  // Drop the repeated symbol on the high end when both share it ("$200–1,200").
  const lo = one(low);
  const sym = /^[^\d]+/.exec(lo)?.[0] ?? "";
  return `${lo}–${sym && hi.startsWith(sym) ? hi.slice(sym.length) : hi}`;
}

/** Early rate ranges: wide on purpose, each with what drives it, honest about confidence, and how to sharpen them. */
export function RateRangesCard({ card }: { card: CardOf<"rate-ranges"> }) {
  const { connect, reply, startWorkflow } = useAgentCardHandlers();
  const ask = reply ?? startWorkflow;
  const p = card.payload;
  return (
    <View style={styles.card} testID="card-rate-ranges">
      <Eyebrow right={<View style={styles.confChip}><Text style={styles.confText}>{RATES_COPY.confidence[p.confidence]}</Text></View>}>{card.title}</Eyebrow>
      {p.items.map((r, i) => (
        <View key={r.deliverable} style={[styles.rate, i > 0 && styles.categoryRule]} testID="rate-range">
          <View style={styles.rateHead}>
            <Text style={[partStyles.h4, styles.flex]}>{r.deliverable}</Text>
            <Text style={styles.rateValue}>{formatRange(r.low, r.high, r.currency)}</Text>
          </View>
          {r.drivers.length ? <Text style={partStyles.caption}>{`${RATES_COPY.drivers}: ${r.drivers.join(" · ")}`}</Text> : null}
        </View>
      ))}
      <SoWhat text={p.note} />
      {/* The connectors the server says would sharpen them; none named while still public-only → ask Mila to help. */}
      {connect && p.sharpenConnectors.length ? (
        <View style={styles.sharpenRow}>
          {p.sharpenConnectors.map((c) => (
            <Button key={c} bold="small" onPress={() => { void connect(c); }} testID="rates-sharpen">{RATES_COPY.sharpenWith(connectorName(c))}</Button>
          ))}
        </View>
      ) : p.sharpenWithConnect && ask ? (
        <Button bold="small" onPress={() => ask(RATES_COPY.connectAnyAsk)} testID="rates-connect-any">{RATES_COPY.connectAny}</Button>
      ) : null}
      <HowPanel runId={card.runId} />
    </View>
  );
}
