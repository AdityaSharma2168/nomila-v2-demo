/**
 * transfer.ts — how the render service moves bytes now that it holds NO bucket access of its own.
 *
 * The API hands it, per render, a signed READ URL for each input and a signed WRITE URL for each output
 * (server/services/remotionRender.ts). This file is the only place those URLs are used:
 *
 *   checkRequest  the body is well formed, and EVERY URL in it (inputs and outputs) is a signed Cloud Storage URL —
 *                 https://storage.googleapis.com/..., nothing else. Anything else is refused before a byte moves, so
 *                 the service (and its headless browser) can never be pointed at an internal or arbitrary host.
 *   fetchInput    GET one input, no redirects, a byte cap and a timeout.
 *   putOutput     PUT one output with EXACTLY the content type its URL was signed for.
 *
 * No dependencies beyond Node's own fetch, so the API's Jest suite tests it directly (remotionTransfer.test.ts).
 */
import { COMPOSITIONS, GCS_REF, gcsRefsIn, mediaSlotsIn, urlsIn, type CompositionId } from "../../../shared/remotionProps";

/** The one host our signer emits (path-style: https://storage.googleapis.com/<bucket>/<object>?X-Goog-...). */
export const SIGNED_URL_HOST = "storage.googleapis.com";
/** Per input. Her photos are stills (the API's own reads cap at 40 MB); a music bed is a few MB. */
export const MAX_INPUT_BYTES = 50 * 1024 * 1024;
/** Per render. A reel has at most 7 photos and a bed; the cap bounds memory (inputs x MAX_INPUT_BYTES). */
export const MAX_INPUTS = 16;
export const INPUT_TIMEOUT_MS = 60_000;
export const OUTPUT_TIMEOUT_MS = 120_000;
export const VIDEO_CONTENT_TYPE = "video/mp4";
export const POSTER_CONTENT_TYPE = "image/jpeg";

type FetchLike = typeof fetch;

/** True only for an https URL on exactly storage.googleapis.com (default port, no credentials in it). */
export function isSignedStorageUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  return u.protocol === "https:" && u.hostname === SIGNED_URL_HOST && u.port === "" && !u.username && !u.password;
}

export interface RenderRequest {
  composition: CompositionId;
  inputProps: Record<string, unknown>;
  output: { videoPutUrl: string; posterPutUrl: string | null };
  /** The signed READ URLs in the props, in order, deduped. */
  inputs: string[];
}

/** The body, checked. A string error is the reason it is refused (a 400). */
export function checkRequest(body: unknown): RenderRequest | { error: string } {
  const { composition, inputProps, output } = (body ?? {}) as Record<string, any>;
  if (!COMPOSITIONS.includes(composition)) return { error: "bad composition" };
  if (!inputProps || typeof inputProps !== "object" || Array.isArray(inputProps)) return { error: "bad inputProps" };
  if (!isSignedStorageUrl(output?.videoPutUrl)) return { error: "output.videoPutUrl must be a signed storage URL" };
  const wantsPoster = output.poster != null || output.posterPutUrl != null;
  if (wantsPoster && !isSignedStorageUrl(output.posterPutUrl)) return { error: "output.posterPutUrl must be a signed storage URL" };
  // The API swaps every ref for a URL; an unsigned ref left behind is a caller bug, and this service cannot read it.
  if (gcsRefsIn(inputProps).length) return { error: `unsigned ${GCS_REF} ref in inputProps` };
  const inputs = urlsIn(inputProps);
  if (inputs.some((u) => !isSignedStorageUrl(u))) return { error: "inputProps may only reference signed storage URLs" };
  // The props the browser loads (<Img> / <Audio> src) must each be nothing or a signed storage URL: no local path,
  // data: or any other scheme can reach Chromium through them, whatever the URL scan above would make of it.
  if (mediaSlotsIn(composition, inputProps).some((v) => v != null && !isSignedStorageUrl(v))) return { error: "a media prop is not a signed storage URL" };
  if (inputs.length > MAX_INPUTS) return { error: "too many inputs" };
  return { composition, inputProps, output: { videoPutUrl: output.videoPutUrl, posterPutUrl: wantsPoster ? output.posterPutUrl : null }, inputs };
}

/** GET one signed input into memory: storage host only, no redirects, at most `maxBytes`, within `timeoutMs`. */
export async function fetchInput(
  url: string, opts: { maxBytes?: number; timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<Buffer> {
  if (!isSignedStorageUrl(url)) throw new Error("input host refused");
  const maxBytes = opts.maxBytes ?? MAX_INPUT_BYTES;
  const res = await (opts.fetchImpl ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? INPUT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`input fetch ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("input too large");
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new Error("input too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** PUT one output to its signed WRITE URL with exactly the content type it was signed for. */
export async function putOutput(
  url: string, body: Buffer, contentType: string, opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<void> {
  if (!isSignedStorageUrl(url)) throw new Error("output host refused");
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: "PUT", body: new Uint8Array(body), headers: { "Content-Type": contentType }, redirect: "error",
    signal: AbortSignal.timeout(opts.timeoutMs ?? OUTPUT_TIMEOUT_MS),
  });
  // Only storage's error <Code>: the rest of its XML echoes the canonical request, which is no place for a log line.
  if (!res.ok) {
    const code = /<Code>([\w.-]{1,64})<\/Code>/.exec(await res.text().catch(() => ""))?.[1];
    throw new Error(`output put ${res.status}${code ? `: ${code}` : ""}`);
  }
}
