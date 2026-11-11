/**
 * draft.test.ts — the draft builder's rules, pure (design-public-card-v3 §9–§10; the 2×2 grid from the reimagined v2).
 * Made-up athletes in different sports (a rower, a fencer, a climber); no database, no model, no network.
 *
 *   D1 cite or cut: no basis → cut; a state finding alone is not a basis
 *   D2 her governance: denied / unresolved basis cut; guardrails and her voice-avoid list filter every line
 *   D3 the identity line: the Brief's positioning in short, else the essence line, else nothing; never her "how to be
 *      understood" note to Mila; made needs THIS exact text approved
 *   D4 what publishes: said / proof on her tap; found needs confirmation; stats, partners, media, "next" need her pick
 *   D5 limits and minimums: one quote, three stats, Story ≥ 2 approved beats, Media ≥ 3 picked, Impact ≥ 1 cause
 *   D6 doors and the grid: Book only when bookings are ready, Shop only with live picks; tiles from the resolver;
 *      a repeating grid blocks publish with a clear reason
 *   D7 M.I.A. only as number + level and only with show_mia; buttons fall back; copy is pronoun-neutral
 *   D8 her order, titles and hidden chapters; parseDecisions refuses bad input
 *   D9 no raw bio and no contact details: her profile bio is never a line; every line is filtered; a line that was only
 *      contact details is cut
 */
import type { DraftInputs } from "./gather";
import { IDENTITY_LINE_MAX, buildDraft, parseDecisions, shortPositioning, textHash, type CardSettings } from "./draft";
import { DUPLICATE_TILES_REASON, tilesFor, type DraftDecisions } from "./types";
import { fakeIdentityView } from "../../testUtils/publicCardFixtures";
import { opaqueItemKey } from "./mediaKey";

/** The public (opaque) form of a raw item key for this suite's athlete. */
const K = (raw: string) => opaqueItemKey("athlete-1", raw);

const NOW = new Date("2026-10-08T12:00:00Z");
const said = (id: string) => ({ kind: "assertion" as const, id });
const fact = (id: string) => ({ kind: "fact" as const, id });

function inputs(over: Partial<DraftInputs> = {}): DraftInputs {
  return {
    fullName: "Hana Vesely", nickname: null, identity: fakeIdentityView(), affiliations: [], partners: [], media: [], offers: [],
    picks: [], socials: [], mia: null, verified: false, bookReady: false, now: NOW, ...over,
  };
}
const ON = { partner: true, book: true, shop: true, create: true, ask_mila: true };
const settings = (decisions: DraftDecisions = {}, over: Partial<CardSettings> = {}): CardSettings => ({ decisions, switches: ON, showMia: false, ...over });
const build = (inp: DraftInputs, s = settings()) => buildDraft(inp, s, "athlete-1");
const item = (d: ReturnType<typeof build>, key: string) => [...d.chapters.flatMap((c) => c.items), ...d.offers, ...d.picks].find((i) => i.key === key);
const published = (d: ReturnType<typeof build>) => [...d.preview.content.chapters.flatMap((c) => c.items), ...d.preview.content.offers, ...d.preview.content.picks].map((i) => i.key);

describe("D1 cite or cut", () => {
  it("an item with no basis is cut, never proposed; a state finding alone is no basis", () => {
    const d = build(inputs({ identity: fakeIdentityView({
      causes: [
        { text: "Clean rivers", basis: [said("a1")], strength: "established" },
        { text: "Unsourced cause", basis: [], strength: "reported" },
        { text: "Salience only", basis: [{ kind: "state_finding", key: "x" }], strength: "reported" },
      ],
    }) }));
    expect(d.cut.map((c) => c.reason)).toEqual(["no_basis", "no_basis"]);
    expect(d.chapters.find((c) => c.key === "impact")!.items.map((i) => i.text)).toEqual(["Clean rivers"]);
    expect(Object.values(d.preview.sources.items).every((refs) => refs.length > 0)).toBe(true);
  });
});

describe("D2 her governance", () => {
  it("denied and unresolved bases are cut; guardrails and her voice-avoid words filter every line", () => {
    const d = build(inputs({ identity: fakeIdentityView({
      causes: [
        { text: "Youth rowing clubs", basis: [said("a1")], strength: "established" },
        { text: "A claim she denied", basis: [fact("f9")], strength: "reported" },
        { text: "An open question", basis: [fact("f8")], strength: "reported" },
        { text: "Talks about politics often", basis: [said("a2")], strength: "established" },
        { text: "The ultimate grind machine", basis: [said("a3")], strength: "established" },
      ],
      guardrails: [{ kind: "denied", text: "denied", basis: [fact("f9")] }, { kind: "never_post", text: "politics", basis: [said("a4")] }],
      unresolved: [{ subject: "x", question: "?", reason: "conflict", evidence: [fact("f8")] }],
      directives: { preferredEmphasis: [], deEmphasize: [], preferredLanguage: [], avoidLanguage: [] },
      voice: { hers: { tone: null, phrases: [], avoid: ["grind"], basis: [] }, observed: { tone: [], platforms: [], basis: [] }, contentThemes: [], signatureCues: [] },
    }) }));
    expect(d.cut.map((c) => c.reason).sort()).toEqual(["denied", "guardrail", "unresolved", "voice_avoid"]);
    expect(JSON.stringify(d.preview.content)).not.toMatch(/politics|grind|denied|open question/i);
  });
});

describe("D3 the identity line", () => {
  const essence = { short: "A rower who turned a lake into a classroom.", long: "", basis: [fact("f1")], strength: "reported" as const };
  const positioning = { statement: "The rower who makes patience look like power. Every season adds a new crew she coaches.", briefId: "b1", factIds: ["mf1", "mf2"], hers: false };
  const herWords = { value: "x", said: "I row for the quiet.", basis: [said("a1")] };
  const withSaid = fakeIdentityView({ essence, howToBeUnderstood: herWords });
  const identity = fakeIdentityView({ essence });
  const lines = (d: ReturnType<typeof build>) => d.chapters[0].items.filter((i) => i.kind === "identity_line");

  it("her \"how to be understood\" words are a note to Mila, never the identity line: the Brief's positioning is used instead", () => {
    const note = fakeIdentityView({ essence, howToBeUnderstood: { ...herWords, said: "pls check my contarcts before any deal, call me at 555-0100" } });
    let d = build(inputs({ identity: note, positioning }));
    expect(lines(d).map((i) => i.key)).toEqual(["hl.identity:positioning"]);
    expect(JSON.stringify({ chapters: d.chapters, preview: d.preview.content, cut: d.cut })).not.toMatch(/contarcts|I row for the quiet|hl\.identity:said/);
    // with no Brief, the essence line, still never her note
    d = build(inputs({ identity: withSaid }));
    expect(lines(d).map((i) => i.key)).toEqual(["hl.identity:essence"]);
    // with neither, nothing: her note never fills the gap
    d = build(inputs({ identity: fakeIdentityView({ howToBeUnderstood: herWords }) }));
    expect(lines(d)).toEqual([]);
  });

  it("the Brief's positioning statement, in short, comes first; it is made, cites the Brief, and waits for her approval", () => {
    const d = build(inputs({ identity, positioning }));
    expect(lines(d).map((i) => [i.key, i.text, i.basis, i.publishable])).toEqual([
      ["hl.identity:positioning", "The rower who makes patience look like power.", "made", false],
    ]);
    expect(item(d, "hl.identity:positioning")!.sources).toEqual([{ kind: "memory_brief", id: "b1" }, { kind: "memory_fact", id: "mf1" }, { kind: "memory_fact", id: "mf2" }]);
    const text = "The rower who makes patience look like power.";
    const approved = build(inputs({ identity, positioning }), settings({ items: { "hl.identity:positioning": { state: "approved", textHash: textHash(text) } } }));
    expect(approved.preview.content.chapters[0].items.filter((i) => i.kind === "identity_line").map((i) => i.text)).toEqual([text]);
  });

  it("a statement she wrote herself publishes without a second approval", () => {
    const d = build(inputs({ identity, positioning: { ...positioning, hers: true } }));
    expect(item(d, "hl.identity:positioning")).toMatchObject({ publishable: true });
  });

  it("the short form: the first sentence, clipped at a word to about 120 characters", () => {
    const long = `${"Builder of crews and quiet mornings, ".repeat(5)}on every lake she can find. Second sentence.`;
    const short = shortPositioning(long);
    expect(short.length).toBeLessThanOrEqual(IDENTITY_LINE_MAX);
    expect(short.endsWith("\u2026")).toBe(true);
    expect(long.startsWith(short.slice(0, -1))).toBe(true);
    expect(short.slice(0, -1)).toMatch(/\S$/);
    expect(shortPositioning("Short and sweet. More here.")).toBe("Short and sweet.");
  });

  it("with no Brief, the essence line; with neither, nothing", () => {
    let d = build(inputs({ identity }));
    expect(lines(d).map((i) => i.key)).toEqual(["hl.identity:essence"]);
    d = build(inputs({ identity: fakeIdentityView() }));
    expect(lines(d)).toEqual([]);
  });

  it("with the positioning hidden, the essence line shows as proposed and publishes only once she approves that exact text", () => {
    const hidden: DraftDecisions = { items: { "hl.identity:positioning": { state: "hidden" } } };
    let d = build(inputs({ identity, positioning }), settings(hidden));
    expect(item(d, "hl.identity:essence")).toMatchObject({ basis: "made", publishable: false, blockedBy: "needs_approval", textHash: textHash(essence.short) });
    const approved: DraftDecisions = { items: { ...hidden.items, "hl.identity:essence": { state: "approved", textHash: textHash(essence.short) } } };
    d = build(inputs({ identity, positioning }), settings(approved));
    expect(published(d)).toContain("hl.identity:essence");
    // the text changed since she approved it: back to proposed
    const changed = fakeIdentityView({ essence: { ...essence, short: "A different line." } });
    d = build(inputs({ identity: changed, positioning }), settings(approved));
    expect(item(d, "hl.identity:essence")).toMatchObject({ publishable: false, blockedBy: "needs_approval" });
  });

  it("a pinned essence statement is approved made", () => {
    const pinned = fakeIdentityView({ essence: { ...essence, strength: "athlete_approved", pinned: true } });
    const d = build(inputs({ identity: pinned }));
    expect(item(d, "hl.identity:essence")).toMatchObject({ publishable: true });
  });
});

describe("D4 what publishes", () => {
  it("found needs her confirmation; said and proof publish on her tap; partners, media and stats wait for her pick", () => {
    const identity = fakeIdentityView({
      proofPoints: [
        { key: "p1", kind: "honour", text: "Regional sculls champion", basis: [fact("f1")], strength: "established", asOf: "2025-06-01" },
        { key: "p2", kind: "captaincy", text: "Crew captain", basis: [fact("f2"), said("a2")], strength: "established", asOf: "2026-02-01" },
      ],
      audience: { measured: { platforms: [{ platform: "instagram", followers: 8400, engagementPerFollower: null, topGeographies: [], age: [], gender: [], basis: [{ kind: "social_feature", key: "instagram.followers_latest" }] }] } },
    });
    const inp = inputs({
      identity,
      affiliations: [{ id: "af1", org: "Lakeside Rowing Club", kind: "club", level: null, conference: null, role: null, position: "Stroke", from: null, to: null, primary: true, current: true, kindOfFact: "said", source: null }],
      partners: [{ dealId: "d1", brandName: "Example Oars", logoUrl: null, signedAt: "2026-03-04T00:00:00.000Z" }],
      media: [{ assetId: "m1", mediaType: "image", postedAt: null, path: "athletes/a/m1.jpg" }],
    });
    let d = build(inp);
    expect(item(d, K("comp:p1"))).toMatchObject({ basis: "found", publishable: false, blockedBy: "needs_confirmation" });
    expect(item(d, K("comp:p2"))).toMatchObject({ basis: "said", publishable: true });
    expect(item(d, K("hl.aff:af1"))).toMatchObject({ basis: "said", publishable: true, text: "Lakeside Rowing Club", label: "Stroke" });
    expect(item(d, K("partner:d1"))).toMatchObject({ basis: "proof", publishable: false, blockedBy: "needs_approval", since: "2026-03" });
    expect(item(d, K("media:m1"))).toMatchObject({ publishable: false, blockedBy: "needs_approval" });
    expect(item(d, "hl.stat:instagram.followers")).toMatchObject({ publishable: false, value: 8400, asOf: "2026-10-08" });
    expect(published(d)).toEqual([K("hl.aff:af1"), K("comp:p2")]);

    d = build(inp, settings({ items: {
      [K("comp:p1")]: { state: "approved" }, [K("partner:d1")]: { state: "approved" }, "hl.stat:instagram.followers": { state: "approved" },
    } }));
    expect(published(d)).toEqual(["hl.stat:instagram.followers", K("hl.aff:af1"), K("partner:d1"), K("comp:p2"), K("comp:p1")]);
    expect(d.preview.sources.items[K("partner:d1")]).toEqual([{ kind: "deal", id: "d1" }]);
    // public keys never carry the internal ids behind them (those live only in the sources manifest)
    expect(JSON.stringify(d.preview.content)).not.toMatch(/:(d1|m1|af1|p1|p2|f1|f2|a2)"/);
  });
});

describe("D5 limits and minimums", () => {
  const beat = (t: string) => ({ text: t, basis: [fact(t)], strength: "reported" as const });
  it("one quote, three stats; Story needs two approved beats; Media three picks; Impact one cause", () => {
    const platforms = ["instagram", "tiktok", "youtube", "twitch"].map((p, i) => ({ platform: p, followers: 1000 * (i + 1), engagementPerFollower: null, topGeographies: [], age: [], gender: [], basis: [{ kind: "social_feature" as const, key: `${p}.f` }] }));
    const identity = fakeIdentityView({
      athleteStatements: ["s1", "s2"].map((id) => ({ id: `said:assertion:${id}`, ref: { kind: "said", source: "assertion", id }, text: `Words ${id}`, truncated: false, provenance: "her_own", medium: "conversation", source: { outlet: null, title: null, platform: null, url: null }, topics: [], at: null, intent: false, partner: false, citedBy: [] })) as any,
      audience: { measured: { platforms } },
      chapters: { origin: beat("Started on a borrowed foil."), rise: beat("Won the junior circuit."), defining: null, now: beat("Trains between lectures."), next: null },
      valuesEvidence: [{ text: "Coaches beginners weekly", basis: [said("a1")], strength: "established" }],
    });
    const media = ["m1", "m2", "m3"].map((id) => ({ assetId: id, mediaType: "image" as const, postedAt: null, path: `p/${id}.jpg` }));
    const approveAll: DraftDecisions = { items: Object.fromEntries([
      ...platforms.map((p) => [`hl.stat:${p.platform}.followers`, { state: "approved" as const }]),
      ["story.origin", { state: "approved" as const, textHash: textHash("Started on a borrowed foil.") }],
      ...media.slice(0, 2).map((m) => [K(`media:${m.assetId}`), { state: "approved" as const }]),
    ]) };
    let d = build(inputs({ fullName: "Kit Oyelaran", identity, media }), settings(approveAll));
    const hl = d.preview.content.chapters[0].items;
    expect(hl.filter((i) => i.kind === "quote").map((i) => i.text)).toEqual(["Words s1"]);
    expect(hl.filter((i) => i.kind === "stat")).toHaveLength(3);
    expect(item(d, "hl.stat:twitch.followers")).toMatchObject({ publishable: false, blockedBy: "over_limit" });
    expect(d.chapters.find((c) => c.key === "story")).toMatchObject({ minimum: 2, meetsMinimum: false });
    expect(d.chapters.find((c) => c.key === "impact")).toMatchObject({ meetsMinimum: false });   // a value is not a cause
    expect(d.preview.content.chapters.map((c) => c.key)).toEqual(["highlights"]);

    approveAll.items!["story.now"] = { state: "approved", textHash: textHash("Trains between lectures.") };
    approveAll.items![K("media:m3")] = { state: "approved" };
    approveAll.items![K("hl.quote:said:assertion:s2")] = { state: "approved" };
    d = build(inputs({ fullName: "Kit Oyelaran", identity, media }), settings(approveAll));
    expect(d.preview.content.chapters.map((c) => c.key)).toEqual(["highlights", "story", "media"]);
    expect(d.preview.content.chapters[0].items.find((i) => i.kind === "quote")!.text).toBe("Words s2");   // her chosen quote
    // every published media key has its stored object, and only those
    expect(Object.values(d.preview.media).map((m) => m.path).sort()).toEqual(["p/m1.jpg", "p/m2.jpg", "p/m3.jpg"]);
    expect(JSON.stringify(d.preview.content)).not.toContain("p/m1.jpg");
  });
});

describe("D6 doors and the grid", () => {
  const offer = { offerId: "o1", publicId: "pub1", title: "Belay clinic", priceCents: 15000, totalCents: 17796, currency: "usd", durationMinutes: 60 };
  const pick = { title: "Chalk bag", imageUrl: null, merchant: "Example Store", priceCents: 2500, currency: "usd", blurb: "Mine since day one.", discountCode: null, href: "https://nomila.test/go/ck1", disclosure: "Paid link" as const, amazon: false };

  it("Book only when bookings are ready, Shop only with live picks; offers and picks follow the doors; tiles come from the resolver", () => {
    let d = build(inputs({ fullName: "Sol Arnaut", offers: [offer], picks: [pick], bookReady: false }));
    expect(d.availability).toEqual({ book: false, shop: true });
    expect(d.preview.content.doors).toMatchObject({ book: false, shop: true });
    expect(d.preview.content.offers).toEqual([]);
    expect(d.preview.content.picks.map((p) => p.key)).toEqual(["pick:ck1"]);
    expect(d.preview.content.tiles).toEqual(tilesFor(d.preview.content));
    expect(d.preview.content.tiles.map((t) => t.intent)).toEqual(["partner", "story", "shop", "create"]);

    d = build(inputs({ fullName: "Sol Arnaut", offers: [offer], picks: [pick], bookReady: true }));
    expect(d.preview.content.offers).toEqual([expect.objectContaining({ key: "offer:pub1", totalCents: 17796 })]);
    expect(d.preview.content.tiles.map((t) => t.intent)).toEqual(["partner", "book", "shop", "create"]);

    // her switches win over availability
    d = build(inputs({ fullName: "Sol Arnaut", offers: [offer], picks: [pick], bookReady: true }), settings({}, { switches: { ...ON, book: false, shop: false } }));
    expect(d.preview.content.offers).toEqual([]);
    expect(d.preview.content.picks).toEqual([]);
  });

  it("a grid that would repeat a tile blocks publish with a clear reason", () => {
    const d = build(inputs({ fullName: "Sol Arnaut" }), settings({}, { switches: { ...ON, partner: false, book: false, shop: false } }));
    expect(d.canPublish).toBe(false);
    expect(d.blockedReason).toBe(DUPLICATE_TILES_REASON);
    const withSocial = build(inputs({ fullName: "Sol Arnaut", socials: [{ network: "Instagram", url: "https://www.instagram.com/example.sol", handle: "example.sol" }] }),
      settings({}, { switches: { ...ON, partner: false, book: false, shop: false } }));
    expect(withSocial.canPublish).toBe(true);
  });
});

describe("D7 M.I.A., buttons and copy", () => {
  it("M.I.A. appears only with show_mia, as number + level", () => {
    const mia = { score: 72, band: "HIGH", asOf: "2026-10-01" };
    expect(build(inputs({ mia })).preview.content.mia).toBeNull();
    expect(build(inputs({ mia }), settings({}, { showMia: true })).preview.content.mia).toEqual(mia);
  });

  it("buttons fall back when their door is off, and no public copy uses a pronoun", () => {
    const identity = fakeIdentityView({ causes: [{ text: "Safer crags", basis: [said("a1")], strength: "established" }] });
    const d = build(inputs({ fullName: "Ama Fenwick", nickname: { value: "Mae", ref: "nickname" }, identity }), settings({}, { switches: { ...ON, ask_mila: false } }));
    expect(d.preview.content.firstName).toBe("Mae");
    expect(d.preview.content.lastName).toBe("Fenwick");
    expect(d.preview.content.chapters.map((c) => c.button)).toEqual([{ door: "partner", label: "Work with Mae" }, { door: "partner", label: "Work with Mae" }]);
    const copy = JSON.stringify([d.preview.content.chapters.map((c) => [c.title, c.button]), d.preview.content.tiles]);
    expect(copy).not.toMatch(/\b(her|she|his|he|him)\b/i);
  });
});

describe("D8 her order, titles and hidden chapters; decisions validation", () => {
  it("Highlights first, then her order; her titles; hidden chapters stay out of the preview", () => {
    const identity = fakeIdentityView({
      causes: [{ text: "Open water safety", basis: [said("a1")], strength: "established" }],
      proofPoints: [{ key: "p1", kind: "honour", text: "Club record holder", basis: [said("a2")], strength: "established", asOf: null }],
    });
    let d = build(inputs({ identity }), settings({ order: ["impact", "highlights", "competition"], chapters: { impact: { title: "What matters" } } }));
    expect(d.preview.content.chapters.map((c) => [c.key, c.title])).toEqual([["highlights", "Highlights"], ["impact", "What matters"], ["competition", "Competition"]]);
    d = build(inputs({ identity }), settings({ chapters: { competition: { hidden: true } } }));
    expect(d.preview.content.chapters.map((c) => c.key)).toEqual(["highlights", "impact"]);
  });

  it("parseDecisions accepts the shape and refuses anything else", () => {
    expect(parseDecisions({ items: { [K("partner:d1")]: { state: "approved" } }, chapters: { story: { hidden: true, title: " Mine " } }, order: ["story", "story"] }))
      .toEqual({ ok: true, value: { items: { [K("partner:d1")]: { state: "approved" } }, chapters: { story: { hidden: true, title: "Mine" } }, order: ["story"] } });
    for (const bad of [null, [], { items: [] }, { items: { "x y": { state: "approved" } } }, { items: { k: { state: "maybe" } } },
      { items: { k: { state: "approved", textHash: "nothex" } } }, { chapters: { nope: {} } }, { chapters: { story: { title: "x".repeat(61) } } }, { order: ["nope"] }]) {
      expect(parseDecisions(bad).ok).toBe(false);
    }
  });
});

describe("D9 no raw bio, no contact details", () => {
  const stmt = (id: string, text: string, medium: string) => ({
    id: `social_feature:${id}`, ref: { kind: "social_feature", key: id }, text, truncated: false, provenance: "her_own", medium,
    source: { outlet: null, title: null, platform: "instagram", url: null }, topics: [], at: null, intent: false, partner: false, citedBy: [],
  });
  const BIO = "Rower 🚣 Lakeside crew 💌: someone@example.com ig: lake.rower";

  it("her profile bio is never a line: not the quote, not the identity line, nowhere in the draft or the preview", () => {
    const identity = fakeIdentityView({ athleteStatements: [stmt("instagram.profile.bio", BIO, "bio")] as any });
    const d = build(inputs({ identity }));
    const all = JSON.stringify({ chapters: d.chapters, preview: d.preview.content });
    expect(all).not.toContain("Lakeside crew");
    expect(all).not.toMatch(/someone@example\.com|lake\.rower/);
    expect(d.chapters[0].items.filter((i) => i.kind === "quote" || i.kind === "identity_line")).toEqual([]);
  });

  it("every line is filtered: a caption quote and a Brief statement lose their contact details, the rest stays", () => {
    const identity = fakeIdentityView({ athleteStatements: [stmt("m1", "Early water, best water. Booking: crew@example.com", "caption")] as any });
    const d = build(inputs({ identity, positioning: { statement: "The calmest stroke on the lake (DM @lake.rower).", briefId: "b1", factIds: [], hers: true } }));
    const quote = d.chapters[0].items.find((i) => i.kind === "quote")!;
    expect(quote.text).toBe("Early water, best water.");
    expect(item(d, "hl.identity:positioning")!.text).toBe("The calmest stroke on the lake.");
    expect(JSON.stringify(d.preview.content)).not.toMatch(/@example\.com|@lake\.rower/);
  });

  it("a line that was nothing but contact details is cut, with the reason she is shown", () => {
    const identity = fakeIdentityView({
      athleteStatements: [stmt("m2", "📧 hello@example.com", "caption")] as any,
      causes: [{ text: "www.example.org", basis: [said("a1")], strength: "established" }],
    });
    const d = build(inputs({ identity }));
    expect(d.cut.map((c) => [c.kind, c.reason]).sort()).toEqual([["cause", "contact_details"], ["quote", "contact_details"]]);
    expect(JSON.stringify(d.preview.content)).not.toMatch(/example\.(com|org)/);
  });

  it("a chapter title she typed loses contact details too", () => {
    const d = build(inputs(), settings({ chapters: { highlights: { title: "Hi! Email me@example.com" } } }));
    expect(d.preview.content.chapters[0].title).toBe("Hi!");
  });
});
