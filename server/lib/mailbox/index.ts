/**
 * mailbox/index.ts — adapter registry, the live-read flag, and retry.
 *
 * Consumers call getMailboxAdapter(provider) and never import a provider module.
 * Tests swap an adapter in with setMailboxAdapterForTests, which is the boundary they
 * mock: no test reaches Gmail.
 */

import type { MailboxAdapter, MailboxProvider } from "./types";
import { MailboxError } from "./types";

export * from "./types";

/**
 * MAILBOX_LIVE_READS — when "true", conversation readers fetch from the mailbox instead
 * of stored inbox_messages bodies, and new mail's PDFs are not rehosted. Default OFF:
 * with it off every reader behaves exactly as before.
 */
export function mailboxLiveReadsEnabled(): boolean {
  return process.env.MAILBOX_LIVE_READS?.trim().toLowerCase() === "true";
}

const overrides = new Map<MailboxProvider, MailboxAdapter | null>();

/** Map a connected_accounts.platform to a mailbox provider, or null when it is not a mailbox. */
export function mailboxProviderOf(platform: string | null | undefined): MailboxProvider | null {
  return platform === "gmail" || platform === "outlook" ? platform : null;
}

/**
 * The adapter for a provider, or null when none is implemented. A null means "this
 * provider has no live reader" — callers keep their stored path for it rather than
 * treating it as a failure.
 */
export async function getMailboxAdapter(provider: MailboxProvider): Promise<MailboxAdapter | null> {
  if (overrides.has(provider)) return overrides.get(provider) ?? null;
  if (provider === "gmail") return (await import("./gmailAdapter.js")).gmailAdapter;
  if (provider === "outlook") return (await import("./outlookAdapter.js")).outlookAdapter;
  return null;
}

/** Test seam: install (or with null, remove) an adapter for a provider. */
export function setMailboxAdapterForTests(provider: MailboxProvider, adapter: MailboxAdapter | null | undefined): void {
  if (adapter === undefined) overrides.delete(provider);
  else overrides.set(provider, adapter);
}

const RETRYABLE = new Set(["transient", "rate_limited"]);

/** The longest provider-requested wait (Retry-After) a read will sit through before giving up. */
const RETRY_AFTER_CAP_MS = Number(process.env.MAILBOX_RETRY_AFTER_CAP_MS ?? 10_000);

/**
 * Run a read, retrying transient/rate-limited failures with exponential backoff.
 * disconnected / not_found are final on the first answer. When the provider said how
 * long to wait (Retry-After), that wait is honoured instead — and a wait longer than
 * RETRY_AFTER_CAP_MS is final now rather than a request held open. Reads only — this
 * never falls back to anything that writes.
 */
export async function withMailboxRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? Number(process.env.MAILBOX_RETRY_BASE_MS ?? 250);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const retryable = err instanceof MailboxError ? RETRYABLE.has(err.kind) : false;
      if (!retryable || i === attempts - 1) throw err;
      const asked = (err as MailboxError).retryAfterMs;
      if (asked != null && asked > RETRY_AFTER_CAP_MS) throw err;
      await new Promise((r) => setTimeout(r, Math.max(baseMs * 2 ** i, asked ?? 0)));
    }
  }
  throw last;
}

/** Lower-cased bare address out of a From header ("Name <a@b.com>" → "a@b.com"). */
export function addressOf(from: string | null | undefined): string | null {
  const s = (from ?? "").trim();
  if (!s) return null;
  const m = s.match(/<([^>]+)>/);
  const addr = (m ? m[1] : s).trim().toLowerCase();
  return addr.includes("@") ? addr : null;
}

/** Display name out of a From header, or null. */
export function displayNameOf(from: string | null | undefined): string | null {
  const s = (from ?? "").trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*</);
  const name = m?.[1]?.trim();
  return name ? name : null;
}

/** Direction by ownership: mail from one of the account's own addresses is outbound. */
export function directionFor(fromEmail: string | null, ownAddresses: Iterable<string>): "inbound" | "outbound" {
  if (!fromEmail) return "inbound";
  for (const a of ownAddresses) if (a && a.toLowerCase() === fromEmail) return "outbound";
  return "inbound";
}
