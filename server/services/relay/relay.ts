/**
 * relay/relay.ts — the ONE relay every Nomila-carried conversation goes through (design §7a: "one service, two stores").
 *
 * A message is never sent person to person. submitRelayMessage():
 *   1. checks the body (not empty, at most RELAY_MAX_CHARS) and the per-thread, per-sender rate limit;
 *   2. moderates it (relay/moderation.ts): clean | held | blocked, with the reasons;
 *   3. writes it to the thread's OWN home through the home's adapter, with that state;
 *   4. only when clean, delivers it: the home sends its content-free notice / flips its turn state.
 * Held and blocked messages are kept (for review) but never delivered; the sender sees "This message is being checked".
 *
 * Homes: a partner request's thread on her opportunity (inbox_messages, platform 'nomila' — services/partner/threads.ts)
 * today; a booking's booking_messages when Book lands (it implements RelayHome the same way). The relay knows nothing
 * about either table.
 */
import { moderateMessage, reasonText, type ModerationState } from "./moderation";
import { take } from "../../lib/publicRateCounters";

export const RELAY_MAX_CHARS = 2_000;
export const RELAY_PER_THREAD_HOUR = 10;

export interface RelayMessageIn<S extends string> {
  sender: S;
  body: string;
  moderation: ModerationState;
  reason: string | null;
  at: Date;
  /** A delivery id from outside (an inbound email's id): writing the same one twice is a no-op. */
  externalId?: string;
}

export interface RelayHome<S extends string> {
  /** Stable key of the thread for the rate limit ("partner:<request id>", "booking:<booking id>"). */
  threadKey: string;
  /** Store the message in the home's own table. null = it was already stored (same externalId). */
  write(msg: RelayMessageIn<S>): Promise<{ id: string } | null>;
  /** After a CLEAN write: notices, turn state, timestamps. Must not throw for a notice failure. */
  deliver(msg: { id: string; sender: S; at: Date }): Promise<void>;
}

export type RelayResult =
  | { ok: true; id: string; moderation: ModerationState; delivered: boolean; duplicate?: false }
  | { ok: true; duplicate: true }
  | { ok: false; status: 400 | 429; error: string };

/** Normalise line endings and trailing space; the text itself is never rewritten. */
export function normaliseBody(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim() : "";
}

export async function submitRelayMessage<S extends string>(
  home: RelayHome<S>,
  input: { sender: S; body: unknown; externalId?: string; now?: Date },
): Promise<RelayResult> {
  const now = input.now ?? new Date();
  const body = normaliseBody(input.body);
  if (!body) return { ok: false, status: 400, error: "write a message" };
  if (body.length > RELAY_MAX_CHARS) return { ok: false, status: 400, error: `messages are at most ${RELAY_MAX_CHARS.toLocaleString("en-US")} characters` };
  if (!(await take(["relay", home.threadKey, input.sender], RELAY_PER_THREAD_HOUR, "hour", now))) {
    return { ok: false, status: 429, error: "You've sent several messages in the last hour. Please wait a little." };
  }
  const verdict = moderateMessage(body);
  const written = await home.write({ sender: input.sender, body, moderation: verdict.state, reason: reasonText(verdict), at: now, externalId: input.externalId });
  if (!written) return { ok: true, duplicate: true };
  if (verdict.state !== "clean") return { ok: true, id: written.id, moderation: verdict.state, delivered: false };
  await home.deliver({ id: written.id, sender: input.sender, at: now });
  return { ok: true, id: written.id, moderation: "clean", delivered: true };
}
