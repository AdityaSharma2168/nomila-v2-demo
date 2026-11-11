/**
 * gmailSender.ts — transactional email through Google Workspace's Gmail API, sent AS the company address.
 *
 * Selected by EMAIL_PROVIDER=gmail (lib/notify.ts) — the only email provider. Auth is KEYLESS domain-wide delegation —
 * no key file:
 *
 *   1. The runtime service account (Cloud Run's identity, via ADC / the metadata server) gets its own access token.
 *   2. With it, the IAM Credentials API signs a JWT *as that same service account* (signJwt):
 *        iss = the service account, sub = the From address, scope = gmail.send ONLY, aud = the token endpoint.
 *      This needs roles/iam.serviceAccountTokenCreator granted to the runtime account on itself.
 *   3. oauth2.googleapis.com/token exchanges the signed JWT (jwt-bearer grant) for an access token that acts as the
 *      From address. This needs the Workspace Admin domain-wide delegation entry (client ID → gmail.send); until it
 *      exists Google answers `unauthorized_client`, which is surfaced as a named, actionable error.
 *   4. users.messages.send posts a base64url MIME message (UTF-8 subject, text + HTML parts, Reply-To).
 *
 * The same delegation also mints the partner inbox's gmail.modify token (getDelegatedGmailToken, used only by
 * services/partner/inboundMail.ts for the one partner mailbox); every token is requested for exactly one scope.
 *
 * Tokens are cached per (address, scope) for ~55 minutes. 429/5xx are retried with exponential backoff (Retry-After
 * honoured, capped). A per-day counter (GMAIL_DAILY_CAP, default 1500) refuses sends past the cap and logs an alert
 * when it is getting close. The counter is per process (one Cloud Run instance) and resets at UTC midnight —
 * deliberately simple; Workspace's own per-user limit (~2000/day) is the hard backstop.
 *
 * Logging NEVER includes an access token, a signed JWT, the message body or a full recipient address (domain only).
 */

import { GoogleAuth } from "google-auth-library";
import { createLogger } from "../logger";

const logger = createLogger("notify/gmail");

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Read + label the partner inbox only (services/partner/inboundMail.ts). Never used for sending. */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const DEFAULT_RUNTIME_SERVICE_ACCOUNT = "gamechanger-runtime@gamechanger-pocket-agent.iam.gserviceaccount.com";
export const DEFAULT_GMAIL_DAILY_CAP = 1500;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_TTL_MS = 55 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;
/** Fraction of the daily cap at which the "near cap" alert fires (once per day). */
const NEAR_CAP_RATIO = 0.9;

export interface GmailMessage {
  /** "Name <addr@domain>" or a bare address. The address part is the delegated mailbox (JWT sub). */
  from:     string;
  to:       string;
  subject:  string;
  html:     string;
  text?:    string;
  replyTo?: string;
}

export interface GmailSendResult { sent: boolean; id?: string; error?: string }

/** A failure with a stable code a caller/test can match on. Its message never carries a token or a body. */
export class GmailSendError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = "GmailSendError";
  }
}

export interface GmailSenderDeps {
  fetch:          typeof fetch;
  /** Access token for the RUNTIME service account itself (cloud-platform scope) — used only to call signJwt. */
  sourceToken:    () => Promise<string>;
  serviceAccount: string;
  dailyCap:       number;
  now:            () => number;
  sleep:          (ms: number) => Promise<void>;
}

// ── MIME ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Header values can never carry a line break (header injection). */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

/** RFC 2047 encoded-word for non-ASCII header text; plain ASCII passes through. */
export function encodeHeaderWord(s: string): string {
  const v = oneLine(s);
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/** Split "Name <addr>" into its parts; a bare address has no name. */
export function parseAddress(raw: string): { name?: string; address: string } {
  const v = oneLine(raw);
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (m) return { ...(m[1].trim() ? { name: m[1].trim() } : {}), address: m[2] };
  return { address: v };
}

function formatAddress(raw: string): string {
  const { name, address } = parseAddress(raw);
  if (!name) return address;
  const word = encodeHeaderWord(name);
  if (word !== name) return `${word} <${address}>`; // non-ASCII → encoded-word
  const special = /[",;:<>@()[\]\\.]/.test(name);
  return `${special ? `"${name.replace(/["\\]/g, "\\$&")}"` : name} <${address}>`;
}

/** Base64 body wrapped at 76 columns (RFC 2045). */
const b64Body = (s: string): string => (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");

/** Plain-text fallback from HTML when the caller didn't supply one. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Build the RFC 5322 message: multipart/alternative (text/plain then text/html), UTF-8, base64 parts. */
export function buildMime(msg: GmailMessage, opts: { boundary?: string; date?: Date } = {}): string {
  const boundary = opts.boundary ?? `=_nomila_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const text = msg.text ?? htmlToText(msg.html);
  const headers = [
    `From: ${formatAddress(msg.from)}`,
    `To: ${parseAddress(msg.to).address}`,
    ...(msg.replyTo ? [`Reply-To: ${formatAddress(msg.replyTo)}`] : []),
    `Subject: ${encodeHeaderWord(msg.subject)}`,
    `Date: ${(opts.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64Body(msg.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

const base64url = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

// ── sender ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const logRecipient = (to: string): string => to.slice(to.lastIndexOf("@") + 1) || "?";
const isRetryable = (status: number): boolean => status === 429 || status >= 500;

export function createGmailSender(deps: GmailSenderDeps) {
  const tokenCache = new Map<string, { token: string; expiresAt: number }>();
  const counter = { day: "", count: 0, alerted: false };

  const today = (): string => new Date(deps.now()).toISOString().slice(0, 10);

  /** fetch with retry/backoff on 429/5xx and on network errors. Returns the final response (ok or not). */
  async function fetchWithRetry(label: string, url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response | undefined;
      try {
        res = await deps.fetch(url, init);
      } catch (err) {
        lastErr = err;
      }
      if (res && !isRetryable(res.status)) return res;
      if (attempt === MAX_ATTEMPTS) {
        if (res) return res;
        break;
      }
      const retryAfter = res ? Number(res.headers.get("retry-after")) : NaN;
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS)
        : Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS) + Math.floor(Math.random() * 100);
      logger.warn({ step: label, attempt, status: res?.status, error: res ? undefined : (lastErr as Error)?.message, backoffMs: backoff }, "Gmail sender: retrying");
      await deps.sleep(backoff);
    }
    throw new GmailSendError("network", `${label}: ${(lastErr as Error)?.message ?? "request failed"}`);
  }

  /** Short, token-free detail from an error response. */
  async function errorDetail(res: Response): Promise<{ error?: string; description?: string }> {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    try {
      const j = JSON.parse(body);
      if (typeof j.error === "string") return { error: j.error, description: typeof j.error_description === "string" ? j.error_description : undefined };
      if (j.error && typeof j.error === "object") return { error: j.error.status ?? String(j.error.code ?? ""), description: j.error.message };
    } catch { /* not JSON */ }
    return { description: body.slice(0, 200) };
  }

  async function signJwt(fromAddress: string, scope: string): Promise<string> {
    const iat = Math.floor(deps.now() / 1000);
    const payload = { iss: deps.serviceAccount, sub: fromAddress, scope, aud: TOKEN_URL, iat, exp: iat + 3600 };
    const source = await deps.sourceToken();
    const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(deps.serviceAccount)}:signJwt`;
    const res = await fetchWithRetry("signJwt", url, {
      method:  "POST",
      headers: { Authorization: `Bearer ${source}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ payload: JSON.stringify(payload) }),
    });
    if (!res.ok) {
      const d = await errorDetail(res);
      const hint = res.status === 403
        ? " — the runtime service account needs roles/iam.serviceAccountTokenCreator on itself, and the IAM Credentials API must be enabled"
        : "";
      throw new GmailSendError("sign_jwt_failed", `signJwt ${res.status}${d.description ? `: ${d.description}` : ""}${hint}`, res.status);
    }
    const data = (await res.json()) as { signedJwt?: string };
    if (!data.signedJwt) throw new GmailSendError("sign_jwt_failed", "signJwt returned no signedJwt");
    return data.signedJwt;
  }

  async function accessTokenFor(fromAddress: string, scope: string = GMAIL_SEND_SCOPE): Promise<string> {
    const cacheKey = `${scope} ${fromAddress}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > deps.now()) return cached.token;

    const assertion = await signJwt(fromAddress, scope);
    const res = await fetchWithRetry("token", TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!res.ok) {
      const d = await errorDetail(res);
      if (d.error === "unauthorized_client") {
        throw new GmailSendError(
          "delegation_not_configured",
          `Gmail domain-wide delegation is not set up for ${deps.serviceAccount} → ${fromAddress}: add the service account's `
          + `client ID with scope ${scope} in Google Workspace Admin (Security → API controls → Domain-wide delegation)`,
          res.status,
        );
      }
      throw new GmailSendError("token_exchange_failed", `token exchange ${res.status}${d.error ? ` ${d.error}` : ""}${d.description ? `: ${d.description}` : ""}`, res.status);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new GmailSendError("token_exchange_failed", "token exchange returned no access_token");
    // ~55 minutes, never longer than Google says the token lives (minus a minute of slack).
    const ttl = Math.min(TOKEN_TTL_MS, data.expires_in ? (data.expires_in - 60) * 1000 : TOKEN_TTL_MS);
    tokenCache.set(cacheKey, { token: data.access_token, expiresAt: deps.now() + ttl });
    return data.access_token;
  }

  /** Reserve one send against today's cap. False (and an error log) when the cap is reached. */
  function reserve(): boolean {
    const d = today();
    if (counter.day !== d) { counter.day = d; counter.count = 0; counter.alerted = false; }
    if (counter.count >= deps.dailyCap) {
      logger.error({ day: d, count: counter.count, cap: deps.dailyCap }, "ALERT Gmail daily send cap reached — refusing to send");
      return false;
    }
    counter.count += 1;
    if (!counter.alerted && counter.count >= Math.ceil(deps.dailyCap * NEAR_CAP_RATIO)) {
      counter.alerted = true;
      logger.warn({ day: d, count: counter.count, cap: deps.dailyCap }, "ALERT Gmail daily send count is near the cap");
    }
    return true;
  }
  const release = (): void => { if (counter.count > 0) counter.count -= 1; };

  async function send(msg: GmailMessage): Promise<GmailSendResult> {
    const toDomain = logRecipient(msg.to);
    const fromAddress = parseAddress(msg.from).address;
    if (!/^[^@\s]+@[^@\s]+$/.test(fromAddress)) return { sent: false, error: "gmail: invalid from address" };
    if (/[\r\n]/.test(msg.to) || !/^[^@\s]+@[^@\s]+$/.test(parseAddress(msg.to).address)) return { sent: false, error: "gmail: invalid recipient" };
    if (!reserve()) return { sent: false, error: "gmail: daily send cap reached" };

    try {
      let token = await accessTokenFor(fromAddress);
      const raw = base64url(buildMime(msg));
      const post = (t: string) => fetchWithRetry("messages.send", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method:  "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ raw }),
      });
      let res = await post(token);
      if (res.status === 401) {
        // Cached token revoked/expired early — drop it and try once with a fresh one.
        tokenCache.delete(`${GMAIL_SEND_SCOPE} ${fromAddress}`);
        token = await accessTokenFor(fromAddress);
        res = await post(token);
      }
      if (!res.ok) {
        const d = await errorDetail(res);
        release();
        logger.error({ toDomain, status: res.status, error: d.error, detail: d.description }, "Gmail send failed");
        return { sent: false, error: `gmail ${res.status}` };
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      logger.info({ toDomain, id: data.id }, "Email sent via Gmail");
      return { sent: true, id: data.id };
    } catch (err: any) {
      release();
      const code = err instanceof GmailSendError ? err.code : "error";
      logger.error({ toDomain, code, error: err.message }, "Gmail send failed");
      return { sent: false, error: `gmail ${code}: ${err.message}` };
    }
  }

  return {
    send,
    /** A delegated access token acting as `address` for exactly `scope` (cached like the send token). Throws GmailSendError. */
    delegatedToken: (address: string, scope: string): Promise<string> => accessTokenFor(address, scope),
    /** Forget a cached delegated token (after a 401). */
    dropToken: (address: string, scope: string): void => { tokenCache.delete(`${scope} ${address}`); },
    /** Today's count (for tests / diagnostics). */
    sentToday: (): number => (counter.day === today() ? counter.count : 0),
  };
}

// ── default instance (Cloud Run: ADC = the runtime service account) ─────────────────────────────────────────────────

let defaultSender: ReturnType<typeof createGmailSender> | null = null;

function envCap(): number {
  const n = Number(process.env.GMAIL_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GMAIL_DAILY_CAP;
}

export function getGmailSender(): ReturnType<typeof createGmailSender> {
  if (!defaultSender) {
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    defaultSender = createGmailSender({
      fetch:          (...a) => fetch(...a),
      sourceToken:    async () => {
        const client = await auth.getClient();
        const { token } = await client.getAccessToken();
        if (!token) throw new GmailSendError("no_source_token", "could not get an access token for the runtime service account (ADC)");
        return token;
      },
      serviceAccount: process.env.GMAIL_SENDER_SERVICE_ACCOUNT?.trim() || DEFAULT_RUNTIME_SERVICE_ACCOUNT,
      dailyCap:       envCap(),
      now:            () => Date.now(),
      sleep:          (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  }
  return defaultSender;
}

/** A delegated Gmail token for one mailbox and one scope, through the default (runtime service account) instance. */
export function getDelegatedGmailToken(address: string, scope: string): Promise<string> {
  return getGmailSender().delegatedToken(address, scope);
}

/** Test hook: forget the default instance (token cache + counter). */
export function resetGmailSenderForTests(): void { defaultSender = null; }
