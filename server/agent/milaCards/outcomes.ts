/**
 * agent/milaCards/outcomes.ts — what every tap on a v2 card records (design "What every tap records"; decision 12: in
 * the EXISTING columns, no migration). memory_decisions.response is pending | accepted | edited | skipped | expired, so:
 *
 *   tap         Insight · Answer                    Idea (an idea-bank row)                    Turn-on            One-time question
 *   accepted    accepted (reason: asked/opened/      detail.cardTap accepted (idea used          accepted, enabled  accepted + a memory_preferences
 *               saved/follow_up)                      happens in Studio, as today)              + consentVersion   row (the rule); detail.answered
 *   edited      edited                               detail.cardTap edited (hook changed)        —                  edited ("Something else…")
 *   not now     skipped · not_now                    detail.cardTap not_now (rests 14 days)      skipped · not_now  —
 *   never       skipped · never                      entry skipped + its pillar paused 30 days   skipped · never    —
 *   ignored     expired, 7 days after it was SEEN    detail.cardTap ignored (seen items only)    expired            expired (counts as one of two asks)
 *
 * Turn-on "accepted" needs the connect sheet's own tap: action "enabled" and the consent version the sheet showed, equal
 * to the offer row's; the yes is then recorded by the Welcome registry (mila_choices via setChoice, via "card"), which is
 * what switches the capability's tools and jobs on. Not now / never are recorded there too. Every answer is one conditional write (`claim`): a double tap or a
 * retry records once, and a repeat of the same answer is answered as done.
 *
 * Content (a made post in "Ready for you": a post action with a built kit) takes only the ⋯ taps — not now (rests 14
 * days, still open: detail.cardTap), never ("Not for me": skipped, response_reason "not_for_me[: their words]", and with
 * `lasting` their words saved as a style preference) and seen. See contentOutcome.
 *
 * An idea-bank row's `response` is never touched (agent/ideaBank: an idea is not something the athlete answered); its
 * tap lives in detail.cardTap, written conditionally on the row being what was read. A pillar pause is its own
 * decision row (skill mila-cards/pillar-pause, detail { kind "pillar_pause", pillarKey, until }). An ignored Answer
 * never counts against anything, so answers are left out of the sweep.
 */
import { z } from "zod";
import type { Decision, PreferenceKind } from "../../../shared/agent";
import { createLogger } from "../../logger";
import type { AgentStore, NewFact } from "../research/store";
import { entryOf, pillarNameKey } from "../ideaBank/bank";
import { STEER_REASON_MAX } from "../../../shared/readyQueue";
import { contentReadyQueueEnabled } from "../ready/config";
import { privateFormats } from "../../lib/contactDetails";

/** An idea's pillar as a pause names it: the pillar's NAME (P-keys renumber with every Brief), else its key. */
export const pillarOf = (e: { pillarKey: string | null; pillarName?: string | null }) => (e.pillarName ? pillarNameKey(e.pillarName) : e.pillarKey);
import { CARD_SKILLS, MILA_CARDS } from "./config";
import { choiceStateFor, declineFromCard, turnOnFromCard, type TurnOnInput } from "../welcome/turnOn";

const logger = createLogger("agent/milaCards/outcomes");

export const CARD_OUTCOME_CARDS = ["insight", "idea", "turn-on", "once", "answer", "content"] as const;
export const CARD_OUTCOMES = ["accepted", "edited", "not_now", "never", "seen"] as const;
export const CARD_ACTIONS = ["asked", "opened", "saved", "follow_up", "idea_used", "enabled", "rule"] as const;

/** POST /api/v1/me/mila/cards/outcome's body. */
export const cardOutcomeBody = z.object({
  card: z.enum(CARD_OUTCOME_CARDS),
  /** The decision row the card names (decisionId / ideaId / the once block's decisionId). */
  ref: z.string().uuid(),
  outcome: z.enum(CARD_OUTCOMES),
  action: z.enum(CARD_ACTIONS).optional(),
  /** One-time question: which choice was tapped. */
  choice: z.number().int().min(0).max(3).optional(),
  /**
   * Turn-on: the consent version the connect sheet SHOWED. Required for a Turn on (it proves the tap came from the
   * sheet that carried those words); it must equal the version stored on the offer's row.
   */
  consentVersion: z.string().max(80).optional(),
  /** Content ⋯ "Tell Mila why": their reason, in their words (stored with the row's response_reason on Not for me). */
  reason: z.string().trim().min(1).max(STEER_REASON_MAX).optional(),
  /**
   * Content ⋯ Not for me: the reason is a lasting taste ("no music on my training clips"), not only about this one post —
   * it is also saved as their own preference (memory_preferences, kind style, source said). Needs a reason.
   */
  lasting: z.boolean().optional(),
  /** A typed one-time question (detail.typed): their answer, in their words (e.g. a final score). */
  text: z.string().trim().min(1).max(200).optional(),
});
export type CardOutcomeInput = z.infer<typeof cardOutcomeBody>;

/** The Welcome registry's consent record (agent/welcome/turnOn.ts); tests pass fakes. */
export interface TurnOnDeps {
  enable(input: TurnOnInput): Promise<{ ok: true } | { ok: false; error: string; message: string }>;
  decline(athleteId: string, key: string, accountRef: string | null, to: "not_now" | "never"): Promise<{ ok: true } | { ok: false; error: string; message: string }>;
  /** The choice's state now (mila_choices; "unset" when there is no row). */
  stateOf(athleteId: string, key: string, accountRef: string | null): Promise<string>;
}
const defaultTurnOn: TurnOnDeps = { enable: turnOnFromCard, decline: declineFromCard, stateOf: choiceStateFor };

export interface OutcomeDeps {
  addPreference(athleteId: string, p: { kind: PreferenceKind; statement: string; source: "said" }): Promise<unknown>;
  turnOn?: TurnOnDeps;
  /** Save a fact they said (a typed answer). Default: the store's insertFacts. */
  addFact?: (athleteId: string, f: NewFact) => Promise<unknown>;
  /** After a typed result is saved. Default: the plan's after_result event run (plan/triggers.ts notifyPlanEvent). */
  onResult?: (athleteId: string, eventName: string) => void;
  now?: () => Date;
}

export type OutcomeResult = { ok: true; receipt: string } | { ok: false; status: 404 | 409 | 400 | 500; error: string };

const SKILL_OF: Record<Exclude<CardOutcomeInput["card"], "idea" | "content">, string> = {
  insight: CARD_SKILLS.insight, answer: CARD_SKILLS.answer, "turn-on": CARD_SKILLS.turnOn, once: CARD_SKILLS.once,
};

/** The receipt line the card turns into (past tense, no live control). */
export const RECEIPTS = {
  asked: "Asked Mila.",
  opened: "Opened.",
  saved: "Saved.",
  follow_up: "Asked Mila.",
  idea_used: "Draft started in Studio. Nothing is posted until you tap Post.",
  enabled: "On. Turn it off any time in Me.",
  turnOnNotNow: "OK. I'll ask again only if it comes up.",
  turnOnNever: "I won't offer this again. You can turn it on in Me.",
  turnOnAlreadyOn: "It's already on. You can change it in Me.",
  turnOnDecidedInMe: "You've already set this in Me.",
  ideaNever: "I won't suggest this one again.",
  notNow: "OK, not now.",
  rule: "Saved as your rule.",
  edited: "Tell me in your words.",
  seen: "",
  answerSaved: "Saved. Thanks for telling me.",
  contentNotNow: "OK, not now. It stays in Studio, out of the way, for two weeks.",
  contentNever: "Taken off your list.",
  contentNeverLasting: "Taken off your list. I'll keep that in mind from now on.",
} as const;

async function patchIdea(store: AgentStore, athleteId: string, d: Decision, write: (detail: Record<string, unknown>) => Record<string, unknown>): Promise<Decision | null> {
  let row: Decision | null = d;
  for (let attempt = 0; attempt < 2 && row; attempt++) {
    const next = write({ ...(row.detail ?? {}) });
    const done = await store.updateDecision(athleteId, row.id, { detail: next, ifUnchanged: { detail: row.detail ?? {}, response: row.response } });
    if (done) return done;
    row = await store.getDecision(athleteId, row.id);
  }
  return null;
}

/**
 * Answer a pending row in ONE conditional write (detail + response, only while it is still pending and unchanged), so
 * two taps, a retry or a double tap can never both win. On a lost race: the row as it now stands, so a repeat of the
 * SAME answer is treated as already done (idempotent) and a different one as a conflict.
 */
async function claim(store: AgentStore, athleteId: string, d: Decision, response: "accepted" | "edited" | "skipped", reason: string | null, detail: Record<string, unknown>):
  Promise<{ ok: true } | { ok: false; status: 409; error: string; same: string | null; reason: string | null }> {
  if (d.response === "pending") {
    const done = await store.updateDecision(athleteId, d.id, { detail, response, responseReason: reason, ifUnchanged: { detail: d.detail ?? {}, response: "pending" } });
    if (done) return { ok: true };
  }
  const now = (await store.getDecision(athleteId, d.id)) ?? d;
  return { ok: false, status: 409, error: `already ${now.response}`, same: now.response, reason: now.responseReason ?? null };
}

/** Record one tap. Never trusts the card's own words: the rule saved is the one stored on the question's row. */
export async function recordOutcome(store: AgentStore, athleteId: string, input: CardOutcomeInput, deps: OutcomeDeps): Promise<OutcomeResult> {
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString();
  const d = await store.getDecision(athleteId, input.ref);
  if (!d) return { ok: false, status: 404, error: "no such card" };

  if (input.card === "idea") {
    const entry = entryOf(d.detail);
    if (!entry) return { ok: false, status: 404, error: "no such idea" };
    if (input.outcome === "seen") {
      if (!d.detail?.cardShownAt) await patchIdea(store, athleteId, d, (x) => ({ ...x, cardShownAt: at }));
      return { ok: true, receipt: RECEIPTS.seen };
    }
    const state = input.outcome;
    const prior = d.detail?.cardTap as { state?: string } | undefined;
    // A repeat of the same tap (a retry, a double tap) changes nothing and pauses no second pillar.
    if (prior?.state === state) return { ok: true, receipt: state === "never" ? RECEIPTS.ideaNever : state === "not_now" ? RECEIPTS.notNow : RECEIPTS.idea_used };
    // "Don't suggest this" is final for that idea: a later tap cannot bring it back.
    if (prior?.state === "never") return { ok: false, status: 409, error: "already never" };
    const until = state === "not_now" ? new Date(now.getTime() + MILA_CARDS.ideaNotNowMs).toISOString() : null;
    const saved = await patchIdea(store, athleteId, d, (x) => ({
      ...x,
      cardTap: { state, at, ...(input.action ? { action: input.action } : {}), ...(until ? { until } : {}) },
      ...(state === "never" ? { status: "skipped" } : {}),
    }));
    if (!saved) return { ok: false, status: 409, error: "the idea changed; try again" };
    const pillar = pillarOf(entry);
    if (state === "never" && pillar) {
      await store.insertDecision(athleteId, {
        runId: null, skillId: CARD_SKILLS.pillarPause, suggested: `Pause the pillar ${entry.pillarName ?? entry.pillarKey}`,
        why: "The athlete tapped \"Don't suggest this\" on an idea of this pillar.", evidence: [], kind: "other", response: "accepted",
        detail: { kind: "pillar_pause", pillarKey: pillar, ideaId: d.id, until: new Date(now.getTime() + MILA_CARDS.pillarPauseMs).toISOString() },
      });
    }
    return { ok: true, receipt: state === "never" ? RECEIPTS.ideaNever : state === "accepted" ? RECEIPTS.idea_used : state === "edited" ? RECEIPTS.idea_used : RECEIPTS.notNow };
  }

  // Made posts are steered only while "Ready for you" is on (agent/ready/config.ts): off, the card does not exist.
  if (input.card === "content") return contentReadyQueueEnabled() ? contentOutcome(store, athleteId, d, input, deps, now) : { ok: false, status: 404, error: "no such card" };

  if (d.skillId !== SKILL_OF[input.card]) return { ok: false, status: 404, error: "no such card" };
  if (input.outcome === "seen") {
    // Conditional on the row being what was read, so a "seen" can never overwrite a tap that landed in between.
    if (!d.detail?.seenAt) await store.updateDecision(athleteId, d.id, { detail: { ...(d.detail ?? {}), seenAt: at }, ifUnchanged: { detail: d.detail ?? {}, response: d.response } });
    return { ok: true, receipt: RECEIPTS.seen };
  }

  if (input.card === "once" && d.detail?.typed) return typedAnswer(store, athleteId, d, input, deps, at);

  if (input.card === "once") {
    if (input.outcome === "edited") {
      const r = await claim(store, athleteId, d, "edited", "something_else", d.detail ?? {});
      return r.ok ? { ok: true, receipt: RECEIPTS.edited } : r.same === "edited" ? { ok: true, receipt: RECEIPTS.edited } : r;
    }
    if (input.outcome !== "accepted" || input.choice == null) return { ok: false, status: 400, error: "a choice is needed" };
    const once = (d.detail ?? {}) as { saveAs?: PreferenceKind; choices?: Array<{ label: string; rule: string }> };
    const choice = once.choices?.[input.choice];
    if (!choice || !once.saveAs) return { ok: false, status: 400, error: "no such choice" };
    // Claim the row first (only while it is still pending, in one statement): a double tap or a retry saves ONE rule.
    const r = await claim(store, athleteId, d, "accepted", "rule", { ...(d.detail ?? {}), answered: { rule: choice.rule, at } });
    if (!r.ok) return r.same === "accepted" ? { ok: true, receipt: RECEIPTS.rule } : r;
    try {
      await deps.addPreference(athleteId, { kind: once.saveAs, statement: choice.rule, source: "said" });
    } catch (err) {
      // The rule was not saved: put the question back as it was, so their next tap can save it.
      await store.updateDecision(athleteId, d.id, { detail: d.detail ?? {}, response: "pending", responseReason: null });
      throw err;
    }
    return { ok: true, receipt: RECEIPTS.rule };
  }

  if (input.card === "turn-on") {
    const capabilityKey = typeof d.detail?.capability === "string" ? (d.detail.capability as string) : null;
    const accountRef = typeof d.detail?.accountRef === "string" ? (d.detail.accountRef as string) : null;
    if (!capabilityKey) return { ok: false, status: 404, error: "no such card" };
    const turnOn = deps.turnOn ?? defaultTurnOn;
    if (input.outcome === "accepted") {
      // Consent is only the connect sheet's own button (decision 4): the tap names the action and the consent version
      // the sheet showed, and it must be the version on the offer's row. Then the Welcome registry records the yes in
      // mila_choices (with history) — that row, not this one, is what switches the capability's tools and jobs on.
      if (input.action !== "enabled") return { ok: false, status: 400, error: "a turn on needs the sheet's button" };
      const version = typeof d.detail?.consentVersion === "string" ? d.detail.consentVersion : null;
      if (!version || input.consentVersion !== version) return { ok: false, status: 409, error: "the consent changed; show the sheet again" };
      // A retry of the same tap: the row is already accepted and the choice already enabled — answered as done.
      if (d.response === "accepted") return { ok: true, receipt: RECEIPTS.enabled };
      // A card already answered otherwise (not now, never, expired) cannot switch anything on: refused BEFORE the
      // registry is written, so a 409 never leaves the capability on behind it. Turning it on is then Me's.
      if (d.response !== "pending") return { ok: false, status: 409, error: `already ${d.response}` };
      const choiceVersion = typeof d.detail?.choiceVersion === "number" ? (d.detail.choiceVersion as number) : undefined;
      const set = await turnOn.enable({ athleteId, key: capabilityKey, accountRef, consentVersion: version, ...(choiceVersion !== undefined ? { expectedVersion: choiceVersion } : {}) });
      if (!set.ok) return { ok: false, status: set.error === "consent_changed" || set.error === "version_conflict" ? 409 : 400, error: set.message };
      // Me's own rows keep via "me" (the chat's offer pacing ignores them: agent/milaCards/surface.ts).
      const detail = { ...(d.detail ?? {}), state: "enabled", consentedAt: at, consentVersion: version, via: d.detail?.via === "me" ? "me" : "card" };
      const r = await claim(store, athleteId, d, "accepted", "enabled", detail);
      if (!r.ok) return r.same === "accepted" ? { ok: true, receipt: RECEIPTS.enabled } : r;
      return { ok: true, receipt: RECEIPTS.enabled };
    }
    if (input.outcome === "not_now" || input.outcome === "never") {
      const receipt = input.outcome === "never" ? RECEIPTS.turnOnNever : RECEIPTS.turnOnNotNow;
      // Already answered: the same answer again is done (idempotent; a card closed as superseded counts as answered);
      // any other answer is a conflict. Checked before the registry is touched, so a repeat Not now is never a second
      // decline (a longer cooldown).
      const answered = (response: string | null, reason: string | null): OutcomeResult =>
        response === "skipped" && reason === "already_on" ? { ok: true, receipt: RECEIPTS.turnOnAlreadyOn }
          : response === "skipped" && reason === "decided_in_me" ? { ok: true, receipt: RECEIPTS.turnOnDecidedInMe }
          : response === "skipped" && reason === input.outcome ? { ok: true, receipt }
            : { ok: false, status: 409, error: `already ${response}` };
      if (d.response !== "pending") return answered(d.response, d.responseReason ?? null);
      // A stale card the athlete already decided in Me (on, paused or turned off since it was drawn): close it as
      // superseded and never decline it. Changing that choice stays an explicit action in Me.
      const state = await turnOn.stateOf(athleteId, capabilityKey, accountRef);
      if (state === "enabled" || state === "paused" || state === "revoked") {
        const why = state === "enabled" ? "already_on" : "decided_in_me";
        const r = await claim(store, athleteId, d, "skipped", why, { ...(d.detail ?? {}), state, supersededAt: at });
        return r.ok ? answered("skipped", why) : answered(r.same, r.reason);
      }
      // The registry first: if the decline is not recorded the card stays pending, so their next tap can record it.
      const set = await turnOn.decline(athleteId, capabilityKey, accountRef, input.outcome);
      if (!set.ok) {
        logger.warn({ athleteId, capability: capabilityKey, error: set.error }, "turn-on decline not recorded in mila_choices");
        return { ok: false, status: 500, error: "Could not save that. Try again." };
      }
      const r = await claim(store, athleteId, d, "skipped", input.outcome, { ...(d.detail ?? {}), state: input.outcome });
      return r.ok ? { ok: true, receipt } : answered(r.same, r.reason);
    }
    return { ok: false, status: 400, error: "not a turn-on tap" };
  }

  // Insight · Answer: several taps may follow one another (asked, then opened); the first one answers the row.
  const response = input.outcome === "accepted" ? "accepted" : input.outcome === "edited" ? "edited" : "skipped";
  const reason = input.outcome === "accepted" ? input.action ?? null : input.outcome === "edited" ? null : input.outcome;
  const first = await claim(store, athleteId, d, response, reason, d.detail ?? {});
  if (!first.ok && input.action) {
    const row = (await store.getDecision(athleteId, d.id)) ?? d;
    await store.updateDecision(athleteId, d.id, { detail: { ...(row.detail ?? {}), taps: [...((row.detail?.taps as string[] | undefined) ?? []), input.action] }, ifUnchanged: { detail: row.detail ?? {}, response: row.response } });
  }
  return { ok: true, receipt: input.action ? RECEIPTS[input.action] : RECEIPTS.notNow };
}

/**
 * A typed one-time question (detail.typed { eventFactId, placeholder }: a result only they know, e.g. a game's final
 * score). Their answer — `text`, in their words — is saved as a fact THEY SAID about that event (type said, subject the
 * event, date the event's date, topic "result"), so the final guard reads its numbers as the post's own sources
 * (numberSourcesFor: every active fact's claim). Claimed first (one conditional write: a double tap saves one fact);
 * if the fact cannot be saved the question is put back. Then `onResult` (default: the plan's after_result event run)
 * lets the plan decide whether a post about it is worth suggesting. Not now / never / seen as on any question.
 */
async function typedAnswer(store: AgentStore, athleteId: string, d: Decision, input: CardOutcomeInput, deps: OutcomeDeps, at: string): Promise<OutcomeResult> {
  if (d.skillId !== CARD_SKILLS.once) return { ok: false, status: 404, error: "no such card" };
  if (input.outcome === "seen") {
    if (!d.detail?.seenAt) await store.updateDecision(athleteId, d.id, { detail: { ...(d.detail ?? {}), seenAt: at }, ifUnchanged: { detail: d.detail ?? {}, response: d.response } });
    return { ok: true, receipt: RECEIPTS.seen };
  }
  if (input.outcome === "not_now" || input.outcome === "never") {
    const r = await claim(store, athleteId, d, "skipped", input.outcome, d.detail ?? {});
    return r.ok || r.same === "skipped" ? { ok: true, receipt: RECEIPTS.notNow } : r;
  }
  const text = (input.text ?? "").replace(/\s+/g, " ").trim();
  if (input.outcome !== "accepted" || !text) return { ok: false, status: 400, error: "type the answer" };
  // Their words become a fact: never a phone, email or street address in it (lib/contactDetails.ts).
  if (privateFormats(text).length) return { ok: false, status: 400, error: "leave out phone numbers, emails and addresses" };
  const typed = d.detail!.typed as { eventFactId?: string };
  const [event] = typed.eventFactId ? await store.getFacts(athleteId, [typed.eventFactId]) : [];
  if (!event) return { ok: false, status: 409, error: "that event is no longer in memory" };
  const answeredDetail = { ...(d.detail ?? {}), answered: { text, at } };
  const r = await claim(store, athleteId, d, "accepted", "answer", answeredDetail);
  if (!r.ok) return r.same === "accepted" ? { ok: true, receipt: RECEIPTS.answerSaved } : r;
  const name = event.subject.name || event.claim;
  try {
    const add = deps.addFact ?? ((a: string, f: NewFact) => store.insertFacts(a, [f]));
    await add(athleteId, {
      subject: { kind: "event", name }, claim: `${name}: ${text}`, type: "said", topic: RESULT_TOPIC,
      source: { ref: `mila-cards/once:${d.id}#said`, title: "You told me" }, date: event.date ?? null, confidence: 1, runId: null,
    });
  } catch (err) {
    // Put the question back — only while the row still holds this tap's answer.
    await store.updateDecision(athleteId, d.id, { detail: d.detail ?? {}, response: "pending", responseReason: null, ifUnchanged: { detail: answeredDetail, response: "accepted" } });
    throw err;
  }
  try { (deps.onResult ?? defaultOnResult)(athleteId, name); } catch { /* the answer is saved either way */ }
  return { ok: true, receipt: RECEIPTS.answerSaved };
}

/** The topic a result they told us is filed under (memory_facts.topic). */
export const RESULT_TOPIC = "result" as const;

const defaultOnResult = (athleteId: string, eventName: string) => {
  void import("../plan/triggers").then(({ notifyPlanEvent }) => notifyPlanEvent(athleteId, `a result was added for ${eventName}`, null, "after_result")).catch(() => undefined);
};

/**
 * ⋯ on a made post (card "content"; content engine plan, "Chips vs free text"): the ref is a post action with a built
 * kit (kind action, detail.kind post, detail.prepared.postKit) — the item "Ready for you" lists (agent/ready/queue.ts).
 *
 *   not_now  detail.cardTap { state not_now, at, until = +14 days, reason? }; the action stays open (response pending), so
 *            the post is still theirs to post — the queue only leaves it out until `until`. A repeat is done.
 *   never    "Not for me": the action is answered skipped, response_reason "not_for_me" or "not_for_me: <their words>"
 *            (what the plan reads back as the recent answers, plan/input.ts), detail.cardTap { state never, at,
 *            reason? }. With `lasting` (needs a reason) their words are also saved as their own preference (kind style,
 *            source said) — the same table the One-time question's rules go to. If that save fails the answer is put
 *            back, so their next tap can save both.
 *   seen     detail.seenAt (first time only), as the other cards.
 *   accepted / edited are not ⋯ taps on a post: "Post it" and "I posted it" are their own routes (400).
 */
async function contentOutcome(store: AgentStore, athleteId: string, d: Decision, input: CardOutcomeInput, deps: OutcomeDeps, now: Date): Promise<OutcomeResult> {
  const det = (d.detail ?? {}) as { kind?: unknown; prepared?: { postKit?: unknown } | null };
  if (d.kind !== "action" || det.kind !== "post" || !det.prepared?.postKit) return { ok: false, status: 404, error: "no such card" };
  const at = now.toISOString();
  if (input.outcome === "seen") {
    if (!d.detail?.seenAt) await store.updateDecision(athleteId, d.id, { detail: { ...(d.detail ?? {}), seenAt: at }, ifUnchanged: { detail: d.detail ?? {}, response: d.response } });
    return { ok: true, receipt: RECEIPTS.seen };
  }
  if (input.outcome === "accepted" || input.outcome === "edited") return { ok: false, status: 400, error: "posting a made item is Post it and I posted it, not a card tap" };
  const reason = input.reason ?? null;

  if (input.outcome === "not_now") {
    const prior = d.detail?.cardTap as { state?: string; until?: string } | undefined;
    if (d.response !== "pending") return { ok: false, status: 409, error: `already ${d.response}` };
    if (prior?.state === "not_now" && prior.until && Date.parse(prior.until) > now.getTime()) return { ok: true, receipt: RECEIPTS.contentNotNow };
    const until = new Date(now.getTime() + MILA_CARDS.contentNotNowMs).toISOString();
    const saved = await patchIdea(store, athleteId, d, (x) => ({ ...x, cardTap: { state: "not_now", at, until, ...(reason ? { reason } : {}) } }));
    return saved ? { ok: true, receipt: RECEIPTS.contentNotNow } : { ok: false, status: 409, error: "the post changed; try again" };
  }

  // never: "Not for me".
  if (input.lasting && !reason) return { ok: false, status: 400, error: "say why, so it can be kept in mind" };
  const receipt = input.lasting ? RECEIPTS.contentNeverLasting : RECEIPTS.contentNever;
  const why = reason ? `not_for_me: ${reason}` : "not_for_me";
  const claimed = { ...(d.detail ?? {}), cardTap: { state: "never", at, ...(reason ? { reason } : {}) } };
  const r = await claim(store, athleteId, d, "skipped", why, claimed);
  if (!r.ok) return r.same === "skipped" && (r.reason ?? "").startsWith("not_for_me") ? { ok: true, receipt } : r;
  if (input.lasting && reason) {
    try {
      await deps.addPreference(athleteId, { kind: "style", statement: reason, source: "said" });
    } catch (err) {
      // Put the post back — only while the row is still exactly the answer this tap wrote.
      await store.updateDecision(athleteId, d.id, { detail: d.detail ?? {}, response: "pending", responseReason: null, ifUnchanged: { detail: claimed, response: "skipped" } });
      throw err;
    }
  }
  return { ok: true, receipt };
}

/**
 * Ignored = SEEN and untouched for 7 days (decision 12): pending Insight, Turn-on and One-time question rows whose
 * detail.seenAt is older become expired; seen ideas with no tap get detail.cardTap ignored. Answers are left alone.
 * Cheap and per athlete: the producers run it before they decide (so pacing reads the truth).
 */
export async function expireIgnored(store: AgentStore, athleteId: string, now: Date = new Date()): Promise<number> {
  const cutoff = now.getTime() - MILA_CARDS.ignoredAfterMs;
  let n = 0;
  for (const skillId of [CARD_SKILLS.insight, CARD_SKILLS.turnOn, CARD_SKILLS.once]) {
    const rows = await store.listDecisions(athleteId, { skillId, responses: ["pending"] });
    for (const d of rows) {
      const seen = typeof d.detail?.seenAt === "string" ? Date.parse(d.detail.seenAt as string) : NaN;
      // Conditional: a tap that landed after the listing wins over the sweep.
      if (Number.isFinite(seen) && seen < cutoff && await store.updateDecision(athleteId, d.id, { response: "expired", responseReason: "ignored", ifUnchanged: { detail: d.detail ?? {}, response: "pending" } })) n++;
    }
  }
  const ideas = await store.listDecisions(athleteId, { kinds: ["other"] });
  for (const d of ideas) {
    if (!entryOf(d.detail) || d.detail?.cardTap) continue;
    const shown = typeof d.detail?.cardShownAt === "string" ? Date.parse(d.detail.cardShownAt as string) : NaN;
    if (Number.isFinite(shown) && shown < cutoff) {
      if (await patchIdea(store, athleteId, d, (x) => ({ ...x, cardTap: { state: "ignored", at: now.toISOString() } }))) n++;
    }
  }
  if (n) logger.info({ athleteId, n }, "mila cards: ignored cards expired");
  return n;
}

/** Pillars paused by "Don't suggest this", still within their 30 days. */
export async function pausedPillars(store: AgentStore, athleteId: string, now: Date = new Date()): Promise<Set<string>> {
  const rows = await store.listDecisions(athleteId, { skillId: CARD_SKILLS.pillarPause });
  return new Set(rows.flatMap((d) => {
    const until = typeof d.detail?.until === "string" ? Date.parse(d.detail.until as string) : NaN;
    const key = typeof d.detail?.pillarKey === "string" ? (d.detail.pillarKey as string) : "";
    return key && Number.isFinite(until) && until > now.getTime() ? [key] : [];
  }));
}
