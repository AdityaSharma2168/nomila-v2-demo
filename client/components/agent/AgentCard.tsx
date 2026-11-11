/**
 * AgentCard — one component per card kind, chosen here; AgentCardList draws a turn's cards in order, laying a run of
 * reveals out as a swipeable rail and a run of capabilities as a grid. A kind the client doesn't know is skipped
 * (field-presence reading of the wire), and every card sits inside an error boundary, so one bad card never takes the
 * conversation down.
 */
import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useReducedMotion } from "../ui/Accordion";
import { ErrorBoundary } from "../mila/ErrorBoundary";
import { ActionCard } from "./ActionCard";
import { ProgressCard } from "./ProgressCard";
import { ProgressView } from "./ProgressCard";
import { ReadyCard } from "./ReadyCard";
import { ConnectCard } from "./ConnectCard";
import { HowIGotThisCard, HowPanel } from "./HowIGotThis";
import { PartnersCard, PlayCard, PositioningCard, RateRangesCard, UnconfirmedCard } from "./PresentationCards";
import { ResearchActivityCard } from "./ResearchActivityCard";
import { AgeBandCard, ConsentCard, InsightCard, QuickQuestionCard, RevealCard } from "./OnboardingCards";
import { MiaPreviewCard } from "./MiaPreviewCard";
import { GoalProposalCard } from "./GoalCards";
import { BriefProposalCard } from "./BriefProposalCard";
import { CapabilityCard, CapabilityGrid } from "./CapabilityCard";
import { FactReviewCard } from "./FactReviewCard";
import { OpenScreenCard } from "./OpenScreenCard";
import { DealChatCard, DealClosedCard, DealReplyCard, DealsWaitingCard } from "./DealCards";
import { BookingChatCard } from "./BookingCard";
import { drawableCards } from "../../lib/agent/cardLogic";
import type { AnyChatCard, CardOf, ProgressWithSteps } from "../../lib/agent/types";

export function AgentCard({ card, turnHasHow = false }: { card: AnyChatCard; turnHasHow?: boolean }) {
  switch (card.kind) {
    case "action": return <ActionCard card={card} lazyHow={!turnHasHow} />;
    case "progress": {
      const p = card.payload as ProgressWithSteps;
      return p.steps?.length ? <ProgressView title={card.title} payload={p} steps={p.steps} /> : <ProgressCard card={card} />;
    }
    case "ready": return <ReadyCard card={card} />;
    case "connect": return <ConnectCard card={card} />;
    case "how-i-got-this": return <HowIGotThisCard card={card} />;
    case "mia-preview": return <MiaPreviewCard card={card} />;
    case "research-activity": return <ResearchActivityCard card={card} />;
    case "rate-ranges": return <RateRangesCard card={card} />;
    case "quick-question": return <QuickQuestionCard card={card} />;
    case "reveal": return <RevealCard card={card} />;
    case "consent": return <ConsentCard card={card} />;
    case "age-band": return <AgeBandCard card={card} />;
    case "positioning": return <PositioningCard card={card} />;
    case "partners": return <PartnersCard card={card} />;
    case "play": return <PlayCard card={card} />;
    case "unconfirmed": return <UnconfirmedCard card={card} />;
    case "insight": return <InsightCard card={card} />;
    case "goal-proposal": return <GoalProposalCard card={card} />;
    case "brief-proposal": return <BriefProposalCard card={card} />;
    case "capability": return <CapabilityCard card={card} />;
    case "fact-review": return <FactReviewCard card={card} />;
    case "open-screen": return <OpenScreenCard card={card} />;
    // Deals and bookings in the chat (AGENT_DEALS_TOOLS / AGENT_BOOKINGS_TOOLS).
    case "deal": return <DealChatCard card={card} />;
    case "deal-reply": return <DealReplyCard card={card} />;
    case "deal-closed": return <DealClosedCard card={card} />;
    case "deals-waiting": return <DealsWaitingCard card={card} />;
    case "booking": return <BookingChatCard card={card} />;
    default: return null;
  }
}

type Group =
  | { kind: "one"; card: AnyChatCard }
  | { kind: "capabilities"; cards: Array<CardOf<"capability">> };

/** Consecutive capabilities become one grid; everything else stands alone. */
export function groupCards(cards: AnyChatCard[]): Group[] {
  const out: Group[] = [];
  for (const c of cards) {
    const last = out[out.length - 1];
    if (c.kind === "capability") {
      if (last?.kind === "capabilities") last.cards.push(c);
      else out.push({ kind: "capabilities", cards: [c] });
    } else {
      out.push({ kind: "one", card: c });
    }
  }
  return out;
}

/**
 * A turn's cards, in order. `runId` (from the SSE done event) adds a "How I got this" under the cards when none of them
 * carries one already — fetched from the run's trace on first open.
 */
/**
 * One card group easing in: fade and rise, `delay` after the turn appears; under reduce motion it is simply there.
 * Always rendered, `animate` or not: the wrapper must not come and go when the turn stops being the latest one, or
 * every card in it remounts and drops its own state (a consent card's "Agreed" vanished, buttons back, as Mila replied).
 */
function StaggerIn({ index, animate, children }: { index: number; animate: boolean; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const still = reduced || !animate;
  const v = useRef(new Animated.Value(still ? 1 : 0)).current;
  useEffect(() => {
    if (still) { v.setValue(1); return undefined; }
    const anim = Animated.timing(v, { toValue: 1, duration: 400, delay: index * 160, easing: Easing.out(Easing.ease), useNativeDriver: true });
    anim.start();
    // Each card's own delayed one-shot — without this, an unmount (or reduceMotion resolving true)
    // mid-delay leaves its still-pending Animated timer running on real timers past the test/screen
    // that started it; `stop()` is a no-op once the animation has already finished.
    return () => anim.stop();
  }, [still, index, v]);
  return <Animated.View style={{ opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>{children}</Animated.View>;
}

/**
 * A turn's cards, in order. `staged` (the reveal moment): the cards arrive one after another rather than all at once.
 * `runId` (from the SSE done event) adds a "How I got this" under the cards when none of them carries one already.
 */
export function AgentCardList({ cards, runId, staged = false }: { cards: unknown; runId?: string | null; staged?: boolean }) {
  const list = drawableCards(cards);
  const howCard = list.some((c) => c.kind === "how-i-got-this");
  const hasHow = howCard || list.some((c) => c.kind === "action");
  if (!list.length && !runId) return null;
  return (
    <View style={styles.list} testID="agent-cards">
      {groupCards(list).map((g, i) => {
        const drawn = g.kind === "capabilities" ? <CapabilityGrid cards={g.cards} /> : <AgentCard card={g.card} turnHasHow={howCard} />;
        return (
          <ErrorBoundary key={g.kind === "one" ? g.card.id : `${g.kind}-${i}`}>
            <StaggerIn index={i} animate={staged}>{drawn}</StaggerIn>
          </ErrorBoundary>
        );
      })}
      {runId && !hasHow ? <HowPanel runId={runId} testID="turn-how" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 12 },
});
