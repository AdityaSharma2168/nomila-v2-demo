/**
 * publicCard/draft.ts — the draft builder (design-public-card-v3 §9 Chapters, §10 Publish and approve; layout from the
 * "v2 Mila at the centre" section of design-public-profile-reimagined). PURE: inputs in (gather.ts), draft out.
 *
 * Rules, in the order they apply to every candidate line:
 *   1. CITE OR CUT. Every item carries its basis (source refs). No basis → cut, never proposed. State findings are
 *      salience only and never count as a basis.
 *   2. HER GOVERNANCE. A line citing something she denied, or anything in unresolved[], is cut. Her guardrails
 *      (never_post / avoid_language) and her voice avoid list filter every line's words.
 *   3. ONE IDENTITY LINE: the Brief's positioning statement in short, else the essence line (rule 8); one she hid gives
 *      way to the next. Her "how to be understood" words and any chat or onboarding note are notes TO Mila, never
 *      public copy (there is no line she writes for the page itself yet; if one is added it goes first).
 *   4. WHAT PUBLISHES. said and proof publish on her Publish tap; found needs her confirmation (her approval, or a
 *      basis that already holds her own word); made needs her approval of THAT EXACT TEXT (textHash), or a pinned
 *      statement. Items she must pick (stats, partners, media, her "next") wait for her approval. Hidden never
 *      publishes.
 *   5. CHAPTERS exist only when they meet their minimum of publishable items (§9); Highlights is always first; her
 *      order and titles win. One white button per chapter (§3), falling back when its door is off.
 *   6. THE GRID. Four tiles, Partner · Book · Shop · Create, fixed here at publish: a slot whose door is off or
 *      cannot work shows "[First]'s story" instead, so the grid is always whole.
 *   7. M.I.A. appears only as the published number and its level, and only when show_mia is on.
 *   8. NO CONTACT DETAILS, NO RAW BIO. Every line passes the contact-detail filter (contactFilter.ts): a line that was
 *      only contact details is cut. Her social bio is never a line (it is a profile field, often carrying an email or
 *      handle); the identity line under her name is the Brief's positioning statement in short, else the essence line,
 *      else nothing — never her "how to be understood" words. Her accounts appear only as the page's Follow links.
 *
 * No model call: every line is her words, an assembled fact, or identity synthesis she approves. Pronoun-neutral copy
 * (her first name, never "her"). Nothing here names an athlete, sport, school, league or brand.
 */
import { createHash } from "node:crypto";
import type { BasisRef, Guardrail, IdentityIntelligenceView } from "../intelligence/identityIntelligence/contract";
import { refKey } from "../intelligence/identityIntelligence/contract";
import type { DraftInputs } from "./gather";
import { mediaKeyOf, opaqueItemKey } from "./mediaKey";
import type { SnapshotMedia } from "./publish";
import { cleanText, sanitizeSnapshot } from "./contactFilter";
import { capWords } from "../../studio/text";
import {
  CHAPTER_KINDS, DUPLICATE_TILES_REASON, PUBLIC_CARD_CONTENT_SCHEMA, PUBLIC_CARD_SOURCES_SCHEMA, buttonLabel, fallbackButton,
  tilesFor, tilesRepeat, validateSnapshot,
  type BasisLabel, type ChapterButton, type ChapterKind, type CutItem, type DraftChapter, type DraftDecisions,
  type DraftItem, type Door, type ItemBlock, type ItemKind, type PublicCardContent, type PublicCardSources,
  type PublicChapter, type PublicItem, type SourceRef,
} from "./types";

export interface CardSettings {
  decisions: DraftDecisions;
  switches: Record<Door, boolean>;
  showMia: boolean;
}

export interface BuiltDraft {
  chapters: DraftChapter[];
  offers: DraftItem[];
  picks: DraftItem[];
  cut: CutItem[];
  availability: { book: boolean; shop: boolean };
  preview: { content: PublicCardContent; sources: PublicCardSources; media: SnapshotMedia };
  canPublish: boolean;
  /** Why Publish would be refused now, in words she is shown; null when it would succeed. */
  blockedReason: string | null;
}

/** The fewest publishable items each chapter needs (§9). Highlights always appears. */
export const CHAPTER_MINIMUM: Record<ChapterKind, number> = {
  highlights: 0, story: 2, competition: 1, venture: 1, partnerships: 1, impact: 1, media: 3, picks: 1,
};
/** §3: the door each chapter's white button prefers. */
export const CHAPTER_BUTTON: Record<ChapterKind, ChapterButton["door"]> = {
  highlights: "ask_mila", partnerships: "partner", competition: "partner", story: "book", media: "book",
  venture: "ask_mila", impact: "ask_mila", picks: "shop",
};
/** Default order after Highlights (the reimagined page's card order). Her picks are the Shop door, not a card. */
const DEFAULT_ORDER: ChapterKind[] = ["highlights", "story", "partnerships", "competition", "media", "impact", "venture"];
export const MAX_STATS = 3;
const MAX_QUOTES = 5;
const MAX_MEDIA = 24;

export const textHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

// ─── candidates ───────────────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
  key: string;
  chapter: ChapterKind | "offers" | "shop";
  kind: ItemKind;
  text: string | null;
  extra?: Partial<PublicItem>;
  refs: SourceRef[];
  /** For governance checks (denied / unresolved) — the identity refs it rests on. */
  basisKeys: string[];
  origin: BasisLabel;
  /** A made line she already approved (a pinned statement). */
  pinned?: boolean;
  /** She must pick it (stats, partners, media, her "next") even when said / proof. */
  mustPick?: boolean;
  /** The identity line's slot order (lower first): the Brief's positioning, then the essence line. */
  slotOrder?: number;
}

const SAID_KINDS = new Set(["assertion", "objective", "media_asset", "said:assertion", "said:objective_event", "said:objective", "record_field"]);

/** BasisRef → SourceRef. State findings are salience, never a basis: dropped. */
export function sourceOf(r: BasisRef): SourceRef | null {
  switch (r.kind) {
    case "state_finding": return null;
    case "first_look": return { kind: "first_look", id: `${r.snapshotId}:${r.platform}` };
    case "social_feature": return { kind: "social_feature", id: r.key };
    case "said": return { kind: `said:${r.source}`, id: r.id };
    default: return { kind: r.kind, id: r.id };
  }
}
function refsOf(basis: BasisRef[] | null | undefined): { refs: SourceRef[]; basisKeys: string[] } {
  const list = (basis ?? []).filter((b) => b.kind !== "state_finding");
  return { refs: list.map(sourceOf).filter((x): x is SourceRef => !!x), basisKeys: list.map(refKey) };
}
/** said if any of her own words is in the basis, else proof if a deal, else found. */
function originOf(refs: SourceRef[]): BasisLabel {
  if (refs.some((r) => SAID_KINDS.has(r.kind))) return "said";
  if (refs.some((r) => r.kind === "deal")) return "proof";
  return "found";
}
const hasHerWord = (refs: SourceRef[]) => refs.some((r) => SAID_KINDS.has(r.kind));
const firstToken = (s: string) => s.trim().split(/\s+/)[0] ?? "";

/** About how long the identity line under her name may run. */
export const IDENTITY_LINE_MAX = 120;

/** The positioning statement's short form: its first sentence, clipped at a word to about IDENTITY_LINE_MAX characters. */
export function shortPositioning(statement: string): string {
  const t = statement.replace(/\s+/g, " ").trim();
  const first = /^(.+?[.!?])(?:\s|$)/.exec(t)?.[1] ?? t;
  if (first.length <= IDENTITY_LINE_MAX) return first;
  const cut = capWords(first, IDENTITY_LINE_MAX - 1).replace(/[\s,;:.\u2014\u2013-]+$/, "");
  return `${cut}\u2026`;
}

/** Highlights · identity line from the Brief: its positioning statement in short (made; approved when she wrote it). */
function positioningCandidate(p: DraftInputs["positioning"]): Candidate[] {
  const text = p?.statement?.trim() ? shortPositioning(p.statement) : "";
  if (!p || !text) return [];
  const refs: SourceRef[] = [{ kind: "memory_brief", id: p.briefId }, ...p.factIds.map((id) => ({ kind: "memory_fact", id }))];
  return [{ key: "hl.identity:positioning", chapter: "highlights", kind: "identity_line", text, origin: "made", pinned: p.hers, slotOrder: 0, refs, basisKeys: [] }];
}

function identityCandidates(v: IdentityIntelligenceView): Candidate[] {
  const out: Candidate[] = [];
  // Highlights · identity line: one slot. The Brief's positioning (positioningCandidate) first, then the essence line.
  // Never her "how to be understood" words (a note to Mila, not public copy), never her social bio, never a line
  // copied from a profile.
  if (v.essence?.short?.trim()) {
    const pinned = v.essence.pinned === true || v.essence.strength === "athlete_approved";
    out.push({ key: "hl.identity:essence", chapter: "highlights", kind: "identity_line", text: v.essence.short.trim(), origin: "made", pinned, slotOrder: 1, ...refsOf(v.essence.basis) });
  }
  // Highlights · quote: her own words, verbatim (never a partner caption, never stated intent, never her profile bio).
  for (const s of (v.athleteStatements ?? []).filter((x) => x.provenance === "her_own" && !x.partner && !x.intent && x.medium !== "bio").slice(0, MAX_QUOTES)) {
    const r = sourceOf(s.ref);
    if (r) out.push({ key: `hl.quote:${s.id}`, chapter: "highlights", kind: "quote", text: s.text, origin: "said", refs: [r], basisKeys: [refKey(s.ref)] });
  }
  // Highlights · stats: measured followers per platform; she picks up to three.
  for (const p of v.audience?.measured?.platforms ?? []) {
    if (p.followers == null) continue;
    out.push({
      key: `hl.stat:${p.platform}.followers`, chapter: "highlights", kind: "stat", text: null, mustPick: true, origin: "found",
      extra: { label: `${p.platform.charAt(0).toUpperCase()}${p.platform.slice(1)} followers`, value: p.followers },
      ...refsOf(p.basis),
    });
  }
  // Story · beats (made, approved as text) and her "next" (her direction, shown only if she approves it).
  for (const beat of ["origin", "rise", "defining", "now"] as const) {
    const b = v.chapters?.[beat];
    if (b?.text?.trim()) out.push({ key: `story.${beat}`, chapter: "story", kind: "beat", text: b.text.trim(), origin: "made", extra: { label: beat }, ...refsOf(b.basis) });
  }
  if (v.chapters?.next?.text?.trim()) {
    out.push({ key: "story.next", chapter: "story", kind: "beat", text: v.chapters.next.text.trim(), origin: "said", mustPick: true, extra: { label: "next" }, ...refsOf(v.chapters.next.basis) });
  }
  // Competition · proof points and signature moments (assembled by rules from the record; newest first).
  const proof = [...(v.proofPoints ?? []), ...(v.signatureMoments ?? [])]
    .filter((p) => p.kind !== "partnership" && p.kind !== "audience")
    .sort((a, b) => (b.asOf ?? "").localeCompare(a.asOf ?? ""));
  const seen = new Set<string>();
  for (const p of proof) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    const r = refsOf(p.basis);
    out.push({ key: `comp:${p.key}`, chapter: "competition", kind: "proof_point", text: p.text, origin: originOf(r.refs), extra: { asOf: p.asOf }, ...r });
  }
  // Impact · causes and values in action (their real basis kinds), and what she stands for (made).
  (v.causes ?? []).forEach((c, i) => {
    const r = refsOf(c.basis);
    out.push({ key: `impact.cause:${r.basisKeys[0] ?? i}`, chapter: "impact", kind: "cause", text: c.text, origin: originOf(r.refs), ...r });
  });
  (v.valuesEvidence ?? []).forEach((c, i) => {
    const r = refsOf(c.basis);
    out.push({ key: `impact.value:${r.basisKeys[0] ?? i}`, chapter: "impact", kind: "value", text: c.text, origin: originOf(r.refs), ...r });
  });
  if (v.standsFor?.short?.trim()) {
    out.push({ key: "impact.standsFor", chapter: "impact", kind: "value", text: v.standsFor.short.trim(), origin: "made",
      pinned: v.standsFor.pinned === true || v.standsFor.strength === "athlete_approved", ...refsOf(v.standsFor.basis) });
  }
  return out;
}

function recordCandidates(inp: DraftInputs, athleteKey: string): Candidate[] {
  const out: Candidate[] = [];
  for (const a of inp.affiliations.filter((x) => x.current && (x.kindOfFact === "said" || x.kindOfFact === "proof"))) {
    out.push({ key: `hl.aff:${a.id}`, chapter: "highlights", kind: "affiliation", text: a.org, origin: a.kindOfFact,
      extra: { label: a.position ?? a.role ?? null }, refs: [{ kind: "athlete_affiliation", id: a.id }], basisKeys: [] });
  }
  for (const p of inp.partners) {
    out.push({ key: `partner:${p.dealId}`, chapter: "partnerships", kind: "partner", text: p.brandName, origin: "proof", mustPick: true,
      extra: { since: p.signedAt.slice(0, 7), logoUrl: p.logoUrl }, refs: [{ kind: "deal", id: p.dealId }], basisKeys: [`deal:${p.dealId}`] });
  }
  for (const m of inp.media.slice(0, 200)) {
    out.push({ key: `media:${m.assetId}`, chapter: "media", kind: "media", text: null, origin: "said", mustPick: true,
      extra: { mediaKey: mediaKeyOf(athleteKey, m.assetId), mediaType: m.mediaType }, refs: [{ kind: "media_asset", id: m.assetId }], basisKeys: [`media_asset:${m.assetId}`] });
  }
  for (const p of inp.picks) {
    const code = p.href.split("/").pop() ?? "";
    if (!code) continue;
    out.push({ key: `pick:${code}`, chapter: "shop", kind: "pick", text: p.title, origin: "said",
      extra: { href: p.href, merchant: p.merchant, priceCents: p.priceCents, currency: p.currency, disclosure: p.disclosure, blurb: p.blurb, amazon: p.amazon },
      refs: [{ kind: "shop_item", id: code }], basisKeys: [] });
  }
  for (const o of inp.offers) {
    out.push({ key: `offer:${o.publicId}`, chapter: "offers", kind: "offer", text: o.title, origin: "said",
      extra: { priceCents: o.priceCents, totalCents: o.totalCents, currency: o.currency, durationMinutes: o.durationMinutes },
      refs: [{ kind: "offer", id: o.offerId }], basisKeys: [] });
  }
  return out;
}

/**
 * The candidate with contact details stripped from its words (contactFilter.ts). Text that was nothing but contact
 * details comes back as "" and is cut. The merchant keeps a web-address-shaped name (it is the shop's own name).
 */
function withoutContactDetails(c: Candidate): Candidate {
  const cleaned = cleanText(c.text);
  const text = typeof cleaned === "string" && !cleaned.trim() ? "" : cleaned;
  if (!c.extra) return { ...c, text };
  const extra = { ...c.extra };
  for (const f of ["label", "blurb", "disclosure"] as const) if (typeof extra[f] === "string") extra[f] = cleanText(extra[f] as string).trim() || null;
  if (typeof extra.merchant === "string") extra.merchant = cleanText(extra.merchant, { bareDomains: false }).trim() || null;
  return { ...c, text, extra };
}

// ─── governance ───────────────────────────────────────────────────────────────────────────────────────────────

const words = (c: Candidate) => [c.text, c.extra?.label, c.extra?.blurb].filter((x): x is string => typeof x === "string").join(" \n ").toLowerCase();
const phraseHit = (hay: string, list: string[]) => list.some((p) => { const n = p.trim().toLowerCase(); return n.length > 1 && hay.includes(n); });

function governance(v: IdentityIntelligenceView | null) {
  const guardrails: Guardrail[] = v?.guardrails ?? [];
  const denied = new Set(guardrails.filter((g) => g.kind === "denied").flatMap((g) => g.basis.map(refKey)));
  const unresolved = new Set((v?.unresolved ?? []).flatMap((u) => u.evidence.map(refKey)));
  const guard = guardrails.filter((g) => g.kind === "never_post" || g.kind === "avoid_language").map((g) => g.text);
  const voiceAvoid = [...(v?.directives?.avoidLanguage ?? []), ...(v?.voice?.hers?.avoid ?? [])];
  return (c: Candidate): CutItem["reason"] | null => {
    if (c.refs.length === 0) return "no_basis";
    if (c.basisKeys.some((k) => denied.has(k))) return "denied";
    if (c.basisKeys.some((k) => unresolved.has(k))) return "unresolved";
    const hay = words(c);
    if (phraseHit(hay, guard)) return "guardrail";
    if (phraseHit(hay, voiceAvoid)) return "voice_avoid";
    return null;
  };
}

function isApprovedMade(c: Candidate, decisions: DraftDecisions): boolean {
  if (c.pinned) return true;
  const d = decisions.items?.[c.key];
  return d?.state === "approved" && !!c.text && d.textHash === textHash(c.text);
}

function judge(c: Candidate, decisions: DraftDecisions): { state: DraftItem["state"]; publishable: boolean; blockedBy: ItemBlock | null } {
  const d = decisions.items?.[c.key];
  const state: DraftItem["state"] = d?.state ?? "proposed";
  if (d?.state === "hidden") return { state, publishable: false, blockedBy: "hidden" };
  if (c.origin === "made") return isApprovedMade(c, decisions) ? { state, publishable: true, blockedBy: null } : { state, publishable: false, blockedBy: "needs_approval" };
  if (c.mustPick && d?.state !== "approved") return { state, publishable: false, blockedBy: "needs_approval" };
  if (c.origin === "found" && !(d?.state === "approved" || hasHerWord(c.refs))) return { state, publishable: false, blockedBy: "needs_confirmation" };
  return { state, publishable: true, blockedBy: null };
}

// ─── the build ────────────────────────────────────────────────────────────────────────────────────────────────

export function buildDraft(inp: DraftInputs, settings: CardSettings, athleteKey: string): BuiltDraft {
  const decisions = settings.decisions ?? {};
  const firstName = inp.nickname?.value || firstToken(inp.fullName);
  const displayName = inp.fullName;
  // Her last name is the rest of her full name; a nickname replaces only the first name.
  const lastName = inp.fullName.trim().split(/\s+/).slice(1).join(" ");
  const cutCheck = governance(inp.identity);
  const cut: CutItem[] = [];

  // Keys travel in public content: anything built from an internal id becomes an opaque, stable key.
  const all = [...positioningCandidate(inp.positioning ?? null), ...(inp.identity ? identityCandidates(inp.identity) : []), ...recordCandidates(inp, athleteKey)]
    .map((c) => ({ ...c, key: opaqueItemKey(athleteKey, c.key) }))
    .map(withoutContactDetails);
  const kept: Candidate[] = [];
  for (const c of all) {
    const why = c.text === "" ? "contact_details" : cutCheck(c);
    if (why) cut.push({ key: c.key, kind: c.kind, reason: why }); else kept.push(c);
  }

  // One identity line: the first in slot order (the Brief's positioning, the essence line) she has not hidden.
  const identity = kept.filter((c) => c.kind === "identity_line" && decisions.items?.[c.key]?.state !== "hidden")
    .sort((a, b) => (a.slotOrder ?? 9) - (b.slotOrder ?? 9));
  const losers = new Set(identity.slice(1).map((c) => c.key));
  const candidates = kept.filter((c) => !losers.has(c.key));

  const toItem = (c: Candidate): DraftItem => {
    const j = judge(c, decisions);
    return {
      key: c.key, kind: c.kind, text: c.text, basis: c.origin, ...(c.extra ?? {}),
      ...j, sources: c.refs, textHash: c.origin === "made" && c.text ? textHash(c.text) : null,
    };
  };

  // Per-kind limits: one quote (her chosen one, else the first), up to three stats she picked, media capped.
  const limit = (items: DraftItem[], kind: ItemKind, max: number, preferApproved: boolean) => {
    const pool = items.filter((i) => i.kind === kind && i.publishable);
    const chosen = preferApproved ? [...pool.filter((i) => i.state === "approved"), ...pool.filter((i) => i.state !== "approved")] : pool;
    const keep = new Set(chosen.slice(0, max).map((i) => i.key));
    for (const i of pool) if (!keep.has(i.key)) { i.publishable = false; i.blockedBy = "over_limit"; }
  };

  const availability = { book: inp.bookReady, shop: inp.picks.length > 0 };
  const sw = settings.switches;
  const doors: Record<Door, boolean> = {
    partner: sw.partner, book: sw.book && availability.book, shop: sw.shop && availability.shop, create: sw.create, ask_mila: sw.ask_mila,
  };

  const titles: Record<ChapterKind, string> = {
    highlights: "Highlights", story: "Story", competition: "Competition", venture: "Venture", partnerships: "Partnerships",
    impact: "Impact", media: "Media", picks: `${firstName}'s picks`,
  };
  const order = [
    "highlights" as ChapterKind,
    ...(decisions.order ?? []).filter((k) => k !== "highlights" && (CHAPTER_KINDS as readonly string[]).includes(k)),
    ...DEFAULT_ORDER.filter((k) => k !== "highlights"),
  ].filter((k, i, arr) => arr.indexOf(k) === i);

  const chapters: DraftChapter[] = order.map((key) => {
    const items = candidates.filter((c) => c.chapter === key).map(toItem);
    if (key === "highlights") { limit(items, "quote", 1, true); limit(items, "stat", MAX_STATS, true); }
    if (key === "media") limit(items, "media", MAX_MEDIA, true);
    const counted = items.filter((i) => i.publishable && (key !== "impact" || i.kind === "cause")).length;
    const chDecision = decisions.chapters?.[key];
    const title = (cleanText(chDecision?.title?.trim()) || titles[key]).slice(0, 60);
    return {
      key, title, defaultTitle: titles[key], hidden: key !== "highlights" && !!chDecision?.hidden,
      button: fallbackButton(CHAPTER_BUTTON[key], doors, firstName),
      minimum: CHAPTER_MINIMUM[key], meetsMinimum: counted >= CHAPTER_MINIMUM[key], items,
    };
  }).filter((ch) => ch.key === "highlights" || ch.items.length > 0);
  const offers = candidates.filter((c) => c.chapter === "offers").map(toItem);
  const picks = candidates.filter((c) => c.chapter === "shop").map(toItem);

  // The preview: exactly what Publish would freeze now.
  const publicItem = (i: DraftItem): PublicItem => {
    const { state: _s, publishable: _p, blockedBy: _b, sources: _src, textHash: _h, ...pub } = i;
    return pub;
  };
  const shown: PublicChapter[] = chapters
    .filter((ch) => ch.key === "highlights" || (!ch.hidden && ch.meetsMinimum))
    .map((ch) => ({ key: ch.key, title: ch.title, button: ch.button, items: ch.items.filter((i) => i.publishable).map(publicItem) }));
  const publicOffers = doors.book ? offers.filter((o) => o.publishable).map(publicItem) : [];
  const publicPicks = doors.shop ? picks.filter((p) => p.publishable).map(publicItem) : [];
  const base = {
    schema: PUBLIC_CARD_CONTENT_SCHEMA,
    displayName, firstName, lastName, verified: inp.verified,
    chapters: shown,
    doors,
    socials: inp.socials,
    offers: publicOffers,
    picks: publicPicks,
    mia: settings.showMia && inp.mia ? { score: inp.mia.score, band: inp.mia.band, asOf: inp.mia.asOf } : null,
  };
  // The grid: the renderer's own resolver, fixed here at publish. Then the whole page through the contact-detail filter
  // once more (defence in depth: every line was already filtered above, so this changes nothing on a clean card).
  const content: PublicCardContent = sanitizeSnapshot({ ...base, tiles: tilesFor(base) }).content;
  // Stats carry "as of" the day they were read.
  const asOf = inp.now.toISOString().slice(0, 10);
  for (const ch of content.chapters) for (const it of ch.items) if (it.kind === "stat") it.asOf = asOf;
  for (const ch of chapters) for (const it of ch.items) if (it.kind === "stat") it.asOf = asOf;

  const byKey = new Map([...chapters.flatMap((c) => c.items), ...offers, ...picks].map((i) => [i.key, i.sources]));
  const sources: PublicCardSources = {
    schema: PUBLIC_CARD_SOURCES_SCHEMA,
    items: Object.fromEntries([...content.chapters.flatMap((c) => c.items), ...content.offers, ...content.picks].map((i) => [i.key, byKey.get(i.key) ?? []])),
  };
  // The stored object behind each published media key (server-only; the page sees the key).
  const pathOf = new Map(inp.media.map((m) => [mediaKeyOf(athleteKey, m.assetId), { path: m.path, kind: m.mediaType }]));
  const media: SnapshotMedia = {};
  for (const ch of content.chapters) for (const it of ch.items) if (it.mediaKey && pathOf.has(it.mediaKey)) media[it.mediaKey] = pathOf.get(it.mediaKey)!;

  let blockedReason: string | null = null;
  if (!displayName) blockedReason = "Add your name to publish";
  else if (tilesRepeat(content.tiles)) blockedReason = DUPLICATE_TILES_REASON;
  else {
    try { validateSnapshot(content, sources, { showMia: settings.showMia, switches: sw }); } catch (err: any) { blockedReason = `This draft cannot be published yet (${err.message})`; }
  }
  return { chapters, offers, picks, cut, availability, preview: { content, sources, media }, canPublish: blockedReason === null, blockedReason };
}

/** Validate an untrusted DraftDecisions body. Returns the clean value or an error message. */
export function parseDecisions(raw: unknown): { ok: true; value: DraftDecisions } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be an object" };
  const r = raw as Record<string, unknown>;
  const out: DraftDecisions = {};
  if (r.items !== undefined) {
    if (!r.items || typeof r.items !== "object" || Array.isArray(r.items)) return { ok: false, error: "items must be an object" };
    const entries = Object.entries(r.items as Record<string, unknown>);
    if (entries.length > 1000) return { ok: false, error: "too many items" };
    out.items = {};
    for (const [k, v] of entries) {
      if (k.length > 200 || !/^[\w.:-]+$/.test(k)) return { ok: false, error: `bad item key: ${k.slice(0, 40)}` };
      const d = v as Record<string, unknown>;
      if (!d || (d.state !== "approved" && d.state !== "hidden")) return { ok: false, error: `bad state for ${k}` };
      if (d.textHash !== undefined && (typeof d.textHash !== "string" || !/^[0-9a-f]{16}$/.test(d.textHash))) return { ok: false, error: `bad textHash for ${k}` };
      out.items[k] = { state: d.state, ...(typeof d.textHash === "string" ? { textHash: d.textHash } : {}) };
    }
  }
  if (r.chapters !== undefined) {
    if (!r.chapters || typeof r.chapters !== "object" || Array.isArray(r.chapters)) return { ok: false, error: "chapters must be an object" };
    out.chapters = {};
    for (const [k, v] of Object.entries(r.chapters as Record<string, unknown>)) {
      if (!(CHAPTER_KINDS as readonly string[]).includes(k)) return { ok: false, error: `bad chapter: ${k.slice(0, 40)}` };
      const d = (v ?? {}) as Record<string, unknown>;
      if (d.hidden !== undefined && typeof d.hidden !== "boolean") return { ok: false, error: `bad hidden for ${k}` };
      if (d.title !== undefined && (typeof d.title !== "string" || d.title.length > 60)) return { ok: false, error: `bad title for ${k}` };
      out.chapters[k as ChapterKind] = { ...(d.hidden !== undefined ? { hidden: d.hidden as boolean } : {}), ...(typeof d.title === "string" ? { title: d.title.trim() } : {}) };
    }
  }
  if (r.order !== undefined) {
    if (!Array.isArray(r.order) || r.order.some((k) => !(CHAPTER_KINDS as readonly unknown[]).includes(k))) return { ok: false, error: "bad order" };
    out.order = [...new Set(r.order as ChapterKind[])];
  }
  return { ok: true, value: out };
}

export { buttonLabel };
