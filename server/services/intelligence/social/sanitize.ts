/**
 * social/sanitize.ts — the secret-sanitization contract for raw payloads (Step 1 design §3).
 *
 * Applied to every provider envelope before it is persisted to raw_source_payloads or copied
 * into media_assets.native. Six rules, in order:
 *   1. exact-value redaction of the live secrets passed in (the connection's access and refresh
 *      tokens, the discovery token, API keys) — anywhere, inside any string;
 *   2. key-name redaction: any object key matching SECRET_KEY has its value replaced, at any depth;
 *   3. URL handling: a string that parses as a URL loses its query string when any parameter
 *      matches SECRET_KEY or a known CDN signing name; `paging` objects are dropped entirely
 *      (Graph paging URLs embed the token) and replaced by the bare cursor;
 *   4. request records keep only allow-listed parameters (see requestRecord);
 *   5. assertNoSecrets re-scans the final JSON text and throws — the caller refuses the insert
 *      and fails the sync run with reason sanitizer_leak; it never degrades to storing;
 *   6. every payload row carries SANITIZER_VERSION.
 *
 * Pure. No database, no provider imports.
 */

export const SANITIZER_VERSION = "v1";

export const SECRET_KEY = /^(access_token|refresh_token|id_token|client_secret|authorization|api_key|apikey|key|secret|password|signature|sig|x-signature|x-expires|oh|oe|_nc_.*|refresh_token)$/i;
/** Known token shapes, redacted even when the caller did not pass them as live secrets. */
const TOKEN_SHAPES = [/EAA[A-Za-z0-9]{100,}/g, /\bya29\.[A-Za-z0-9._-]{30,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g];
const REDACTED = "<redacted:secret>";

export interface SanitizeReport { redactedValues: number; redactedKeys: number; strippedUrls: number; droppedPaging: number }

function replaceSecrets(s: string, secrets: string[]): { out: string; hits: number } {
  let out = s, hits = 0;
  for (const sec of secrets) {
    if (sec && sec.length >= 8 && out.includes(sec)) { out = out.split(sec).join(REDACTED); hits++; }
  }
  for (const re of TOKEN_SHAPES) {
    if (re.test(out)) { out = out.replace(re, REDACTED); hits++; }
    re.lastIndex = 0;
  }
  return { out, hits };
}

function stripUrl(s: string): { out: string; stripped: boolean } {
  if (!/^https?:\/\//i.test(s)) return { out: s, stripped: false };
  let u: URL;
  try { u = new URL(s); } catch { return { out: s, stripped: false }; }
  let hit = false;
  for (const k of [...u.searchParams.keys()]) if (SECRET_KEY.test(k)) { hit = true; break; }
  if (!hit) return { out: s, stripped: false };
  u.search = "";
  return { out: u.toString(), stripped: true };
}

/**
 * Deep-clean a value. Returns a new tree; the input is not mutated.
 * `secrets` are the live credential strings for this call; they never reach the output.
 */
export function sanitizePayload<T = unknown>(value: T, secrets: string[] = []): { out: T; report: SanitizeReport } {
  const report: SanitizeReport = { redactedValues: 0, redactedKeys: 0, strippedUrls: 0, droppedPaging: 0 };
  const rec = (x: unknown): unknown => {
    if (typeof x === "string") {
      const r = replaceSecrets(x, secrets); report.redactedValues += r.hits;
      const u = stripUrl(r.out); if (u.stripped) report.strippedUrls++;
      return u.out;
    }
    if (Array.isArray(x)) return x.map(rec);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (k === "paging") {
          report.droppedPaging++;
          const cursors = (v as any)?.cursors;
          if (cursors && typeof cursors === "object") o.paging_cursors = rec(cursors);
          continue;
        }
        if (SECRET_KEY.test(k)) { report.redactedKeys++; o[k] = REDACTED; continue; }
        o[k] = rec(v);
      }
      return o;
    }
    return x;
  };
  return { out: rec(value) as T, report };
}

const LEAK = /access_token=|refresh_token=|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|client_secret|EAA[A-Za-z0-9]{100,}|ya29\.[A-Za-z0-9._-]{30,}|AIza[0-9A-Za-z_-]{30,}/;

export class SanitizerLeakError extends Error {
  constructor(public readonly where: string) { super(`sanitizer_leak: a secret-like string survived sanitization (${where})`); }
}

/** Final gate before an insert. Throws SanitizerLeakError; never returns a degraded value. */
export function assertNoSecrets(value: unknown, secrets: string[] = [], where = "payload"): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (LEAK.test(text)) throw new SanitizerLeakError(where);
  for (const sec of secrets) if (sec && sec.length >= 8 && text.includes(sec)) throw new SanitizerLeakError(`${where}: live secret`);
}

/** The only request parameters a stored request record may carry. */
export const REQUEST_PARAM_ALLOWLIST = new Set([
  "fields", "metric", "metric_type", "period", "timeframe", "breakdown", "limit", "since", "until", "after", "before",
  "cursor", "max_count", "pageToken", "maxResults", "part", "id", "ids", "playlistId", "channelId", "forHandle",
  "dimensions", "metrics", "startDate", "endDate", "sort", "order", "type", "mine",
]);

export function requestRecord(input: { path: string; params?: Record<string, unknown>; pageIndex?: number }): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.params ?? {})) if (REQUEST_PARAM_ALLOWLIST.has(k)) params[k] = v;
  return { path: input.path, params, pageIndex: input.pageIndex ?? 0 };
}
