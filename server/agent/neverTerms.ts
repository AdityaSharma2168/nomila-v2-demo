/**
 * agent/neverTerms.ts — the athlete's never-use terms (e.g. a child's name), parsed from their "avoid" preferences.
 * Pure (no database), so model-input builders and the eval can read it without one; memory.ts re-exports it.
 *
 * An "avoid" preference written as "Never use: Name[, Name]" (or "Never name: …" / "Never mention: …") lists terms the
 * policy blocks in anything outgoing.
 */
import type { Preference } from "../../shared/agent";

export const NEVER_TERMS_RE = /^never\s+(?:use|name|mention)\s*:\s*(.+)$/i;

export function neverTermsFrom(prefs: Array<Pick<Preference, "kind" | "statement" | "status">>): string[] {
  return prefs.filter((p) => p.kind === "avoid" && p.status === "active")
    .flatMap((p) => { const m = NEVER_TERMS_RE.exec(p.statement.trim()); return m ? m[1].split(/[,;]/).map((x) => x.trim()).filter((x) => x.length >= 2) : []; });
}
