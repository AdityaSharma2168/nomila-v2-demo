/**
 * inboxBodyFingerprint.ts — the ONE fingerprint of a stored inbox message's text (inbox_messages.body_sha256, 0086).
 *
 * SHA-256 over the UTF-8 bytes of the TRIMMED text, lowercase hex — shared/bodyHash.ts does the hashing. Trimmed,
 * because the echo gate it serves has always matched on trimmed text: the in-app reply stores `body.trim()`, and the
 * provider's copy of that same send comes back with whatever whitespace the mailbox added at the ends.
 *
 * Hashed over the FULL text, before any storage clamp, so two long messages that share their first 8000 characters
 * do not collide.
 */
import { bodySha256 } from "../../shared/bodyHash";

export function inboxBodyFingerprint(body: string): string;
export function inboxBodyFingerprint(body: string | null | undefined): string | null;
export function inboxBodyFingerprint(body: string | null | undefined): string | null {
  if (body == null) return null;
  return bodySha256(body.trim());
}
