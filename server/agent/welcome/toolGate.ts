/**
 * agent/welcome/toolGate.ts — per-athlete tool enablement, enforced by the server (owner-approved A3, 3 Nov 2026).
 *
 * A Mila tool that an OPTIONAL capability unlocks (registry.ts `tools`, optionalToolCapabilities) is usable for an
 * athlete only while at least one capability that lists it is allowed for them (choices.ts isAllowed: their choice is
 * enabled, the capabilities it needs are allowed, the feature is available). Every other tool is core and always
 * available. Two enforcement points, both server-side and neither depending on the prompt:
 *
 *   per turn   refusedTools()     the engine drops refused tools from what the model sees (Mastra turn assembly).
 *   per call   toolRefusal()      callPassTool refuses the call with an actionable error, whatever the model saw
 *                                 (a stale list, a replayed call, a tool named by hand).
 *   per tap    tapRefusal()       the approve tap (approvals.ts executeAgentAction) re-checks it: a card queued while
 *                                 the capability was on is declined, and runs nothing, if it was turned off since.
 *
 * A tool that serves several documents is owned per use ("documents_make:pitch", registry TOOL_QUALIFIER_ARG): the
 * per-call check reads the call's `document` and asks only that use's capabilities, and the per-turn list keeps the
 * tool (another use may be core: a public page draft), so a pitch made without pitch_deck is refused at the call with
 * the offer to turn it on.
 *
 * A per-account capability (draft replies) is allowed when it is enabled on at least one of the athlete's own
 * connected accounts that is still active. Any error fails CLOSED (the tool is refused). Transparent while
 * MILA_WELCOME is off: nothing is read and nothing is refused, so the tools behave exactly as before.
 *
 * Outside the engines the same check guards the two other ways Mila can act on an optional capability:
 *   voice        POST /api/internal/voice/athletes/:id/draft-intent (the voice worker's draft card) → deals_draft_reply
 *   legacy v1    the old Mila loop (server/mila/loop.ts, prod's text chat until the Mastra cutover; retires with it):
 *                legacyToolRefusal maps its tools onto the registry's (draft_reply → deals_draft_reply).
 *
 * The refusal text is model-facing (Prompt Register): it never invites a card that cannot be drawn. offer_capability is
 * named only for a capability the Turn-on card can offer (cardOfferable: MILA_CARDS_V2 on and a card presentation in
 * milaCards/capabilities.ts); otherwise the athlete turns it on in Me.
 */
import { and, eq } from "drizzle-orm";
import { createLogger } from "../../logger";
import { milaWelcomeEnabled } from "./config";
import { availableNow, capability, CAPABILITIES, optionalToolCapabilities, splitToolName, TOOL_QUALIFIER_ARG, type CapabilityEntry } from "./registry";
import { openToAthlete, turnOnKeys } from "./turnOn";
import { milaCardsV2Enabled } from "../milaCards/config";
import { presentation } from "../milaCards/capabilities";

const logger = createLogger("agent/welcome/toolGate");

const TOOL_CAPS = optionalToolCapabilities();

/** The optional capabilities that unlock this tool as a whole (empty: a core tool, or one owned per use). */
export function capabilitiesForTool(name: string): readonly string[] {
  return TOOL_CAPS.get(name) ?? [];
}

/** Tools owned per use (registry "name:kind"). */
const PER_USE = new Set([...TOOL_CAPS.keys()].map(splitToolName).filter((t) => t.kind).map((t) => t.tool));

/**
 * The optional capabilities that unlock THIS call: the tool's own owners, or, for a tool owned per use, the owners of
 * the use its `document` argument names (none: that use is core).
 */
export function capabilitiesForCall(name: string, args?: unknown): readonly string[] {
  if (!PER_USE.has(name)) return capabilitiesForTool(name);
  const kind = args && typeof args === "object" ? (args as Record<string, unknown>)[TOOL_QUALIFIER_ARG] : undefined;
  return typeof kind === "string" ? TOOL_CAPS.get(`${name}:${kind}`) ?? [] : [];
}

/** May a Turn-on card be offered for this capability key now? */
export type Offerable = (key: string) => boolean;
/**
 * The card system's answer (#1202): offer_capability exists only while MILA_CARDS_V2 is on, and draws a card only for
 * a registry key with a card presentation (milaCards/capabilities.ts). Anything else is turned on in Me.
 */
export const cardOfferable: Offerable = (key) => milaCardsV2Enabled() && presentation(key) !== null;

/**
 * The model-facing refusal: what is off and the one thing Mila can do about it (Prompt Register). With a capability the
 * Turn-on card can offer, Mila offers it; otherwise she says it is off and that they can turn it on in Me.
 */
export function refusalText(tool: string, caps: readonly string[], offerable: Offerable = cardOfferable): string {
  const names = caps.map((k) => `${capability(k)?.name ?? k} (${k})`).join(" or ");
  const card = caps.find((k) => offerable(k));
  return card
    ? `${tool} is off for this athlete: ${names} is not turned on. Do not retry. Offer it with offer_capability (key: ${card}); only their tap on that card turns it on.`
    : `${tool} is off for this athlete: ${names} is not turned on. Do not retry, and do not offer it with offer_capability. Say it is off and that they can turn it on in Me; only their own tap turns it on.`;
}

/** The v1 loop's tools (server/mila, legacy) that an optional capability's registry tool covers. */
export const LEGACY_V1_TOOLS: Readonly<Record<string, string>> = { draft_reply: "deals_draft_reply" };

/** Is any one of these optional capabilities allowed for the athlete right now? Fails closed. */
async function anyAllowed(athleteId: string, caps: readonly string[]): Promise<boolean> {
  const { isAllowed } = await import("./choices");
  for (const key of caps) {
    const entry = capability(key);
    if (!entry) continue;
    if (entry.scope === "athlete") {
      if ((await isAllowed(athleteId, key, null)).allowed) return true;
      continue;
    }
    // Per account: enabled on at least one of the athlete's own accounts (isAllowed re-checks it is theirs and active).
    const { db } = await import("../../db");
    const { milaChoices } = await import("../../../shared/schema");
    const rows = await db.select({ accountRef: milaChoices.account_ref }).from(milaChoices)
      .where(and(eq(milaChoices.athlete_id, athleteId), eq(milaChoices.capability, key), eq(milaChoices.state, "enabled")));
    for (const r of rows) if (r.accountRef && (await isAllowed(athleteId, key, r.accountRef)).allowed) return true;
  }
  return false;
}

/**
 * The tools among `names` this athlete may not use now, each with the capabilities that would unlock it. Empty while
 * MILA_WELCOME is off. One check per capability set (memoised for the call), fail closed on any error.
 */
export async function refusedTools(athleteId: string, names: readonly string[]): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  if (!milaWelcomeEnabled()) return out;
  const memo = new Map<string, Promise<boolean>>();
  for (const name of names) {
    const caps = capabilitiesForTool(name);
    if (!caps.length) continue;
    const k = caps.join("|");
    if (!memo.has(k)) memo.set(k, anyAllowed(athleteId, caps).catch((err: any) => {
      logger.warn({ athleteId, caps, error: String(err?.message ?? err).slice(0, 200) }, "capability check failed: tool refused");
      return false;
    }));
    if (!(await memo.get(k)!)) out.set(name, caps);
  }
  return out;
}

/**
 * The refusal text for one call, or null when it may run (core, or a capability that unlocks it is allowed). `args`
 * are the call's own: a tool owned per use is judged on the use they name.
 */
export async function toolRefusal(athleteId: string, name: string, offerable: Offerable = cardOfferable, args?: unknown): Promise<string | null> {
  if (!milaWelcomeEnabled()) return null;
  const caps = capabilitiesForCall(name, args);
  if (!caps.length) return null;
  const ok = await anyAllowed(athleteId, caps).catch((err: any) => {
    logger.warn({ athleteId, caps, error: String(err?.message ?? err).slice(0, 200) }, "capability check failed: tool refused");
    return false;
  });
  if (ok) return null;
  const kind = PER_USE.has(name) ? (args as Record<string, unknown>)[TOOL_QUALIFIER_ARG] : null;
  return refusalText(typeof kind === "string" ? `${name} (document: ${kind})` : name, caps, offerable);
}

/**
 * The athlete-facing refusal at her TAP (approvals.ts executeAgentAction): a card queued while the capability was on
 * runs only if it is still on when she taps. Null when the tool may run. Plain words for the app, not the model.
 * Transparent while MILA_WELCOME is off; fails closed (refusedTools treats a failed check as off).
 */
export async function tapRefusal(athleteId: string, name: string, args?: unknown): Promise<string | null> {
  // A tool owned per use (documents_share for a pitch vs the public page) is judged on the stored arguments' use.
  if (!milaWelcomeEnabled()) return null;
  const caps = capabilitiesForCall(name, args);
  if (!caps.length) return null;
  if (await anyAllowed(athleteId, caps)) return null;
  const names = caps.map((k) => capability(k)?.name ?? k).join(" or ");
  return `${names} is turned off now, so this was not done. Turn it on in Me if you still want it.`;
}

/**
 * The legacy v1 loop's check before it runs a tool: refused (with the refusal text, under the v1 tool's own name) when
 * the registry tool it stands for is off for this athlete. Fails closed; transparent while MILA_WELCOME is off.
 */
export async function legacyToolRefusal(athleteId: string, v1Name: string): Promise<string | null> {
  const name = LEGACY_V1_TOOLS[v1Name];
  if (!name || !milaWelcomeEnabled()) return null;
  const refused = (await refusedTools(athleteId, [name])).get(name);
  return refused ? refusalText(v1Name, refused, () => false) : null;   // the v1 loop has no offer_capability
}

/** Keep only the tools this athlete may use now (the per-turn assembly). */
export async function allowedTools<T extends { name: string }>(athleteId: string, tools: readonly T[]): Promise<T[]> {
  const refused = await refusedTools(athleteId, tools.map((t) => t.name));
  return refused.size ? tools.filter((t) => !refused.has(t.name)) : [...tools];
}

/**
 * Where each optional capability Mila could switch on stands for this athlete right now — what CAN DO NOW tells the
 * model (engine/context.ts canDoNow), so Mila never claims one that is off and offers the one that is. Only built,
 * available capabilities a card switches on (turnOnKeys, availableNow, openToAthlete: the same list Me shows):
 *   on        allowed now (the SAME check refusedTools makes, so the turn's tools and this list agree)
 *   offer     off, and a Turn-on card may be offered (cardOfferable; never said no, not paused or turned off, not
 *             resting after Not now; a per-account one has an active account to rest on)
 *   connect   off, and it needs an account they have not connected (a per-account one with none active)
 *   inMe      off, and not to be offered in chat (paused, turned off, said never, resting, or no card): Me turns it on
 * Null while MILA_WELCOME is off (nothing is gated, so nothing is listed). Any failed check counts as off (fails closed).
 */
export interface CapabilityOverview {
  on: CapabilityEntry[];
  offer: CapabilityEntry[];
  connect: CapabilityEntry[];
  inMe: CapabilityEntry[];
}

/**
 * Capabilities that only mean something in a live voice call (voice_send: a spoken "send it"). CAN DO NOW lists them
 * only on the voice surface, so Mila never brings them up, or offers them, in chat or anywhere else.
 */
export const VOICE_ONLY_CAPABILITIES: ReadonlySet<string> = new Set(["voice_send"]);

export async function capabilityOverview(athleteId: string, opts: { offerable?: Offerable; now?: Date; surface?: "voice" } = {}): Promise<CapabilityOverview | null> {
  if (!milaWelcomeEnabled()) return null;
  const offerable = opts.offerable ?? cardOfferable;
  const now = (opts.now ?? new Date()).getTime();
  const keys = new Set(turnOnKeys(CAPABILITIES));
  const entries = CAPABILITIES.filter((c) => keys.has(c.key) && availableNow(c) && openToAthlete(c.key, athleteId)
    && (opts.surface === "voice" || !VOICE_ONLY_CAPABILITIES.has(c.key)));
  const { accountsFor, listChoices } = await import("./choices");
  const choices = await listChoices(athleteId);
  const out: CapabilityOverview = { on: [], offer: [], connect: [], inMe: [] };
  for (const c of entries) {
    const allowed = await anyAllowed(athleteId, [c.key]).catch((err: any) => {
      logger.warn({ athleteId, capability: c.key, error: String(err?.message ?? err).slice(0, 200) }, "capability check failed: listed as off");
      return false;
    });
    if (allowed) { out.on.push(c); continue; }
    const rests = (accountRef: string | null) => choices.some((x) => x.capability === c.key && x.accountRef === accountRef && (
      x.state === "never" || x.state === "paused" || x.state === "revoked" || (x.state === "not_now" && !!x.cooldownUntil && Date.parse(x.cooldownUntil) > now)));
    if (!offerable(c.key)) { out.inMe.push(c); continue; }
    if (c.scope === "per_account") {
      // Offerable on an active account of theirs whose own choice is not resting (offer_capability picks that one).
      const active = (await accountsFor(athleteId, c.key).catch(() => [])).filter((a) => a.status === "active");
      if (!active.length) out.connect.push(c);
      else if (active.every((a) => rests(a.accountRef))) out.inMe.push(c);
      else out.offer.push(c);
      continue;
    }
    if (rests(null)) out.inMe.push(c);
    else out.offer.push(c);
  }
  return out;
}

// Exported for the guard test: the optional tools must exist in the tool registry (a use's tool, for "name:kind").
export const OPTIONAL_TOOL_NAMES: readonly string[] = [...new Set([...TOOL_CAPS.keys()].map((n) => splitToolName(n).tool))];
