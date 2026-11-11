/**
 * lib/research/providers/youtubeOEmbed.ts — a public YouTube video's existence and title, from YouTube's public oEmbed endpoint.
 *
 * One GET to `https://www.youtube.com/oembed?url=<watch url>&format=json`, short timeout. Metadata only: the small oEmbed JSON
 * is read for its `title` field; the video and its page are never fetched. 200 → { exists: true, title }; anything else (404
 * for a video that does not exist, any other status, an error, a timeout) → { exists: false, title: null }, and the read step
 * treats the source as unavailable (`video_unavailable`) without a model call. The title lets the read step match a grounding
 * chunk (whose web.title is only the domain) to the interview the discovery model described. YouTube only: no other site is
 * checked.
 */

export interface VideoInfo { exists: boolean; title: string | null }
export type VideoInfoLookup = (watchUrl: string) => Promise<VideoInfo>;

export function youtubeOEmbedUrl(watchUrl: string): string {
  return `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
}

const MAX_BODY_BYTES = 16_384;

/** The oEmbed answer for a watch URL. `fetchImpl` is injectable for tests. */
export async function youtubeVideoInfo(watchUrl: string, opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<VideoInfo> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5_000);
  try {
    const res = await f(youtubeOEmbedUrl(watchUrl), { method: "GET", signal: ctrl.signal });
    if (res.status !== 200) { try { await res.body?.cancel(); } catch { /* not read */ } return { exists: false, title: null }; }
    let title: string | null = null;
    try {
      const text = await res.text();
      if (text.length <= MAX_BODY_BYTES) { const j = JSON.parse(text); title = typeof j?.title === "string" && j.title.trim() ? j.title.trim().slice(0, 300) : null; }
    } catch { /* exists, title unknown */ }
    return { exists: true, title };
  } catch {
    return { exists: false, title: null };
  } finally {
    clearTimeout(timer);
  }
}
