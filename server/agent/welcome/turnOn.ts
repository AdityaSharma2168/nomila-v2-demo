/**
 * agent/welcome/turnOn.ts — the interface the Turn-on card (card system v2, #1193: offer_capability and the card tap
 * route) and Me call, so a tap really switches a capability on THROUGH the registry's consent record (mila_choices via
 * setChoice). Nothing here is chat words: a yes is only ever the athlete's tap.
 *
 *   offerFor(athleteId, key, accountRef?)    may Mila show the Turn-on card for this capability now? The registry
 *                                            entry, its consent words and version, and the athlete's current choice
 *                                            (its version, for the tap's optimistic check). Refused with a reason
 *                                            Mila can act on (already on, said never, resting after not now, …).
 *   turnOnFromCard({ … consentVersion })     the sheet's Turn on: the consent version the sheet SHOWED must be the
 *                                            registry's current one (else the words changed: show the sheet again),
 *                                            then setChoice(enabled, via card).
 *   declineFromCard(…, "not_now" | "never")  the card's Not now / Don't offer this again.
 *   consentWords(key)                        the words a sheet must show for the version it records.
 *
 * Engine-independent; writes only through choices.ts (refused while MILA_WELCOME is off).
 */
import { milaWelcomeEnabled } from "./config";
import { availableNow, capability, DRAFTS_SAYS, type CapabilityEntry, type ConsentBlock } from "./registry";
import type { Choice, ChoiceState, SetChoiceResult } from "./choices";
import { bookingsEnabledFor } from "../../services/bookings/config";

/**
 * A capability that is built and flagged on but open only to some athletes (review of #1226, 6 Nov 2026): bookings is
 * piloted (BOOKINGS_PILOT_ATHLETE_IDS), so for anyone else a yes would do nothing. Such a capability is neither offered
 * nor listed in Me for an athlete it is not open to. Capabilities not named here are open to everyone.
 */
const OPEN_TO: Readonly<Record<string, (athleteId: string) => boolean>> = { bookings: bookingsEnabledFor };

/** Is this capability open to this athlete (beyond its status and flag, which availableNow checks)? */
export function openToAthlete(key: string, athleteId: string): boolean {
  return OPEN_TO[key]?.(athleteId) ?? true;
}

export interface ConsentWords {
  version: string;
  /** What Mila will do once it is on: the registry's consent.automatic, in order, then DRAFTS_SAYS when drafts is true. */
  automatic: string[];
  /** What always waits for their tap (consent.alwaysApprove). */
  alwaysAsks: string[];
  drafts: boolean;
  onRevoke: ConsentBlock["onRevoke"];
}

export function consentWords(entry: CapabilityEntry): ConsentWords {
  const c = entry.consent;
  const automatic = [...c.automatic.map((i) => i.says), ...(c.drafts ? [DRAFTS_SAYS] : [])];
  return { version: c.version, automatic, alwaysAsks: c.alwaysApprove.map((i) => i.says), drafts: c.drafts, onRevoke: c.onRevoke };
}

/** The capabilities a Turn-on card may name: optional, switched on by a choice (not a connection, page or rule). */
export function turnOnKeys(entries: readonly CapabilityEntry[]): string[] {
  return entries.filter((c) => !c.core && c.optInTarget === "choice").map((c) => c.key);
}

export type OfferRefusal =
  | "welcome_off" | "unknown_capability" | "core_capability" | "not_a_switch" | "not_available" | "needs_account"
  | "already_on" | "paused" | "said_never" | "turned_off" | "cooling_down";

export type OfferCheck =
  | { ok: true; entry: CapabilityEntry; words: ConsentWords; choice: Choice }
  | { ok: false; reason: OfferRefusal; message: string };

const no = (reason: OfferRefusal, message: string): OfferCheck => ({ ok: false, reason, message });

/** May the Turn-on card for `key` be shown to this athlete now? */
export async function offerFor(athleteId: string, key: string, accountRef: string | null = null, now: Date = new Date()): Promise<OfferCheck> {
  if (!milaWelcomeEnabled()) return no("welcome_off", "capability choices are off: do not offer anything");
  const entry = capability(key);
  if (!entry) return no("unknown_capability", "no such capability");
  if (entry.core) return no("core_capability", "that one is core: it is always on and is never offered");
  if (entry.optInTarget !== "choice") return no("not_a_switch", "that one is not switched on from a card");
  if (!availableNow(entry) || !openToAthlete(key, athleteId)) return no("not_available", "that one is not available yet: do not offer it");
  if (entry.scope === "per_account" && !accountRef) return no("needs_account", "say which connected account it is for (account_ref)");
  if (entry.scope === "athlete" && accountRef) accountRef = null;
  const { getChoice } = await import("./choices");
  const choice = await getChoice(athleteId, key, accountRef);
  switch (choice.state) {
    case "enabled": return no("already_on", "it is already on: say so, and that they can turn it off in Me");
    case "paused": return no("paused", "they paused it: they can resume it in Me; do not offer it");
    case "never": return no("said_never", "they asked never to be offered this: do not offer it");
    case "revoked": return no("turned_off", "they turned it off: do not offer it again; they can turn it on in Me");
    case "not_now":
      if (choice.cooldownUntil && Date.parse(choice.cooldownUntil) > now.getTime()) {
        return no("cooling_down", `they said not now; do not offer it before ${choice.cooldownUntil.slice(0, 10)}`);
      }
      break;
    default: break;
  }
  return { ok: true, entry, words: consentWords(entry), choice };
}

export interface TurnOnInput {
  athleteId: string;
  key: string;
  accountRef?: string | null;
  /** The consent version the sheet showed. */
  consentVersion: string;
  /** The choice version the card was drawn with (0 = unset); a choice that moved since is refused. */
  expectedVersion?: number;
}

/** The sheet's Turn on: records the yes, with the consent the athlete saw, in mila_choices (+ history). */
export async function turnOnFromCard(input: TurnOnInput): Promise<SetChoiceResult | { ok: false; error: "consent_changed" | "not_a_switch"; message: string }> {
  const entry = capability(input.key);
  if (entry && !entry.core && entry.optInTarget !== "choice") return { ok: false, error: "not_a_switch", message: "that one is not switched on from a card" };
  if (entry && input.consentVersion !== entry.consent.version) {
    return { ok: false, error: "consent_changed", message: "the consent changed; show the sheet again" };
  }
  const { setChoice } = await import("./choices");
  return setChoice({
    athleteId: input.athleteId, capability: input.key, accountRef: entry?.scope === "per_account" ? input.accountRef ?? null : null,
    to: "enabled", via: "card", ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  });
}

/** The choice's state now, on the account only when the capability is per account (what a card tap checks first). */
export async function choiceStateFor(athleteId: string, key: string, accountRef: string | null): Promise<string> {
  const entry = capability(key);
  const { getChoice } = await import("./choices");
  return (await getChoice(athleteId, key, entry?.scope === "per_account" ? accountRef : null)).state;
}

/** The card's Not now / Don't offer this again. */
export async function declineFromCard(athleteId: string, key: string, accountRef: string | null, to: Extract<ChoiceState, "not_now" | "never">): Promise<SetChoiceResult> {
  const entry = capability(key);
  const { setChoice } = await import("./choices");
  return setChoice({ athleteId, capability: key, accountRef: entry?.scope === "per_account" ? accountRef : null, to, via: "card" });
}
