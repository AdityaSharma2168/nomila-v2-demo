/**
 * agent/milaCards/tools.ts — the tools that PRODUCE the card system v2's five new cards (MILA_CARDS_V2, dev only; design
 * "Mila card designs" v2.2 §Build plan). Each takes ids and a headline from the model, checks its display rule in code,
 * resolves the card's one image on the server (media.ts) and writes the decision row its taps record against:
 *
 *   share_insight        draft  Insight: angle, headline, line, F-keys (≥ 1 source, every figure traced to a cited fact,
 *                               not care, not the same angle or facts within 14 days)
 *   ideas_suggest        draft  Idea carousel: 1–5 live idea-bank ids (none: the freshest live ones); not care, pillar not
 *                               paused, not resting after Not now, at most one set per chat per day
 *   offer_capability     draft  Turn-on offer: a Welcome registry key with a card presentation (capabilities.ts); the
 *                               registry decides (welcome/turnOn.ts offerFor: optional, a switch, available, unset or
 *                               past its cooldown); at most one offer in 24 h; the consent words are the registry's
 *   ask_once             draft  One-time question (quick-question + once): key unanswered, at most two asks (the second
 *                               after 30 days), one per chat, no option that sends, posts or pays
 *   answer_with_sources  draft  Answer with sources: headline, line, more, sources (https), a brand by name
 *
 * "draft" = private to Nomila and reversible (the harness's level for the goal tools): nothing here leaves Nomila, and a
 * card's taps are the athlete's own (POST /api/v1/me/mila/cards/outcome). The descriptions are the page's words
 * (prompts.ts). Text budgets are the arguments' own (a 14-word headline is refused and Mila retries within budget), and
 * the card schemas check them again; no argument takes an image or a URL to one (the server picks every image).
 */
import { z } from "zod";
import { logNeedsALook, verifyDeliverable } from "../../services/verify/deliverable";
import { answerFromCard } from "../../services/verify/adapters";
import type { ChatCard, Decision, DealCardBrand } from "../../../shared/agent";
import { CARD_TEXT, INSIGHT_ANGLES, ONCE_SAVE_AS, type CardMedia } from "../../../shared/milaCards";
import type { AgentStore } from "../research/store";
import { errorResult, okResult, resolveFactKeys, type AgentTool, type ToolContext } from "../tools";
import { entryOf, listBank, type BankIdea } from "../ideaBank/bank";
import { CAPABILITY_KEYS, capabilityKeyGuide, presentation, sheetConsent } from "./capabilities";
import { capability as registryEntry } from "../welcome/registry";
import { offerFor } from "../welcome/turnOn";
import { CARD_SKILLS, MILA_CARDS, milaCardsV2Enabled } from "./config";
import { atmosphereMedia, brandMedia, budgetFor, chartMedia, dbCardMediaDeps, libraryMedia, logoMedia, platformMedia, type CardMediaDeps } from "./media";
import { expireIgnored, pausedPillars, pillarOf } from "./outcomes";
import { isEventFact, periodEnd } from "../moments/facts";
import { gameDaySignalsEnabled } from "../events/config";

/** ask_once's typed-mode refusals (what Mila reads; Prompt Register). */
export const TYPED_OFF = "typed questions are not available yet: ask in your own words in the chat instead";
export const TYPED_NOT_EVENT = "typed.event_fact must be the F-key of one of their dated events";
export const TYPED_NOT_PASSED = "that event has not happened yet: ask for a result only after it";
import {
  ANSWER_WITH_SOURCES_DESCRIPTION, ASK_ONCE_DESCRIPTION, ASK_ONCE_TYPED_DESCRIPTION, IDEAS_SUGGEST_DESCRIPTION, OFFER_CAPABILITY_DESCRIPTION, SHARE_INSIGHT_DESCRIPTION,
} from "./prompts";

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
/** Cut at a word boundary to `n` characters (an idea's hook written before the card budget existed). */
export function fit(s: string, n: number): string {
  const t = oneLine(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}
const headlineArg = z.string().min(1).max(CARD_TEXT.headline).describe("Eight words or fewer (48 characters at most).");
const lineArg = z.string().min(1).max(CARD_TEXT.line).describe("Fifteen words or fewer (90 characters at most).");
/** Every number written in a text (1,940 · 96% · 2.5): digits only, for the trace check. */
export const numbersIn = (s: string) => (oneLine(s).match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, "").replace(/,/g, ""));
const siteOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, "").slice(0, 30); } catch { return ""; } };
const sinceMs = (iso: string | undefined | null, now: number) => (iso ? now - Date.parse(iso) : Infinity);
const inThisChat = (d: Decision, ctx: ToolContext) => !!ctx.turn?.conversationId && d.detail?.conversationId === ctx.turn.conversationId;

export interface MilaCardToolDeps {
  media?: CardMediaDeps;
  now?: () => Date;
}

export function milaCardTools(store: AgentStore, deps: MilaCardToolDeps = {}): AgentTool[] {
  const media = deps.media ?? dbCardMediaDeps;
  const now = () => (deps.now ?? (() => new Date()))();
  const enabled = milaCardsV2Enabled;

  // ── share_insight ──────────────────────────────────────────────────────────────────────────────────────────────
  const insightArgs = z.object({
    angle: z.enum(INSIGHT_ANGLES),
    headline: headlineArg,
    line: lineArg,
    fact_keys: z.array(z.string().max(40)).min(1).max(8).describe("The F-keys it rests on."),
    figures: z.array(z.object({ label: z.string().min(1).max(20), value: z.string().min(1).max(12), note: z.string().max(14).optional() })).max(3).optional()
      .describe("Up to three figures for 'See more', each as a cited fact states it."),
    series: z.array(z.number()).min(2).max(12).optional().describe("For change, strength, gap or timing: the values over time, oldest first, each as a cited fact states it."),
    brand_names: z.array(z.string().min(1).max(80)).max(3).optional().describe("For angle brand: the brands involved."),
    why: z.string().max(CARD_TEXT.why).optional(),
    ask: z.string().max(CARD_TEXT.ask).optional().describe("What 'Ask Mila' sends as their message."),
  });
  const shareInsight: AgentTool<typeof insightArgs> = {
    name: "share_insight",
    description: SHARE_INSIGHT_DESCRIPTION,
    kind: "ours", permission: "draft", enabled,
    args: insightArgs,
    async execute(ctx, a) {
      const factIds = resolveFactKeys(ctx, a.fact_keys);
      if (!factIds.length) return errorResult("none of those F-keys is in this turn: cite facts from CONTEXT or recall_facts");
      const facts = (await store.getFacts(ctx.athleteId, factIds)).filter((f) => f.status === "active" || f.status === "disputed");
      if (!facts.length) return errorResult("those facts are not on record any more: say it in words instead");
      if (facts.some((f) => f.sensitive)) return errorResult("it touches a care moment: no insight card; say it in words only if it matters");
      const said = facts.map((f) => f.claim).join("\n");
      const traced = new Set(numbersIn(said));
      // Every number the card would show — headline, line, why, each figure and its note, the series — as a cited fact
      // states it (the delta on the chart comes from a figure's note, so it is traced too).
      const shown = [a.headline, a.line, a.why ?? "", ...(a.figures ?? []).flatMap((f) => [f.value, f.note ?? ""])];
      const untraced = [...new Set([...shown.flatMap(numbersIn), ...(a.series ?? []).map((n) => String(n))])].filter((n) => !traced.has(n));
      if (untraced.length) return errorResult(`every figure must be as a cited fact states it; not found in the facts: ${untraced.join(", ")}`);
      const sources = facts.flatMap((f) => (f.source.url || f.source.title ? [{ label: fit(f.source.title || siteOf(f.source.url!) || "Source", 40), ...(f.source.url ? { url: f.source.url, site: siteOf(f.source.url) || null } : {}), date: f.date ?? null }] : []));
      if (!sources.length) return errorResult("an insight needs at least one source; say it in words instead");

      const t = now().getTime();
      await expireIgnored(store, ctx.athleteId, now()).catch(() => 0);
      const recent = (await store.listDecisions(ctx.athleteId, { skillId: CARD_SKILLS.insight })).filter((d) => sinceMs(d.createdAt, t) < MILA_CARDS.insightRepeatMs && d.detail?.kind === "insight_card");
      const same = recent.find((d) => d.detail?.angle === a.angle || ((d.detail?.factIds as string[] | undefined) ?? []).some((id) => factIds.includes(id)));
      if (same) return errorResult("an insight like this was shown in the last 14 days: do not show it again");

      const budget = budgetFor(ctx.turn);
      const alt = fit(a.headline, CARD_TEXT.alt);
      let m: CardMedia | null = null;
      if (a.angle === "brand" && a.brand_names?.length) {
        const brands: DealCardBrand[] = [];
        for (const n of a.brand_names) { const b = await brandMedia(media, n, alt); brands.push(b?.brand ?? { name: n, logoUrl: null, domain: null, isPerson: false }); }
        m = logoMedia(brands, alt);
      } else if (a.angle !== "opportunity" && a.series?.length) {
        const last = a.series[a.series.length - 1];
        const delta = (a.figures ?? []).map((f) => f.note ?? "").find((n) => /[+−-]\s?\d/.test(n)) ?? null;
        m = chartMedia(a.series, last.toLocaleString("en-US"), delta, alt);
      }
      m ??= await atmosphereMedia(media, ctx.athleteId, budget, { key: `insight:${a.angle}`, query: a.headline }, alt);

      const d = await store.insertDecision(ctx.athleteId, {
        runId: ctx.runId || null, skillId: CARD_SKILLS.insight, suggested: oneLine(a.headline), why: oneLine(a.why ?? a.line),
        evidence: factIds.map((factId) => ({ kind: "fact" as const, factId })), kind: "other",
        detail: { kind: "insight_card", angle: a.angle, headline: oneLine(a.headline), factIds, conversationId: ctx.turn?.conversationId ?? null },
      });
      const insightCard = {
        decisionId: d.id, angle: a.angle, media: m, headline: oneLine(a.headline), line: oneLine(a.line),
        more: { evidence: (a.figures ?? []).map((f) => ({ label: f.label, value: f.value, note: f.note ?? null })), why: oneLine(a.why ?? "") },
        sources: sources.slice(0, 4), factIds,
        seeMore: { label: "My Intelligence", target: { screen: "scouting", id: "mia" } },
        ask: oneLine(a.ask ?? `Tell me more about this: ${a.headline}`).slice(0, CARD_TEXT.ask),
      };
      // The card as built, for the app's own screens (Home's briefing reads it: agent/milaCards/surface.ts).
      await store.updateDecision(ctx.athleteId, d.id, { detail: { ...(d.detail ?? {}), card: insightCard } });
      return okResult({ shown: "insight", headline: oneLine(a.headline), _card: insightCard });
    },
    card(result, ctx): ChatCard | null {
      const c = (result as { _card?: Record<string, unknown> })._card;
      if (!c) return null;
      return { id: `insight:${c.decisionId}`, kind: "insight", title: "Insight", payload: c as never, links: [], runId: ctx.runId };
    },
  };

  // ── ideas_suggest ──────────────────────────────────────────────────────────────────────────────────────────────
  const ideasArgs = z.object({
    idea_ids: z.array(z.string().max(80)).min(1).max(5).optional().describe("Idea-bank ids, best first. Leave out to show the freshest live ideas."),
  });
  const ideasSuggest: AgentTool<typeof ideasArgs> = {
    name: "ideas_suggest",
    description: IDEAS_SUGGEST_DESCRIPTION,
    kind: "ours", permission: "draft", enabled,
    args: ideasArgs,
    async execute(ctx, a) {
      const t = now().getTime();
      await expireIgnored(store, ctx.athleteId, now()).catch(() => 0);
      const bank = await listBank(store, ctx.athleteId);   // care moments are never read
      const paused = await pausedPillars(store, ctx.athleteId, now());
      const rows = new Map<string, Decision>();
      for (const d of await store.listDecisions(ctx.athleteId, { kinds: ["other"] })) if (entryOf(d.detail)) rows.set(d.id, d);
      const conv = ctx.turn?.conversationId ?? null;
      const offeredHere = (d: Decision) => {
        const o = d.detail?.cardOffered as { conversationId?: string | null; at?: string } | undefined;
        return !!conv && o?.conversationId === conv && sinceMs(o.at, t) < MILA_CARDS.ideasPerChatMs;
      };
      if ([...rows.values()].some(offeredHere)) {
        return errorResult("ideas were already shown in this chat today: do not show them again");
      }
      const live = (b: BankIdea) => {
        const tap = rows.get(b.decisionId)?.detail?.cardTap as { state?: string; until?: string } | undefined;
        const resting = tap?.state === "not_now" && tap.until && Date.parse(tap.until) > t;
        const pillar = pillarOf(b.entry);
        return b.entry.status === "new" && tap?.state !== "never" && !resting && !(pillar && paused.has(pillar))
          && !(b.entry.expiresOn && Date.parse(`${b.entry.expiresOn}T23:59:59Z`) < t);
      };
      let picked: BankIdea[];
      if (a.idea_ids?.length) {
        const byId = new Map(bank.map((b) => [b.decisionId, b]));
        picked = a.idea_ids.map((id) => byId.get(id)).filter((b): b is BankIdea => !!b);
        if (!picked.length) return errorResult("none of those ids is in their idea bank: never invent an idea; call ideas_suggest without ids for the live ones");
        const dead = picked.filter((b) => !live(b));
        if (dead.length === picked.length) return errorResult("those ideas are used, resting, paused or past their moment: do not show them");
        picked = picked.filter(live);
      } else {
        picked = bank.filter(live).sort((x, y) => (x.entry.expiresOn ?? "9999").localeCompare(y.entry.expiresOn ?? "9999") || y.createdAt.localeCompare(x.createdAt)).slice(0, 3);
        if (!picked.length) return errorResult("their idea bank has no live ideas right now: say so, or offer to plan their week");
      }
      const budget = budgetFor(ctx.turn);
      const items = [];
      for (const b of picked.slice(0, 5)) {
        const d = rows.get(b.decisionId);
        const mediaIds = (d?.evidence ?? []).flatMap((e) => (e.kind === "record" && e.table === "media_assets" ? [e.id] : []));
        const headline = fit(b.entry.idea.hook, CARD_TEXT.headline);
        const m = await libraryMedia(media, ctx.athleteId, budget, mediaIds, headline, { key: `idea:${b.decisionId}`, query: b.entry.idea.hook });
        items.push({
          ideaId: b.decisionId, media: m, headline,
          line: fit(b.entry.idea.timing || b.entry.brief.captionAngle || b.entry.brief.show || "From your idea bank.", CARD_TEXT.line),
          format: b.entry.idea.format, length: null,
          moment: b.momentName && b.entry.expiresOn ? { label: fit(`${b.momentName} · ${b.entry.expiresOn}`, 30), until: b.entry.expiresOn } : null,
          brand: null, pillarKey: pillarOf(b.entry), studio: { screen: "studio" as const, id: b.decisionId },
        });
        if (d && ctx.turn?.conversationId) {
          const offered = { conversationId: ctx.turn?.conversationId ?? null, at: now().toISOString() };
          await store.updateDecision(ctx.athleteId, d.id, { detail: { ...(d.detail ?? {}), cardOffered: offered }, ifUnchanged: { detail: d.detail ?? {}, response: d.response } });
        }
      }
      return okResult({ shown: "ideas", ideas: items.map((i) => ({ id: i.ideaId, hook: i.headline })), _card: { items } });
    },
    card(result, ctx): ChatCard | null {
      const c = (result as { _card?: { items: unknown[] } })._card;
      if (!c?.items?.length) return null;
      return { id: `ideas:${ctx.runId}`, kind: "ideas", title: "Ideas", payload: c as never, links: [], runId: ctx.runId };
    },
  };

  // ── offer_capability ───────────────────────────────────────────────────────────────────────────────────────────
  const offerArgs = z.object({
    key: z.enum(CAPABILITY_KEYS).describe(capabilityKeyGuide()),
    account_ref: z.string().max(80).optional().describe("The connected account it would use, when it rests on one. Leave it out to use their connected account."),
  });
  const offerCapability: AgentTool<typeof offerArgs> = {
    name: "offer_capability",
    description: OFFER_CAPABILITY_DESCRIPTION,
    kind: "ours", permission: "draft", enabled,
    args: offerArgs,
    async execute(ctx, a) {
      const cap = presentation(a.key);
      if (!cap) return errorResult("no such capability");
      // The registry decides: optional, a switch, available, and the athlete's own state (on, paused, never, turned
      // off, resting after not now). welcome/turnOn.ts offerFor; mila_choices is the record.
      // A per-account capability (draft replies) with no account named rests on one of their own active accounts: the
      // first whose own choice may be offered. None connected: the Connect card comes first.
      let accountRef = a.account_ref ?? null;
      let ok = await offerFor(ctx.athleteId, a.key, accountRef, now());
      if (!ok.ok && ok.reason === "needs_account") {
        const { accountsFor } = await import("../welcome/choices");
        const active = (await accountsFor(ctx.athleteId, a.key)).filter((x) => x.status === "active");
        if (!active.length) return errorResult(`${registryEntry(a.key)?.name ?? a.key} needs a connected account first: offer to connect one (offer_connection) instead, and say nothing is on yet`);
        for (const acct of active) {
          ok = await offerFor(ctx.athleteId, a.key, acct.accountRef, now());
          accountRef = acct.accountRef;
          if (ok.ok) break;
        }
      }
      if (!ok.ok) return errorResult(ok.message);
      const t = now().getTime();
      await expireIgnored(store, ctx.athleteId, now()).catch(() => 0);
      // Pacing (cards): at most one Turn-on offer in 24 hours, whatever its capability. Me's own rows (detail.via "me":
      // the What Mila can do list, agent/milaCards/surface.ts) are not chat offers: pacing ignores them.
      const offers = (await store.listDecisions(ctx.athleteId, { skillId: CARD_SKILLS.turnOn })).filter((d) => d.detail?.via !== "me");
      if (offers.some((d) => sinceMs(d.createdAt, t) < MILA_CARDS.turnOnGapMs)) return errorResult("another offer appeared in the last 24 hours: do not offer now");
      const consent = sheetConsent(a.key)!;
      const budget = budgetFor(ctx.turn);
      const m = cap.platform ? platformMedia(cap.platform, cap.headline) : await atmosphereMedia(media, ctx.athleteId, budget, { key: `turn-on:${cap.key}`, query: cap.scene }, cap.headline);
      const d = await store.insertDecision(ctx.athleteId, {
        runId: ctx.runId || null, skillId: CARD_SKILLS.turnOn, suggested: `Turn on: ${cap.headline}`, why: cap.line, evidence: [], kind: "other",
        detail: {
          kind: "capability_offer", capability: cap.key, accountRef, state: ok.choice.state, consentVersion: consent.version,
          choiceVersion: ok.choice.version, conversationId: ctx.turn?.conversationId ?? null,
        },
      });
      const turnOnCard = {
        capability: cap.key, accountRef, accountLabel: null, media: m, headline: cap.headline, line: cap.line, glyph: cap.glyph,
        consentShort: cap.consentShort, sheet: cap.sheet,
        consent: { reads: consent.reads, drafts: consent.drafts, alwaysAsks: consent.alwaysAsks, onRevoke: consent.onRevoke },
        consentVersion: consent.version, choiceVersion: ok.choice.version, state: ok.choice.state === "not_now" ? "not_now" : "unset",
        decisionId: d.id,
      };
      // The card as built, for the app's own screens (Home's briefing reads it: agent/milaCards/surface.ts).
      await store.updateDecision(ctx.athleteId, d.id, { detail: { ...(d.detail ?? {}), card: turnOnCard } });
      return okResult({ shown: "turn-on", capability: cap.key, note: "Only their tap on the card's sheet turns it on. Nothing is on yet.", _card: turnOnCard });
    },
    card(result, ctx): ChatCard | null {
      const c = (result as { _card?: Record<string, unknown> })._card;
      if (!c) return null;
      return { id: `turn-on:${c.decisionId}`, kind: "turn-on", title: "Mila can do more", payload: c as never, links: [], runId: ctx.runId };
    },
  };

  // ── ask_once ───────────────────────────────────────────────────────────────────────────────────────────────────
  // Two faces, chosen per turn: the rule question (as it always was), and — only while GAME_DAY_SIGNALS is on — the
  // same plus the typed mode. The model is never told about a mode the server would refuse.
  const onceArgsRule = z.object({
    question: z.string().min(1).max(160).describe("The question, in Mila's words."),
    context: z.string().max(40).optional().describe("What prompted it, e.g. \"2 product-only offers this month\"."),
    key: z.string().min(3).max(60).regex(/^[a-z0-9_]+$/).describe("A stable snake_case name for the choice, e.g. product_only_offers."),
    save_as: z.enum(ONCE_SAVE_AS),
    choices: z.array(z.object({ label: z.string().min(1).max(30), rule: z.string().min(1).max(120) })).min(2).max(4),
    topic: z.string().max(30).optional().describe("Two or three words that start their own answer, e.g. Free-product offers."),
    brand_names: z.array(z.string().min(1).max(80)).max(3).optional().describe("The brands that prompted it, for their logos."),
    why: z.string().max(CARD_TEXT.line).optional(),
  });
  const onceArgs = z.object({
    question: z.string().min(1).max(160).describe("The question, in Mila's words."),
    context: z.string().max(40).optional().describe("What prompted it, e.g. \"2 product-only offers this month\"."),
    key: z.string().min(3).max(60).regex(/^[a-z0-9_]+$/).describe("A stable snake_case name for the choice, e.g. product_only_offers."),
    save_as: z.enum(ONCE_SAVE_AS).optional().describe("Required for a rule question; leave unset with typed."),
    choices: z.array(z.object({ label: z.string().min(1).max(30), rule: z.string().min(1).max(120) })).max(4).optional()
      .describe("Two to four answers for a rule question; none with typed."),
    typed: z.object({
      event_fact: z.string().min(1).max(80).describe("The F-key of the event the answer is about."),
      placeholder: z.string().min(1).max(60).describe("A short example of the kind of answer: a score, a time or a place."),
    }).optional().describe("A result only they know, answered in their own words (a score, a time or a place): saved as a fact they said about that event, never as a rule."),
    topic: z.string().max(30).optional().describe("Two or three words that start their own answer, e.g. Free-product offers."),
    brand_names: z.array(z.string().min(1).max(80)).max(3).optional().describe("The brands that prompted it, for their logos."),
    why: z.string().max(CARD_TEXT.line).optional(),
  });
  const SENDS = /\b(send|sends|sent|post|posts|posted|publish|publishes|pay|pays|paid|accept it|auto[- ]?reply|reply for me)\b/i;
  const askOnce: AgentTool<typeof onceArgs> = {
    name: "ask_once",
    get description() { return gameDaySignalsEnabled() ? ASK_ONCE_TYPED_DESCRIPTION : ASK_ONCE_DESCRIPTION; },
    get args() { return (gameDaySignalsEnabled() ? onceArgs : onceArgsRule) as unknown as typeof onceArgs; },
    kind: "ours", permission: "draft", enabled,
    async execute(ctx, a) {
      const choices = (a.choices ?? []).map((c) => ({ label: oneLine(c.label), rule: oneLine(c.rule) }));
      if (!a.typed && (choices.length < 2 || !a.save_as)) return errorResult("a rule question needs two to four answers and save_as; for a result only they know, use typed");
      if (a.typed && (choices.length || a.save_as)) return errorResult("a typed question has no answers to pick and no save_as: their words are saved as a fact about the event");
      let typed: { placeholder: string; eventFactId: string } | null = null;
      if (a.typed) {
        // GAME_DAY_SIGNALS: typed questions only once the app can take a typed answer (agent/events/config.ts).
        if (!gameDaySignalsEnabled()) return errorResult(TYPED_OFF);
        const [byKey] = resolveFactKeys(ctx, [a.typed.event_fact]);
        const factId = byKey ?? (/^[0-9a-f-]{36}$/i.test(a.typed.event_fact.trim()) ? a.typed.event_fact.trim() : null);
        const [fact] = factId ? await store.getFacts(ctx.athleteId, [factId]) : [];
        if (!fact || !isEventFact(fact)) return errorResult(TYPED_NOT_EVENT);
        // A result exists only once the event has happened: its (period's) last day is before today.
        if (periodEnd(fact.date!, fact.datePrecision) >= now().toISOString().slice(0, 10)) return errorResult(TYPED_NOT_PASSED);
        typed = { placeholder: oneLine(a.typed.placeholder), eventFactId: fact.id };
      }
      if (new Set(choices.map((c) => c.label.toLowerCase())).size < choices.length) return errorResult("two answers say the same thing");
      if (choices.some((c) => SENDS.test(`${c.label} ${c.rule}`))) return errorResult("an option would make something go out without a tap: every answer must leave sending, posting and paying to their tap");
      const t = now().getTime();
      await expireIgnored(store, ctx.athleteId, now()).catch(() => 0);
      const asked = await store.listDecisions(ctx.athleteId, { skillId: CARD_SKILLS.once });
      if (asked.some((d) => inThisChat(d, ctx))) return errorResult("a question was already asked in this chat");
      const same = asked.filter((d) => d.detail?.key === a.key);
      if (same.some((d) => d.response === "accepted" || d.response === "edited")) return errorResult("they already answered this; follow their rule");
      if (same.length >= MILA_CARDS.onceMaxAsks) return errorResult("this was asked twice already: do not ask again");
      if (same.length && sinceMs(same[same.length - 1].createdAt, t) < MILA_CARDS.onceRetryMs) return errorResult("this was asked in the last 30 days: do not ask again yet");
      const brands: DealCardBrand[] = [];
      for (const n of a.brand_names ?? []) { const b = await brandMedia(media, n, n); brands.push(b?.brand ?? { name: n, logoUrl: null, domain: null, isPerson: false }); }
      const m = brands.length ? logoMedia(brands, oneLine(a.context ?? a.question).slice(0, CARD_TEXT.alt)) : null;
      const d = await store.insertDecision(ctx.athleteId, {
        runId: ctx.runId || null, skillId: CARD_SKILLS.once, suggested: oneLine(a.question), why: oneLine(a.why ?? ""), evidence: [], kind: "other",
        detail: { kind: "once_question", key: a.key, saveAs: a.save_as ?? null, choices, ...(typed ? { typed } : {}), conversationId: ctx.turn?.conversationId ?? null },
      });
      return okResult({
        shown: "question", question: oneLine(a.question), note: typed ? "Their answer is saved as something they told you about that event; no answer means not now." : "Their tap saves the rule; no answer means not now.",
        _card: {
          question: oneLine(a.question), options: choices.map((c) => c.label), why: oneLine(a.why ?? ""), media: m, context: a.context ? oneLine(a.context) : null,
          once: { key: a.key, ...(a.save_as ? { saveAs: a.save_as } : {}), decisionId: d.id, choices, ...(typed ? { typed } : {}), answered: null, somethingElse: true, prefill: a.topic ? `${oneLine(a.topic)}: ` : "" },
        },
      });
    },
    card(result, ctx): ChatCard | null {
      const c = (result as { _card?: { once: { decisionId: string } } })._card;
      if (!c) return null;
      return { id: `once:${c.once.decisionId}`, kind: "quick-question", title: "One quick question", payload: c as never, links: [], runId: ctx.runId };
    },
  };

  // ── answer_with_sources ────────────────────────────────────────────────────────────────────────────────────────
  const answerArgs = z.object({
    headline: headlineArg,
    line: lineArg,
    brand_name: z.string().max(80).optional().describe("When it is about one brand: its name (the server draws its logo and cover)."),
    // 'more' as one of three shapes (the registry's JSON Schema has no discriminated unions): pass at most one.
    stats: z.array(z.object({ label: z.string().min(1).max(20), value: z.string().min(1).max(12), note: z.string().max(18).optional() })).min(2).max(4).optional()
      .describe("'more' as 2–4 figures."),
    list: z.array(z.object({ lead: z.string().max(14).optional(), text: z.string().min(1).max(80), source: z.number().int().min(0).max(4).optional() })).min(2).max(4).optional()
      .describe("'more' as 2–4 rows (a date or label, what, the index of its source)."),
    table: z.object({ columns: z.array(z.string().min(1).max(18)).min(2).max(3), rows: z.array(z.array(z.string().max(24))).min(1).max(6) }).optional()
      .describe("'more' as a table of up to 3 columns and 6 rows (opens on a sheet)."),
    sources: z.array(z.object({ label: z.string().min(1).max(40), url: z.string().max(500), date: z.string().max(20).optional() })).min(1).max(5)
      .describe("Only pages from this turn's results."),
    follow_ups: z.array(z.string().min(1).max(50)).max(2).optional(),
  });
  const answerWithSources: AgentTool<typeof answerArgs> = {
    name: "answer_with_sources",
    description: ANSWER_WITH_SOURCES_DESCRIPTION,
    kind: "ours", permission: "draft", enabled,
    args: answerArgs,
    async execute(ctx, a) {
      // The kept sources, and where each of the model's indexes now points: a list row's `source` is an index into the
      // sources AS GIVEN, so dropping a non-https one must move the rows after it (or a row would cite the wrong page).
      const kept = a.sources.map((s, i) => ({ s, i })).filter(({ s }) => /^https:\/\//i.test(s.url) && siteOf(s.url));
      const sources = kept.map(({ s }) => s);
      const ixOf = new Map(kept.map(({ i }, j) => [i, j] as const));
      if (!sources.length) return errorResult("an answer card needs at least one source page (https) from this turn's results; say it in words instead");
      if ([a.stats, a.list, a.table].filter(Boolean).length > 1) return errorResult("pass one of stats, list or table, not several");
      const more0 = a.stats ? { kind: "stats" as const, items: a.stats } : a.list ? { kind: "list" as const, items: a.list } : a.table ? { kind: "table" as const, ...a.table } : null;
      const table = more0?.kind === "table" ? more0 : null;
      if (table && table.rows.some((r) => r.length !== table.columns.length)) return errorResult("every table row needs one cell per column");
      const budget = budgetFor(ctx.turn);
      const alt = fit(a.headline, CARD_TEXT.alt);
      let brand: DealCardBrand | null = null;
      let m: CardMedia | null = null;
      if (a.brand_name) {
        const b = await brandMedia(media, a.brand_name, alt);
        brand = b?.brand ?? { name: oneLine(a.brand_name), logoUrl: null, domain: null, isPerson: false };
        m = b?.media ?? logoMedia([brand], alt);
      } else if (more0?.kind === "stats") {
        const pts = more0.items.map((i) => Number(numbersIn(i.value)[0])).filter((n) => Number.isFinite(n));
        if (pts.length === more0.items.length) m = chartMedia(pts, more0.items[more0.items.length - 1].value, null, alt);
      }
      const listItems = more0?.kind === "list" ? more0.items.map((i) => ({ lead: i.lead ?? null, text: i.text, sourceIx: i.source != null ? ixOf.get(i.source) ?? null : null })) : null;
      // CHECK BEFORE DELIVER (A4): every claim carries a source chip, every chip points at a kept source, every source is
      // a web page. Failed: no card and no decision row; Mila is told why and says the answer in words, naming her
      // sources — so the athlete still gets her answer, never silence. The card as built is in the log line.
      const verdict = await verifyDeliverable("answer", answerFromCard({
        headline: a.headline, line: a.line, list: listItems, sources,
      }), {});
      if (!verdict.ok) {
        logNeedsALook("answer_with_sources", verdict, { runId: ctx.runId, headline: oneLine(a.headline).slice(0, 80), sources: sources.map((s) => s.url.slice(0, 120)) });
        return errorResult(`this answer card did not pass its check (${verdict.failures.map((f) => f.check).join(", ")}); say the answer in words and name where each point came from`);
      }
      m ??= await atmosphereMedia(media, ctx.athleteId, budget, { key: `answer:${ctx.runId}`, query: a.headline }, alt);
      const d = await store.insertDecision(ctx.athleteId, {
        runId: ctx.runId || null, skillId: CARD_SKILLS.answer, suggested: oneLine(a.headline), why: oneLine(a.line),
        evidence: sources.map((s) => ({ kind: "url" as const, url: s.url, title: s.label })), kind: "other",
        detail: { kind: "answer_card", headline: oneLine(a.headline), conversationId: ctx.turn?.conversationId ?? null },
      });
      const more = !more0 ? null
        : more0.kind === "stats" ? { kind: "stats" as const, items: more0.items.map((i) => ({ label: i.label, value: i.value, note: i.note ?? null })) }
        : more0.kind === "list" ? { kind: "list" as const, items: listItems! }
        : more0;
      return okResult({
        shown: "answer", headline: oneLine(a.headline),
        _card: {
          media: m, brand, headline: oneLine(a.headline), line: oneLine(a.line), more,
          sources: sources.map((s) => ({ label: s.label, url: s.url, site: siteOf(s.url), date: s.date ?? null })),
          asOf: now().toISOString().slice(0, 10), followUps: (a.follow_ups ?? []).map(oneLine), saved: false, decisionId: d.id,
        },
      });
    },
    card(result, ctx): ChatCard | null {
      const c = (result as { _card?: Record<string, unknown> })._card;
      if (!c) return null;
      return { id: `answer:${c.decisionId}`, kind: "answer", title: "Answer", payload: c as never, links: [], runId: ctx.runId };
    },
  };

  return [shareInsight, ideasSuggest, offerCapability, askOnce, answerWithSources] as AgentTool[];
}
