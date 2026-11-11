/**
 * agent/fixtures — typed fixtures for the agent UI's tests and the dev gallery. PLACEHOLDERS ONLY: [First], [Sport],
 * [Brand A], [Event A], [Platform A], example.org links and example numbers. Nothing here is a real athlete, sport, brand
 * or source, and none of it ships in a screen's copy.
 */
import type {
  ActionPayloadWithNote,
  AgeBand,
  AgentGoal,
  AgentOnboardingState,
  AnyChatCard,
  CardSource,
  FactType,
  GoalHorizon,
  RateRangesCardPayload,
  ResearchEvent,
  MiaPreview,
  MiaSharpenStep,
  CardOf,
  ChatCard,
  HowIGotThisCardPayload,
  StudioItem,
} from "./types";
import type { PostKit, PostKitResponse } from "../../../shared/postKit";
import { activityCard } from "./onboardingAdapter";

export const HOW_FIXTURE: HowIGotThisCardPayload = {
  runId: "run-fixture-1",
  skillId: "research/athlete",
  why: "Your public profile and two news stories agree on the number, and the profile is the most recent of the three, so I used it.",
  facts: [
    { claim: "[Platform A] profile shows 48K followers", type: "found", source: { label: "[Platform A] profile", url: "https://example.org/profile" } },
    { claim: "A [Publication A] story from this season quotes a similar audience", type: "found", source: { label: "[Publication A]", url: "https://example.org/story" } },
    { claim: "You said your audience is mostly [Region A]", type: "said", source: { label: "You, in onboarding" } },
  ],
};

// ─── agent/1 chat cards ─────────────────────────────────────────────────────────────────────────────────────────

export const ACTION_CARD: CardOf<"action"> = {
  id: "card-action-1",
  kind: "action",
  title: "Reply to [Brand A]",
  payload: {
    approvalId: "appr-1",
    verb: "send_message",
    body: "Hi [Name], thanks for thinking of me. For 3 posts over 30 days with 30-day usage, my rate is [amount]. Happy to talk through dates.",
    money: { amountMinor: 120000, currency: "usd" },
    buttons: ["approve", "edit", "decline"],
  },
  links: [],
  runId: "run-fixture-1",
};

export const ACTION_CARD_PAYMENT: CardOf<"action"> = {
  id: "card-action-2",
  kind: "action",
  title: "Refund a booking deposit",
  payload: { approvalId: "appr-2", verb: "payment", body: null, money: { amountMinor: 8050, currency: "usd" }, buttons: ["approve", "decline"] },
  links: [],
  runId: null,
};

export const PROGRESS_CARD: CardOf<"progress"> = {
  id: "card-progress-1",
  kind: "progress",
  title: "Building your page",
  payload: { step: 2, of: 4, label: "Writing copy", state: "running" },
  links: [],
  runId: "run-fixture-2",
};

export const PROGRESS_DONE: CardOf<"progress"> = { ...PROGRESS_CARD, id: "card-progress-2", payload: { step: 4, of: 4, label: "Done", state: "done" } };
export const PROGRESS_FAILED: CardOf<"progress"> = { ...PROGRESS_CARD, id: "card-progress-3", payload: { step: 3, of: 4, label: "Choosing photos", state: "failed" } };

export const READY_CARD: CardOf<"ready"> = {
  id: "card-ready-1",
  kind: "ready",
  title: "3 post kits ready",
  payload: { itemKind: "post_kit", itemId: "studio-postkit-1", summary: "For your goal: [Goal A]. Uses 2 of your clips.", experimental: false },
  links: [{ label: "Review", target: { screen: "studio", id: "studio-postkit-1" } }],
  runId: "run-fixture-3",
};

export const READY_EXPERIMENTAL: CardOf<"ready"> = {
  ...READY_CARD,
  id: "card-ready-2",
  title: "Image edit ready",
  payload: { itemKind: "visual", itemId: "studio-visual-1", summary: "A new background on one of your photos.", experimental: true },
};

export const CONNECT_CARD: CardOf<"connect"> = {
  id: "card-connect-1",
  kind: "connect",
  title: "Connect your calendar?",
  payload: {
    connectorId: "google_calendar",
    service: "Google Calendar",
    access: ["See when you're busy or free", "Nothing changes on your calendar without asking"],
    why: "So I can suggest posts and meetings around your schedule.",
  },
  links: [],
  runId: null,
};

export const HOW_CARD: CardOf<"how-i-got-this"> = {
  id: "card-how-1",
  kind: "how-i-got-this",
  title: "How I got this",
  payload: HOW_FIXTURE,
  links: [],
  runId: HOW_FIXTURE.runId,
};

export const CHAT_CARDS: ChatCard[] = [ACTION_CARD, PROGRESS_CARD, READY_CARD, CONNECT_CARD, HOW_CARD];

// ─── Proposed: onboarding cards ─────────────────────────────────────────────────────────────────────────────────

const S = (label: string, path = "source"): CardSource => ({ label, url: `https://example.org/${path}` });

/** agent/1 `reveal` (#890): one card, the headline, then sourced highlights. */
export const REVEAL_CARD: CardOf<"reveal"> = {
  id: "rev-1", kind: "reveal", title: "Here's what I found", links: [], runId: "run-fixture-1",
  payload: {
    headline: "You're building something brands look for.",
    highlights: [
      { text: "Named to [Award A] this season, one of [n] chosen", factIds: ["f-2"], sources: [S("[Organization A]", "award")] },
      { text: "Covered in the news through the season, mostly for your results", factIds: ["f-3"], sources: [S("[Publication A]", "news"), S("[Publication B]", "news-2")] },
      { text: "An audience of 40–50K on [Platform A], growing since spring", factIds: ["f-1"], sources: [S("[Platform A] profile", "profile")] },
      { text: "Your community work keeps coming up in what others say about you", factIds: ["f-4"], sources: [S("[Publication A]", "feature")] },
    ],
    standing: { text: "A rising name in [Sport]: your audience and coverage are ahead of your partnerships.", factIds: ["f-1", "f-3"], sources: [S("[Platform A] profile", "profile")] },
    windows: [
      { text: "[Event A] is this month: your biggest audience of the season.", factIds: ["f-5"], sources: [S("[Organization A] schedule", "schedule")] },
      { text: "Brands plan event partners about six weeks ahead, and [Event B] is in six weeks.", factIds: ["f-6"], sources: [S("[Organization A] schedule", "schedule")] },
    ],
  },
};
export const REVEAL_CARDS: Array<CardOf<"reveal">> = [REVEAL_CARD];

/** The ring's eight dimensions in its order (constants/ring.ts), for building example previews. */
const MIA_DIMS = ["audience_scale", "engagement_quality", "commercial_proof", "brand_fit", "narrative_power", "cultural_relevance", "athletic_authority", "momentum"] as const;
const MIA_GROUP_KEYS = ["audience", "commercial", "brand", "performance"] as const;

/**
 * An example `mia-preview/1` MiaPreview: score of 850, the eight dimensions' contributions (of 100) in `assessment` (what
 * Home's ringBands reads), the four groups summing them, and the sharpen steps (example values only).
 */
export function miaPreviewFixture(score: number, contributions: number[], level: "HIGH" | "MEDIUM" | "LOW", sharpen: MiaSharpenStep[], preliminary = true): MiaPreview {
  const dims = MIA_DIMS.map((key, i) => ({
    key, state: "neutral" as const, score: Math.min(100, contributions[i] * 8), confidence: level, confidenceReason: null, rationale: null,
    components: [], sources: { grounded: [], site_only: [], nomila_supplied: [], not_support: [], unrecorded: [] }, weight: 12.5, contribution: contributions[i], signals: [],
  }));
  return {
    contract: "mia-preview/1", athleteId: "athlete-fixture", status: "ready", score, scale: { min: 0, max: 850 },
    groups: MIA_GROUP_KEYS.map((key, g) => ({
      key, name: key.charAt(0).toUpperCase() + key.slice(1),
      contribution: contributions[g * 2] + contributions[g * 2 + 1],
      score: Math.round((dims[g * 2].score! + dims[g * 2 + 1].score!) / 2),
      dimensions: [dims[g * 2], dims[g * 2 + 1]].map((d) => ({ key: d.key, score: d.score, weight: d.weight, contribution: d.contribution, state: d.state })),
    })),
    assessment: {
      entryId: "entry-fixture", evidenceAsOf: "2026-10-09", createdAt: "2026-10-09T10:00:00Z", versions: { methodology: null, evaluator: null, params: null },
      score, readState: "assessed_partial", overall: { level, explanation: null }, confidenceBand: null, summary: null, hasReasons: false,
      dimensions: dims, evidence: [], notes: { strengths: [], constraints: [], missingEvidence: [], evaluationRisks: [] },
    },
    preliminary, label: preliminary ? "Preliminary — connect to sharpen" : null,
    confidence: { level, explanation: null }, inputs: { public: [], measured: [] }, sharpen,
    evidenceAsOf: "2026-10-09", identity: { uncertain: false, factIds: [] }, provenance: null,
  };
}

const SHARPEN_SOCIAL: MiaSharpenStep[] = [
  { kind: "connect", connector: "instagram", service: "Instagram", reason: "measured_audience" },
  { kind: "evidence", connector: null, text: "Results from this season would firm up Performance." },
];

/** The reveal's centrepiece (`mia-preview/1`): a preliminary score of 850 with its eight bands (example values). */
export const MIA_PREVIEW_CARD: CardOf<"mia-preview"> = {
  id: "mia-1", kind: "mia-preview", title: "Your M.I.A. — preliminary", links: [], runId: null,
  payload: {
    preview: miaPreviewFixture(540, [9, 6, 4, 8, 10, 7, 12, 8], "LOW", SHARPEN_SOCIAL),
    note: "Preliminary: built from public information. It firms up as you confirm facts and connect your accounts.",
  },
};

export const POSITIONING_CARD: CardOf<"positioning"> = {
  id: "pos-1", kind: "positioning", title: "How I'd position you", links: [], runId: "run-fixture-1",
  payload: {
    from: "A rising name in [Sport]",
    to: "The athlete brands trust with their community",
    statement: "Proof on the field, purpose off it, and an audience that shows up for both.",
    pillars: [
      { title: "Performance", line: "Results and recognition you can point to." },
      { title: "Community", line: "The work people already link to you." },
      { title: "Access", line: "A real, reachable audience, not just a big one." },
    ],
    how: HOW_FIXTURE,
  },
};

export const PARTNERS_CARD: CardOf<"partners"> = {
  id: "partners-1", kind: "partners", title: "Partners that fit", links: [], runId: "run-fixture-1",
  payload: {
    categories: [
      { category: "[Category A]", why: "Your audience matches who they sell to.", brands: [{ name: "[Brand A]", domain: null, logoUrl: null }, { name: "[Brand B]", domain: null, logoUrl: null }] },
      { category: "[Category B]", why: "They back athletes with a community story.", brands: [{ name: "[Brand C]", domain: null, logoUrl: null }] },
      { category: "Local businesses", why: "Quick first deals that build your record.", brands: [] },
    ],
    how: HOW_FIXTURE,
  },
};

export const PLAY_CARD: CardOf<"play"> = {
  id: "play-1", kind: "play", title: "The play", links: [], runId: "run-fixture-1",
  payload: {
    move: "Pitch one [Category A] brand around [Event A]",
    whyNow: "It's six weeks out: the window brands plan in.",
    steps: ["I build a deck from what you've confirmed", "You choose the brand", "I draft the note; you send it"],
    startPrompt: "Let's pitch a brand around my next big event.",
    how: HOW_FIXTURE,
  },
};

export const UNCONFIRMED_CARD: CardOf<"unconfirmed"> = {
  id: "unconf-1", kind: "unconfirmed", title: "What I couldn't confirm", links: [], runId: "run-fixture-1",
  payload: {
    items: [
      { what: "Your real reach and engagement", fix: { kind: "connect", connectorId: "instagram", service: "Instagram" } },
      { what: "Deals already in your inbox", fix: { kind: "connect", connectorId: "gmail", service: "your inbox" } },
      { what: "Which causes matter most to you", fix: { kind: "tell", prompt: "The causes that matter most to me are " } },
    ],
  },
};

export const INSIGHT_CARDS: Array<CardOf<"insight">> = [
  { id: "ins-1", kind: "insight", title: "", links: [], runId: "run-fixture-2", payload: { angle: "brand", text: "A competitor people root for: driven when it counts, generous when it doesn't.", factIds: ["f-3", "f-4"], sources: [S("[Publication A]", "feature")] } },
  { id: "ins-2", kind: "insight", title: "", links: [], runId: "run-fixture-2", payload: { angle: "strength", text: "Steady coverage brands can point to, without you having to ask for it.", factIds: ["f-3"], sources: [S("[Publication A]", "news")] } },
  { id: "ins-3", kind: "insight", title: "", links: [], runId: "run-fixture-2", payload: { angle: "gap", text: "Your community work isn't on your profile yet, so brands can't see it.", factIds: ["f-4"], sources: [] } },
  { id: "ins-4", kind: "insight", title: "", links: [], runId: "run-fixture-2", payload: { angle: "timing", text: "[Event A] is eight weeks out; brands lock in event partners about six weeks ahead.", factIds: ["f-5"], sources: [S("[Organization A] schedule", "schedule")] } },
];

const fact = (factId: string, claim: string, type: FactType, sources: CardSource[], date: string | null = null, status: "active" | "disputed" = "active") =>
  ({ factId, claim, type, date, status, sensitivity: "none" as const, sources });

export const FACT_GROUPS: Array<CardOf<"fact-review">> = [
  {
    id: "fr-1", kind: "fact-review", title: "About you", links: [], runId: "run-fixture-1",
    payload: {
      buttons: ["confirm", "correct", "remove"],
      facts: [
        fact("f-10", "You compete in [Sport] for [Team A]", "found", [S("[Team A] roster", "roster")], "2026"),
        fact("f-11", "You're from [Hometown A]", "found", [S("[Publication A]", "profile-story")], null, "disputed"),
        fact("f-12", "You study [Field A]", "found", [S("[School A] bio", "bio")]),
      ],
    },
  },
  {
    id: "fr-2", kind: "fact-review", title: "Your audience", links: [], runId: "run-fixture-1",
    payload: {
      buttons: ["confirm", "correct", "remove"],
      facts: [
        fact("f-30", "40–50K followers on [Platform A]", "found", [S("[Platform A] profile", "profile")], "Sep 2026"),
        fact("f-31", "Your community work is part of your story", "made", [{ label: "Nomila" }]),
      ],
    },
  },
];

export const PROPOSAL_CARDS: Array<CardOf<"goal-proposal">> = [
  {
    id: "gp-1", kind: "goal-proposal", title: "Proposed goal", links: [], runId: "run-fixture-4",
    payload: {
      decisionId: "dec-1", goal: "Land your first paid partnership this season", horizon: "next",
      why: "You have the audience and the coverage brands ask for; what's missing is a pitch.",
      value: "A first deal, and the record that makes the next one easier",
      nextDecision: "Which kind of brand to start with",
      factIds: ["f-1", "f-3"], sources: [S("[Platform A] profile", "profile")], buttons: ["accept", "edit", "skip"],
    },
  },
  {
    id: "gp-2", kind: "goal-proposal", title: "Proposed goal", links: [], runId: "run-fixture-4",
    payload: {
      decisionId: "dec-2", goal: "Grow your audience on [Platform B]", horizon: "now",
      why: "Your clips already travel on [Platform A]; [Platform B] has the same kind of viewers and you post there least.",
      value: "More reach for every deal you pitch",
      nextDecision: "How often you want to post",
      factIds: ["f-1"], sources: [], buttons: ["accept", "edit", "skip"],
    },
  },
  {
    id: "gp-3", kind: "goal-proposal", title: "Proposed goal", links: [], runId: "run-fixture-4",
    payload: {
      decisionId: "dec-3", goal: "Make your community work part of your public story", horizon: "later",
      why: "It's the thing people already link to you, and it isn't on your profile yet.",
      value: "A reason for the right brands to choose you",
      nextDecision: "Which part of it you want to show",
      factIds: ["f-4"], sources: [], buttons: ["accept", "edit", "skip"],
    },
  },
];

const cap = (id: string, label: string, pitch: string, available = true, screen: string | null = null): CardOf<"capability"> => ({
  id: `cap-${id}`, kind: "capability", title: label, links: [], runId: null,
  payload: { capability: { id, label, skillId: available ? `${id}/start` : null, workflow: null, screen, available }, pitch },
});

export const CAPABILITY_CARDS: Array<CardOf<"capability">> = [
  cap("deals", "Deals", "Find offers in your inbox, weigh them and draft replies."),
  cap("pitch_decks", "Pitch decks", "A deck for any brand you want to work with."),
  cap("content", "Content", "Post ideas and kits made from your own clips."),
  cap("public_card", "Public card", "Your page for brands, fans and organizations.", true, "me"),
  cap("bookings", "Bookings", "Paid appearances, sessions and calls.", false),
  cap("shop", "Shop", "Products you love, with your link.", false),
];

export const CONSENT_CARD: CardOf<"consent"> = {
  id: "consent-1", kind: "consent", title: "How I work for you", links: [], runId: null,
  payload: {
    consentId: "how_mila_works/1",
    title: "How I work for you",
    points: ["I only use what you share and what's public", "Nothing goes out in your name without your tap", "You can see how I got anything, and correct it"],
    buttons: ["agree", "not_now"],
  },
};

export const AGE_BAND_CARD: CardOf<"age-band"> = {
  id: "age-1", kind: "age-band", title: "", links: [], runId: null,
  payload: { question: "Are you under 18? Optional, and it only helps me explain partner rules.", options: [{ value: "under_18", label: "Under 18" }, { value: "18_plus", label: "18 or over" }] },
};

// ─── Goals and Studio ───────────────────────────────────────────────────────────────────────────────────────────

export const GOALS_FIXTURE: AgentGoal[] = [
  {
    id: "g-1", text: "Land my first paid partnership this season", plan: "Shortlist brands that fit, send one strong pitch a week, and follow up on every open.", horizon: "This season",
    actions: [
      { id: "a-1", title: "Pitch deck for [Brand A]", kind: "deck", when: "Ready", state: "made", studioItemId: "studio-deck-1", open: { screen: "PitchDetail", params: { brandId: 1, brandName: "[Brand A]" } }, startPrompt: null },
      { id: "a-2", title: "Shortlist 5 brands that fit", kind: "task", when: "This week", state: "to_start", studioItemId: null, open: null, startPrompt: "Shortlist 5 brands that fit me." },
      { id: "a-3", title: "Follow up with [Brand B]", kind: "reply", when: "Done Mon", state: "done", studioItemId: null, open: null, startPrompt: null },
    ],
  },
  {
    id: "g-2", text: "Grow my audience on [Platform B]", plan: "Two posts a week from clips you already have.", horizon: "Next 3 months",
    actions: [
      { id: "a-4", title: "Post kit · [Hook A]", kind: "post_kit", when: "Post Thu", state: "made", studioItemId: "studio-postkit-1", open: { screen: "post-kit", params: { id: "studio-postkit-1" } }, startPrompt: null },
      { id: "a-5", title: "Plan next week's posts", kind: "post_kit", when: "By Sun", state: "to_start", studioItemId: null, open: null, startPrompt: "Plan next week's posts." },
    ],
  },
  { id: "g-3", text: "Make my community work part of my public story", plan: null, horizon: null, actions: [] },
];

export const STUDIO_FIXTURE: StudioItem[] = [
  { id: "studio-deck-1", kind: "deck", title: "[Brand A]", status: "draft", version: 2, goal: { id: "g-1", text: "Land my first paid partnership this season" }, thumbUrl: null, updatedAt: "2026-10-08T10:00:00Z", meta: null, open: { screen: "PitchDetail", params: { brandId: 1, brandName: "[Brand A]" } } },
  { id: "studio-page-1", kind: "page", title: "Your public card", status: "published", version: 3, goal: { id: "g-3", text: "Make my community work part of my public story" }, thumbUrl: null, updatedAt: "2026-10-07T10:00:00Z", meta: "41 views", open: { url: "https://example.org/card" } },
  { id: "studio-postkit-1", kind: "post_kit", title: "[Hook A]", status: "approved", version: 1, goal: { id: "g-2", text: "Grow my audience on [Platform B]" }, thumbUrl: null, updatedAt: "2026-10-06T10:00:00Z", meta: "Post Thu", open: { screen: "post-kit", params: { id: "studio-postkit-1" } } },
  { id: "studio-visual-1", kind: "media_edit", title: "Background change", status: "experimental", version: 1, goal: null, thumbUrl: null, updatedAt: "2026-10-05T10:00:00Z", meta: null, open: null },
  { id: "studio-deck-2", kind: "deck", title: "[Brand B]", status: "published", version: 1, goal: { id: "g-1", text: "Land my first paid partnership this season" }, thumbUrl: null, updatedAt: "2026-10-01T10:00:00Z", meta: "Opened 3 times", open: { screen: "PitchDetail", params: { brandId: 2, brandName: "[Brand B]" } } },
];

/**
 * A built post kit (decisionId "studio-postkit-1", matching STUDIO_FIXTURE and GOALS_FIXTURE's a-4) — one clip with a
 * clip range, one photo on the shortlist, so the screen's swap and inline-clip-playback states have something real to
 * exercise. `preview` null (no render asked for: AGENT_POST_KIT_RENDER off) — the screens draw the chosen asset's own
 * media, per design "Moments → post kits" §9/§12.
 */
export const POST_KIT_FIXTURE: PostKitResponse = {
  contract: "post-kit/1",
  decisionId: "studio-postkit-1",
  state: "made",
  kit: {
    contract: "post-kit/1",
    momentDecisionId: null,
    idea: { hook: "[Hook A] — three weeks out from [Event A].", format: "reel", platform: "instagram", timing: "This week" },
    formatFromMoment: false,
    brief: { show: "A normal Tuesday: the parts nobody posts.", captionAngle: "The work behind the result.", avoid: "Nothing staged." },
    assets: [
      { assetId: "asset-clip-1", mediaType: "clip", clip: { startSec: 4, endSec: 9, from: "beat" }, durationSec: 20, provenance: "camera" },
    ],
    shortlist: ["asset-photo-1"],
    caption: { text: "Three weeks out from [Event A] — here's what a normal Tuesday looks like. #process #[Sport]", hashtags: ["#process", "#[Sport]"], edited: false },
    treatmentPlan: {
      aspect: "9:16", cropToFill: true, order: ["asset-clip-1"], trims: [{ assetId: "asset-clip-1", startSec: 4, endSec: 9 }], stills: [],
      overlayText: "The work nobody sees.", lookPreset: "natural", musicMood: "warm", coverFrame: { assetId: "asset-clip-1", atSec: 5 }, totalSec: 5,
    },
    aiGenerationNeeded: { value: false, reason: "Built from your own photos and clips." },
    match: { runId: "run-fixture-match", skillVersion: "post-kit/match/0.1.0", candidates: 6, costMicroUsd: 1800, noneFitNote: null },
    builtAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z",
  },
  media: [
    { assetId: "asset-clip-1", mediaType: "clip", thumbUrl: "https://example.org/media/clip-1-poster.jpg", videoUrl: "https://example.org/media/clip-1.mp4", available: true, inKit: true },
    { assetId: "asset-photo-1", mediaType: "photo", thumbUrl: "https://example.org/media/photo-1.jpg", videoUrl: null, available: true, inKit: false },
  ],
  goal: { id: "g-2", text: "Grow my audience on [Platform B]" },
  moment: { name: "[Event A]", whyNow: "Three weeks out and nothing posted about it yet." },
  why: "A normal training day, told plainly, is her best-performing format.",
  preview: null,
};

/** The stored render (PostKit.preview) for a fixture, in a status; `outputs` only when ready. */
function storedPreview(status: "queued" | "ready" | "failed", outputs: NonNullable<PostKit["preview"]>["outputs"] = []): NonNullable<PostKit["preview"]> {
  return {
    contract: "post-kit-render/1", key: `fixture-${status}`, status, jobId: status === "ready" ? null : "fixture-job", outputs,
    coverAssetId: outputs[0]?.assetId ?? null, notes: [], error: status === "failed" ? "The preview couldn't be made." : null,
    // A queued one was asked for just now (it is read on the client's clock: past PREVIEW_STALL_MS it reads as failed).
    requestedAt: status === "queued" ? new Date().toISOString() : "2026-10-06T10:00:05.000Z",
    renderedAt: status === "ready" ? "2026-10-06T10:01:00.000Z" : null,
  };
}

/**
 * A kit's preview, asked for and not ready: being made ("queued", asked for at the moment this is called) or it failed.
 * The raw media shows meanwhile.
 */
export function postKitPreviewAs(base: PostKitResponse, status: "queued" | "failed"): PostKitResponse {
  return {
    ...base,
    kit: base.kit ? { ...base.kit, preview: storedPreview(status) } : null,
    preview: { status, previewUrl: null, items: [], coverUrl: null, notes: [], error: status === "failed" ? "The preview couldn't be made." : null },
  };
}

/** POST_KIT_FIXTURE (a reel) with its preview ready: one rendered video, its cover frame the poster. */
export const POST_KIT_PREVIEW_READY: PostKitResponse = {
  ...POST_KIT_FIXTURE,
  kit: { ...POST_KIT_FIXTURE.kit!, preview: storedPreview("ready", [{ assetId: "render-reel-1", kind: "video", sourceAssetId: "asset-clip-1" }]) },
  preview: {
    status: "ready", previewUrl: "https://example.org/media/render-reel-1.mp4",
    items: [{ kind: "video", url: "https://example.org/media/render-reel-1.mp4" }],
    coverUrl: "https://example.org/media/render-reel-1-cover.jpg", notes: [], error: null,
  },
};

/**
 * POST_KIT_PREVIEW_READY with three suggested tracks (AGENT_POST_KIT_MUSIC_CHOICES): the first in use, one owing a
 * credit (CC BY), one with no listening link yet. Placeholder titles, not real catalogue entries.
 */
const MUSIC_CHOICES = [
  { trackId: "track-a", title: "[Track A]", artist: "[Artist A]", reason: "warm, reflective · low energy · 84 BPM · 2:57", licence: "CC0-1.0", credit: null },
  { trackId: "track-b", title: "[Track B]", artist: "[Artist B]", reason: "warm · mid energy · 100 BPM · 4:00, loops", licence: "CC-BY-4.0", credit: "\"[Track B]\" by [Artist B], licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)", creditShort: "\"[Track B]\" by [Artist B], CC BY 4.0", contentIdRegistered: true },
  { trackId: "track-c", title: "[Track C]", artist: "[Artist C]", reason: "warm, bright · mid energy · 120 BPM · 3:12", licence: "CC0-1.0", credit: null },
];
export const POST_KIT_MUSIC_READY: PostKitResponse = {
  ...POST_KIT_PREVIEW_READY,
  kit: { ...POST_KIT_PREVIEW_READY.kit!, music: { choices: MUSIC_CHOICES, selected: "track-a" } },
  music: {
    choices: MUSIC_CHOICES.map((c, i) => ({ ...c, selected: i === 0, allowed: true, listenUrl: i === 2 ? null : `https://example.org/media/${c.trackId}.m4a` })),
  },
};

/** A carousel (a photo, then a clip) with its preview ready: one rendered picture, then a short rendered video slide. */
export const POST_KIT_CAROUSEL_READY: PostKitResponse = {
  ...POST_KIT_FIXTURE,
  kit: {
    ...POST_KIT_FIXTURE.kit!,
    idea: { ...POST_KIT_FIXTURE.kit!.idea, format: "carousel" },
    assets: [
      { assetId: "asset-photo-1", mediaType: "photo", clip: null, durationSec: null, provenance: "camera" },
      POST_KIT_FIXTURE.kit!.assets[0],
    ],
    shortlist: [],
    treatmentPlan: { ...POST_KIT_FIXTURE.kit!.treatmentPlan, aspect: "4:5", order: ["asset-photo-1", "asset-clip-1"], totalSec: null, coverFrame: { assetId: "asset-photo-1", atSec: null } },
    preview: storedPreview("ready", [
      { assetId: "render-slide-1", kind: "image", sourceAssetId: "asset-photo-1" },
      { assetId: "render-slide-2", kind: "video", sourceAssetId: "asset-clip-1" },
    ]),
  },
  media: POST_KIT_FIXTURE.media.map((m) => ({ ...m, inKit: true })),
  preview: {
    status: "ready", previewUrl: "https://example.org/media/render-slide-1.jpg",
    items: [{ kind: "image", url: "https://example.org/media/render-slide-1.jpg" }, { kind: "video", url: "https://example.org/media/render-slide-2.mp4" }],
    coverUrl: "https://example.org/media/render-slide-1.jpg", notes: [], error: null,
  },
};

export const AGENCY_CARDS: AnyChatCard[] = [
  MIA_PREVIEW_CARD, REVEAL_CARD, POSITIONING_CARD, PARTNERS_CARD, PLAY_CARD, UNCONFIRMED_CARD,
];

export const ALL_CARD_FIXTURES: AnyChatCard[] = [
  ...CHAT_CARDS,
  ACTION_CARD_PAYMENT, PROGRESS_DONE, PROGRESS_FAILED, READY_EXPERIMENTAL,
  ...AGENCY_CARDS, ...INSIGHT_CARDS, ...FACT_GROUPS, ...PROPOSAL_CARDS, ...CAPABILITY_CARDS, CONSENT_CARD, AGE_BAND_CARD,
];

// ─── Personas: the UI must read right from youth to pro ─────────────────────────────────────────────────────────
// Made-up athletes in mixed sports, for the gallery and tests only. Small numbers are drawn exactly like big ones.

export interface Persona {
  key: "youth" | "college" | "pro";
  name: string;
  sport: string;
  ageBand: AgeBand | null;
  play: CardOf<"play">;
  action: CardOf<"action">;
}

const play = (id: string, move: string, whyNow: string, steps: string[]): CardOf<"play"> => ({ ...PLAY_CARD, id, payload: { ...PLAY_CARD.payload, move, whyNow, steps } });

export const PERSONAS: Record<Persona["key"], Persona> = {
  youth: {
    key: "youth", name: "Rio Tester", sport: "Swimming", ageBand: "under_18",
    play: play("play-youth", "Share one clip from every meet", "Your season is starting, and people who follow you want to see it.", ["Pick a clip after each meet", "I write a short caption with you", "You post it when you're ready"]),
    action: {
      ...ACTION_CARD, id: "action-youth", title: "Say yes to [Local business]",
      payload: { approvalId: "appr-youth", verb: "deal_response", body: "Thank you! I'd love to do one post about your shop in exchange for the swim gear.", money: { amountMinor: 5000, currency: "usd" }, buttons: ["approve", "edit", "decline"] },
    },
  },
  college: {
    key: "college", name: "Jordan Demo", sport: "Volleyball", ageBand: "18_plus",
    play: PLAY_CARD,
    action: ACTION_CARD,
  },
  pro: {
    key: "pro", name: "Sam Example", sport: "Track and field", ageBand: "18_plus",
    play: play("play-pro", "Renew your strongest partner before [Event A], on longer terms", "They plan next year's budget this quarter.", ["I pull what you delivered for them", "I draft the renewal case", "You review and send"]),
    action: {
      ...ACTION_CARD, id: "action-pro", title: "Counter [Brand C]",
      payload: { approvalId: "appr-pro", verb: "deal_response", body: "Thanks for the offer. For a 12-month category exclusive across 6 posts, my rate is [amount]. Open to a call this week.", money: { amountMinor: 5000000, currency: "usd" }, buttons: ["approve", "edit", "decline"] },
    },
  },
};

export const CONNECT_YOUTH: CardOf<"connect"> = {
  ...CONNECT_CARD, id: "connect-youth", title: "Connect Instagram?",
  payload: { connectorId: "instagram", service: "Instagram", why: "So I can see your real audience and help you grow it.", access: ["Your profile, posts and their insights", "Nothing is posted without your tap"] },
};

/** The Mila chat with the harness's cards inline (the gallery's chat page). */
export const CHAT_TRANSCRIPT: AgentOnboardingState = {
  status: "active", everStarted: true, working: null, suggestions: ["Why that rate?", "Make it shorter"], canFinish: false, optional: false,
  checkpoints: [],
  turns: [
    { id: "c1", role: "athlete", text: "Can you help me answer the request from [Brand A]?", cards: [] },
    { id: "c2", role: "mila", text: "They want 3 posts over a month. Based on your rates and what they usually pay, I'd counter at the rate below.", cards: [ACTION_CARD] },
    { id: "c3", role: "athlete", text: "How's my page coming along?", cards: [] },
    { id: "c4", role: "mila", text: "It's halfway there. And the post kits you asked for are ready to review.", cards: [PROGRESS_CARD, READY_CARD] },
    { id: "c5", role: "mila", text: "If you connect your calendar, I can plan around your schedule.", cards: [CONNECT_CARD] },
    { id: "c6", role: "athlete", text: "Why that rate?", cards: [] },
    { id: "c7", role: "mila", text: "Here's what I used.", cards: [HOW_CARD] },
  ],
};

/** A partner rule explained, not enforced: a payout setup where the payment provider's rules for minors apply. */
export const PAYOUT_NOTE_CARD: CardOf<"action"> = {
  id: "action-payout", kind: "action", title: "Set up your payouts", links: [], runId: null,
  payload: {
    approvalId: "appr-payout", verb: "other_act", body: null, money: null, buttons: ["approve", "decline"],
    partnerNote: "Our payment partner asks for a parent or guardian on payout accounts for athletes under 18. I'll walk you both through it.",
  } as ActionPayloadWithNote,
};

// ─── The approved reveal, per persona (#891 shapes): live research → ONE reveal moment → rates → goals ──────────
// Example values only. `frac` places a research event in the run (0–1) so the fixture API can play it live.

export interface PersonaReveal {
  /** The research run's events with their place in the run. */
  activity: Array<{ frac: number; event: ResearchEvent }>;
  /** Mila's quick question while the athlete waits. */
  quick: CardOf<"quick-question">;
  mia: CardOf<"mia-preview">;
  reveal: CardOf<"reveal">;
  rates: CardOf<"rate-ranges">;
  proposals: Array<CardOf<"goal-proposal">>;
}

const ex = (path: string) => `https://example.org/${path}`;
const at = (frac: number) => new Date(Date.UTC(2026, 9, 9, 10, 0, Math.round(frac * 60))).toISOString();
const mia = (id: string, score: number, contributions: number[], level: "HIGH" | "MEDIUM" | "LOW", sharpen: MiaSharpenStep[] = SHARPEN_SOCIAL): CardOf<"mia-preview"> => ({
  ...MIA_PREVIEW_CARD, id, payload: { ...MIA_PREVIEW_CARD.payload, preview: miaPreviewFixture(score, contributions, level, sharpen) },
});
type Line = [text: string, label: string, path: string];
const lines = (xs: Line[]) => xs.map(([text, label, path], i) => ({ text, factIds: [`${path}-${i}`], sources: [{ label, url: ex(path) }] }));
const reveal = (id: string, headline: string, highlights: Line[], standing: Line, windows: Line[]): CardOf<"reveal"> => ({
  id, kind: "reveal", title: "Here's what I found", links: [], runId: "run-fixture-1",
  payload: { headline, highlights: lines(highlights), standing: lines([standing])[0], windows: lines(windows) },
});
const rates = (id: string, items: RateRangesCardPayload["items"], sharpenConnectors: string[] = ["instagram", "tiktok"]): CardOf<"rate-ranges"> => ({
  id, kind: "rate-ranges", title: "Early rate ranges", links: [], runId: "run-fixture-2",
  payload: { items, confidence: "low", sharpenWithConnect: true, sharpenConnectors, note: "Estimates from public information only, so they are wide. They sharpen when you connect your accounts.", factIds: [] },
});
const goal = (decisionId: string, text: string, horizon: GoalHorizon, why: string, value: string, nextDecision: string): CardOf<"goal-proposal"> => ({
  id: `gp-${decisionId}`, kind: "goal-proposal", title: "Proposed goal", links: [], runId: "run-fixture-4",
  payload: { decisionId, goal: text, horizon, why, value, valueConfidence: "low", nextDecision, factIds: [], sources: [], buttons: ["accept", "edit", "skip"] },
});
const quick = (id: string, question: string, options: string[], why: string): CardOf<"quick-question"> => ({
  id, kind: "quick-question", title: "Quick question", links: [], runId: null, payload: { question, options, why },
});
const ev = {
  read: (frac: number, pass: "a" | "b", domain: string, title?: string) => ({ frac, event: { kind: "reading" as const, at: at(frac), pass, domain, url: `https://${domain}/`, ...(title ? { title } : {}) } }),
  found: (frac: number, pass: "a" | "b", text: string, domain: string, title?: string) => ({ frac, event: { kind: "discovery" as const, at: at(frac), pass, text, source: { domain, url: `https://${domain}/`, ...(title ? { title } : {}) } } }),
  done: (frac: number, pass: "a" | "b", facts: number) => ({ frac, event: { kind: "pass_done" as const, at: at(frac), pass, facts } }),
};

export const REVEAL_BY_PERSONA: Record<"youth" | "college" | "pro", PersonaReveal> = {
  youth: {
    activity: [
      ev.read(0.05, "a", "example-club.org", "[Club] results"),
      ev.found(0.18, "a", "Club record in [Event], [year]", "example-club.org", "[Club] results"),
      ev.read(0.3, "b", "example-local-news.com", "[Local paper]"),
      ev.found(0.42, "b", "Featured in [Local paper], [year]", "example-local-news.com", "[Local paper]"),
      ev.read(0.62, "b", "example-social.com", "[Platform A] profile"),
      ev.found(0.75, "b", "300–400 followers on [Platform A]", "example-social.com", "[Platform A] profile"),
      ev.done(0.8, "a", 6),
    ],
    quick: quick("qq-youth", "What do you enjoy most about your sport?", ["Racing", "Training with my team", "Getting better"], "It helps me tell your story your way."),
    mia: mia("mia-youth", 260, [3, 5, 1, 3, 6, 3, 7, 5], "LOW", [{ kind: "connect", connector: "instagram", service: "Instagram", reason: "measured_audience" }]),
    reveal: reveal("rev-youth", "You're early, and that's your advantage.", [
      ["A club record in [Event] this year", "[Club] results", "club"],
      ["Featured in [Local paper] for your season", "[Local paper]", "paper"],
      ["A small, real following that watches what you post", "[Platform A] profile", "profile"],
    ], ["Early in your career, with results that are getting noticed locally.", "[Club] results", "club"], [
      ["Your season opener is this month: people who follow you want to see it.", "[Club] schedule", "schedule"],
      ["[Championship A] is in two months.", "[Club] schedule", "schedule"],
    ]),
    rates: rates("rates-youth", [
      { deliverable: "One post", low: 25, high: 150, currency: "USD", drivers: ["local reach", "how engaged your followers are"] },
      { deliverable: "An appearance at a local event", low: 50, high: 300, currency: "USD", drivers: ["travel", "the event's size"] },
    ]),
    proposals: [
      goal("dec-y1", "Share a clip from every meet this season", "now", "Your season is starting and people who follow you want to see it.", "A following that grows with your results", "Which meets to start with"),
      goal("dec-y2", "Build a highlight reel by the end of the season", "next", "It's the thing coaches, clubs and local brands ask for first.", "One link that shows who you are", "Which clips you're proudest of"),
    ],
  },
  college: {
    activity: [
      ev.read(0.06, "a", "example-athletics.edu", "[School A] roster"),
      ev.found(0.16, "a", "Named to [Award A], [year]", "example-awards.org", "[Organization A]"),
      ev.read(0.26, "a", "example-news.com", "[Publication A]"),
      ev.found(0.36, "a", "5–8 news stories this season", "example-news.com", "[Publication A]"),
      ev.read(0.6, "b", "example-social.com", "[Platform A] profile"),
      ev.done(0.66, "a", 9),
      ev.found(0.72, "b", "40–50K followers on [Platform A]", "example-social.com", "[Platform A] profile"),
      ev.read(0.84, "b", "example-stats.com"),
    ],
    quick: quick("qq-college", "Is there a cause or community you care about?", ["Yes, I'll tell you", "Not right now"], "Brands look for athletes who stand for something."),
    mia: MIA_PREVIEW_CARD,
    reveal: REVEAL_CARD,
    rates: rates("rates-college", [
      { deliverable: "One feed post", low: 200, high: 1200, currency: "USD", drivers: ["audience size", "engagement", "your sport's season"] },
      { deliverable: "An appearance", low: 300, high: 2000, currency: "USD", drivers: ["travel", "your profile on campus"] },
    ]),
    proposals: PROPOSAL_CARDS,
  },
  pro: {
    activity: [
      ev.read(0.05, "a", "example-federation.org", "[Federation] profile"),
      ev.found(0.14, "a", "[Title A] winner, [year]", "example-federation.org", "[Federation]"),
      ev.read(0.22, "a", "example-news.com"),
      ev.found(0.3, "a", "40+ news stories this season", "example-news.com", "News search"),
      ev.found(0.38, "b", "3 current partners", "example-partners.com", "Partner announcements"),
      ev.read(0.58, "b", "example-social.com"),
      ev.found(0.7, "b", "1.5–2M followers across platforms", "example-social.com", "Public profiles"),
      ev.done(0.74, "a", 14),
    ],
    quick: quick("qq-pro", "Any partner you'd like to grow, or move on from?", ["Grow one", "Move on from one", "Not now"], "So I start where it matters to you."),
    mia: mia("mia-pro", 742, [14, 9, 13, 10, 11, 9, 15, 8], "MEDIUM", [{ kind: "evidence", connector: null, text: "Current partner terms would firm up Commercial." }]),
    reveal: reveal("rev-pro", "You're a proven name. The next step is owning a category.", [
      ["[Title A] winner, [year]", "[Federation]", "results"],
      ["Three current partners, two renewed", "Partner announcements", "partners"],
      ["40+ news stories this season", "News search", "news"],
      ["1.5–2M followers across platforms", "Public profiles", "profiles"],
    ], ["At the top of your sport, with partners who renew.", "[Federation]", "results"], [
      ["Partner budgets for next year are set this quarter.", "Partner announcements", "partners"],
      ["[Event A], your biggest stage this year, is in two months.", "[Federation] calendar", "calendar"],
    ]),
    rates: rates("rates-pro", [
      { deliverable: "One feed post", low: 15000, high: 50000, currency: "USD", drivers: ["reach", "category exclusivity", "usage rights"] },
      { deliverable: "Category partnership (12 months)", low: 150000, high: 600000, currency: "USD", drivers: ["exclusivity", "deliverables", "your results this year"] },
    ], []),
    proposals: [
      goal("dec-p1", "Own one category with a long-term partner", "next", "Your partners renew because you deliver; depth now beats more logos.", "Fewer, bigger, steadier partnerships", "Which category matters most to you"),
      goal("dec-p2", "Renew your strongest partner before [Event A]", "now", "Budgets for next year are set this quarter.", "A longer term, on better terms", "What you'd change in the current deal"),
    ],
  },
};

/** A delicate fact (sensitivity "care"): shown plainly in the review, never leading the reveal. */
export const FACT_GROUP_CARE: CardOf<"fact-review"> = {
  id: "fr-care", kind: "fact-review", title: "Also found", links: [], runId: "run-fixture-1",
  payload: {
    buttons: ["confirm", "correct", "remove"],
    facts: [{ factId: "f-care", claim: "Out for part of last season with an injury", type: "found", date: null, status: "active", sources: [{ label: "[Publication A]", url: ex("feature") }], sensitivity: "care" }],
  },
};

/** The live research card, mid-run (built through the same adapter as the app). */
export const ACTIVITY_CARD = activityCard("run-fixture-1", REVEAL_BY_PERSONA.college.activity.map((a) => a.event), "running");
ALL_CARD_FIXTURES.push(ACTIVITY_CARD, REVEAL_BY_PERSONA.college.rates, REVEAL_BY_PERSONA.college.quick, FACT_GROUP_CARE);
