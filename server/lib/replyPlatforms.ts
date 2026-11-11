/**
 * replyPlatforms.ts — THE table of platforms a reply can be sent on, and how.
 *
 * Two readers used to keep their own list: the send gate (`sendGate.ts`, "can this card offer
 * Send") and the send path (`sendThreadReply`, an if/else chain per platform). A test pinned the
 * gate's Set to a hard-coded list, so nothing stopped the two from drifting. Now both read this
 * table: the gate's sendable set is DERIVED from it, and `sendThreadReply` dispatches through it,
 * so a platform is sendable exactly when it has a sender here and its switch is on.
 *
 * Pure on purpose: the senders are loaded lazily (dynamic import), so the gate — imported by the
 * card builders and voice — never pulls in the database or a provider client.
 *
 * Nothing here sends by itself. `sendThreadReply` is the only caller of a sender, and it is only
 * reached from the approve endpoint (routes/pendingActions.ts): her tap, the approved-body hash,
 * claim-once, zero retention. A new platform goes through that same gate, unchanged.
 */

import type { ThreadReplyResult } from "../services/threadReply";
import type { MailboxSendContext, MailboxSendFailure } from "../services/replySenders";
import { GMAIL_SEND_SCOPE, OUTLOOK_SEND_SCOPE } from "./connectionScopes";

/**
 * OUTLOOK_SEND — Outlook replies sent from the app through Microsoft Graph. Off by default and
 * in both Cloud Run YAMLs; the live OAuth request does not ask for Mail.Send yet
 * (docs/plans/outlook-send-azure-checklist.md says what changes when it does).
 */
export function outlookSendEnabled(): boolean {
  return process.env.OUTLOOK_SEND?.trim().toLowerCase() === "true";
}

/** A mailbox send: picks the connection, sends, fills `ctx.out`. Returns a failure, or null once sent. */
export type MailboxSender = (ctx: MailboxSendContext) => Promise<MailboxSendFailure | null>;

/** A relay send: the whole reply is someone else's path (it records its own rows). */
export type RelaySender = (athleteId: string, threadId: string, body: string) => Promise<ThreadReplyResult>;

export interface ReplyPlatform {
  /** How the athlete knows this inbox ("Gmail", "Outlook"). */
  label: string;
  /** Is sending on this platform switched on right now. Read at call time (flags). */
  enabled: () => boolean;
  /**
   * Whether a connection's STORED granted scopes let it send. Absent = the platform has no
   * per-grant send scope (Instagram, the Nomila relay).
   */
  grantCanSend?: (scopes: string | null) => boolean;
  /**
   * Shown on a reply card (and in the agent's draft result) when the platform is switched off.
   * Read by the athlete and by Mila: in the Prompt Register (Mila & agent page).
   */
  offWhy?: string;
  /** Shown when sending is on but this connection's grant can't send. Same register. */
  reconnectWhy?: string;
  sender:
    | { kind: "mailbox"; send: MailboxSender }
    | { kind: "relay"; send: RelaySender };
}

const lazyMailbox = (name: "gmailSender" | "instagramSender" | "outlookSender"): MailboxSender =>
  async (ctx) => (await import("../services/replySenders.js"))[name](ctx);

export const REPLY_PLATFORMS: Readonly<Record<string, ReplyPlatform>> = Object.freeze({
  gmail: {
    label: "Gmail",
    enabled: () => true,
    // NULL scopes count as able to send: every Gmail row since late May asked for gmail.send, and
    // a 403 from Google still maps to SCOPE_MISSING at send time (threadInbox.ts).
    grantCanSend: (scopes) => scopes == null || GMAIL_SEND_SCOPE.test(scopes),
    // No reconnectWhy on purpose: a Gmail card's reason is exactly what it was before this table (a grant
    // that can't send is told so by the send itself, SCOPE_MISSING), so Gmail cards don't change here.
    sender: { kind: "mailbox", send: lazyMailbox("gmailSender") },
  },
  instagram: {
    label: "Instagram",
    enabled: () => true,
    sender: { kind: "mailbox", send: lazyMailbox("instagramSender") },
  },
  outlook: {
    label: "Outlook",
    enabled: outlookSendEnabled,
    // No NULL leniency: no Outlook grant has ever asked for Mail.Send, so an unknown is a no.
    grantCanSend: (scopes) => OUTLOOK_SEND_SCOPE.test(scopes ?? ""),
    offWhy: "replies to Outlook mail are sent from Outlook for now",
    reconnectWhy: "Outlook hasn't given Nomila permission to send yet; reconnect Outlook in Settings to allow it",
    sender: { kind: "mailbox", send: lazyMailbox("outlookSender") },
  },
  // A request from her public card: her reply goes through Nomila's relay (services/partner/threads.ts).
  nomila: {
    label: "Nomila",
    enabled: () => true,
    sender: {
      kind: "relay",
      send: async (athleteId, threadId, body) =>
        (await import("../services/partner/threads.js")).replyOnPartnerThread(athleteId, threadId, body),
    },
  },
});

/** The table entry for `platform`, or null. Own keys only, so "constructor" is not a platform. */
export function replyPlatform(platform: string | null | undefined): ReplyPlatform | null {
  if (!platform || !Object.prototype.hasOwnProperty.call(REPLY_PLATFORMS, platform)) return null;
  return REPLY_PLATFORMS[platform];
}

/** The platforms a reply can be sent on right now — derived, never listed by hand. */
export function sendablePlatforms(): string[] {
  return Object.keys(REPLY_PLATFORMS).filter((p) => REPLY_PLATFORMS[p].enabled());
}
