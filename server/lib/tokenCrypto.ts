/**
 * tokenCrypto — OAuth tokens at rest, sealed with Cloud KMS envelope encryption.
 *
 * WHAT: connected_accounts.access_token / refresh_token are text columns. With TOKEN_KMS=true every
 * write stores a sealed envelope instead of the token:
 *
 *     "kms1:" + base64url(JSON { v: 1, kid, dek_wrapped, iv, ct, tag })
 *
 *   - a random 256-bit data key (DEK) per write, AES-256-GCM, a fresh 96-bit IV per value;
 *   - the DEK wrapped by Cloud KMS `encrypt` under ONE key, KMS_TOKEN_KEY
 *     (projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>); `kid` records that key so a later
 *     key change still decrypts old rows (KMS picks the right key VERSION from the ciphertext itself);
 *   - v + kid are bound into the GCM additional data, so an edited header fails like an edited body.
 *
 * This is NOT per-athlete crypto-shredding (declined 7 Oct): one KMS key for every row.
 *
 * READS ACCEPT BOTH, ALWAYS. openToken() returns a legacy plain-text value unchanged and decrypts an
 * envelope — whatever TOKEN_KMS says — so flipping the flag off again (rollback) never strands a row that
 * was already sealed. The flag only decides what WRITES store. With the flag off and no sealed rows,
 * behaviour is byte-for-byte what it was.
 *
 * KMS CALLS: one `encrypt` per write (both tokens of a write share the DEK); `decrypt` only on a cache
 * miss — unwrapped DEKs are kept in memory, bounded (DEK_CACHE_MAX) and for DEK_CACHE_TTL_MS.
 * KMS is reached over REST with Application Default Credentials (google-auth-library, already a
 * dependency) — no new package. Tests replace the KMS boundary with __setKmsForTests; the real
 * client refuses to run under jest.
 *
 * Nothing here ever logs or throws token material, DEKs, or ciphertext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";

export const ENVELOPE_PREFIX = "kms1:";

export interface TokenEnvelope {
  v:           1;
  /** The KMS cryptoKey resource name that wrapped the DEK. */
  kid:         string;
  /** KMS ciphertext of the DEK (base64, as KMS returns it). */
  dek_wrapped: string;
  /** base64 */
  iv:          string;
  /** base64 */
  ct:          string;
  /** base64 GCM auth tag */
  tag:         string;
}

/** A failure to seal or open a token. The message never carries the token or key material. */
export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCryptoError";
  }
}

// ── Config ─────────────────────────────────────────────────────────────────────

const KEY_NAME = /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/;

/** TOKEN_KMS=true → writes store sealed envelopes. Default off. */
export function tokenKmsEnabled(): boolean {
  return process.env.TOKEN_KMS?.trim().toLowerCase() === "true";
}

function configuredKey(): string {
  const key = process.env.KMS_TOKEN_KEY?.trim();
  if (!key) throw new TokenCryptoError("TOKEN_KMS is on but KMS_TOKEN_KEY is not set");
  if (!KEY_NAME.test(key)) throw new TokenCryptoError("KMS_TOKEN_KEY is not a cryptoKey resource name (projects/…/locations/…/keyRings/…/cryptoKeys/…)");
  return key;
}

// ── KMS boundary ───────────────────────────────────────────────────────────────

export interface KmsClient {
  /** Wrap (encrypt) a DEK under keyName; returns the KMS ciphertext, base64. */
  wrap(keyName: string, dek: Buffer): Promise<string>;
  /** Unwrap (decrypt) a KMS ciphertext under keyName; returns the DEK. */
  unwrap(keyName: string, wrapped: string): Promise<Buffer>;
}

let auth: GoogleAuth | null = null;

async function kmsPost(path: string, body: Record<string, string>): Promise<any> {
  if (process.env.JEST_WORKER_ID !== undefined) {
    throw new TokenCryptoError("tests must not reach Cloud KMS — use __setKmsForTests");
  }
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloudkms"] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new TokenCryptoError("could not obtain a GCP access token for Cloud KMS");
  let res: Response;
  try {
    res = await fetch(`https://cloudkms.googleapis.com/v1/${path}`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    throw new TokenCryptoError(`Cloud KMS unreachable: ${String(err?.name ?? "error")}`);
  }
  if (!res.ok) {
    // The error body is KMS's own message (permission/key state); it never echoes our plaintext.
    const detail = await res.text().catch(() => "");
    throw new TokenCryptoError(`Cloud KMS ${path.split(":").pop()} failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

const restKms: KmsClient = {
  async wrap(keyName, dek) {
    const out = await kmsPost(`${keyName}:encrypt`, { plaintext: dek.toString("base64") });
    if (typeof out?.ciphertext !== "string") throw new TokenCryptoError("Cloud KMS encrypt returned no ciphertext");
    return out.ciphertext;
  },
  async unwrap(keyName, wrapped) {
    const out = await kmsPost(`${keyName}:decrypt`, { ciphertext: wrapped });
    if (typeof out?.plaintext !== "string") throw new TokenCryptoError("Cloud KMS decrypt returned no plaintext");
    return Buffer.from(out.plaintext, "base64");
  },
};

let kms: KmsClient = restKms;

/** Tests only: replace the KMS boundary (null restores the REST client) and clear the DEK cache. */
export function __setKmsForTests(client: KmsClient | null): void {
  kms = client ?? restKms;
  dekCache.clear();
  inflight.clear();
}

// ── DEK cache ──────────────────────────────────────────────────────────────────

export const DEK_CACHE_MAX    = 1_000;
export const DEK_CACHE_TTL_MS = 15 * 60_000;

/** wrapped DEK → unwrapped DEK. Map order = insertion order, so the first key is the oldest (LRU on hit). */
const dekCache = new Map<string, { dek: Buffer; expiresAt: number }>();
const inflight = new Map<string, Promise<Buffer>>();

function cachePut(wrapped: string, dek: Buffer): void {
  dekCache.delete(wrapped);
  dekCache.set(wrapped, { dek, expiresAt: Date.now() + DEK_CACHE_TTL_MS });
  while (dekCache.size > DEK_CACHE_MAX) dekCache.delete(dekCache.keys().next().value as string);
}

function cacheGet(wrapped: string): Buffer | null {
  const hit = dekCache.get(wrapped);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { dekCache.delete(wrapped); return null; }
  dekCache.delete(wrapped);
  dekCache.set(wrapped, hit);
  return hit.dek;
}

/** Tests/diagnostics: how many DEKs are cached. */
export function dekCacheSize(): number {
  return dekCache.size;
}

async function unwrapDek(kid: string, wrapped: string): Promise<Buffer> {
  const cached = cacheGet(wrapped);
  if (cached) return cached;
  const pending = inflight.get(wrapped);
  if (pending) return pending;
  const p = kms.unwrap(kid, wrapped)
    .then((dek) => {
      if (dek.length !== 32) throw new TokenCryptoError("unwrapped data key has the wrong length");
      cachePut(wrapped, dek);
      return dek;
    })
    .finally(() => inflight.delete(wrapped));
  inflight.set(wrapped, p);
  return p;
}

// ── Envelope ───────────────────────────────────────────────────────────────────

interface DataKey { kid: string; dek: Buffer; wrapped: string }

async function newDataKey(): Promise<DataKey> {
  const kid = configuredKey();
  const dek = randomBytes(32);
  const wrapped = await kms.wrap(kid, dek);
  cachePut(wrapped, dek); // an immediate read-back of this write needs no KMS call
  return { kid, dek, wrapped };
}

const aad = (kid: string) => Buffer.from(`nomila-token|v1|${kid}`, "utf8");

function sealWith(key: DataKey, plain: string): TokenEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.dek, iv);
  cipher.setAAD(aad(key.kid));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    v: 1, kid: key.kid, dek_wrapped: key.wrapped,
    iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Encrypt one token under a fresh DEK wrapped by KMS_TOKEN_KEY. */
export async function encryptToken(plain: string): Promise<TokenEnvelope> {
  return sealWith(await newDataKey(), plain);
}

/** Decrypt an envelope (object or its "kms1:" string form). Throws TokenCryptoError on any tampering. */
export async function decryptToken(blob: TokenEnvelope | string): Promise<string> {
  const env = typeof blob === "string" ? decodeEnvelope(blob) : blob;
  if (env?.v !== 1 || typeof env.kid !== "string" || !KEY_NAME.test(env.kid)
      || typeof env.dek_wrapped !== "string" || typeof env.iv !== "string"
      || typeof env.ct !== "string" || typeof env.tag !== "string") {
    throw new TokenCryptoError("token envelope is malformed");
  }
  const dek = await unwrapDek(env.kid, env.dek_wrapped);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(env.iv, "base64"));
    decipher.setAAD(aad(env.kid));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new TokenCryptoError("token envelope failed authentication (tampered or wrong key)");
  }
}

export function isSealed(stored: string | null | undefined): stored is string {
  return typeof stored === "string" && stored.startsWith(ENVELOPE_PREFIX);
}

export function encodeEnvelope(env: TokenEnvelope): string {
  return ENVELOPE_PREFIX + Buffer.from(JSON.stringify(env), "utf8").toString("base64url");
}

export function decodeEnvelope(stored: string): TokenEnvelope {
  if (!isSealed(stored)) throw new TokenCryptoError("not a sealed token");
  try {
    return JSON.parse(Buffer.from(stored.slice(ENVELOPE_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new TokenCryptoError("token envelope is malformed");
  }
}

// ── Column helpers (what read/write paths call) ────────────────────────────────

/** A stored column value → the usable token. Legacy plain text passes through; envelopes are decrypted. */
export async function openToken<T extends string | null | undefined>(stored: T): Promise<T> {
  if (!isSealed(stored)) return stored;
  return (await decryptToken(stored)) as T;
}

export interface TokenFields {
  access_token?:  string | null;
  refresh_token?: string | null;
}

/**
 * A connected_accounts row (or partial select) → the same row with its token columns opened.
 * Undefined/null rows pass through, so `openTokenFields((await db.select()…)[0])` keeps the
 * `if (!row) …` checks working.
 */
export async function openTokenFields<T extends TokenFields>(row: T): Promise<T>;
export async function openTokenFields<T extends TokenFields>(row: T | undefined): Promise<T | undefined>;
export async function openTokenFields<T extends TokenFields>(row: T | null | undefined): Promise<T | null | undefined> {
  if (!row || (!isSealed(row.access_token) && !isSealed(row.refresh_token))) return row;
  const out = { ...row };
  if ("access_token"  in row) out.access_token  = await openToken(row.access_token);
  if ("refresh_token" in row) out.refresh_token = await openToken(row.refresh_token);
  return out;
}

/**
 * A connected_accounts write (insert values or update set) → the same object with its token columns
 * sealed, when TOKEN_KMS is on. Off: returned unchanged. One DEK (one KMS call) per write.
 * null/undefined/"" are left as they are (clearing a token stays a clear). Already-sealed values are kept.
 */
export async function sealTokenFields<T extends TokenFields>(patch: T): Promise<T> {
  return tokenKmsEnabled() ? sealTokenFieldsNow(patch) : patch;
}

/** sealTokenFields with the TOKEN_KMS gate open — the migration script seals whatever the flag says. */
export async function sealTokenFieldsNow<T extends TokenFields>(patch: T): Promise<T> {
  const needs = (v: string | null | undefined): v is string => typeof v === "string" && v !== "" && !isSealed(v);
  if (!needs(patch.access_token) && !needs(patch.refresh_token)) return patch;
  const key = await newDataKey();
  const out = { ...patch };
  if (needs(patch.access_token))  out.access_token  = encodeEnvelope(sealWith(key, patch.access_token));
  if (needs(patch.refresh_token)) out.refresh_token = encodeEnvelope(sealWith(key, patch.refresh_token));
  return out;
}
