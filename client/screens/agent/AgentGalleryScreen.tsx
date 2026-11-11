/**
 * AgentGalleryScreen — DEV ONLY (web, `__DEV__` and EXPO_PUBLIC_AGENT_V3 both on; App.tsx mounts it at /agent-gallery
 * before sign-in). Every new agent card and screen drawn from the typed fixtures, on an in-memory AgentApi, so they can
 * be reviewed and screenshotted at phone width without signing in or a server. Nothing here ships in a production
 * bundle path: App.tsx only reaches it under __DEV__.
 *
 *   /agent-gallery              the index
 *   /agent-gallery?s=<page>     one page, full screen (what the screenshots capture)
 */
import React, { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Bold, BoldType } from "../../constants/theme";
import { N } from "../../components/deals/opps/tokens";
import { AgentApiProvider } from "../../lib/agent/hooks";
import { fixtureAgentApi, type FixtureApiOptions } from "../../lib/agent/fixtureApi";
import {
  ACTION_CARD_PAYMENT, CAPABILITY_CARDS, PAYOUT_NOTE_CARD, CHAT_TRANSCRIPT, CONNECT_CARD, CONNECT_YOUTH, FACT_GROUPS, HOW_CARD, INSIGHT_CARDS,
  PARTNERS_CARD, PERSONAS, POSITIONING_CARD, PROGRESS_CARD, PROGRESS_DONE, PROGRESS_FAILED, PROPOSAL_CARDS, READY_CARD,
  READY_EXPERIMENTAL, REVEAL_CARDS, UNCONFIRMED_CARD, CONSENT_CARD, AGE_BAND_CARD, REVEAL_BY_PERSONA, FACT_GROUP_CARE, type Persona,
} from "../../lib/agent/fixtures";
import type { AnyChatCard } from "../../lib/agent/types";
import { useQueryClient } from "@tanstack/react-query";
import {
  BOOKING_REQUEST_CARD, BOOKING_UPCOMING_CARD, DEAL_CARD_CLOSED, DEAL_CARD_NO_FEE, DEAL_CARD_YOURS, DEAL_CLOSED_CARD, DEAL_PENDING_ROWS,
  REPLY_CARD, REPLY_CARD_OUTLOOK, REPLY_CARD_SENT, WAITING_CARD,
} from "../../lib/agent/dealFixtures";
import { AgentCardList } from "../../components/agent/AgentCard";
import { OwnGoalComposer } from "../../components/agent/GoalCards";
import { AgentCardHandlersProvider, type AgentCardHandlers } from "../../components/agent/handlers";
import { PublishedSection } from "../../components/agent/PublishedSection";
import { AgentOnboardingFlow } from "./AgentOnboardingFlow";
import { OnboardingConversation } from "./OnboardingConversation";
import { GoalsScreen } from "./GoalsScreen";
import { GoalsTab } from "./GoalsTabScreen";
import { HomeComingUp } from "../../components/goals/ComingUpStrip";
import { GOALS_PLAN_FIXTURE, goalsPostsFixture } from "../../lib/agent/goalsFixtures";
import { StudioLibraryScreen } from "./StudioLibraryScreen";
import { PostKitScreen } from "./PostKitScreen";
import { StudioForYouScreen } from "./StudioForYouScreen";
import { POST_KIT_CAROUSEL_READY, POST_KIT_FIXTURE, POST_KIT_MUSIC_READY, POST_KIT_PREVIEW_READY, postKitPreviewAs, STUDIO_FIXTURE } from "../../lib/agent/fixtures";
import type { PostKitResponse } from "../../../shared/postKit";
import { SignInFront, type EmailStepInitial } from "../onboarding/SignInFront";
import { SportGridScreen } from "../onboarding/SportGridScreen";
import { IsThisYouFront } from "../onboarding/IsThisYouFront";
import { MilaIntroScreen } from "../onboarding/MilaIntroScreen";
import { WhatMilaHasScreen } from "../onboarding/WhatMilaHasScreen";
import { factCards, type OnboardingFact } from "../../lib/onboardingFront";
import type { ClaimPrompt, SignInFailure } from "../../lib/auth-context";

/**
 * Chat v2 (EXPO_PUBLIC_MILA_THREAD_V2) on a scripted server: the real module, transport and parser. Required only when
 * a page is opened, so the gallery never puts the chat library in a bundle that does not otherwise have it.
 */
function ThreadV2Page({ kind, long = false, voice = "idle" }: {
  kind: "answer" | "midstream" | "cards" | "failed" | "followups" | "cards-v2";
  long?: boolean;
  /** The gallery's voice session: "idle" shows the mic, "live" the voice bar with a spoken exchange. */
  voice?: "off" | "idle" | "live";
}) {
  // __DEV__ is folded at bundle time, so a production bundle drops this require (the gallery is dev only).
  const t = (__DEV__ ? require("../../components/mila/thread") : null) as typeof import("../../components/mila/thread") | null;
  // One set of options for the life of the page (the voice session is fixed per screen).
  const options = useMemo(() => t?.galleryOptions(kind, voice), [t, kind, voice]);
  if (!t || !options) return null;
  const saved = long || kind === "followups";
  return (
    <t.MilaThreadScreen
      visible
      presentation="tab"
      onClose={() => {}}
      initialPrompt={saved || kind === "answer" ? undefined : kind === "cards" ? "Reply to Northpeak" : kind === "cards-v2" ? "What's new?" : "How are my deals?"}
      initialConversationId={saved ? "00000000-0000-4000-8000-000000000001" : undefined}
      threadOptions={options}
    />
  );
}

/** The card kit's gallery page (dev only, required on open like the thread). */
function KitPage({ card, expanded = false }: { card: import("../../components/mila/cards/kit/fixtures").KitFixtureKey; expanded?: boolean }) {
  const k = (__DEV__ ? require("../../components/mila/cards/kit/KitGallery") : null) as typeof import("../../components/mila/cards/kit/KitGallery") | null;
  return k ? <k.KitGalleryPage card={card} expanded={expanded} /> : null;
}

function KitScreen({ screen, meSheet }: { screen: "home" | "me" | "all-deals"; meSheet?: string }) {
  const k = (__DEV__ ? require("../../components/mila/cards/kit/KitGallery") : null) as typeof import("../../components/mila/cards/kit/KitGallery") | null;
  return k ? <k.KitScreenPage screen={screen} meSheet={meSheet} /> : null;
}

/** Gallery taps that would leave the app: logged, never executed. */
const GALLERY_HANDLERS: AgentCardHandlers = {
  openLink: () => {},
  startWorkflow: () => {},
  prefill: () => {},
  connect: async () => true,
  act: async () => {},
  startCapability: () => {},
  reply: () => {},
};
/** Inside the onboarding conversation the flow's own act / start handlers stay (they drive the fixture API). */
const { act: _act, startCapability: _start, startWorkflow: _sw, reply: _reply, ...GALLERY_FLOW_HANDLERS } = GALLERY_HANDLERS;

function Fixture({ opts, children }: { opts: FixtureApiOptions; children: React.ReactNode }) {
  // Each page gets its own query cache and its own fixture API, so pages never share state.
  const qc = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }), []);
  const api = useMemo(() => fixtureAgentApi(opts), [opts]);
  return (
    <QueryClientProvider client={qc}>
      <AgentApiProvider api={api}>
        <AgentCardHandlersProvider value={GALLERY_HANDLERS}>{children}</AgentCardHandlersProvider>
      </AgentApiProvider>
    </QueryClientProvider>
  );
}

/** Cards on the Mila ground, as they sit in the chat. */
function CardsPage({ title, cards, extra }: { title: string; cards: AnyChatCard[]; extra?: React.ReactNode }) {
  return (
    <ScrollView style={styles.mila} contentContainerStyle={styles.milaBody}>
      <Text style={styles.pageTitle}>{title}</Text>
      <AgentCardList cards={cards} />
      {extra}
    </ScrollView>
  );
}

function personaCards(p: Persona): AnyChatCard[] {
  const r = REVEAL_BY_PERSONA[p.key];
  return [r.mia, r.reveal, r.quick, r.rates, ...INSIGHT_CARDS, POSITIONING_CARD, PARTNERS_CARD, p.play, UNCONFIRMED_CARD];
}

type Page = { key: string; label: string; opts: FixtureApiOptions; render: () => React.ReactNode };

/** The deal cards read their reply state from GET /pending-actions?deal_id=…: seed this page's cache with the fixture rows. */
function SeedDealRows({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  useMemo(() => {
    for (const [dealId, rows] of Object.entries(DEAL_PENDING_ROWS)) qc.setQueryData(["/api/v1/me/pending-actions", dealId, null], rows);
  }, [qc]);
  return <>{children}</>;
}

const conversation = (segment: number, persona?: Persona["key"]): Page["render"] => () => (
  <AgentOnboardingFlow onDone={() => {}} extraHandlers={GALLERY_FLOW_HANDLERS} key={`${segment}-${persona}`} />
);

/**
 * The chosen Goals tab + Home's "Coming up" (AGENT_V3 + AGENT_PLAN) over the typed GET /me/agent/goals fixture. The
 * picker's answer here is a LABELLED placeholder (a venue / equipment / light stock still, never a person), as on the
 * prototypes; the app shows the picker's own stored copy (no image credit is shown anywhere: owner, #907).
 */
const PLACEHOLDER_ATMOSPHERE = [
  "1576678927484-cc907957088c", "1540497077202-7c8a3999166f", "1508615070457-7baeba4003ab", "1558365849-6ebd8b0454b2", "1571902943202-507ec2618e8f", "1471922694854-ff1b63b20054",
].map((id) => `https://images.unsplash.com/photo-${id}?w=900&q=70&auto=format&fit=crop`);
const PLAN_OPTS: FixtureApiOptions = {
  plan: GOALS_PLAN_FIXTURE,
  atmosphere: (slot) => {
    // One distinct image per slot of the fixture (never a repeat on the screen).
    const i = Math.max(0, ["goal:goal-1", "goal:goal-2", "goal:goal-3", "rec:rec-1", "rec:rec-2", "goal:goal-4"].indexOf(slot.key)) % PLACEHOLDER_ATMOSPHERE.length;
    return { key: slot.key, kind: "image", imageId: slot.key, url: PLACEHOLDER_ATMOSPHERE[i], width: null, height: null };
  },
};

/**
 * The post kit screens over POST_KIT_FIXTURE with media that loads: a LABELLED placeholder still (an atmosphere stock
 * image, never a person) as the poster and the photo, and a short public CC0 sample clip (MDN's "flower") as the clip.
 * The repo has no test-asset footage of an athlete; the app itself only ever plays her own signed library files.
 */
const PLACEHOLDER_CLIP = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const GALLERY_KIT: PostKitResponse = {
  ...POST_KIT_FIXTURE,
  kit: { ...POST_KIT_FIXTURE.kit!, assets: [{ ...POST_KIT_FIXTURE.kit!.assets[0], clip: { startSec: 0, endSec: 5, from: "opening" } }] },
  media: [
    { ...POST_KIT_FIXTURE.media[0], thumbUrl: PLACEHOLDER_ATMOSPHERE[2], videoUrl: PLACEHOLDER_CLIP },
    { ...POST_KIT_FIXTURE.media[1], thumbUrl: PLACEHOLDER_ATMOSPHERE[0] },
  ],
};
const KIT_ROUTE = { params: { id: GALLERY_KIT.decisionId } };
// The preview render's states over the same placeholders: the "rendered" reel is the same sample clip with another
// placeholder still as its cover frame, and a carousel's rendered slides are placeholder stills (labelled above).
const GALLERY_KIT_READY: PostKitResponse = {
  ...GALLERY_KIT,
  kit: { ...GALLERY_KIT.kit!, preview: POST_KIT_PREVIEW_READY.kit!.preview },
  preview: { ...POST_KIT_PREVIEW_READY.preview!, previewUrl: PLACEHOLDER_CLIP, items: [{ kind: "video", url: PLACEHOLDER_CLIP }], coverUrl: PLACEHOLDER_ATMOSPHERE[3] },
};
const GALLERY_CAROUSEL_READY: PostKitResponse = {
  ...POST_KIT_CAROUSEL_READY,
  kit: { ...POST_KIT_CAROUSEL_READY.kit!, assets: [POST_KIT_CAROUSEL_READY.kit!.assets[0], { ...POST_KIT_CAROUSEL_READY.kit!.assets[1], clip: { startSec: 0, endSec: 5, from: "opening" } }] },
  media: GALLERY_KIT.media.map((m) => ({ ...m, inKit: true })),
  preview: {
    ...POST_KIT_CAROUSEL_READY.preview!, previewUrl: PLACEHOLDER_ATMOSPHERE[4],
    items: [{ kind: "image", url: PLACEHOLDER_ATMOSPHERE[4] }, { kind: "video", url: PLACEHOLDER_CLIP }], coverUrl: PLACEHOLDER_ATMOSPHERE[4],
  },
};
const kitPage = (kit: PostKitResponse, more: FixtureApiOptions = {}): FixtureApiOptions => ({ postKits: { [kit.decisionId]: kit }, ...more });
const feedPage = (kit: PostKitResponse): FixtureApiOptions => ({ studio: STUDIO_FIXTURE.filter((i) => i.kind === "post_kit"), postKits: { [kit.decisionId]: kit } });

// The onboarding front (DEV fixtures; names and teams are placeholders). The sign-in photos here are the #900
// prototype's placeholders: the app itself only ever shows the shared library's stored copies.
const PLACEHOLDER_SIGNIN = ["1547347298-4074fc3086f0", "1530549387789-4c1017266635"].map((id) => ({ id, url: `https://images.unsplash.com/photo-${id}?w=900&q=70&auto=format&fit=crop` }));
const FRONT_CLAIM: ClaimPrompt = { claimSessionId: "s-fixture", tier: "candidate", claims: [
  { claimId: "c-1", athleteId: "a-1", candidate: { athleteId: "a-1", fullName: "Jordan Demo", sport: "[Sport]", teamOrSchool: "[Team A]", classYear: 2027, cityOrCountry: "[City A]", knownSocialHandles: { instagram: "jordandemo" }, claimability: "open" } },
  { claimId: "c-2", athleteId: "a-2", candidate: { athleteId: "a-2", fullName: "Jordan Demo", sport: "[Sport]", teamOrSchool: "[Team B]", classYear: 2025, cityOrCountry: null, knownSocialHandles: null, claimability: "open" } },
] };
const FRONT_FACTS: OnboardingFact[] = factCards(FACT_GROUPS.flatMap((c) => c.payload.facts).map((f) => ({ id: f.factId, claim: f.claim, type: f.type, status: f.status, date: f.date, topic: null, sources: f.sources, sensitivity: f.sensitivity === "care" ? "care" : "none" })));
const noop = async () => {};
/** The sign-in front with the email code on, against canned answers (no server): "sent", then a match. */
function EmailFront({ initial, providerError }: { initial?: EmailStepInitial; providerError?: SignInFailure }) {
  return (
    <SignInFront
      photos={PLACEHOLDER_SIGNIN} onGoogle={() => {}} onApple={() => {}} onMicrosoft={() => {}} optionsOpen intervalMs={0} revealMs={0}
      emailSignIn providerError={providerError} initialEmailStep={initial ?? null}
      onEmailStart={async () => ({ kind: "sent", resendAfterSec: 60 })}
      onEmailVerify={async () => ({ kind: "wrong", triesLeft: 4 })}
    />
  );
}
const frontPages: Page[] = [
  { key: "front-signin", label: "Front · sign-in (no library photos: the dark ground)", opts: {}, render: () => <SignInFront photos={[]} onGoogle={() => {}} onApple={() => {}} onMicrosoft={() => {}} /> },
  { key: "front-signin-photos", label: "Front · sign-in, rotating photos (placeholders)", opts: {}, render: () => <SignInFront photos={PLACEHOLDER_SIGNIN} onGoogle={() => {}} onApple={() => {}} onMicrosoft={() => {}} /> },
  { key: "front-signin-options", label: "Front · sign-in, Google · Apple · Microsoft", opts: {}, render: () => <SignInFront photos={PLACEHOLDER_SIGNIN} onGoogle={() => {}} onApple={() => {}} onMicrosoft={() => {}} optionsOpen intervalMs={0} revealMs={0} /> },
  { key: "front-signin-email-link", label: "Front · sign-in, providers + Use email instead", opts: {}, render: () => <EmailFront /> },
  { key: "front-signin-provider-error", label: "Front · sign-in, a provider sign-in failed", opts: {}, render: () => <EmailFront providerError={{ kind: "failed" }} /> },
  { key: "front-signin-account-exists", label: "Front · sign-in, the email already has an account", opts: {}, render: () => <EmailFront providerError={{ kind: "account_exists", email: "jordan.lee@school.edu" }} /> },
  { key: "front-email-locked-out", label: "Front · email entry, locked out for a day", opts: {}, render: () => <EmailFront initial={{ step: "email", email: "jordan.lee@gmail.com", emailError: { kind: "tooMany", minutes: 1440 } }} /> },
  { key: "front-email", label: "Front · email entry", opts: {}, render: () => <EmailFront initial={{ step: "email", email: "jordan.lee@gmail.com" }} /> },
  { key: "front-email-invalid", label: "Front · email entry, not an address", opts: {}, render: () => <EmailFront initial={{ step: "email", email: "jordan.lee@gmail", emailError: { kind: "invalid" } }} /> },
  { key: "front-email-send-failed", label: "Front · email entry, couldn't send", opts: {}, render: () => <EmailFront initial={{ step: "email", email: "jordan.lee@gmail.com", emailError: { kind: "sendFailed" } }} /> },
  { key: "front-email-busy", label: "Front · email entry, lots of sign-ins right now", opts: {}, render: () => <EmailFront initial={{ step: "email", email: "jordan.lee@gmail.com", emailError: { kind: "busy" } }} /> },
  { key: "front-email-too-many", label: "Front · email entry, too many codes", opts: {}, render: () => <EmailFront initial={{ step: "email", email: "jordan.lee@gmail.com", emailError: { kind: "tooMany", minutes: 15 } }} /> },
  { key: "front-code", label: "Front · check your email (typing)", opts: {}, render: () => <EmailFront initial={{ step: "code", email: "jordan.lee@gmail.com", code: "4829", resendInSec: 42 }} /> },
  { key: "front-code-wrong", label: "Front · wrong code", opts: {}, render: () => <EmailFront initial={{ step: "code", email: "jordan.lee@gmail.com", codeError: { kind: "wrong", triesLeft: 2 }, resendInSec: 42 }} /> },
  { key: "front-code-expired", label: "Front · code expired", opts: {}, render: () => <EmailFront initial={{ step: "code", email: "jordan.lee@gmail.com", code: "482913", codeError: { kind: "expired" } }} /> },
  { key: "front-code-locked", label: "Front · code locked", opts: {}, render: () => <EmailFront initial={{ step: "code", email: "jordan.lee@gmail.com", code: "482913", codeError: { kind: "locked" } }} /> },
  { key: "front-sport", label: "Front · the sport grid", opts: {}, render: () => <SportGridScreen onContinue={() => {}} initial={["Volleyball", "Beach volleyball"]} /> },
  { key: "front-sport-name", label: "Front · the sport grid, name not known", opts: {}, render: () => <SportGridScreen onContinue={() => {}} askName /> },
  { key: "front-claim", label: "Front · Is this you?", opts: {}, render: () => <IsThisYouFront prompt={FRONT_CLAIM} onConfirm={noop} onDismiss={noop} /> },
  { key: "front-intro", label: "Front · Mila's intro", opts: {}, render: () => <MilaIntroScreen onStart={() => {}} /> },
  { key: "front-intro-picked", label: "Front · Mila's intro, 2 picked", opts: {}, render: () => <MilaIntroScreen onStart={() => {}} initial={["brand", "deals"]} /> },
  { key: "front-intro-soon", label: "Front · Mila's intro, a Soon tile picked", opts: {}, render: () => <MilaIntroScreen onStart={() => {}} initial={["picks"]} /> },
  { key: "front-intro-more", label: "Front · Mila's intro, how it works", opts: {}, render: () => <MilaIntroScreen onStart={() => {}} sheetOpen /> },
  { key: "front-has", label: "Front · what Mila already has", opts: {}, render: () => <WhatMilaHasScreen facts={FRONT_FACTS} working onConfirm={noop} onCorrect={noop} onContinue={() => {}} /> },
];

export const GALLERY_PAGES: Page[] = [
  ...frontPages,
  // Goals (the chosen design) and Home's Coming up
  { key: "goals-tab", label: "Goals tab (AGENT_PLAN)", opts: PLAN_OPTS, render: () => <GoalsTab /> },
  { key: "goals-tab-second", label: "Goals tab · goal 2 open (from Coming up)", opts: PLAN_OPTS, render: () => <GoalsTab route={{ params: { goalId: "goal-2" } }} /> },
  { key: "goals-tab-defaults", label: "Goals tab · picker dark (category defaults)", opts: { plan: GOALS_PLAN_FIXTURE }, render: () => <GoalsTab /> },
  // Post rows (design "Goals tab post details + plan ready"): ready · preparing · no kit; a tap on a row opens it in place.
  { key: "goals-posts", label: "Goals tab · post rows (ready · preparing · no kit)", opts: { ...PLAN_OPTS, plan: goalsPostsFixture(), postKits: { "act-post-ready": { ...GALLERY_KIT_READY, decisionId: "act-post-ready" } } }, render: () => <GoalsTab /> },
  { key: "goals-updating", label: "Goals tab · Mila is updating your plan", opts: { ...PLAN_OPTS, plan: goalsPostsFixture({ planning: { runId: "run-2", step: "post_kits", startedAt: "2026-10-12T09:00:00.000Z" } }) }, render: () => <GoalsTab /> },
  { key: "coming-up", label: "Home · Coming up", opts: { plan: GOALS_PLAN_FIXTURE }, render: () => <ScrollView style={styles.paper}><HomeComingUp enabled onOpen={() => {}} /></ScrollView> },
  // Cards
  { key: "chat", label: "Mila chat · cards inline", opts: { initialState: CHAT_TRANSCRIPT }, render: () => (
    <OnboardingConversation state={CHAT_TRANSCRIPT} onFinish={() => {}} onStartWorkflow={() => {}} onCapability={() => {}} extraHandlers={GALLERY_HANDLERS} />
  ) },
  { key: "cards-action", label: "Cards · action (send, pay, youth, pro)", opts: {}, render: () => (
    <CardsPage title="Action" cards={[PERSONAS.college.action, ACTION_CARD_PAYMENT, PERSONAS.youth.action, PAYOUT_NOTE_CARD, PERSONAS.pro.action]} />
  ) },
  { key: "cards-deals", label: "Cards · deals (AGENT_DEALS_TOOLS): deal, reply approval, sent, Outlook, say-no, waiting", opts: {}, render: () => (
    <SeedDealRows><CardsPage title="Deals" cards={[DEAL_CARD_YOURS, DEAL_CARD_NO_FEE, REPLY_CARD, REPLY_CARD_SENT, REPLY_CARD_OUTLOOK, DEAL_CLOSED_CARD, WAITING_CARD, DEAL_CARD_CLOSED]} /></SeedDealRows>
  ) },
  { key: "cards-bookings", label: "Cards · bookings (AGENT_BOOKINGS_TOOLS): a request, an upcoming session", opts: {}, render: () => (
    <CardsPage title="Bookings" cards={[BOOKING_REQUEST_CARD, BOOKING_UPCOMING_CARD]} />
  ) },
  { key: "cards-progress", label: "Cards · progress, ready", opts: {}, render: () => (
    <CardsPage title="Progress · ready" cards={[PROGRESS_CARD, PROGRESS_DONE, PROGRESS_FAILED, READY_CARD, READY_EXPERIMENTAL]} />
  ) },
  { key: "cards-connect", label: "Cards · connect, how I got this", opts: {}, render: () => (
    <CardsPage title="Connect · how I got this" cards={[CONNECT_CARD, CONNECT_YOUTH, HOW_CARD]} />
  ) },
  { key: "agency-college", label: "Presentation · college", opts: {}, render: () => <CardsPage title={`${PERSONAS.college.name} · ${PERSONAS.college.sport}`} cards={personaCards(PERSONAS.college)} /> },
  { key: "agency-youth", label: "Presentation · youth", opts: {}, render: () => <CardsPage title={`${PERSONAS.youth.name} · ${PERSONAS.youth.sport}`} cards={personaCards(PERSONAS.youth)} /> },
  { key: "agency-pro", label: "Presentation · pro", opts: {}, render: () => <CardsPage title={`${PERSONAS.pro.name} · ${PERSONAS.pro.sport}`} cards={personaCards(PERSONAS.pro)} /> },
  { key: "cards-review", label: "Cards · facts, age, goals, consent, capabilities", opts: {}, render: () => (
    <CardsPage title="Facts · goals · capabilities" cards={[...FACT_GROUPS.slice(0, 1), FACT_GROUP_CARE, AGE_BAND_CARD, ...PROPOSAL_CARDS.slice(0, 2), CONSENT_CARD, ...CAPABILITY_CARDS]} extra={<View style={styles.gap}><OwnGoalComposer onAdd={() => {}} /></View>} />
  ) },
  // Onboarding
  { key: "onb-name", label: "Onboarding · name and sport", opts: { segment: 0 }, render: conversation(0) },
  { key: "onb-research", label: "Onboarding · researching, live (college)", opts: { segment: 1, researchStepMs: 2500 }, render: conversation(1) },
  { key: "onb-research-youth", label: "Onboarding · researching, live (youth)", opts: { segment: 1, researchStepMs: 2500, persona: "youth" }, render: conversation(1, "youth") },
  { key: "onb-research-pro", label: "Onboarding · researching, live (pro)", opts: { segment: 1, researchStepMs: 2500, persona: "pro" }, render: conversation(1, "pro") },
  { key: "onb-found", label: "Onboarding · the reveal (college)", opts: { segment: 2 }, render: conversation(2) },
  { key: "onb-insights", label: "Onboarding · insights and rate ranges", opts: { segment: 3 }, render: conversation(3) },
  { key: "onb-connect", label: "Onboarding · connect", opts: { segment: 4 }, render: conversation(4) },
  { key: "onb-facts", label: "Onboarding · check facts (incl. a private one)", opts: { segment: 5 }, render: conversation(5) },
  { key: "onb-goals", label: "Onboarding · goals (college)", opts: { segment: 6 }, render: conversation(6) },
  { key: "onb-goals-youth", label: "Onboarding · goals (youth)", opts: { segment: 6, persona: "youth" }, render: conversation(6, "youth") },
  { key: "onb-goals-pro", label: "Onboarding · goals (pro)", opts: { segment: 6, persona: "pro" }, render: conversation(6, "pro") },
  { key: "onb-consent", label: "Onboarding · how Mila works", opts: { segment: 7 }, render: conversation(7) },
  { key: "onb-capabilities", label: "Onboarding · what I can do, Go to Home", opts: { segment: 8 }, render: conversation(8) },
  { key: "onb-pro", label: "Onboarding · the reveal (pro)", opts: { segment: 2, persona: "pro" }, render: conversation(2, "pro") },
  { key: "onb-youth", label: "Onboarding · the reveal (youth)", opts: { segment: 2, persona: "youth" }, render: conversation(2, "youth") },
  { key: "onb-loading", label: "Onboarding · loading", opts: { latencyMs: 600000 }, render: conversation(-1) },
  { key: "onb-error", label: "Onboarding · error", opts: { fail: true }, render: conversation(-2) },
  // Goals
  { key: "goals", label: "Goals", opts: {}, render: () => <GoalsScreen /> },
  { key: "goals-empty", label: "Goals · empty", opts: { goals: [] }, render: () => <GoalsScreen /> },
  { key: "goals-loading", label: "Goals · loading", opts: { latencyMs: 600000 }, render: () => <GoalsScreen /> },
  { key: "goals-error", label: "Goals · error", opts: { fail: true }, render: () => <GoalsScreen /> },
  // Studio
  { key: "studio", label: "Studio library", opts: {}, render: () => <StudioLibraryScreen /> },
  { key: "studio-empty", label: "Studio · empty", opts: { studio: [] }, render: () => <StudioLibraryScreen /> },
  { key: "studio-loading", label: "Studio · loading", opts: { latencyMs: 600000 }, render: () => <StudioLibraryScreen /> },
  { key: "studio-error", label: "Studio · error", opts: { fail: true }, render: () => <StudioLibraryScreen /> },

  { key: "post-kit", label: "Post kit (built)", opts: { postKits: { [GALLERY_KIT.decisionId]: GALLERY_KIT } }, render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-done", label: "Post kit · posted (read-only)", opts: { postKits: { [GALLERY_KIT.decisionId]: { ...GALLERY_KIT, state: "done" } } }, render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-write-error", label: "Post kit · a write fails (tap I posted it twice)", opts: { postKits: { [GALLERY_KIT.decisionId]: GALLERY_KIT }, postKitFailures: { posted: { status: 500, code: "internal" }, swap: { status: 409, code: "unavailable" } } }, render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-closed", label: "Post kit · no longer open (expired / skipped)", opts: { postKits: { [GALLERY_KIT.decisionId]: GALLERY_KIT }, postKitFailures: { read: { status: 409, code: "closed" } } }, render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-empty", label: "Post kit · nothing built yet", opts: { postKits: { [GALLERY_KIT.decisionId]: { ...GALLERY_KIT, state: "to_start", kit: null } } }, render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-no-preview", label: "Post kit · no video (the chosen asset's still)", opts: { postKits: { [GALLERY_KIT.decisionId]: { ...GALLERY_KIT, media: GALLERY_KIT.media.map((m) => ({ ...m, videoUrl: null })) } } }, render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-build-held", label: "Post kit · Build it, held (tap Build it)", opts: kitPage({ ...GALLERY_KIT, state: "to_start", kit: null }, { postKitBuildOutcome: { status: "held", reason: "never_content" } }), render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-build-week-cap", label: "Post kit · Build it, weekly cap (tap Build it)", opts: kitPage({ ...GALLERY_KIT, state: "to_start", kit: null }, { postKitBuildOutcome: { status: "skipped", reason: "week_count" } }), render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-preview-ready", label: "Post kit · preview ready (the rendered reel)", opts: kitPage(GALLERY_KIT_READY), render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-music", label: "Post kit · three suggested tracks (play one, Use this)", opts: kitPage({ ...GALLERY_KIT_READY, kit: { ...GALLERY_KIT_READY.kit!, music: POST_KIT_MUSIC_READY.kit!.music }, music: POST_KIT_MUSIC_READY.music }), render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-music-brand-stale", label: "Post kit · music, post became brand work (one track not allowed)", opts: kitPage({ ...GALLERY_KIT_READY, kit: { ...GALLERY_KIT_READY.kit!, music: POST_KIT_MUSIC_READY.kit!.music }, music: { choices: POST_KIT_MUSIC_READY.music!.choices.map((c) => ({ ...c, allowed: c.trackId !== "track-b" })) } }), render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-preview-carousel", label: "Post kit · preview ready (carousel slides)", opts: kitPage(GALLERY_CAROUSEL_READY), render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-preview-preparing", label: "Post kit · preparing the preview", opts: kitPage(postKitPreviewAs(GALLERY_KIT, "queued")), render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-preview-failed", label: "Post kit · the preview failed (Try again)", opts: kitPage(postKitPreviewAs(GALLERY_KIT, "failed")), render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-loading", label: "Post kit · loading", opts: { latencyMs: 600000 }, render: () => <PostKitScreen route={KIT_ROUTE} /> },
  { key: "post-kit-error", label: "Post kit · error", opts: { fail: true }, render: () => <PostKitScreen route={KIT_ROUTE} /> },

  { key: "for-you", label: "Studio · For you feed", opts: { studio: STUDIO_FIXTURE.filter((i) => i.kind === "post_kit"), postKits: { [GALLERY_KIT.decisionId]: GALLERY_KIT } }, render: () => <StudioForYouScreen /> },
  { key: "for-you-preview-ready", label: "Studio · For you feed, preview ready", opts: feedPage(GALLERY_KIT_READY), render: () => <StudioForYouScreen /> },
  { key: "for-you-preview-preparing", label: "Studio · For you feed, preparing the preview", opts: feedPage(postKitPreviewAs(GALLERY_KIT, "queued")), render: () => <StudioForYouScreen /> },
  { key: "for-you-preview-failed", label: "Studio · For you feed, the preview failed", opts: feedPage(postKitPreviewAs(GALLERY_KIT, "failed")), render: () => <StudioForYouScreen /> },
  { key: "for-you-empty", label: "Studio · For you feed, empty", opts: { studio: [] }, render: () => <StudioForYouScreen /> },
  // Mila chat v2 (EXPO_PUBLIC_MILA_THREAD_V2): scripted streams through the real transport
  { key: "thread-v2-empty", label: "Mila chat v2 · empty", opts: {}, render: () => <ThreadV2Page kind="answer" /> },
  { key: "thread-v2-midstream", label: "Mila chat v2 · mid-stream", opts: {}, render: () => <ThreadV2Page kind="midstream" /> },
  { key: "thread-v2-cards", label: "Mila chat v2 · deal + approval cards", opts: {}, render: () => <SeedDealRows><ThreadV2Page kind="cards" /></SeedDealRows> },
  { key: "thread-v2-failed", label: "Mila chat v2 · a failed reply (Retry)", opts: {}, render: () => <ThreadV2Page kind="failed" /> },
  // The card system v2 (EXPO_PUBLIC_MILA_CARDS_V2; design "Mila card designs" v2.2): every card collapsed and expanded,
  // as it sits in the chat, and all of them streamed through the real chat v2 transport.
  { key: "thread-v2-cards-v2", label: "Mila chat v2 · the v2 cards, streamed", opts: {}, render: () => <ThreadV2Page kind="cards-v2" /> },
  ...(["insight", "ideas", "turn-on", "once", "answer", "deal", "deals-list"] as const).flatMap((c) => [
    { key: `cards-v2-${c}-collapsed`, label: `Mila cards v2 · ${c}, collapsed`, opts: {}, render: () => <KitPage card={c} /> },
    { key: `cards-v2-${c}-expanded`, label: `Mila cards v2 · ${c}, expanded`, opts: {}, render: () => <KitPage card={c} expanded /> },
  ]),
  ...(["home", "me", "all-deals"] as const).map((s) => (
    { key: `cards-v2-screen-${s}`, label: `Mila cards v2 · on ${s}`, opts: {}, render: () => <KitScreen screen={s} /> }
  )),
  // Me › What Mila can do with one capability's Turn-on sheet open (the pitch card).
  { key: "cards-v2-screen-me-sheet", label: "Mila cards v2 · on me, a Turn-on sheet open", opts: {}, render: () => <KitScreen screen="me" meSheet="pitch_deck" /> },
  { key: "thread-v2-long", label: "Mila chat v2 · long chat (opens at the newest)", opts: {}, render: () => <ThreadV2Page kind="answer" long /> },
  // Parity with today's chat: voice, the ＋ (tap it: photo → a chip that uploads, then Send), follow-ups
  { key: "thread-v2-voice-live", label: "Mila chat v2 · voice session live", opts: {}, render: () => <ThreadV2Page kind="answer" voice="live" /> },
  { key: "thread-v2-no-voice", label: "Mila chat v2 · voice unavailable", opts: {}, render: () => <ThreadV2Page kind="answer" voice="off" /> },
  { key: "thread-v2-followups", label: "Mila chat v2 · saved chat with nav chips", opts: {}, render: () => <ThreadV2Page kind="followups" /> },
  // Me
  { key: "me-published", label: "Me · published", opts: {}, render: () => <ScrollView style={styles.paper}><PublishedSection /></ScrollView> },
];

function pageFromUrl(): string | null {
  if (Platform.OS !== "web") return null;
  try { return new URLSearchParams(window.location.search).get("s"); } catch { return null; }
}

function GalleryIndex({ onOpen }: { onOpen: (k: string) => void }) {
  return (
    <ScrollView style={styles.paper} contentContainerStyle={styles.index}>
      <Text style={styles.indexTitle}>Agent UI gallery</Text>
      <Text style={styles.indexLede}>Dev only. Every card and screen from typed fixtures, on an in-memory API.</Text>
      {GALLERY_PAGES.map((p) => (
        <Pressable key={p.key} onPress={() => onOpen(p.key)} style={styles.indexRow} accessibilityRole="link">
          <Text style={styles.indexRowText}>{p.label}</Text>
          <Text style={styles.indexKey}>{p.key}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const Stack = createNativeStackNavigator();

function GalleryBody() {
  const [page, setPage] = useState<string | null>(pageFromUrl());
  const p = GALLERY_PAGES.find((x) => x.key === page);
  if (!p) return <GalleryIndex onOpen={(k) => { try { window.history.pushState(null, "", `?s=${k}`); } catch {} setPage(k); }} />;
  return <Fixture key={p.key} opts={p.opts}>{p.render()}</Fixture>;
}

export function AgentGalleryScreen() {
  // A navigator, so the screens' useNavigation works; nothing navigates anywhere.
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="AgentGallery" component={GalleryBody} />
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  paper: { flex: 1, backgroundColor: Bold.paper },
  mila: { flex: 1, backgroundColor: N.cream100 },
  milaBody: { padding: 20, paddingBottom: 60, gap: 12 },
  pageTitle: { ...BoldType.label, color: Bold.mute, marginBottom: 4 },
  gap: { marginTop: 12 },
  index: { padding: 20, gap: 4 },
  indexTitle: { ...BoldType.screenTitleSm, color: Bold.ink },
  indexLede: { ...BoldType.lede, color: Bold.mute, marginBottom: 12 },
  indexRow: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  indexRowText: { ...BoldType.rowTitle, color: Bold.ink },
  indexKey: { ...BoldType.caption, color: Bold.mute },
});
