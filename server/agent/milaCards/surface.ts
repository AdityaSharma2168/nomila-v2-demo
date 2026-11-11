/**
 * agent/milaCards/surface.ts — the v2 cards on the app's own screens (design v2.2 "Home: the briefing, not a new shelf";
 * decision 16 "What Mila can do" in Me). GET /api/v1/me/mila/cards/surface answers:
 *
 *   briefing      ≤ 3 cards for Home v3's briefing, collapsed (Insight, Idea, Turn-on only; Questions and Answers stay
 *                 in their chat): the newest live idea set first (its tall form leads), then the newest Insight shown
 *                 and not yet answered within 7 days, then a pending chat offer the registry would still make (offerFor).
 *                 At most one athlete face across them.
 *   capabilities  always empty (5 Nov 2026). Me › What Mila can do reads GET /api/v1/me/mila/capabilities instead
 *                 (routes/milaChoices.ts): every built switch with its state and sheet, turned on, paused or off
 *                 through that route. Kept in the answer for app builds that still read it.
 *
 * The idea set runs through the shared per-call path (agent/callTool.ts) as a skill "home" that lists only
 * ideas_suggest, so it gets the same fence, flag and enablement checks as any of Mila's calls.
 *
 * The stored card is the one the producer built (detail.card); a stored atmosphere picture is picked and signed again
 * (freshMedia: its URL is short-lived), and a picture that still fails draws the card's fallback on the phone.
 */
import type { Decision } from "../../../shared/agent";
import { MAX_FACES_PER_SCREEN, checkMilaCardDto, toMilaCardDto, type CardMedia, type MilaCardDto } from "../../../shared/milaCards";
import type { AgentStore } from "../research/store";
import { milaWelcomeEnabled } from "../welcome/config";
import { offerFor } from "../welcome/turnOn";
import type { Choice } from "../welcome/choices";
import { presentation } from "./capabilities";
import { CARD_SKILLS, MILA_CARDS } from "./config";
import { atmosphereMedia, budgetFor, type CardMediaDeps } from "./media";
import { milaCardTools } from "./tools";
import { callTool } from "../callTool";

/** The Welcome registry's reads (tests pass fakes; the defaults read mila_choices). */
export interface SurfaceWelcome {
  enabled(): boolean;
  getChoice(athleteId: string, key: string): Promise<Pick<Choice, "state" | "version">>;
  offerable(athleteId: string, key: string, now: Date): Promise<boolean>;
}
const defaultWelcome: SurfaceWelcome = {
  enabled: milaWelcomeEnabled,
  getChoice: async (athleteId, key) => (await import("../welcome/choices")).getChoice(athleteId, key, null),
  offerable: async (athleteId, key, now) => (await offerFor(athleteId, key, null, now)).ok,
};

export interface SurfaceDeps {
  media: CardMediaDeps;
  now?: () => Date;
  welcome?: SurfaceWelcome;
  /** The deletion fence callTool checks (default lib/privacy/deletionFence.ts isAthleteDeleting). */
  isDeleting?: (athleteId: string) => Promise<boolean>;
}

/** The surface's one tool call: a read-only skill of its own, so the policy's skill_toolset check holds. */
const HOME_SKILL = { id: "home", tools: ["ideas_suggest"] } as const;

const fresh = (d: Decision, now: number) => now - Date.parse(d.createdAt) < MILA_CARDS.ignoredAfterMs;

function asDto(kind: string, id: string, title: string, payload: unknown): MilaCardDto | null {
  const r = toMilaCardDto({ id, kind, title, links: [], payload });
  return r.ok ? r.dto : null;
}

/**
 * A stored card's picture, signed again: the URL the producer wrote expired an hour later (lib/mediaStore signedUrl), so
 * a stored atmosphere picture is picked again by the same slot key (the pick is stable per key) and signed now. A
 * chart, a logo or a brand cover (a public https URL) is drawn as stored.
 */
async function freshMedia(deps: SurfaceDeps, athleteId: string, card: Record<string, unknown>, key: string, query: string): Promise<Record<string, unknown>> {
  const m = card.media as CardMedia | undefined;
  if (!m || m.kind !== "atmosphere" || !m.url) return card;
  const media = await atmosphereMedia(deps.media, athleteId, budgetFor(undefined), { key, query }, m.alt);
  return { ...card, media };
}

export async function cardSurface(store: AgentStore, athleteId: string, deps: SurfaceDeps): Promise<{ briefing: MilaCardDto[]; capabilities: MilaCardDto[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const t = now.getTime();
  const briefing: MilaCardDto[] = [];

  // The idea set: the same producer the chat uses (live ideas only; care, paused pillars and resting ideas left out).
  const ideas = milaCardTools(store, { media: deps.media, now: () => now }).find((x) => x.name === "ideas_suggest")!;
  const call = await callTool({
    skill: { id: HOME_SKILL.id, tools: [...HOME_SKILL.tools] }, tool: ideas, name: ideas.name, args: {},
    ctx: { athleteId, runId: "", skillId: HOME_SKILL.id }, neverTerms: [], citing: false,
    queueApproval: async () => { throw new Error("the surface never queues"); },
    ...(deps.isDeleting ? { isDeleting: deps.isDeleting } : {}),
  }).catch(() => null);
  const r = call?.outcome === "ok" ? (call.result as { status?: string; _card?: unknown }) : null;
  if (r?.status === "ok" && r._card) { const d = asDto("ideas", `home-ideas:${now.toISOString().slice(0, 10)}`, "Ideas", r._card); if (d) briefing.push(d); }

  const insights = (await store.listDecisions(athleteId, { skillId: CARD_SKILLS.insight, responses: ["pending"] })).filter((d) => d.detail?.card && fresh(d, t));
  const lastInsight = insights[insights.length - 1];
  if (lastInsight) {
    const card = await freshMedia(deps, athleteId, lastInsight.detail?.card as Record<string, unknown>, `insight:${String(lastInsight.detail?.angle ?? "")}`, String(lastInsight.detail?.headline ?? ""));
    const d = asDto("insight", `insight:${lastInsight.id}`, "Insight", card);
    if (d) briefing.push(d);
  }

  const welcome = deps.welcome ?? defaultWelcome;
  const offers = (await store.listDecisions(athleteId, { skillId: CARD_SKILLS.turnOn, responses: ["pending"] })).filter((d) => d.detail?.card && d.detail?.via !== "me" && fresh(d, t));
  const lastOffer = offers[offers.length - 1];
  const offerKey = typeof lastOffer?.detail?.capability === "string" ? (lastOffer.detail.capability as string) : null;
  const cap = offerKey ? presentation(offerKey) : null;
  // A chat offer still pending here may since have been answered elsewhere (turned on in Me, said never): drawn only
  // while the registry would still make it.
  if (lastOffer && cap && (await welcome.offerable(athleteId, cap.key, now).catch(() => false))) {
    const card = await freshMedia(deps, athleteId, lastOffer.detail?.card as Record<string, unknown>, `turn-on:${cap.key}`, cap.scene);
    const d = asDto("turn-on", `turn-on:${lastOffer.id}`, "Mila can do more", card);
    if (d) briefing.push(d);
  }

  // One athlete face in the briefing at most (the circles above already show one).
  let faces = 0;
  const limited = briefing.slice(0, 3).map((d) => {
    if (d.type !== "ideas") return d;
    const items = d.data.fields.items.map((it) => {
      if (!it.media.hasFace) return it;
      faces += 1;
      return faces <= MAX_FACES_PER_SCREEN - 1 ? it : { ...it, media: { ...it.media, kind: "atmosphere" as const, url: null, mediaId: null, hasFace: false } };
    });
    return checkMilaCardDto({ type: "ideas", data: { ...d.data, fields: { items } } }) ?? d;
  });

  // Me › What Mila can do reads GET /api/v1/me/mila/capabilities (routes/milaChoices.ts: every built switch, on, paused
  // or off, with its sheet), and its taps go straight to that route. `capabilities` stays in this answer, empty, for
  // app builds that still read it here.
  return { briefing: limited, capabilities: [] };
}
