/**
 * verify/deliverable.ts — "check before deliver" (A4, owner-approved 3 Nov 2026): one deterministic check of a piece of
 * generated work before it is shown to the athlete as ready. No model, no network, no spend.
 *
 *   verifyDeliverable(kind, artifact, ctx)   → { ok: true } or { ok: false, status: "needs_a_look", failures }
 *
 *   video        ffprobe reads it (valid container with a video stream), duration inside the expected range, sound
 *                when sound was expected, the expected resolution, a file size inside the bounds
 *   image        it decodes, and its dimensions (exact, or at least a minimum)
 *   document     every required section is present, no placeholder tokens ([Name], [amount], {{first}}, TODO, lorem
 *                ipsum …), and every link is one a reader of HER document should be sent to: our own hosts, her own
 *                accounts (connected or verified), a page one of her own facts came from, or a profile on a well-known
 *                platform (linkVerdict). Anything else — a shortener, a stranger's site, javascript: — is refused
 *   draft_reply  it has a recipient, no placeholder tokens, it is under the length cap, and no other athlete's PRIVATE
 *                data is in it: their internal id, email, phone, text from their records, or one of their deal amounts
 *                beside their name. A name alone is not a leak (a teammate on a joint campaign is named freely)
 *   answer       every claim-bearing statement carries at least one source chip, every chip points at a real source,
 *                and every source is an http(s) URL
 *
 * A failure is the deliverable's, never a throw: the caller marks it "needs a look", logs the failures, and sends the
 * athlete down the surface's existing failure path (the post preview's failed state, the document build's failed tell,
 * the draft's refusal, an answer said in words). The `reason` strings are for logs and job rows, not for the athlete.
 * The deliverable itself is kept where it can be looked at (a document as built, a render's files under
 * needs-a-look/ — keep.ts, a draft on its agent run's trace). A BUG in a check is caught here too and fails closed or
 * open by kind (VERIFIER_ERROR_MODE): never a throw, never a retry.
 *
 * ─── THE MODEL REVIEW HOOK (OFF) ──────────────────────────────────────────────────────────────────────────────
 *
 * `ctx.modelReview` is the seam for an optional light model review. It runs only when a caller passes one AND every
 * deterministic check passed. No caller passes one today: there is no flag and no default, so nothing here can spend.
 *
 * The probes that touch files (ffprobe, sharp) live in ./media.ts and are injectable through `ctx.read`, so the checks
 * themselves are pure and the offline evals (server/agent/evals/offline) drive them from recorded probe output.
 */
import { createLogger } from "../../logger";

const logger = createLogger("verify/deliverable");

export type DeliverableKind = "video" | "image" | "document" | "draft_reply" | "answer";

export interface VerifyFailure {
  /** A closed code per kind (VERIFY_CHECKS). */
  check: string;
  /** What was wrong, for the logs and the job row. Never shown to the athlete. */
  reason: string;
}

export type VerifyResult =
  | { ok: true; kind: DeliverableKind; checked: string[] }
  | { ok: false; kind: DeliverableKind; status: "needs_a_look"; checked: string[]; failures: VerifyFailure[] };

/** Every check, by kind — the closed vocabulary the failures use. */
export const VERIFY_CHECKS = {
  video: ["readable", "duration", "audio", "resolution", "size"],
  image: ["decodes", "dimensions", "size"],
  document: ["sections", "placeholders", "links"],
  draft_reply: ["recipient", "placeholders", "length", "other_athlete"],
  answer: ["has_claims", "claim_sources", "source_index", "source_urls"],
} as const satisfies Record<DeliverableKind, readonly string[]>;

/** An optional light model review (OFF: no caller passes one). Returns extra failures; never throws through. */
export type ModelReview = (kind: DeliverableKind, artifact: unknown) => Promise<VerifyFailure[]>;

// ─── media facts (what a probe reads off a file) ─────────────────────────────────────────────────────────────

export interface VideoFacts {
  /** ffprobe read it and found a video stream. */
  valid: boolean;
  error?: string;
  durationSec: number | null;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

export interface ImageFacts {
  decoded: boolean;
  error?: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

export interface Range { min?: number; max?: number }

/**
 * A duration expectation with the same slack studio/video/structure.ts allows a finished clip (STRUCTURE_LIMITS:
 * the larger of 0.3 s and 5%), so this check never fails a clip the structure check would pass on length.
 */
export function durationAround(sec: number): Range {
  const slack = Math.max(0.3, sec * 0.05);
  return { min: Math.max(0, sec - slack), max: sec + slack };
}

export interface VideoCtx {
  durationSec?: Range;
  /** true: it must carry sound (a bed was laid). false/absent: sound is not checked. */
  audio?: boolean;
  width?: number;
  height?: number;
  bytes?: Range;
  read?: (path: string) => Promise<VideoFacts>;
  modelReview?: ModelReview;
}

export interface ImageCtx {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  bytes?: Range;
  read?: (path: string) => Promise<ImageFacts>;
  modelReview?: ModelReview;
}

export type VideoArtifact = { path: string } | { facts: VideoFacts };
export type ImageArtifact = { path: string } | { facts: ImageFacts };

// ─── documents ──────────────────────────────────────────────────────────────────────────────────────────────

export interface DocumentArtifact {
  /** The document's sections by id (a deck's card kinds, a brand book's chapters), each with its visible text. */
  sections: Array<{ id: string; text: string }>;
  /** Every link a reader can follow (anchor hrefs), as written. */
  links: string[];
}

export interface DocumentCtx {
  requiredSections: readonly string[];
  /** Our hosts: a link to one of these, or to a subdomain of one, passes. Relative links and #anchors are ours. */
  allowedHosts: readonly string[];
  /** What is HERS (services/documents herLinks): her accounts and the pages her own facts came from. Absent: none. */
  her?: HerLinks;
  modelReview?: ModelReview;
}

/** The links that are the athlete's own, read off her rows (never off the document). */
export interface HerLinks {
  /** Her accounts: connected (connected_accounts), verified or researched (social_identities), or typed at sign-up. */
  accounts: ReadonlyArray<{ platform: string; handle?: string | null; url?: string | null }>;
  /** The source pages of her active facts (memory_facts.source_url and also_seen_at). */
  factUrls: readonly string[];
  /** Hosts of her facts whose source is official (her school's or club's own site): any page on them passes. */
  officialHosts?: readonly string[];
}

// ─── reply drafts ───────────────────────────────────────────────────────────────────────────────────────────

export interface DraftReplyArtifact {
  body: string;
  /** Who it is addressed to (an address, a name, or the brand). */
  to: string | null;
}

/** Another athlete as the draft check sees them: what is PRIVATE to them. The caller leaves out her own. */
export interface OtherAthlete {
  id: string;
  /** Their full name. Never a finding on its own: it only ties one of their deal amounts to them. */
  name?: string | null;
  emails?: readonly string[];
  phones?: readonly string[];
  /** Their deal amounts (USD). A finding only beside their full name ("Riley got $4,000"). */
  amounts?: readonly number[];
  /** Text from their records (thread summaries, subjects): a sentence of it copied into her draft is a finding. */
  snippets?: readonly string[];
}

export interface DraftReplyCtx {
  maxChars: number;
  otherAthletes: ReadonlyArray<OtherAthlete>;
  /** Text the reply may quote back (the thread itself): a value that is already in it is theirs to repeat, not a leak. */
  quoted?: string;
  modelReview?: ModelReview;
}

/**
 * Length caps. Email has no platform limit that matters here (Gmail's is 25 MB): the prompt asks for under 150 words
 * and the model's output is capped at 1,200 tokens, so 6,000 characters (body + greeting + signature) is a runaway
 * guard that a real reply never meets. A DM: Instagram's Send API refuses text over 1,000 characters.
 */
export const DRAFT_MAX_CHARS = { email: 6000, dm: 1000 } as const;

// ─── answers with sources ───────────────────────────────────────────────────────────────────────────────────

export interface AnswerArtifact {
  statements: Array<{
    text: string;
    /** Indexes into `sources`: the chips shown beside this statement. */
    sourceIx: number[];
    /** false: framing, not a claim ("Here's what I found."). Absent: a claim unless it is a question. */
    claim?: boolean;
  }>;
  sources: Array<{ url: string; label?: string }>;
}

export type AnswerCtx = { modelReview?: ModelReview };

export interface ArtifactOf { video: VideoArtifact; image: ImageArtifact; document: DocumentArtifact; draft_reply: DraftReplyArtifact; answer: AnswerArtifact }
export interface CtxOf { video: VideoCtx; image: ImageCtx; document: DocumentCtx; draft_reply: DraftReplyCtx; answer: AnswerCtx }

// ─── placeholders ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * The words a template slot is made of. A bracket is residue only when it holds one of these ([Name], [Brand Name],
 * [your rate], [insert date], [amount]) or is a SHOUTED slot ([BRAND_NAME], [FIRST NAME]) — so "[Live]", "[1]",
 * "[sic]", "[Official Video]" and a markdown link's "[text](url)" are not.
 */
const SLOT_WORDS = "name|brand|company|athlete|recipient|contact|amount|rate|fee|price|budget|figure|date|deadline|url|email|phone|handle|location|insert|your|placeholder";
const SLOT_WORD_RE = `(?:[A-Za-z][A-Za-z'./-]*\\s+){0,3}(?:${SLOT_WORDS})(?:\\s+[A-Za-z][A-Za-z'./-]*){0,3}`;
const SHOUTED_SLOT_RE = "[A-Z][A-Z0-9]*(?:[ _][A-Z0-9]+)+|[A-Z]+_[A-Z_]+";

/**
 * Template residue a writer left in: [Name], [amount], [Brand Name], [BRAND_NAME], {{first}}, <insert date>, TODO /
 * FIXME as whole words, $XX / XXX-XX / XXXX figures, lorem ipsum. Calibrated against real deck and reply text
 * (deliverable.test.ts): "TODOS", "todo list", "Super Bowl XXX", "XXL", "[Live]", "[1]" and "Date TBD" all pass.
 */
const PLACEHOLDER_RES: RegExp[] = [
  new RegExp(`\\[\\s*(?:${SLOT_WORD_RE})\\s*\\](?!\\()`, "i"),
  new RegExp(`\\[\\s*(?:${SHOUTED_SLOT_RE})\\s*\\](?!\\()`),
  /\{\{\s*[A-Za-z_][\w.\s-]{0,38}\}\}/,
  /<\s*(?:insert|add|your|name|brand|amount|date)\b[^>]{0,40}>/i,
  /(?<![\p{L}\p{N}_])(?:TODO|FIXME)(?![\p{L}\p{N}_])/u,
  /\$\s?X{2,}(?![A-Za-z])|(?<![A-Za-z])X{3,}-X{2,}(?![A-Za-z])|(?<![A-Za-z])X{4,}(?![A-Za-z])/,
  /\blorem ipsum\b/i,
];

export function placeholderIn(text: string): string | null {
  for (const re of PLACEHOLDER_RES) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

// ─── links ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The app's own deep-link scheme (app.config: co.nomila.app) — the owner's page links into her app with it. */
export const OUR_APP_SCHEME = "co.nomila.app:";

/**
 * Whether a link resolves to one of our hosts. Relative paths, #anchors and the app's own scheme are ours; mailto/tel
 * are not web links. Anything else — another host, javascript:, data: — is not.
 */
export function linkIsOurs(href: string, allowedHosts: readonly string[]): boolean {
  const h = href.trim();
  if (!h || h.startsWith("#") || (h.startsWith("/") && !h.startsWith("//"))) return true;
  if (/^(?:mailto|tel):/i.test(h) || h.toLowerCase().startsWith(OUR_APP_SCHEME)) return true;
  let url: URL;
  try { url = new URL(h); } catch { return false; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return allowedHosts.some((a) => {
    const want = a.toLowerCase();
    return host === want || host.endsWith(`.${want}`);
  });
}

const isHttpUrl = (u: string): boolean => {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a full name stands in `text` as a whole name (not inside a longer word), in any case and spacing. */
export const nameIn = (text: string, name: string): boolean =>
  new RegExp(`(^|[^\\p{L}])${escapeRe(name.trim().replace(/\s+/g, " "))}($|[^\\p{L}])`, "iu").test(text.replace(/\s+/g, " "));

// ─── her links (documents) ──────────────────────────────────────────────────────────────────────────────────

/**
 * The well-known platforms a profile link may point at (a deck's "follow me", a brand book's socials): any https page
 * on them with a path passes. Link shorteners are not here on purpose: bit.ly hides where it goes.
 */
export const PROFILE_PLATFORMS = [
  "instagram.com", "tiktok.com", "youtube.com", "x.com", "twitter.com", "threads.net", "threads.com", "facebook.com",
  "linkedin.com", "twitch.tv", "snapchat.com", "linktr.ee",
] as const;

/** One platform's two spellings read as one (twitter.com and x.com), and m./www. dropped. */
const canonHost = (h: string) => {
  const host = h.toLowerCase().replace(/^(?:www|m|mobile)\./, "");
  return host === "twitter.com" ? "x.com" : host;
};

const parseWeb = (u: string): URL | null => {
  try {
    const url = new URL(u.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch { return null; }
};

/** A URL as host + path, lower-cased, trailing slash, query and hash dropped: what "the same page" means here. */
const pageKey = (url: URL) => `${canonHost(url.hostname)}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;

/** Each platform's profile URLs for a handle (her accounts carry a handle more often than a URL). */
const PROFILE_URL: Record<string, (h: string) => string[]> = {
  instagram: (h) => [`https://instagram.com/${h}`],
  tiktok: (h) => [`https://tiktok.com/@${h}`],
  youtube: (h) => [`https://youtube.com/@${h}`, `https://youtube.com/c/${h}`, `https://youtube.com/user/${h}`],
  x: (h) => [`https://x.com/${h}`],
  twitter: (h) => [`https://x.com/${h}`],
};

/** Her accounts as page keys: a link at or under one (her profile, or a post of hers on it) is hers. */
function herAccountKeys(her: HerLinks | undefined): string[] {
  const keys: string[] = [];
  for (const a of her?.accounts ?? []) {
    const urls = a.url ? [a.url] : [];
    const handle = (a.handle ?? "").trim().replace(/^@/, "");
    if (handle && /^[\w.-]{1,64}$/.test(handle)) urls.push(...(PROFILE_URL[a.platform.toLowerCase()]?.(handle) ?? []));
    for (const u of urls) {
      const url = parseWeb(u);
      if (url && url.pathname.replace(/\/+$/, "")) keys.push(pageKey(url));
    }
  }
  return keys;
}

export type LinkVerdict = "ours" | "her_account" | "her_fact" | "profile_platform" | "refused";

/**
 * Whose a link is, in order: ours (linkIsOurs); one of her accounts; a page one of her facts came from (or any page of
 * an official source of hers — her school's or club's own site); a profile on a well-known platform. Anything else is
 * "refused". Only http(s) links reach the last three, and a link carrying credentials (user:pass@) never passes them.
 */
export function linkVerdict(href: string, ctx: Pick<DocumentCtx, "allowedHosts" | "her">): LinkVerdict {
  if (linkIsOurs(href, ctx.allowedHosts)) return "ours";
  const url = parseWeb(href);
  if (!url || url.username || url.password) return "refused";
  const key = pageKey(url);
  if (herAccountKeys(ctx.her).some((k) => key === k || key.startsWith(`${k}/`))) return "her_account";
  const facts = new Set((ctx.her?.factUrls ?? []).map(parseWeb).filter((u): u is URL => !!u).map(pageKey));
  if (facts.has(key)) return "her_fact";
  const host = canonHost(url.hostname);
  if ((ctx.her?.officialHosts ?? []).some((h) => canonHost(h) === host)) return "her_fact";
  const onPlatform = PROFILE_PLATFORMS.some((p) => host === canonHost(p) || host.endsWith(`.${canonHost(p)}`));
  if (onPlatform && url.protocol === "https:" && url.pathname.replace(/\/+$/, "")) return "profile_platform";
  return "refused";
}

// ─── other athletes' private data (draft replies) ──────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const digitsOf = (s: string) => s.replace(/\D/g, "");
/** Every figure in a text, as a number ("$4,000" → 4000, "4k" → 4000, "4.5k" → 4500). */
const figuresIn = (text: string): number[] =>
  [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(k\b)?/gi)]
    .map((m) => Number(`${m[1].replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`) * (m[3] ? 1000 : 1));

/**
 * Another athlete's PRIVATE data found in `text`, as "<kind> <athlete id>" (kinds: id, email, phone, record_text,
 * deal_amount). Their name alone is never a hit: it only ties one of their deal amounts to them. Anything already in
 * `quoted` (the thread she is replying to) is the other side's to repeat, not a leak.
 */
export function otherAthletesIn(text: string, others: DraftReplyCtx["otherAthletes"], quoted = ""): string[] {
  const hits: string[] = [];
  const lower = norm(text);
  const q = norm(quoted);
  const digits = digitsOf(text);
  const qDigits = digitsOf(quoted);
  const textFigures = new Set(figuresIn(text));
  const quotedFigures = new Set(figuresIn(quoted));
  for (const o of others) {
    const kinds = new Set<string>();
    const id = (o.id ?? "").toLowerCase();
    if (id && lower.includes(id) && !q.includes(id)) kinds.add("id");
    for (const e of o.emails ?? []) {
      const em = norm(e);
      if (em.includes("@") && lower.includes(em) && !q.includes(em)) kinds.add("email");
    }
    for (const ph of o.phones ?? []) {
      // The national number (the last ten digits): "+1 (555) 201-7788" and "555-201-7788" are one phone.
      const d = digitsOf(ph).slice(-10);
      if (d.length >= 7 && digits.includes(d) && !qDigits.includes(d)) kinds.add("phone");
    }
    for (const sn of o.snippets ?? []) {
      // A sentence of theirs, long enough to be distinctive (a short phrase is anyone's).
      const hit = sn.split(/(?<=[.!?])\s+/).map(norm).some((s) => s.length >= 40 && lower.includes(s) && !q.includes(s));
      if (hit) { kinds.add("record_text"); break; }
    }
    const name = norm(o.name ?? "");
    const amounts = (o.amounts ?? []).filter((a) => Number.isFinite(a) && a > 0);
    if (amounts.length && name.split(" ").length >= 2 && nameIn(lower, name)) {
      if (amounts.some((a) => textFigures.has(a) && !quotedFigures.has(a))) kinds.add("deal_amount");
    }
    for (const k of kinds) hits.push(`${k} ${o.id}`);
  }
  return hits;
}

// ─── the checks, per kind (pure) ────────────────────────────────────────────────────────────────────────────

const inRange = (v: number, r: Range) => (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max);
const fmtRange = (r: Range) => `${r.min ?? "-"}..${r.max ?? "-"}`;

export function checkVideo(f: VideoFacts, ctx: VideoCtx): VerifyFailure[] {
  if (!f.valid) return [{ check: "readable", reason: `ffprobe could not read it${f.error ? `: ${f.error.slice(0, 160)}` : ""}` }];
  const out: VerifyFailure[] = [];
  if (ctx.durationSec && (f.durationSec === null || !inRange(f.durationSec, ctx.durationSec))) {
    out.push({ check: "duration", reason: `duration ${f.durationSec ?? "unknown"} s outside ${fmtRange(ctx.durationSec)}` });
  }
  if (ctx.audio && !f.hasAudio) out.push({ check: "audio", reason: "no audio stream where sound was expected" });
  if ((ctx.width !== undefined && f.width !== ctx.width) || (ctx.height !== undefined && f.height !== ctx.height)) {
    out.push({ check: "resolution", reason: `${f.width}x${f.height}, expected ${ctx.width ?? "*"}x${ctx.height ?? "*"}` });
  }
  if (ctx.bytes && (f.sizeBytes === null || !inRange(f.sizeBytes, ctx.bytes))) {
    out.push({ check: "size", reason: `${f.sizeBytes ?? "unknown"} bytes outside ${fmtRange(ctx.bytes)}` });
  }
  return out;
}

export function checkImage(f: ImageFacts, ctx: ImageCtx): VerifyFailure[] {
  if (!f.decoded) return [{ check: "decodes", reason: `it does not decode${f.error ? `: ${f.error.slice(0, 160)}` : ""}` }];
  const out: VerifyFailure[] = [];
  const w = f.width ?? 0;
  const h = f.height ?? 0;
  const exact = (ctx.width !== undefined && w !== ctx.width) || (ctx.height !== undefined && h !== ctx.height);
  const small = (ctx.minWidth !== undefined && w < ctx.minWidth) || (ctx.minHeight !== undefined && h < ctx.minHeight);
  if (w <= 0 || h <= 0 || exact || small) {
    out.push({ check: "dimensions", reason: `${w}x${h}, expected ${ctx.width ?? `>=${ctx.minWidth ?? 1}`}x${ctx.height ?? `>=${ctx.minHeight ?? 1}`}` });
  }
  if (ctx.bytes && (f.sizeBytes === null || !inRange(f.sizeBytes, ctx.bytes))) {
    out.push({ check: "size", reason: `${f.sizeBytes ?? "unknown"} bytes outside ${fmtRange(ctx.bytes)}` });
  }
  return out;
}

export function checkDocument(d: DocumentArtifact, ctx: DocumentCtx): VerifyFailure[] {
  const out: VerifyFailure[] = [];
  const have = new Set(d.sections.map((s) => s.id));
  const missing = ctx.requiredSections.filter((id) => !have.has(id));
  if (missing.length) out.push({ check: "sections", reason: `missing ${missing.join(", ")}` });
  for (const s of d.sections) {
    const p = placeholderIn(s.text);
    if (p) { out.push({ check: "placeholders", reason: `"${p.slice(0, 40)}" in ${s.id}` }); break; }
  }
  const refused = d.links.filter((l) => linkVerdict(l, ctx) === "refused");
  if (refused.length) {
    out.push({ check: "links", reason: `not ours, not her account, not from her facts, not a known profile platform: ${refused.slice(0, 3).map((l) => l.slice(0, 80)).join(", ")}` });
  }
  return out;
}

export function checkDraftReply(r: DraftReplyArtifact, ctx: DraftReplyCtx): VerifyFailure[] {
  const out: VerifyFailure[] = [];
  if (!r.to || !r.to.trim()) out.push({ check: "recipient", reason: "no recipient" });
  const p = placeholderIn(r.body);
  if (p) out.push({ check: "placeholders", reason: `"${p.slice(0, 40)}"` });
  if (r.body.length > ctx.maxChars) out.push({ check: "length", reason: `${r.body.length} chars over the ${ctx.maxChars} cap` });
  const others = otherAthletesIn(r.body, ctx.otherAthletes, ctx.quoted);
  // Another athlete's data: the log line names only how many and of what kind, never the value or whose.
  if (others.length) out.push({ check: "other_athlete", reason: `${others.length} match(es) of another athlete's private data: ${[...new Set(others.map((o) => o.split(" ")[0]))].join(", ")}` });
  return out;
}

export function checkAnswer(a: AnswerArtifact): VerifyFailure[] {
  const out: VerifyFailure[] = [];
  const claims = a.statements.filter((s) => s.text.trim() && s.claim !== false && !/\?\s*$/.test(s.text.trim()));
  if (!claims.length) out.push({ check: "has_claims", reason: "no claim-bearing statement" });
  const bare = claims.filter((s) => !s.sourceIx.length);
  if (bare.length) out.push({ check: "claim_sources", reason: `${bare.length} claim(s) without a source chip: "${bare[0].text.slice(0, 60)}"` });
  const badIx = a.statements.flatMap((s) => s.sourceIx).filter((i) => !Number.isInteger(i) || i < 0 || i >= a.sources.length);
  if (badIx.length) out.push({ check: "source_index", reason: `chip(s) pointing at no source: ${badIx.join(", ")}` });
  const badUrl = a.sources.filter((s) => !isHttpUrl(s.url));
  if (badUrl.length) out.push({ check: "source_urls", reason: `not an http(s) URL: ${badUrl.map((s) => s.url.slice(0, 60)).join(", ")}` });
  return out;
}

// ─── the one entry point ────────────────────────────────────────────────────────────────────────────────────

async function readVideo(a: VideoArtifact, ctx: VideoCtx): Promise<VideoFacts> {
  if ("facts" in a) return a.facts;
  const read = ctx.read ?? (await import("./media")).readVideoFacts;
  return read(a.path);
}

async function readImage(a: ImageArtifact, ctx: ImageCtx): Promise<ImageFacts> {
  if ("facts" in a) return a.facts;
  const read = ctx.read ?? (await import("./media")).readImageFacts;
  return read(a.path);
}

/**
 * What a BUG in the verifier itself (a check or a reader that throws) does, per kind. Never a retry and never a hang:
 * the throw is caught here, logged as `deliverable_verifier_error`, and turned into a result at once.
 *
 *   closed  the result is a failure ("verifier_error"): the delivery point takes its needs-a-look path — the athlete
 *           hears the friendly line and can ask again; nothing is sent, published or shown as ready
 *           (video, image, document: a broken preview or deck must not be called ready; draft_reply: a draft that
 *           could not be checked for another athlete's data must not be shown)
 *   open    the result is a pass, with "verifier_error" in `checked` so the log and the eval can see it (answer: an
 *           answer card is private, reversible, and its sources were already refused unless https by the tool
 *           itself; a bug here must not turn every sourced answer into "I couldn't")
 */
export const VERIFIER_ERROR_MODE: Record<DeliverableKind, "open" | "closed"> = {
  video: "closed", image: "closed", document: "closed", draft_reply: "closed", answer: "open",
};

async function runChecks(kind: DeliverableKind, artifact: unknown, ctx: unknown): Promise<VerifyFailure[]> {
  switch (kind) {
    case "video": return checkVideo(await readVideo(artifact as VideoArtifact, ctx as VideoCtx), ctx as VideoCtx);
    case "image": return checkImage(await readImage(artifact as ImageArtifact, ctx as ImageCtx), ctx as ImageCtx);
    case "document": return checkDocument(artifact as DocumentArtifact, ctx as DocumentCtx);
    case "draft_reply": return checkDraftReply(artifact as DraftReplyArtifact, ctx as DraftReplyCtx);
    case "answer": return checkAnswer(artifact as AnswerArtifact);
    default: return [{ check: "kind", reason: `unknown kind ${String(kind)}` }];
  }
}

export async function verifyDeliverable<K extends DeliverableKind>(kind: K, artifact: ArtifactOf[K], ctx: CtxOf[K]): Promise<VerifyResult> {
  let failures: VerifyFailure[];
  try {
    failures = await runChecks(kind, artifact, ctx);
  } catch (err) {
    const mode = VERIFIER_ERROR_MODE[kind] ?? "closed";
    const error = String((err as Error)?.message ?? err).slice(0, 200);
    logger.error({ event: "deliverable_verifier_error", kind, mode, error }, `the verifier threw — failing ${mode}`);
    if (mode === "open") return { ok: true, kind, checked: ["verifier_error"] };
    return { ok: false, kind, status: "needs_a_look", checked: ["verifier_error"], failures: [{ check: "verifier_error", reason: `the check itself failed: ${error}` }] };
  }
  const checked: string[] = [...(VERIFY_CHECKS[kind] ?? [])];
  // The hook (OFF: no caller passes one) — only on work every deterministic check passed.
  const review = (ctx as { modelReview?: ModelReview }).modelReview;
  if (!failures.length && review) {
    try {
      failures = await review(kind, artifact);
      checked.push("model_review");
    } catch (err) {
      logger.warn({ kind, error: String((err as Error)?.message ?? err).slice(0, 160) }, "model review failed — deterministic result stands");
    }
  }
  return failures.length ? { ok: false, kind, status: "needs_a_look", checked, failures } : { ok: true, kind, checked };
}

/** The one log line a delivery point writes for a deliverable that needs a look: kind, where, the failing checks. */
export function logNeedsALook(where: string, result: Extract<VerifyResult, { ok: false }>, extra: Record<string, unknown> = {}): void {
  logger.warn({ event: "deliverable_needs_a_look", where, kind: result.kind, checks: result.failures.map((f) => f.check), failures: result.failures, ...extra },
    "deliverable needs a look — not shown as ready");
}

/** The failing checks as one short line for a job row ("needs a look: duration, audio"). */
export const needsALookLine = (result: Extract<VerifyResult, { ok: false }>): string =>
  `needs a look: ${[...new Set(result.failures.map((f) => f.check))].join(", ")}`;
