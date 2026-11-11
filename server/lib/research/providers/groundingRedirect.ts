/**
 * lib/research/providers/groundingRedirect.ts — resolve a Google Search grounding redirect to the source's real URL.
 *
 * Search grounding never shows the model a page's address: every grounded source arrives as a
 * `vertexaisearch.cloud.google.com/grounding-api-redirect/…` link, and the discovery answer repeats it as the athlete_media URL.
 * The targeted source read must read (and store as source_url) the real page, so before selection the read step follows such a
 * link ONCE and keeps the Location it points to. This is URL resolution only: one request, redirects not followed further,
 * the response body never read. Anything else — a non-redirect response, an error, a timeout — resolves to null and the source
 * stays unreadable, exactly as before.
 */

const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const GROUNDING_REDIRECT_PATH = "/grounding-api-redirect/";

/** True for a Google Search grounding redirect link (the only kind this module resolves). */
export function isGroundingRedirect(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.hostname.toLowerCase() === GROUNDING_REDIRECT_HOST && u.pathname.startsWith(GROUNDING_REDIRECT_PATH);
  } catch { return false; }
}

export type RedirectResolver = (url: string) => Promise<string | null>;

/** The real URL behind a grounding redirect, or null. `fetchImpl` is injectable for tests. */
export async function resolveGroundingRedirect(url: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<string | null> {
  if (!isGroundingRedirect(url)) return null;
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5_000);
  try {
    const res = await f(url, { method: "GET", redirect: "manual", signal: ctrl.signal });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    try { await res.body?.cancel(); } catch { /* the body is never read */ }
    if (!location) return null;
    const target = new URL(location, url);
    if (!/^https?:$/.test(target.protocol) || isGroundingRedirect(target.href)) return null;
    return target.href;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
