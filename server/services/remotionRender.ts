/**
 * remotionRender — the API's side of the motion renderer (media/remotion on Cloud Run, dev).
 *
 * On when REMOTION_RENDER_URL is set (gcp/cloud-run-dev.yaml only). The service is private: each call carries an ID token
 * for this instance's service account, minted by google-auth-library from the metadata server.
 *
 * The renderer holds NO bucket access. Props are built with media-bucket paths as GCS_REF strings
 * (shared/remotionProps.ts); before the call every ref is checked against this athlete (her own `athletes/<id>/` prefix,
 * or the product's shared music / atmosphere) and swapped for a signed READ URL, and the outputs — which must be under
 * her prefix — go as signed WRITE URLs with a fixed content type. A ref that fails the check refuses the render before
 * anything is signed. The URLs live SIGNED_TTL_MS: GCS checks expiry when a request starts, and a render (queue + cold
 * start + up to the service's 900 s timeout) finishes well inside it.
 */
import { GoogleAuth } from "google-auth-library";
import { GCS_REF, gcsRefsIn, mediaSlotsIn, replaceRefs, urlsIn, type CompositionId, type CompositionProps } from "../../shared/remotionProps";
import { signedUploadUrl, signedUrl } from "../lib/mediaStore";
import { createLogger } from "../logger";

const logger = createLogger("remotionRender");

export const remotionRenderUrl = (env: Readonly<Record<string, string | undefined>> = process.env): string | null => {
  const url = env.REMOTION_RENDER_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
};

/** Read and write URLs for one render: 30 min, twice the service's 900 s request timeout. */
export const SIGNED_TTL_MS = 30 * 60_000;
export const VIDEO_CONTENT_TYPE = "video/mp4";
export const POSTER_CONTENT_TYPE = "image/jpeg";

/** The product's own shared objects a render may read for any athlete: licensed + free-library music, beds, atmosphere. */
export const SHARED_MEDIA_PREFIXES = ["studio/tracks/", "studio/beds/", "atmosphere/shared/"] as const;

const cleanPath = (p: unknown): p is string =>
  typeof p === "string" && /^[\w\-./]+$/.test(p) && !p.includes("..") && !p.startsWith("/") && !p.includes("//");
const ownPrefix = (athleteId: string) => `athletes/${athleteId}/`;

/** May this athlete's render READ this bucket path? Hers, or the product's shared media. Pure. */
export function inputPathAllowed(path: unknown, athleteId: string): boolean {
  if (!cleanPath(path) || !cleanPath(athleteId) || athleteId.includes("/")) return false;
  return path.startsWith(ownPrefix(athleteId)) || SHARED_MEDIA_PREFIXES.some((p) => path.startsWith(p));
}

/** May this athlete's render WRITE this bucket path? Only under her own prefix. Pure. */
export function outputPathAllowed(path: unknown, athleteId: string): boolean {
  return cleanPath(path) && cleanPath(athleteId) && !athleteId.includes("/") && path.startsWith(ownPrefix(athleteId));
}

export interface RenderResult { video: string; poster: string | null; durationSec: number; ms: number }

let auth: GoogleAuth | null = null;

/** One render on the service for this athlete. Throws on any failure, including a refused ref (callers fall back). */
export async function renderOnRemotion<C extends CompositionId>(
  athleteId: string,
  composition: C,
  inputProps: CompositionProps[C],
  output: { video: string; poster?: string },
  opts: { timeoutMs?: number } = {},
): Promise<RenderResult> {
  const base = remotionRenderUrl();
  if (!base) throw new Error("REMOTION_RENDER_URL is not set");

  // Tenancy first: nothing is signed unless every path belongs to this render. Media props must be refs (so they pass
  // the check below), and a URL anywhere in the props would reach the renderer unchecked, so neither is allowed.
  if (mediaSlotsIn(composition, inputProps).some((v) => v != null && !(typeof v === "string" && v.startsWith(GCS_REF)))) {
    throw new Error("render media prop is not a media-bucket ref");
  }
  if (urlsIn(inputProps).length) throw new Error("render props carry a URL");
  const refs = gcsRefsIn(inputProps);
  const refused = refs.find((ref) => !inputPathAllowed(ref.slice(GCS_REF.length), athleteId));
  if (refused) throw new Error(`render input outside this athlete's media: ${refused.slice(0, 120)}`);
  if (!outputPathAllowed(output.video, athleteId) || (output.poster !== undefined && !outputPathAllowed(output.poster, athleteId))) {
    throw new Error("render output outside this athlete's media");
  }

  const map: Record<string, string> = {};
  await Promise.all(refs.map(async (ref) => { map[ref] = await signedUrl(ref.slice(GCS_REF.length), SIGNED_TTL_MS); }));
  const videoPutUrl = await signedUploadUrl(output.video, VIDEO_CONTENT_TYPE, SIGNED_TTL_MS);
  const posterPutUrl = output.poster ? await signedUploadUrl(output.poster, POSTER_CONTENT_TYPE, SIGNED_TTL_MS) : undefined;

  auth ??= new GoogleAuth();
  const client = await auth.getIdTokenClient(base);
  const started = Date.now();
  const res = await client.request<{ ok: boolean; error?: string; durationSec: number; ms: number }>({
    url: `${base}/render`, method: "POST",
    data: { composition, inputProps: replaceRefs(inputProps, map), output: { ...output, videoPutUrl, posterPutUrl } },
    timeout: opts.timeoutMs ?? 9 * 60_000, validateStatus: () => true,
  });
  if (res.status !== 200 || !res.data?.ok) {
    throw new Error(`render service ${res.status}: ${String(res.data?.error ?? "no body").slice(0, 200)}`);
  }
  logger.info({ composition, ms: Date.now() - started, durationSec: res.data.durationSec }, "remotion render done");
  return { video: output.video, poster: output.poster ?? null, durationSec: res.data.durationSec, ms: res.data.ms };
}
