// Pure helpers behind the Concept 0.4 "Me" and "What Nomila Knows" screens. No React, no fetch.
//
//   greetingFor(date)          "Good morning" / "Good afternoon" / "Good evening"
//   knowsLine(n)               "12 things Nomila knows" — a count of current entries, never "verified facts"
//   entryStateText(entry)      the empty-state wording per missing-data state
//   sourceTint(key)            the kit Tint for a source label (your word = said; confirmed deals = proof; inbox deals and the rest = found)
//   sourceSummary(bySource)    "5 from you · 3 official · 2 researched"
//   toRecordEntry(entry)       the RecordSheet's entry shape, so Change / Tell Mila / History are the existing ones
//   identityLine(identity)     the factual identity line ("Canon Soccer · Striker · Junior"); nothing interpretive
//   tierText(entry)            knowledge/3: how firmly Nomila holds it, in words — "Confirmed by you" · "<source>" ·
//                              "<source> · reported" · "<source> · unconfirmed". Never "verified", never a badge.
//   entryLogoUri(entry)        knowledge/3: the org / brand logo from logoDomain (presentation only), or null → icon
//   glanceModel(k)             knowledge/3: the "At a glance" card — team/school, sport · position, place, nationality, class
//   presentEntries(k, c, s)    the present entries of one section
//   honourName(entry)          an honour's name without its "(year)" (the year shows on the right)
//   canDispute(entry)          "This isn't right" applies: something is on record, no correction field, not yet disputed
//
// Grouping (the Me screens refinement, Oct 2026) — client-first, over the served entries, nothing re-stated:
//   provenanceOf(entry)        the quiet glyph per fact (you · official · researched · accounts · deals) + unconfirmed
//   orgLogoDomain(org, domain) the ORGANISATION's own domain or null (never the evidence site's); null → a neutral mark
//   careerGroups(entries)      one row per organisation (exact meta.org, normalised): year range, role chips, the entries
//   honoursModel(entries)      identical title + year grouped; strongest first; the unconfirmed folded apart
//   brandGroups(knowledge)     one row per brand with its relationship chips, the entries behind it

import type { TintName } from "../constants/theme";
import type { AthleteKnowledge, BrandProfile, CategoryKey, KnowledgeEntry, MeIdentity, SourceKey } from "../hooks/use-me-knowledge";
import { brandLogoUri } from "./brand-logo";
import type { RecordEntry, RecordKind } from "../hooks/use-athlete-record";
import type { ProvenanceGlyph } from "./myIntelligenceLogic";

/**
 * The avatar's fallback glyph (DESIGN.md Avatar: a sport icon centred in a circle), by the KIND of sport — ball,
 * water, track, combat, target — never one sport by name; a sport the families do not place reads "activity"; no
 * sport at all reads "user". Feather names, kept as strings so this module stays React-free.
 */
const SPORT_FAMILIES: ReadonlyArray<[RegExp, string]> = [
  [/\b(swim|div(e|ing)|water|row|crew|sail|surf|kayak|cano|paddl|aquat)/i, "droplet"],
  [/\b(run|track|cross[- ]?country|marathon|sprint|triathl|cycl|bik|ski|skat|snowboard)/i, "wind"],
  [/\b(box|wrestl|judo|taekwondo|karate|fenc|mma|martial|grappl)/i, "shield"],
  [/\b(golf|archer|shoot)/i, "target"],
  [/ball\b|\b(soccer|tennis|hockey|lacrosse|rugby|cricket|squash|badminton|polo|bowl)/i, "disc"],
];
export function sportIcon(sport: string | null | undefined): string {
  const s = (sport ?? "").trim();
  if (!s) return "user";
  return SPORT_FAMILIES.find(([re]) => re.test(s))?.[1] ?? "activity";
}

export function greetingFor(d: Date): string {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function knowsLine(n: number | null): string {
  if (n == null) return "Not tracked yet";
  if (n === 0) return "Nothing yet";
  return `${n} thing${n === 1 ? "" : "s"} Nomila knows`;
}

export function entryStateText(e: Pick<KnowledgeEntry, "state">): string {
  switch (e.state) {
    case "present": return "";
    case "not_yet_computed": return "Not researched yet";
    case "unavailable": return "Not available yet";
    default: return "Not on record";
  }
}

export function sourceTint(key: SourceKey | null | undefined): TintName {
  switch (key) {
    case "you": return "said";
    case "proof": return "proof";
    case "inbox": case "connected": case "official": case "researched": return "found";
    default: return "none";
  }
}

const SHORT: Record<SourceKey, string> = { you: "from you", proof: "from deals", inbox: "from inbox", connected: "connected", official: "official", researched: "researched", inferred: "inferred" };
const ORDER: SourceKey[] = ["you", "proof", "inbox", "connected", "official", "researched", "inferred"];
export function sourceSummary(bySource: Partial<Record<SourceKey, number>>): string {
  return ORDER.filter((k) => (bySource[k] ?? 0) > 0).map((k) => `${bySource[k]} ${SHORT[k]}`).join(" · ");
}

const KIND: Record<SourceKey, RecordKind> = { you: "said", proof: "proof", inbox: "found", connected: "found", official: "found", researched: "found", inferred: "made" };

/** A knowledge entry with a correction path, in the shape the existing RecordSheet edits (PUT /me/record/:field). */
export function toRecordEntry(e: KnowledgeEntry): RecordEntry | null {
  if (!e.correct) return null;
  return {
    field: e.correct.field,
    label: e.correct.label,
    value: e.value,
    raw: e.correct.raw,
    kind: e.source ? KIND[e.source.key] : null,
    source: e.source ? [e.source.label, e.source.detail].filter(Boolean).join(" · ") : null,
    at: e.at,
    editable: true,
    actions: ["change", "tell_mila", "history"],
    shape: e.correct.shape,
  };
}

export function identityLine(i: MeIdentity | null | undefined): string | null {
  if (!i) return null;
  return [i.primary?.label ?? null, ...i.facts].filter(Boolean).join(" · ") || null;
}

/**
 * The Me hero's identity as three factual lines (Concept 0.4 Me): "<team> <sport>", then "<role> · <position> · <class>",
 * then nationality. Each null when there is nothing to say; nothing interpretive, no identity check.
 */
export function meIdentityLines(i: MeIdentity | null | undefined): { primary: string | null; detail: string | null; nationality: string | null } {
  if (!i) return { primary: null, detail: null, nationality: null };
  return {
    primary: i.primary?.label ?? null,
    detail: [i.role ?? null, ...i.facts].filter(Boolean).join(" · ") || null,
    nationality: i.nationality ?? null,
  };
}

// ─── knowledge/3 ───────────────────────────────────────────────────────────────

/** The entry's tier in words, under its source. Her own word reads "Confirmed by you"; nothing ever says "verified". */
export function tierText(e: Pick<KnowledgeEntry, "state" | "source" | "tier" | "yourDispute">): string | null {
  if (e.state !== "present" || !e.source) return null;
  if (e.yourDispute) return "You said this isn't right";
  if (e.source.key === "you") return "Confirmed by you";
  if (e.tier === "reported") return `${e.source.label} · reported`;
  if (e.tier === "unconfirmed") return `${e.source.label} · unconfirmed`;
  return e.source.label;
}

/** The logo for an entry's org / brand (presentation only); null → the caller's icon. */
export function entryLogoUri(e: Pick<KnowledgeEntry, "logoDomain">): string | null {
  return e.logoDomain ? brandLogoUri(null, e.logoDomain) : null;
}

export function presentEntries(k: AthleteKnowledge | null | undefined, category: CategoryKey, section: string): KnowledgeEntry[] {
  const c = k?.categories.find((x) => x.key === category);
  return c?.sections.find((s) => s.key === section)?.entries.filter((e) => e.state === "present") ?? [];
}

export function honourName(e: Pick<KnowledgeEntry, "value">): string {
  return (e.value ?? "").replace(/\s*\((\d{4})\)\s*$/, "");
}

export function canDispute(e: Pick<KnowledgeEntry, "state" | "correct" | "yourDispute">): boolean {
  return e.state === "present" && !e.correct && !e.yourDispute;
}

export interface GlanceModel {
  team: KnowledgeEntry | null;
  /** "Soccer · Midfielder" from the sport and position entries. */
  sportLine: string | null;
  place: KnowledgeEntry | null;
  nationality: KnowledgeEntry | null;
  classYear: KnowledgeEntry | null;
  /** Every at-a-glance entry, for tapping. */
  all: KnowledgeEntry[];
}

/** The "At a glance" card from keyFacts (server order: name · team · sport · position · hometown · nationality · class). */
export function glanceModel(k: AthleteKnowledge | null | undefined): GlanceModel {
  const facts = k?.keyFacts ?? [];
  const by = (pred: (e: KnowledgeEntry) => boolean) => facts.find(pred) ?? null;
  const team = by((e) => e.id.startsWith("team_") || e.id === "school");
  const sport = by((e) => e.id === "sport");
  const position = by((e) => e.id === "position");
  const sportLine = [sport?.value ?? null, position?.value ?? null].filter(Boolean).join(" · ") || null;
  return { team, sportLine, place: by((e) => e.id === "hometown"), nationality: by((e) => e.id === "nationality"), classYear: by((e) => e.id === "class_year"), all: facts };
}

// ─── grouping (Me screens refinement, Oct 2026) ────────────────────────────────

export interface Provenance { glyph: ProvenanceGlyph; unconfirmed: boolean }

/** Unconfirmed = the tier says so, sources disagree, or she said it isn't right. */
export function isUnconfirmed(e: Pick<KnowledgeEntry, "tier" | "status" | "yourDispute">): boolean {
  return e.tier === "unconfirmed" || e.status === "disputed" || !!e.yourDispute;
}
/** Her own word on this fact — the only place "Confirmed by you" may be said, and only for that fact. */
export function confirmedByYou(e: Pick<KnowledgeEntry, "source">): boolean {
  return e.source?.key === "you";
}

/** The glyph per source: person = you · briefcase = a deal · document = official · link = accounts / inbox · magnifier = researched. */
export function provenanceOf(e: Pick<KnowledgeEntry, "source" | "tier" | "status" | "yourDispute">): Provenance {
  const glyph: ProvenanceGlyph = (() => {
    switch (e.source?.key) {
      case "you": return "you";
      case "proof": return "proof";
      case "official": return "document";
      case "inbox": case "connected": return "link";
      default: return "search";
    }
  })();
  return { glyph, unconfirmed: isUnconfirmed(e) };
}

/** The firmest provenance among several entries (you > deals > official > accounts > researched); unconfirmed only when all are. */
const GLYPH_RANK: Record<ProvenanceGlyph, number> = { you: 0, proof: 1, document: 2, link: 3, search: 4 };
export function provenanceOfAll(entries: ReadonlyArray<Pick<KnowledgeEntry, "source" | "tier" | "status" | "yourDispute">>): Provenance {
  const all = entries.map(provenanceOf);
  const best = [...all].sort((a, b) => GLYPH_RANK[a.glyph] - GLYPH_RANK[b.glyph])[0];
  return { glyph: best?.glyph ?? "search", unconfirmed: all.length > 0 && all.every((p) => p.unconfirmed) };
}

/** Org / brand name → grouping key: lower-cased, accents and punctuation dropped (the server's orgKey, mirrored). */
export function orgGroupKey(org: string | null | undefined): string {
  return String(org ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Words that name a kind of organisation, not the organisation: they never vouch for a domain. */
const GENERIC_ORG_WORDS = new Set([
  "the", "of", "and", "for", "at", "de", "la", "le", "el", "los", "las",
  "university", "college", "school", "high", "academy", "institute", "state", "city", "county", "town",
  "club", "fc", "sc", "cf", "afc", "ac", "team", "teams", "squad", "national", "youth", "junior", "senior", "women", "womens", "men", "mens",
  "united", "states", "america", "american", "international", "internationals", "world",
  "soccer", "football", "basketball", "athletics", "sports", "sport", "association", "federation", "league", "conference", "under", "u",
]);

/**
 * The logo must be the ORGANISATION's own, never the website that happened to report her. A served domain is trusted
 * only when its registrable label shares a distinctive word with the organisation's name (a university ↔ its own
 * site, a brand ↔ its own site); a generic name (a national team, "City FC") vouches for nothing. Null → the neutral mark.
 */
export function orgLogoDomain(org: string | null | undefined, logoDomain: string | null | undefined): string | null {
  const d = (logoDomain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  if (!d) return null;
  const parts = d.split(".").filter(Boolean);
  if (parts.length < 2) return null;
  parts.pop();                                                                            // the TLD
  if (parts.length > 1 && /^(co|com|org|net|ac|edu|gov)$/.test(parts[parts.length - 1])) parts.pop();   // "co.uk", "ac.uk"
  const label = (parts[parts.length - 1] ?? "").replace(/[^a-z0-9]/g, "");
  if (label.length < 3) return null;
  const words = orgGroupKey(org).split(" ").filter((w) => w.length >= 3 && !GENERIC_ORG_WORDS.has(w));
  return words.some((w) => label.includes(w) || (w.length >= 5 && w.includes(label))) ? logoDomain!.trim() : null;
}

export interface CareerGroup {
  key: string;
  org: string;
  orgKind: string | null;
  entries: KnowledgeEntry[];
  /** "2023 – present" · "2021 – 2024" · "2022" · null. */
  range: string | null;
  /** Role chips, distinct, from the entries Nomila holds firmly. */
  roles: string[];
  /** The organisation's own domain, or null → a neutral mark. */
  logoDomain: string | null;
  provenance: Provenance;
}

const yearsOf = (e: KnowledgeEntry): { years: number[]; present: boolean } => {
  const text = `${e.meta?.span ?? ""} ${e.meta?.year ?? ""}`;
  const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  return { years, present: /present/i.test(text) || (!e.meta?.span && e.status === "current" && false) };
};

/** One row per organisation, in first-seen order; a national-team entry groups by its team name like any other. */
export function careerGroups(entries: ReadonlyArray<KnowledgeEntry>): CareerGroup[] {
  const groups = new Map<string, CareerGroup>();
  for (const e of entries) {
    if (e.state !== "present") continue;
    const org = (e.meta?.org ?? e.value ?? "").trim();
    const key = orgGroupKey(org);
    if (!key) continue;
    const g = groups.get(key) ?? { key, org, orgKind: e.meta?.orgKind ?? null, entries: [], range: null, roles: [], logoDomain: null, provenance: { glyph: "search", unconfirmed: false } };
    g.entries.push(e);
    if (!g.orgKind && e.meta?.orgKind) g.orgKind = e.meta.orgKind;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    let min = Infinity, max = -Infinity, present = false;
    for (const e of g.entries) { const y = yearsOf(e); for (const n of y.years) { min = Math.min(min, n); max = Math.max(max, n); } present = present || y.present; }
    g.range = present ? (Number.isFinite(min) ? `${min} – present` : "present") : Number.isFinite(min) ? (min === max ? String(min) : `${min} – ${max}`) : null;
    g.roles = [...new Set(g.entries.filter((e) => e.tier === "established" && e.meta?.role).map((e) => e.meta!.role!.trim()))].filter(Boolean);
    g.logoDomain = g.entries.map((e) => orgLogoDomain(g.org, e.logoDomain)).find((d): d is string => !!d) ?? null;
    g.provenance = provenanceOfAll(g.entries);
  }
  return [...groups.values()];
}

export interface HonourItem { key: string; name: string; year: number | null; entries: KnowledgeEntry[]; provenance: Provenance }
export interface HonoursModel { top: HonourItem[]; more: HonourItem[]; unconfirmed: HonourItem[] }
export const HONOURS_TOP = 5;

const honourYear = (e: KnowledgeEntry): number | null => e.meta?.year ?? (Number((e.value ?? "").match(/\((\d{4})\)\s*$/)?.[1]) || null);
const TIER_RANK: Record<string, number> = { established: 0, reported: 1, unconfirmed: 2 };
const SOURCE_RANK: Record<string, number> = { you: 0, official: 1, proof: 1, connected: 2, inbox: 2, researched: 3, inferred: 4 };
const rankOf = (it: HonourItem): [number, number, number] => {
  const tier = Math.min(...it.entries.map((e) => TIER_RANK[e.tier ?? "reported"] ?? 1));
  const source = Math.min(...it.entries.map((e) => SOURCE_RANK[e.source?.key ?? "researched"] ?? 3));
  return [tier, source, -(it.year ?? 0)];
};

/**
 * Identical title + year grouped; the firmest first (established, then an official source, then newest); the unconfirmed
 * (sources disagree, or she said it isn't right) folded apart — never dropped, never picked between.
 */
export function honoursModel(entries: ReadonlyArray<KnowledgeEntry>, top = HONOURS_TOP): HonoursModel {
  const items = new Map<string, HonourItem>();
  entries.forEach((e, i) => {
    if (e.state !== "present" || !e.value) return;
    const name = honourName(e).trim();
    const year = honourYear(e);
    const key = `${orgGroupKey(name)}|${year ?? ""}`;
    const it = items.get(key) ?? { key: `${key}|${i}`, name, year, entries: [], provenance: { glyph: "search", unconfirmed: false } };
    it.entries.push(e);
    items.set(key, it);
  });
  const all = [...items.values()].map((it) => ({ ...it, provenance: provenanceOfAll(it.entries) }));
  const confirmed = all.filter((it) => !it.provenance.unconfirmed)
    .map((it, i) => ({ it, r: rankOf(it), i }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.i - b.i)
    .map((x) => x.it);
  const unconfirmed = all.filter((it) => it.provenance.unconfirmed).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  return { top: confirmed.slice(0, top), more: confirmed.slice(top), unconfirmed };
}

export interface BrandGroup {
  key: string; name: string; entries: KnowledgeEntry[]; chips: string[];
  /** The brand's own domain, or null → the initials. */
  logoDomain: string | null;
  /** The brand's stored logo (inbox_brands.logo_url) when any entry carries one. Presentation only. */
  logoUrl: string | null;
  provenance: Provenance;
  /** (Density pass) the brand's inbox_brands id and research when any entry carries them. Presentation only. */
  brandId: number | null;
  profile: BrandProfile | null;
}

const BRAND_SECTIONS: ReadonlyArray<{ key: string; chip: ((e: KnowledgeEntry) => string) }> = [
  { key: "confirmed", chip: () => "Partner" },
  { key: "reported", chip: (e) => e.label || "Reported" },
  { key: "seen", chip: () => "Seen with" },
];

/** One row per brand across her partnerships (confirmed · reported · seen with), relationship chips from the sections. */
export function brandGroups(k: AthleteKnowledge | null | undefined): BrandGroup[] {
  const groups = new Map<string, BrandGroup>();
  for (const s of BRAND_SECTIONS) {
    for (const e of presentEntries(k, "partnerships", s.key)) {
      const name = (e.meta?.org ?? e.value ?? "").trim();
      const key = orgGroupKey(name);
      if (!key) continue;
      const g = groups.get(key) ?? { key, name, entries: [], chips: [], logoDomain: null, logoUrl: null, provenance: { glyph: "search", unconfirmed: false }, brandId: null, profile: null };
      g.entries.push(e);
      const chip = s.chip(e);
      if (!g.chips.includes(chip)) g.chips.push(chip);
      groups.set(key, g);
    }
  }
  for (const g of groups.values()) {
    g.logoDomain = g.entries.map((e) => orgLogoDomain(g.name, e.logoDomain)).find((d): d is string => !!d) ?? null;
    g.logoUrl = g.entries.map((e) => e.logoUrl?.trim() || null).find((u): u is string => !!u) ?? null;
    g.provenance = provenanceOfAll(g.entries);
    g.brandId = g.entries.map((e) => e.brandId ?? null).find((id): id is number => typeof id === "number") ?? null;
    g.profile = g.entries.map((e) => e.brandProfile ?? null).find((p): p is BrandProfile => !!p) ?? null;
  }
  return [...groups.values()];
}

// ─── the brand deck + letter (the density pass, Oct 2026) ──────────────────────

/** The first ~two sentences of a stored text, exactly as written — a trim, never a rewrite. */
export function twoSentences(text: string | null | undefined): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const parts = t.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [t];
  return parts.slice(0, 2).join(" ").trim();
}

/**
 * The pages of a brand's deck, per field that exists, in BrandDeckHero's order: identity (always) · about · athletes they
 * work with · their audience (+ sports). A brand with images but no text research shows identity plus image-only pages;
 * one with nothing is a single hero. No fit page: fit ratings come from deal analysis, not this record. Images: the
 * cover first, then the ranked set; a fact page past the images repeats the cover rather than go blank.
 */
export type BrandDeckPage =
  | { kind: "identity"; image: string | null }
  | { kind: "about"; image: string | null; text: string; sources: Array<{ url: string; title: string | null }> }
  | { kind: "athletes"; image: string | null; items: string[] }
  | { kind: "audience"; image: string | null; text: string | null; chips: string[] }
  | { kind: "image"; image: string };
export const BRAND_IMAGE_PAGES = 3;

export function brandDeckPages(profile: BrandProfile | null | undefined): BrandDeckPage[] {
  const images = [...new Set([profile?.coverUrl ?? null, ...(profile?.images ?? [])].filter((u): u is string => !!u))];
  const at = (i: number) => images[i] ?? images[0] ?? null;
  const pages: BrandDeckPage[] = [{ kind: "identity", image: at(0) }];
  const about = twoSentences(profile?.description);
  if (about) pages.push({ kind: "about", image: at(pages.length), text: about, sources: profile?.sources ?? [] });
  if (profile?.knownAthletePartnerships.length) pages.push({ kind: "athletes", image: at(pages.length), items: profile.knownAthletePartnerships });
  if (profile?.audienceSummary || profile?.sportCategories.length) pages.push({ kind: "audience", image: at(pages.length), text: profile.audienceSummary, chips: profile.sportCategories });
  if (pages.length === 1) for (const image of images.slice(1, 1 + BRAND_IMAGE_PAGES)) pages.push({ kind: "image", image });
  return pages;
}

/**
 * The brand letter ("<Brand> and you"): the entries about her and that brand, parted by how Nomila holds them — what it
 * holds (established / reported, not her word), what she told Nomila (her word, in her-words style: the brand's own
 * entries she confirmed, plus anything in her own words elsewhere in the view that names the brand — her "Brands &
 * causes"), and what it heard but has not confirmed (unconfirmed, disputed, or hers to dispute). Nothing is restated;
 * nothing stands in for data that is not connected.
 */
export interface BrandLetterModel { knows: KnowledgeEntry[]; told: KnowledgeEntry[]; unconfirmed: KnowledgeEntry[] }
export function brandLetterModel(group: Pick<BrandGroup, "name" | "entries">, k?: AthleteKnowledge | null): BrandLetterModel {
  const present = group.entries.filter((e) => e.state === "present" && !!e.value);
  const name = group.name.trim().toLowerCase();
  const own = new Set(present.map((e) => e.id));
  const mentions = (e: KnowledgeEntry) => !!name && (e.value ?? "").toLowerCase().includes(name);
  const herWords = (k?.categories ?? []).flatMap((c) => c.sections.flatMap((s) => s.entries))
    .filter((e) => e.state === "present" && !!e.value && confirmedByYou(e) && !isUnconfirmed(e) && !own.has(e.id) && mentions(e));
  return {
    told: [...present.filter((e) => confirmedByYou(e) && !isUnconfirmed(e)), ...herWords],
    knows: present.filter((e) => !confirmedByYou(e) && !isUnconfirmed(e)),
    unconfirmed: present.filter((e) => isUnconfirmed(e)),
  };
}

/** A fact's firmness in one word for a chip: Established · Reported · Unconfirmed. */
export function tierWord(e: Pick<KnowledgeEntry, "tier" | "status" | "yourDispute">): string {
  if (isUnconfirmed(e)) return "Unconfirmed";
  return e.tier === "reported" ? "Reported" : "Established";
}
