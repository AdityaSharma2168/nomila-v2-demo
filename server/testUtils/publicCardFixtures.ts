/**
 * publicCardFixtures.ts — made-up public card content for the publicCard suites. Invented people in different sports;
 * no real athlete, school, league or brand. Imported by tests only. Tiles are resolved by the real resolver.
 */
import {
  PUBLIC_CARD_CONTENT_SCHEMA, PUBLIC_CARD_SOURCES_SCHEMA, tilesFor,
  type PublicCardContent, type PublicCardSources,
} from "../services/publicCard/types";
import { mediaKeyOf } from "../services/publicCard/mediaKey";
import type { SnapshotMedia } from "../services/publicCard/publish";
import type { IdentityIntelligenceView } from "../services/intelligence/identityIntelligence/contract";

export function fixtureCard(first = "Tavi", last = "Okonkwo-Lind"): { content: PublicCardContent; sources: PublicCardSources; media: SnapshotMedia } {
  const mk = mediaKeyOf("fixture", `${first}-photo`);
  const chapters: PublicCardContent["chapters"] = [
    { key: "highlights", title: "Highlights", button: { door: "ask_mila", label: `Ask Mila about ${first}` }, items: [
      { key: "hl.identity:said", kind: "identity_line", text: "Open-water swimmer who trains before sunrise.", basis: "said" },
      { key: "hl.quote:a1", kind: "quote", text: "I race the clock, not the lane next to me.", basis: "said" },
      { key: "hl.stat:instagram.followers", kind: "stat", text: null, label: "Instagram followers", value: 12400, asOf: "2026-10-01", basis: "found" },
    ] },
    { key: "partnerships", title: "Partnerships", button: { door: "partner", label: `Work with ${first}` }, items: [
      { key: "partner:d1", kind: "partner", text: "Northwind Outfitters", since: "2026-03", basis: "proof" },
    ] },
    { key: "media", title: "Media", button: { door: "book", label: `Book time with ${first}` }, items: [
      { key: "media:x1", kind: "media", text: null, mediaKey: mk, mediaType: "image", basis: "said" },
    ] },
  ];
  const base = {
    schema: PUBLIC_CARD_CONTENT_SCHEMA,
    displayName: `${first} ${last}`,
    firstName: first,
    lastName: last,
    verified: true,
    chapters,
    doors: { partner: true, book: true, shop: true, create: true, ask_mila: true },
    socials: [{ network: "Instagram", url: `https://www.instagram.com/example.${first.toLowerCase()}`, handle: `example.${first.toLowerCase()}` }],
    offers: [{ key: "offer:o1", kind: "offer" as const, text: "Video call", priceCents: 15000, totalCents: 17796, currency: "usd", durationMinutes: 30, locationMode: "virtual" as const, basis: "said" as const }],
    picks: [{ key: "pick:abc123", kind: "pick" as const, text: "Trail bottle", href: "https://nomila.test/go/abc123", merchant: "Example Store", disclosure: "Paid link", blurb: "Never leaves my bag.", basis: "said" as const }],
    mia: null,
  };
  const content: PublicCardContent = { ...base, tiles: tilesFor(base) };
  const sources: PublicCardSources = {
    schema: PUBLIC_CARD_SOURCES_SCHEMA,
    items: {
      "hl.identity:said": [{ kind: "said:assertion", id: "a0" }],
      "hl.quote:a1": [{ kind: "assertion", id: "a1" }],
      "hl.stat:instagram.followers": [{ kind: "social_feature", id: "instagram.followers_latest" }],
      "partner:d1": [{ kind: "deal", id: "d1" }],
      "media:x1": [{ kind: "media_asset", id: "x1" }],
      "offer:o1": [{ kind: "offer", id: "o1" }],
      "pick:abc123": [{ kind: "shop_item", id: "abc123" }],
    },
  };
  return { content, sources, media: { [mk]: { path: `athletes/fixture/${first}.jpg`, kind: "image" } } };
}

export const ALL_SWITCHES_ON = { door_partner: true, door_book: true, door_shop: true, door_create: true, door_ask_mila: true };

// ─── identity intelligence views for the draft builder (made-up people) ───────────────────────────────────────


/** An empty /me/story view (every part present, nothing in it), with overrides. */
export function fakeIdentityView(over: Partial<IdentityIntelligenceView> = {}): IdentityIntelligenceView {
  const empty = {
    contract: "identity-intelligence/0.2",
    pageState: "ready", generatedAt: "2026-10-01T00:00:00.000Z", overallConfidence: "MEDIUM", sufficiency: { met: true, reasons: [] },
    athletic: { identity: { sport: null, position: null, level: null, team: null, role: null, careerStage: null }, style: null },
    origin: null, values: [], valuesEvidence: [], causes: [], interests: [], personality: [], motivation: null, ambitions: [],
    essence: null, positioning: { current: null, desired: null }, standsFor: null, pillars: [], differentiators: [],
    throughline: null, chapters: { origin: null, rise: null, defining: null, now: null, next: null }, signatureMoments: [],
    proofPoints: [], voice: { hers: null, observed: { tone: [], platforms: [], basis: [] }, contentThemes: [], signatureCues: [] },
    audience: { measured: { platforms: [] } }, communities: [], associations: [], mediaFraming: null, imageGap: null,
    direction: [], howToBeUnderstood: null,
    directives: { preferredEmphasis: [], deEmphasize: [], preferredLanguage: [], avoidLanguage: [] },
    approved: {}, guardrails: [], unresolved: [], athleteStatements: [],
  };
  return { ...empty, ...over } as unknown as IdentityIntelligenceView;
}
