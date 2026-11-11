/**
 * agent/welcome/choices.ts — the athlete's choices per capability (design "Mila welcome flow" §4 + §12, owner-approved
 * 28 Oct 2026). mila_choices is the canonical preference and consent record; mila_choice_history keeps every change.
 *
 * Five states never mixed (§4): available (registry + flags, computed), connected (connected_accounts), ENABLED (this
 * file: what the athlete wants, per capability and per account), running (domain tables) and action pending
 * (pending_actions). Only the athlete moves the preference here: there is no system writer, no migration writer and
 * no "existing" origin. A connection, an expired token or a flag never changes a choice.
 *
 *   getChoice     the preference for (athlete, capability, account): unset when there is no row.
 *   setChoice     the athlete's answer. Validates the transition (TRANSITIONS), the scope (a per-account capability
 *                 needs one of the athlete's own connected accounts that can serve it; an athlete-wide one takes none),
 *                 and that a yes came from a tap (card, Me or Settings), never from words alone. Row-locked and
 *                 version-checked, so concurrent answers serialise and an `expectedVersion` that moved is refused.
 *   pauseChoice / revokeChoice / revokeForAccount   the athlete pausing, turning off, or disconnecting an account.
 *   isAllowed     the check at execution boundaries: is this capability enabled for this athlete (and account), are
 *                 the capabilities it needs still allowed, and does the consent they gave cover this action?
 *
 * Writes are refused while MILA_WELCOME is off. Engine-independent: no engine, model or tool-server import.
 * Nothing here names an athlete, sport, school or brand.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { connectedAccounts, milaChoiceHistory, milaChoices } from "../../../shared/schema";
import { milaWelcomeEnabled } from "./config";
import { availableNow, CAPABILITIES, type CapabilityEntry, type ConnKind, type ConsentBlock, type Env, type Requirement } from "./registry";

export const CHOICE_STATES = ["enabled", "not_now", "never", "paused", "revoked"] as const;
export type ChoiceState = (typeof CHOICE_STATES)[number];
export type PreferenceState = ChoiceState | "unset";
export const CHOICE_VIAS = ["card", "chat", "me", "settings"] as const;
export type ChoiceVia = (typeof CHOICE_VIAS)[number];

/**
 * Allowed moves of the preference (design §4 diagram). The same state again is a no-op (no history row), except:
 * repeating not_now is a new decline (its cooldown lengthens), and enabled → enabled is a fresh yes to a grown consent
 * version. Nothing ever moves back to unset,
 * and repeated not_now never becomes never by itself.
 */
export const TRANSITIONS: Record<PreferenceState, readonly ChoiceState[]> = {
  unset:   ["enabled", "not_now", "never"],
  not_now: ["enabled", "not_now", "never"],
  never:   ["never", "enabled"],
  enabled: ["enabled", "paused", "revoked"],
  paused:  ["paused", "enabled", "revoked"],
  revoked: ["revoked", "enabled"],
};

/** A yes is a tap: the server-drawn card, the switch in Me, or Settings. Words in chat can decline, pause or turn off. */
export const YES_VIAS: readonly ChoiceVia[] = ["card", "me", "settings"];

/** Not-now cooldowns (owner, 28 Oct: 14 → 30 → 60 → 90 days, the ceiling). Pacing (PR 2) also needs a new trigger. */
export const NOT_NOW_COOLDOWN_DAYS = [14, 30, 60, 90] as const;

/** Which connected_accounts platforms can serve each connection kind of the registry. */
const PLATFORMS_FOR: Record<ConnKind, readonly string[]> = {
  mailbox: ["gmail", "outlook"],
  instagram: ["instagram"],
  instagram_dms: ["instagram"],
  youtube: ["youtube"],
  tiktok: ["tiktok"],
  calendar: [],
  payouts: [],
};

export interface Choice {
  athleteId: string;
  capability: string;
  accountRef: string | null;
  state: PreferenceState;
  via: ChoiceVia | null;
  consentVersion: string | null;
  consent: ConsentBlock | null;
  notNowCount: number;
  cooldownUntil: string | null;
  /** 0 = unset (no row). */
  version: number;
  decidedAt: string | null;
}

export type ChoiceError =
  | "disabled" | "unknown_capability" | "core_capability" | "not_available" | "scope" | "account_not_found"
  | "account_does_not_fit" | "invalid_transition" | "needs_tap" | "version_conflict";

export type SetChoiceResult =
  | { ok: true; changed: boolean; choice: Choice }
  | { ok: false; error: ChoiceError; message: string };

export interface SetChoiceInput {
  athleteId: string;
  capability: string;
  accountRef?: string | null;
  to: ChoiceState;
  via: ChoiceVia;
  /** The version the athlete was looking at (0 = unset). Omitted: no check (the row lock still serialises). */
  expectedVersion?: number;
  now?: Date;
}

type Registry = readonly CapabilityEntry[];
type Row = typeof milaChoices.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const lookup = (registry: Registry, key: string) => registry.find((c) => c.key === key);

const keyWhere = (athleteId: string, capability: string, accountRef: string | null) =>
  and(eq(milaChoices.athlete_id, athleteId), eq(milaChoices.capability, capability), sql`coalesce(${milaChoices.account_ref}, '') = ${accountRef ?? ""}`);

function toChoice(athleteId: string, capability: string, accountRef: string | null, r: Row | undefined): Choice {
  if (!r) return { athleteId, capability, accountRef, state: "unset", via: null, consentVersion: null, consent: null, notNowCount: 0, cooldownUntil: null, version: 0, decidedAt: null };
  return {
    athleteId, capability, accountRef: r.account_ref, state: r.state as ChoiceState, via: r.via as ChoiceVia,
    consentVersion: r.consent_version, consent: (r.consent as ConsentBlock | null) ?? null, notNowCount: r.not_now_count,
    cooldownUntil: r.cooldown_until ? r.cooldown_until.toISOString() : null, version: r.version, decidedAt: r.decided_at.toISOString(),
  };
}

const fail = (error: ChoiceError, message: string): SetChoiceResult => ({ ok: false, error, message });

/** Connection kinds a per-account capability's needs reach (through the per-account capabilities it needs). */
function connKindsOf(registry: Registry, r: Requirement | null, seen = new Set<string>()): ConnKind[] {
  if (!r) return [];
  if ("all" in r) return r.all.flatMap((x) => connKindsOf(registry, x, seen));
  if ("any" in r) return r.any.flatMap((x) => connKindsOf(registry, x, seen));
  if ("conn" in r) return [r.conn];
  if ("capability" in r) {
    if (seen.has(r.capability)) return [];
    seen.add(r.capability);
    return connKindsOf(registry, lookup(registry, r.capability)?.needs ?? null, seen);
  }
  return [];
}

/** The preference for one (athlete, capability, account). Reads regardless of the flag; unset when there is no row. */
export async function getChoice(athleteId: string, capability: string, accountRef: string | null = null): Promise<Choice> {
  const [r] = await db.select().from(milaChoices).where(keyWhere(athleteId, capability, accountRef)).limit(1);
  return toChoice(athleteId, capability, accountRef, r);
}

/** Every answered choice of the athlete (Me › What Mila does for you reads this with the registry). */
export async function listChoices(athleteId: string): Promise<Choice[]> {
  const rows = await db.select().from(milaChoices).where(eq(milaChoices.athlete_id, athleteId));
  return rows.map((r) => toChoice(athleteId, r.capability, r.account_ref, r));
}

/** The athlete's answer. Athlete-initiated only: `via` names where they answered; a yes must be a tap. */
export async function setChoice(input: SetChoiceInput, opts: { registry?: Registry } = {}): Promise<SetChoiceResult> {
  if (!milaWelcomeEnabled()) return fail("disabled", "MILA_WELCOME is off; nothing is recorded.");
  const registry = opts.registry ?? CAPABILITIES;
  const { athleteId, capability, to, via } = input;
  const accountRef = input.accountRef ?? null;
  const now = input.now ?? new Date();
  const entry = lookup(registry, capability);
  if (!entry) return fail("unknown_capability", `No capability "${capability}" in the registry.`);
  if (entry.core) return fail("core_capability", `"${capability}" is core: on for everyone, never a choice.`);
  if (!(CHOICE_STATES as readonly string[]).includes(to)) return fail("invalid_transition", `Unknown state "${to}".`);
  if (!(CHOICE_VIAS as readonly string[]).includes(via)) return fail("needs_tap", `Unknown via "${via}".`);
  if (to === "enabled" && !YES_VIAS.includes(via)) return fail("needs_tap", "A yes is recorded only from the athlete's tap (card, Me or Settings), never from words alone.");
  if (to === "enabled" && !availableNow(entry)) return fail("not_available", `"${capability}" is not available now (status or flag).`);

  if (entry.scope === "athlete" && accountRef) return fail("scope", `"${capability}" is athlete-wide; it takes no account.`);
  if (entry.scope === "per_account") {
    if (!accountRef) return fail("scope", `"${capability}" is per account; say which connected account.`);
    const [acct] = await db.select({ platform: connectedAccounts.platform, status: connectedAccounts.status })
      .from(connectedAccounts).where(and(eq(connectedAccounts.id, accountRef), eq(connectedAccounts.athlete_id, athleteId))).limit(1);
    if (!acct) return fail("account_not_found", "That account is not one of this athlete's connections.");
    const platforms = new Set(connKindsOf(registry, entry.needs).flatMap((k) => PLATFORMS_FOR[k]));
    if (!platforms.has(acct.platform)) return fail("account_does_not_fit", `A ${acct.platform} account cannot serve "${capability}".`);
    if (to === "enabled" && acct.status !== "active") return fail("account_not_found", "That account is not connected now; reconnect it first.");
  }

  return db.transaction(async (tx) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const [row] = await tx.select().from(milaChoices).where(keyWhere(athleteId, capability, accountRef)).for("update").limit(1);
      const from: PreferenceState = (row?.state as ChoiceState | undefined) ?? "unset";
      const version = row?.version ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
        return fail("version_conflict", `The choice moved (version ${version}, expected ${input.expectedVersion}); read it again.`);
      }
      // Same state again changes nothing, except a fresh not-now (a new decline) or a yes to a grown consent version.
      if (row && from === to && to !== "not_now" && !(to === "enabled" && row.consent_version !== entry.consent.version)) {
        return { ok: true as const, changed: false, choice: toChoice(athleteId, capability, accountRef, row) };
      }
      // A default-on capability is on while unset, so from unset it can also be paused or turned off.
      const next = from === "unset" && entry.defaultOn ? [...TRANSITIONS.unset, "paused", "revoked"] as readonly ChoiceState[] : TRANSITIONS[from];
      if (!next.includes(to)) return fail("invalid_transition", `"${capability}" cannot go from ${from} to ${to}.`);

      const notNowCount = (row?.not_now_count ?? 0) + (to === "not_now" ? 1 : 0);
      const cooldownUntil = to === "not_now"
        ? new Date(now.getTime() + NOT_NOW_COOLDOWN_DAYS[Math.min(notNowCount, NOT_NOW_COOLDOWN_DAYS.length) - 1] * 86_400_000)
        : null;
      // A yes stamps the consent the athlete is answering now; other moves keep what the last yes covered.
      const consentVersion = to === "enabled" ? entry.consent.version : (row?.consent_version ?? null);
      const consentCopy = to === "enabled" ? entry.consent : ((row?.consent as ConsentBlock | null) ?? null);
      const values = {
        state: to, via, consent_version: consentVersion, consent: consentCopy, not_now_count: notNowCount,
        cooldown_until: cooldownUntil, version: version + 1, decided_at: now,
      };

      let saved: Row | undefined;
      if (row) {
        [saved] = await tx.update(milaChoices).set(values).where(and(eq(milaChoices.id, row.id), eq(milaChoices.version, version))).returning();
      } else {
        [saved] = await tx.insert(milaChoices)
          .values({ athlete_id: athleteId, capability, account_ref: accountRef, scope: entry.scope, created_at: now, ...values })
          .onConflictDoNothing().returning();
        if (!saved) continue; // another answer created the row first: lock it and decide again
      }
      if (!saved) return fail("version_conflict", "The choice moved while saving; read it again.");
      await appendHistory(tx, saved, from);
      return { ok: true as const, changed: true, choice: toChoice(athleteId, capability, accountRef, saved) };
    }
    return fail("version_conflict", "The choice kept moving; read it again.");
  });
}

async function appendHistory(tx: Tx, r: Row, from: PreferenceState): Promise<void> {
  await tx.insert(milaChoiceHistory).values({
    choice_id: r.id, athlete_id: r.athlete_id, capability: r.capability, account_ref: r.account_ref, version: r.version,
    from_state: from === "unset" ? null : from, to_state: r.state, via: r.via, consent_version: r.consent_version,
    consent: r.consent, not_now_count: r.not_now_count, cooldown_until: r.cooldown_until, created_at: r.decided_at,
  });
}

/** The athlete pauses a capability (resume is setChoice to enabled, from a tap). */
export function pauseChoice(athleteId: string, capability: string, accountRef: string | null, via: ChoiceVia): Promise<SetChoiceResult> {
  return setChoice({ athleteId, capability, accountRef, to: "paused", via });
}

/** The athlete turns a capability off. */
export function revokeChoice(athleteId: string, capability: string, accountRef: string | null, via: ChoiceVia): Promise<SetChoiceResult> {
  return setChoice({ athleteId, capability, accountRef, to: "revoked", via });
}

/**
 * The athlete disconnected an account: every capability enabled or paused on it is turned off (design §4, "Athlete
 * disconnects the account"). Reconnecting does not turn them back on; a different account never inherits them.
 */
export async function revokeForAccount(athleteId: string, accountRef: string, via: ChoiceVia): Promise<string[]> {
  if (!milaWelcomeEnabled()) return [];
  const rows = await db.select({ capability: milaChoices.capability, state: milaChoices.state }).from(milaChoices)
    .where(and(eq(milaChoices.athlete_id, athleteId), eq(milaChoices.account_ref, accountRef)));
  const revoked: string[] = [];
  for (const r of rows) {
    if (r.state !== "enabled" && r.state !== "paused") continue;
    const res = await revokeChoice(athleteId, r.capability, accountRef, via);
    if (res.ok && res.changed) revoked.push(r.capability);
  }
  return revoked;
}

/** One of the athlete's connected accounts a per-account capability can be switched on for (Me lists them). */
export interface ChoiceAccount { accountRef: string; platform: string; label: string; status: string }

/**
 * The athlete's connected accounts that can serve a per-account capability (its needs' connection kinds), active or
 * not (Me shows an expired one as needing a reconnect); empty for an athlete-wide capability. Reads regardless of the flag.
 */
export async function accountsFor(athleteId: string, capability: string, opts: { registry?: Registry } = {}): Promise<ChoiceAccount[]> {
  const registry = opts.registry ?? CAPABILITIES;
  const entry = lookup(registry, capability);
  if (!entry || entry.scope !== "per_account") return [];
  const platforms = new Set(connKindsOf(registry, entry.needs).flatMap((k) => PLATFORMS_FOR[k]));
  if (!platforms.size) return [];
  const rows = await db.select({ id: connectedAccounts.id, platform: connectedAccounts.platform, alias: connectedAccounts.alias, username: connectedAccounts.platform_username, status: connectedAccounts.status })
    .from(connectedAccounts).where(eq(connectedAccounts.athlete_id, athleteId));
  return rows
    .filter((r) => platforms.has(r.platform) && (r.status === "active" || r.status === "expired"))
    .map((r) => ({ accountRef: r.id, platform: r.platform, label: (r.alias || r.username || r.platform).slice(0, 40), status: r.status ?? "pending" }));
}

// ─── isAllowed: the check at execution boundaries ───────────────────────────────────────────────────────────────

export type AllowReason =
  | "core" | "enabled" | "default_on" | "unknown_capability" | "not_available" | "scope" | "account_not_connected"
  | "unset" | "not_now" | "never" | "paused" | "revoked" | "needs_unmet" | "needs_approval" | "action_not_covered";

export interface AllowResult { allowed: boolean; reason: AllowReason; detail?: string }

/**
 * May work for `capability` run for this athlete (and account) right now, doing `action`?
 *   core → yes (its own connection and flag checks stay with the job).
 *   optional → only when the athlete's choice is enabled, every capability it needs is itself allowed (so pausing or
 *   turning off one stops its dependents), and — when `action` is given — the consent they said yes to covers it.
 *   An action the registry lists under alwaysApprove is never allowed automatically: it waits for the athlete's tap.
 * Reads regardless of MILA_WELCOME; callers gate on the flag (gate.ts) so nothing changes while it is off.
 */
export async function isAllowed(
  athleteId: string, capability: string, accountRef: string | null = null, action?: string,
  opts: { registry?: Registry; env?: Env } = {},
): Promise<AllowResult> {
  return check(athleteId, capability, accountRef, action, opts.registry ?? CAPABILITIES, opts.env ?? process.env, new Map());
}

/**
 * One isAllowed walk's answers, per capability|account: a finished key returns what it found (so a capability two
 * siblings need is judged once, and a failure stays a failure), and a key still being judged is a cycle, which fails
 * closed. The validator rejects cycles, so that branch is the guard, not a path.
 */
type Memo = Map<string, AllowResult | "in_progress">;

async function check(athleteId: string, capability: string, accountRef: string | null, action: string | undefined, registry: Registry, env: Env, memo: Memo): Promise<AllowResult> {
  // Only the first call carries an action (needs are judged without one), so the key is capability and account.
  const key = `${capability}|${accountRef ?? ""}`;
  const prior = memo.get(key);
  if (prior === "in_progress") return { allowed: false, reason: "needs_unmet", detail: "cycle" };
  if (prior) return prior;
  memo.set(key, "in_progress");
  const res = await judge(athleteId, capability, accountRef, action, registry, env, memo);
  memo.set(key, res);
  return res;
}

async function judge(athleteId: string, capability: string, accountRef: string | null, action: string | undefined, registry: Registry, env: Env, memo: Memo): Promise<AllowResult> {
  const entry = lookup(registry, capability);
  if (!entry) return { allowed: false, reason: "unknown_capability" };
  if (!availableNow(entry, env)) return { allowed: false, reason: "not_available" };
  if (entry.core) return { allowed: true, reason: "core" };
  if ((entry.scope === "per_account") !== (accountRef != null)) return { allowed: false, reason: "scope" };

  if (accountRef) {
    const [acct] = await db.select({ status: connectedAccounts.status }).from(connectedAccounts)
      .where(and(eq(connectedAccounts.id, accountRef), eq(connectedAccounts.athlete_id, athleteId))).limit(1);
    if (!acct || acct.status !== "active") return { allowed: false, reason: "account_not_connected" };
  }

  const choice = await getChoice(athleteId, capability, accountRef);
  // A default-on capability (registry defaultOn) is enabled until the athlete answers otherwise; its consent is the
  // registry's current block.
  const defaultOn = choice.state === "unset" && !!entry.defaultOn;
  if (choice.state !== "enabled" && !defaultOn) return { allowed: false, reason: choice.state };

  if (action) {
    if (entry.consent.alwaysApprove.some((i) => i.action === action)) return { allowed: false, reason: "needs_approval", detail: action };
    const c = defaultOn ? entry.consent : choice.consent;
    const covered = !!c && (c.automatic.some((i) => i.action === action) || (action === "draft" && c.drafts) || (action === "internal_record" && c.internalRecords));
    if (!covered) return { allowed: false, reason: "action_not_covered", detail: `${action} is not in ${choice.consentVersion}` };
  }

  const ok = await needsMet(athleteId, entry.needs, accountRef, registry, env, memo);
  if (!ok.met) return { allowed: false, reason: "needs_unmet", detail: ok.detail };
  return { allowed: true, reason: defaultOn ? "default_on" : "enabled" };
}

/**
 * Capability nodes of `needs` must themselves be allowed (per-account ones on the same account). Connection and data
 * nodes are the job's and the snapshot's to check (domain tables), so they count as met here.
 */
async function needsMet(athleteId: string, r: Requirement | null, accountRef: string | null, registry: Registry, env: Env, memo: Memo): Promise<{ met: boolean; detail?: string }> {
  if (!r) return { met: true };
  if ("all" in r) {
    for (const x of r.all) { const m = await needsMet(athleteId, x, accountRef, registry, env, memo); if (!m.met) return m; }
    return { met: true };
  }
  if ("any" in r) {
    let last: { met: boolean; detail?: string } = { met: false };
    for (const x of r.any) { last = await needsMet(athleteId, x, accountRef, registry, env, memo); if (last.met) return last; }
    return last;
  }
  if ("capability" in r) {
    const dep = lookup(registry, r.capability);
    const ref = dep?.scope === "per_account" ? accountRef : null;
    const res = await check(athleteId, r.capability, ref, undefined, registry, env, memo);
    return res.allowed ? { met: true } : { met: false, detail: `${r.capability}: ${res.reason}` };
  }
  return { met: true };
}
