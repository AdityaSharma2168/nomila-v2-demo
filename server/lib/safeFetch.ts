/**
 * safeFetch — a GET for a URL this server did not choose, refused anywhere inside our own network,
 * and connected ONLY to the address that was checked.
 *
 * WHY (docs/studio-brandimage-ssrf-card.md): brandImage fetches a brand's homepage from a domain an
 * inbox sender can choose, then fetches every <img> the page names, following redirects with no host
 * check at any hop — so a hostile page could make Cloud Run request the metadata server or any
 * internal address. Today only incidental details (a missing header, a mime filter) stop the worst
 * case. This is the check by design. PR 4 (C4), Mia-cleared for this PR.
 *
 * WHAT IS REFUSED, at the first URL and again at EVERY redirect hop:
 *   - any scheme but https:
 *   - `metadata.google.internal` (and `metadata`), `localhost`, and any `*.localhost` / `*.internal`
 *   - a host that is, or resolves to, a non-public address: loopback, RFC 1918, CGNAT (100.64/10),
 *     link-local (169.254/16 — the metadata server's IP — and fe80::/10), ULA (fc00::/7), 0.0.0.0/8,
 *     benchmarking (198.18/15), multicast and reserved, IPv4-mapped IPv6 of any of those
 *   - more than MAX_HOPS redirects
 *
 * Redirects are followed by hand: a 3xx and its Location come back to this loop, and the next hop is
 * resolved, checked and pinned on its own before it is requested.
 *
 * ─── DNS REBINDING — CLOSED (PR 7, Lane F1) ─────────────────────────────────────────────────────────
 *
 * The address is checked here AND the connection is made to that address. The request goes through
 * node:https with a `lookup` that answers the checked addresses and never asks DNS again — so a name
 * that answers public to the check and private to the connect is connected to the public address it
 * was checked as. Every address the check saw was public, so handing them all back (node's own
 * happy-eyeballs picks among them) is still a pin. TLS still verifies the certificate against the
 * HOSTNAME — SNI and the name check come from the request's host, not the socket's address — so the
 * pin changes where the socket goes, never what it trusts. Each hop is one lookup, one connection.
 * ⚠️ MUTATION "re-resolve allowed" (safeFetch.test): drop the `lookup` option — "the connection is
 * pinned to the checked address — a name that answers public then private is never re-resolved"
 * reds by name.
 *
 * Why node:https and not a fetch dispatcher: pinning fetch's connect needs undici's Agent, and undici
 * is not a direct dependency (it is in node_modules only as Expo's CLI's). node:https takes `lookup`
 * directly. The answer is wrapped back into a web Response, so callers that read `.ok`, `.status`,
 * `.headers`, `.url`, `.text()` and `.arrayBuffer()` see what fetch gave them — including a gzip /
 * br / deflate body decoded, which fetch did and https does not. No Accept-Encoding is sent, so an
 * encoded body is the server's own choice; when it happens it is decoded here.
 *
 * No new dependency: node's `net.BlockList`, `dns.promises.lookup`, `node:https`, `node:zlib`. The
 * resolver and the request are injectable so the tests never touch DNS or the network. `fetchImpl`
 * remains as the older test seam; an injected fetch is NOT pinned — tests only, production always pins.
 */
import { BlockList, isIP, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { createLogger } from "../logger";

const logger = createLogger("safe-fetch");

export const MAX_HOPS = 5;

/** Why a URL was refused — the reason a log line or a test names. */
export type UnsafeReason =
  | "scheme"
  | "bad_url"
  | "blocked_host"
  | "private_address"
  | "unresolvable"
  | "too_many_redirects"
  | "hop_not_allowed";

export class UnsafeUrlError extends Error {
  readonly code = "unsafe_url" as const;
  constructor(
    readonly url: string,
    readonly reason: UnsafeReason,
  ) {
    super(`refused ${reason}: ${url}`);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
] as const)
  BLOCKED.addSubnet(net, prefix, "ipv6");

/** Names refused before any lookup — the metadata server answers to both. */
const BLOCKED_NAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "localhost",
]);

/** Whether an IP literal is outside the public internet. An IPv4-mapped IPv6 is judged as its IPv4. */
export function isBlockedAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return BLOCKED.check(mapped[1], "ipv4");
  const family = isIP(ip);
  if (family === 4) return BLOCKED.check(ip, "ipv4");
  if (family === 6) return BLOCKED.check(ip, "ipv6");
  return true; // not an address at all: refuse rather than guess
}

export type Resolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true });

/** The addresses a connection may be made to — every one of them checked public. */
export interface Pin {
  addresses: { address: string; family: number }[];
}

/** Parse and check one URL, and keep what it was checked AS. Throws UnsafeUrlError when it may not be requested. */
export async function checkAndResolve(
  raw: string,
  resolve: Resolver = defaultResolver,
): Promise<{ url: URL; pin: Pin }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(raw, "bad_url");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError(raw, "scheme");
  // URL keeps IPv6 literals in brackets and may keep a trailing dot; neither changes the host.
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    BLOCKED_NAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  )
    throw new UnsafeUrlError(raw, "blocked_host");
  const literal = isIP(host);
  if (literal) {
    if (isBlockedAddress(host))
      throw new UnsafeUrlError(raw, "private_address");
    return { url, pin: { addresses: [{ address: host, family: literal }] } };
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new UnsafeUrlError(raw, "unresolvable");
  }
  if (addrs.length === 0) throw new UnsafeUrlError(raw, "unresolvable");
  // EVERY answer must be public: a name with one private A record is a private name.
  if (addrs.some((a) => isBlockedAddress(a.address)))
    throw new UnsafeUrlError(raw, "private_address");
  return {
    url,
    pin: {
      addresses: addrs.map((a) => ({ address: a.address, family: a.family })),
    },
  };
}

/** Parse and check one URL. Returns the URL when it may be requested; throws UnsafeUrlError when not. */
export async function checkUrl(
  raw: string,
  resolve: Resolver = defaultResolver,
): Promise<URL> {
  return (await checkAndResolve(raw, resolve)).url;
}

// ─── The pinned request ──────────────────────────────────────────────────────────────────────────

/** The one function that opens a connection: node's https.request in production, a stub in tests. */
export type RequestFn = (options: RequestOptions) => ClientRequest;

/**
 * A `lookup` that answers from the pin and never asks DNS. node's connect calls it with `all: true`
 * (happy-eyeballs over every address) or without (one address); both shapes answer only checked
 * addresses.
 */
export const pinnedLookup =
  (pin: Pin): LookupFunction =>
  (_hostname, options, callback) => {
    const all = typeof options === "object" && options !== null && options.all;
    if (all) callback(null, pin.addresses.map((a) => ({ address: a.address, family: a.family })));
    else callback(null, pin.addresses[0].address, pin.addresses[0].family);
  };

/** RequestInit headers, in any of their three shapes, as the plain object https.request takes. */
function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
    return out;
  }
  return { ...h };
}

/** Statuses a Response may not carry a body for (the constructor refuses one). */
const NULL_BODY = new Set([204, 205, 304]);

/**
 * An IncomingMessage as the web Response the callers already read. The body streams; an encoded body
 * is decoded (and its encoding/length headers dropped, since they no longer describe the bytes).
 * `url` is the hop that answered, as fetch reports it — brandImage resolves relative image refs
 * against it.
 */
function toResponse(url: URL, res: IncomingMessage): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599) {
    res.resume();
    throw new Error(`safeFetch: unexpected status ${status} from ${url.host}`);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.append(k, v);
  }
  let body: ReadableStream<Uint8Array> | null = null;
  if (NULL_BODY.has(status)) {
    res.resume();
  } else {
    const encoding = (res.headers["content-encoding"] ?? "").toLowerCase();
    let stream: Readable = res;
    if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(createGunzip());
    else if (encoding === "br") stream = res.pipe(createBrotliDecompress());
    else if (encoding === "deflate") stream = res.pipe(createInflate());
    if (stream !== res) {
      headers.delete("content-encoding");
      headers.delete("content-length");
    }
    // node's web ReadableStream and the global's are one runtime type under two declarations.
    body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  }
  const response = new Response(body, {
    status,
    statusText: res.statusMessage ?? "",
    headers,
  });
  // `url` is a prototype getter the constructor cannot set; an own property carries the hop.
  Object.defineProperty(response, "url", { value: url.toString(), configurable: true });
  return response;
}

/** One GET to `url`, connected to its pin. Resolves on headers; the body streams behind the Response. */
function pinnedRequest(
  url: URL,
  pin: Pin,
  init: Omit<RequestInit, "redirect">,
  request: RequestFn,
): Promise<Response> {
  if (init.body !== undefined && init.body !== null)
    return Promise.reject(new Error("safeFetch is a GET: it carries no body"));
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers: headerRecord(init.headers),
    lookup: pinnedLookup(pin),
    ...(init.signal ? { signal: init.signal } : {}),
  };
  return new Promise<Response>((resolveResponse, reject) => {
    let req: ClientRequest;
    try {
      req = request(options);
    } catch (err) {
      reject(err);
      return;
    }
    req.once("response", (res: IncomingMessage) => {
      try {
        resolveResponse(toResponse(url, res));
      } catch (err) {
        reject(err);
      }
    });
    req.once("error", reject);
    req.end();
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A GET that follows at most MAX_HOPS redirects by hand, checking every URL before it is requested
 * and connecting each hop only to the address it was checked as.
 * Throws UnsafeUrlError on a refusal (callers already treat a throw as "no page" / "no image").
 * ⚠️ MUTATION (safeFetch.test): follow the redirect with `redirect: "follow"` and no hop check —
 * "a redirect to the metadata server is refused at the hop" reds by name.
 */
export async function safeFetch(
  raw: string,
  init: Omit<RequestInit, "redirect"> = {},
  deps: {
    resolve?: Resolver;
    /** TEST SEAM ONLY — an injected fetch is not pinned. Production always takes the request path. */
    fetchImpl?: typeof fetch;
    request?: RequestFn;
    /**
     * Caller policy, checked on EVERY url including the first: false refuses it (hop_not_allowed). Own-site brand
     * imagery passes "same registrable domain", so a redirect to another site is never followed.
     */
    allowHop?: (url: URL) => boolean;
  } = {},
): Promise<Response> {
  const resolve = deps.resolve ?? defaultResolver;
  const request = deps.request ?? httpsRequest;
  let current = raw;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let checked: { url: URL; pin: Pin };
    try {
      if (deps.allowHop) {
        let parsed: URL;
        try { parsed = new URL(current); } catch { throw new UnsafeUrlError(current, "bad_url"); }
        if (!deps.allowHop(parsed)) throw new UnsafeUrlError(current, "hop_not_allowed");
      }
      checked = await checkAndResolve(current, resolve);
    } catch (err) {
      if (err instanceof UnsafeUrlError)
        logger.warn(
          { url: current, reason: err.reason, hop },
          "safeFetch refused a URL",
        );
      throw err;
    }
    const res = deps.fetchImpl
      ? await deps.fetchImpl(current, { ...init, redirect: "manual" })
      : await pinnedRequest(checked.url, checked.pin, init, request);
    const location = REDIRECTS.has(res.status)
      ? res.headers.get("location")
      : null;
    if (!location) return res;
    // Drop the redirect's body before the next hop; its connection is not needed.
    await res.body?.cancel().catch(() => {});
    current = new URL(location, current).toString();
  }
  logger.warn({ url: raw, hops: MAX_HOPS }, "safeFetch refused a URL");
  throw new UnsafeUrlError(raw, "too_many_redirects");
}
