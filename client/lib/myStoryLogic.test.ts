/**
 * myStoryLogic.test — My Story S1's composition of GET /me/story (pure).
 *
 *   C1 hero: throughline.short → essence.short → positioning.current.short; none ⇒ null
 *   C2 pillars: proof keys resolve against proofPoints + signatureMoments, at most three, unknown keys dropped
 *   C3 chapters: non-null only, fixed order and labels, text exactly as served (any "Reported as" wording kept);
 *      a quote only when a statement is cited by the chapter or carries its fixed topic; never an intent; never twice;
 *      only a quotable one (source_read, or a written form answer) — never chat / voice / a caption / a bio
 *   C4 stands for: null when absent; her related statement beneath it; long only when it differs
 *   C5 headed: the desired positioning leads; direction deduplicated by objective id and identical wording; domain labels
 *   C6 why: fixed strength words, basis counts by kind, the cited statements
 *   C7 imagery: connected / upload only, never generated or discovery, never a reject; her only when the subject is known
 *      (another person, nobody and unknown excluded; an unread row passes); the hero needs a clear face, no group shot,
 *      and prefers a portrait frame when dimensions ride the row; pillars take clear or partial faces, never a group
 *      shot; hero first, one distinct photo per pillar; one photo ⇒ the hero owns it
 *   never: a string that is not served text or a fixed label
 * Fixtures are fictional.
 */
import { parseMeStory } from "../hooks/use-me-story";
import type { MeStory, MeStoryStatement } from "./meStoryLogic";
import {
  CHAPTER_LABEL, avatarPhotoUrl, chapterModel, domainLabel, eligibleStoryPhotos, headedModel, cardPhotos, detailPhoto, detailPhotos, heroCandidates, heroFor, heroModel, meImagery, pillarModel, seesModel, stableHash, standsForModel, statementSourceLine, storyImagery, storyPage, thumbUri, whyModel,
} from "./myStoryLogic";

jest.mock("../lib/query-client", () => ({ apiRequest: jest.fn() }));

const st = (id: string, over: Partial<MeStoryStatement> = {}): MeStoryStatement => ({
  id, text: `Words for ${id}.`, truncated: false, provenance: "her_own", medium: "caption", source: { outlet: null, title: null, platform: "instagram", url: null }, topics: [], at: null, intent: false, citedBy: [], ...over,
});

const served = {
  pageState: "ready",
  essence: { short: "A harbour-town rower who builds crews.", long: "A harbour-town rower who builds the crew around her.", basis: [{ kind: "fact", id: "f1" }], strength: "established" },
  positioning: { current: { short: "The crew-minded rower.", long: "The crew-minded rower, as her posts show.", basis: [{ kind: "media_asset", id: "c1" }], strength: "reported" }, desired: { value: "Be known as the rower who builds the next crew", source: "objective", basis: [{ kind: "objective", id: "o1" }] } },
  throughline: { short: "The water is the constant.", long: "From the harbour to the national squad, the water is the constant.", basis: [{ kind: "fact", id: "f1" }, { kind: "evidence", id: "e1" }], strength: "reported" },
  standsFor: { short: "Rowing opened to every kid on the harbour.", long: "Rowing opened to every kid on the harbour, whatever they can pay.", basis: [{ kind: "evidence", id: "e2" }], strength: "reported" },
  pillars: [
    { key: "competitor", label: "Competitor", definition: "Races at national level.", proof: ["pp:national", "sm:final", "pp:missing", "pp:captain"], basis: [{ kind: "fact", id: "f2" }], strength: "established", salience: 0.9 },
    { key: "builder", label: "Builder", definition: "Coaches the next crew.", proof: [], basis: [{ kind: "assertion", id: "a1" }], strength: "established", salience: 0.6 },
  ],
  proofPoints: [{ key: "pp:national", kind: "national_team", text: "National U23 squad, 2025", basis: [], strength: "established", asOf: null }, { key: "pp:captain", kind: "captaincy", text: "Crew captain", basis: [], strength: "established", asOf: null }],
  signatureMoments: [{ key: "sm:final", kind: "signature", text: "Stroked the winning crew at the regional final", basis: [], strength: "established", asOf: "2025-05-01" }],
  chapters: {
    origin: { text: "Reported as growing up rowing on the harbour.", athleteFacingText: "IGNORED PRE-754 TEXT", basis: [{ kind: "assertion", id: "a2" }], strength: "reported" },
    rise: null,
    defining: { text: "The regional final.", basis: [{ kind: "evidence", id: "e3" }], strength: "established" },
    now: { text: "Rowing for Lakeside College.", basis: [{ kind: "fact", id: "f2" }], strength: "established" },
  },
  direction: [
    { value: "Be known as the rower who builds the next crew", objectiveId: "o1", domain: "positioning", athleteAuthored: true, basis: [{ kind: "objective", id: "o1" }] },
    { value: "Start a coaching business for young rowers", objectiveId: "o2", domain: "owned_venture", athleteAuthored: true, basis: [{ kind: "objective", id: "o2" }] },
    { value: "start a coaching business for young rowers", objectiveId: "o3", domain: "impact", athleteAuthored: false, basis: [{ kind: "objective", id: "o3" }] },
    { value: "Grow a steadier presence on two platforms", objectiveId: "o4", domain: "audience_growth", athleteAuthored: false, basis: [{ kind: "objective", id: "o4" }] },
  ],
  imageGap: { text: "Coverage frames the final; her direction is the coaching.", basis: [{ kind: "evidence", id: "e4" }], strength: "reported" },
  athleteStatements: [
    { id: "said:assertion:a2", text: "I grew up rowing on the harbour every single morning", truncated: false, provenance: "her_own", medium: "form", source: { outlet: null, title: null, platform: null, url: null }, topics: ["origin"], at: null, intent: false, citedBy: ["chapters.origin", "origin"] },
    { id: "evidence:e2", text: "Every kid on the harbour should get a seat in a boat.", truncated: false, provenance: "source_read", medium: "video", source: { outlet: "Outlet One", title: "Morning interview", platform: null, url: "https://outlet-one.example/i" }, topics: ["values"], at: "2026-09-01T00:00:00.000Z", intent: false, citedBy: ["standsFor"] },
    { id: "said:objective:o1", text: "Be known as the rower who builds the next crew", truncated: false, provenance: "her_own", medium: "objective", source: { outlet: null, title: null, platform: null, url: null }, topics: ["ambition"], at: null, intent: true, citedBy: ["positioningDesired"] },
    { id: "media_asset:c1", text: "Another dawn on the water with the crew", truncated: false, provenance: "her_own", medium: "caption", source: { outlet: null, title: null, platform: "instagram", url: "https://instagram.example/p/1" }, topics: [], at: null, intent: false, citedBy: ["positioningCurrent"] },
  ],
};

const story: MeStory = parseMeStory(served);

describe("parse", () => {
  it("takes every part as served and never reads athleteFacingText", () => {
    expect(story.chapters.origin?.text).toBe("Reported as growing up rowing on the harbour.");
    expect(JSON.stringify(story)).not.toContain("IGNORED");
    expect(story.pillars[0].proof).toEqual(["pp:national", "sm:final", "pp:missing", "pp:captain"]);
    expect(story.athleteStatements).toHaveLength(4);
    expect(parseMeStory(null).pageState).toBe("unavailable");
    expect(parseMeStory({ pageState: "ready" }).chapters).toEqual({ origin: null, rise: null, defining: null, now: null });
  });
});

describe("C1 hero", () => {
  it("throughline → essence → positioning.current, short forms", () => {
    // ONE statement + ONE supporting line (essence.short), only when the statement is the throughline and differs.
    expect(heroModel(story)).toMatchObject({ text: "The water is the constant.", slot: "throughline", support: "A harbour-town rower who builds crews." });
    expect(heroModel({ ...story, throughline: null })).toMatchObject({ text: "A harbour-town rower who builds crews.", slot: "essence", support: null });
    expect(heroModel({ ...story, essence: { ...story.essence!, short: "The water is the constant." } })).toMatchObject({ slot: "throughline", support: null });
    expect(heroModel({ ...story, throughline: null, essence: null })).toMatchObject({ text: "The crew-minded rower.", slot: "positioningCurrent" });
    expect(heroModel({ ...story, throughline: null, essence: null, positioning: { current: null, desired: story.positioning.desired } })).toBeNull();
  });
});

describe("C2 pillars", () => {
  it("resolves proof keys in the pillar's order, drops unknown keys, caps at three", () => {
    const [competitor, builder] = pillarModel(story);
    expect(competitor.proof.map((p) => p.text)).toEqual(["National U23 squad, 2025", "Stroked the winning crew at the regional final", "Crew captain"]);
    expect(builder.proof).toEqual([]);
    expect(competitor.definition).toBe("Races at national level.");
  });
});

describe("C3 chapters", () => {
  it("non-null only, in order, fixed labels, served text exactly, a quote only where one relates", () => {
    const ch = chapterModel(story);
    expect(ch.map((c) => [c.key, c.label])).toEqual([["origin", CHAPTER_LABEL.origin], ["defining", CHAPTER_LABEL.defining], ["now", CHAPTER_LABEL.now]]);
    expect(ch[0].text).toBe("Reported as growing up rowing on the harbour.");
    expect(ch[0].quote?.id).toBe("said:assertion:a2");
    expect(ch[1].quote).toBeNull();
    expect(ch[2].quote).toBeNull();
  });
  it("falls back to the origin topic when nothing cites the origin chapter; never an intent; never the same statement twice", () => {
    const s: MeStory = { ...story, athleteStatements: [st("x", { medium: "form", topics: ["origin"], citedBy: [] }), st("y", { medium: "form", topics: ["origin"], citedBy: ["chapters.now"], intent: true })] };
    const ch = chapterModel(s);
    expect(ch[0].quote?.id).toBe("x");
    expect(ch[2].quote).toBeNull();
    const used = new Set(["x"]);
    expect(chapterModel(s, used)[0].quote).toBeNull();
  });
  it("features only published statements or written form answers — never chat, voice, a caption or a bio", () => {
    const chat = st("chat", { medium: "conversation", topics: ["origin"], citedBy: ["chapters.origin"], text: "i grew up rowing wiyh my dad" });
    const caption = st("cap", { medium: "caption", citedBy: ["chapters.origin"] });
    const bio = st("bio", { medium: "bio", citedBy: ["chapters.origin"] });
    const read = st("read", { provenance: "source_read", medium: "article", citedBy: ["chapters.origin"], text: "The harbour was my first coach." });
    expect(chapterModel({ ...story, athleteStatements: [chat, caption, bio] })[0].quote).toBeNull();
    expect(chapterModel({ ...story, athleteStatements: [chat, caption, bio, read] })[0].quote?.id).toBe("read");
    expect(whyModel({ title: "x", slot: "chapters.origin", text: "x", basis: [], strength: null }, [chat, caption, read]).quotes.map((q) => q.id)).toEqual(["read"]);
  });
  it("never quotes the chapter's own words back under it", () => {
    const s: MeStory = { ...story, athleteStatements: [st("same", { provenance: "source_read", medium: "article", text: "Reported as growing up rowing on the harbour.", citedBy: ["chapters.origin"] })] };
    expect(chapterModel(s)[0].quote).toBeNull();
  });
});

describe("C4 what you stand for", () => {
  it("renders only when served, with her cited statement, and the long form only when it differs", () => {
    const m = standsForModel(story)!;
    expect(m.short).toBe("Rowing opened to every kid on the harbour.");
    expect(m.long).toBe("Rowing opened to every kid on the harbour, whatever they can pay.");
    expect(m.quote?.text).toBe("Every kid on the harbour should get a seat in a boat.");
    expect(standsForModel({ ...story, standsFor: null })).toBeNull();
    expect(standsForModel({ ...story, standsFor: { short: "Same.", long: "Same.", basis: [], strength: "reported" } })!.long).toBeNull();
  });
  it("shares the used set with the chapters so one statement never appears twice", () => {
    const used = new Set<string>();
    chapterModel(story, used);
    const s: MeStory = { ...story, athleteStatements: story.athleteStatements.map((x) => (x.id === "said:assertion:a2" ? { ...x, citedBy: [...x.citedBy, "standsFor"] } : x)) };
    chapterModel(s, used);
    expect(standsForModel(s, used)!.quote?.id).toBe("evidence:e2");
  });
});

describe("C5 where you're headed", () => {
  it("leads with the desired positioning verbatim and deduplicates the rest by objective id and wording", () => {
    const h = headedModel(story)!;
    expect(h.lead).toEqual({ text: "Be known as the rower who builds the next crew", objectiveId: "o1" });
    expect(h.others).toEqual([
      { text: "Start a coaching business for young rowers", label: "Venture", objectiveId: "o2" },
      { text: "Grow a steadier presence on two platforms", label: "Audience growth", objectiveId: "o4" },
    ]);
    expect(headedModel({ ...story, positioning: { ...story.positioning, desired: null }, direction: [] })).toBeNull();
    expect(headedModel({ ...story, positioning: { ...story.positioning, desired: null } })!.lead).toBeNull();
  });
  it("domain labels are fixed words, never served text", () => {
    expect([domainLabel("impact"), domainLabel("audience"), domainLabel("brand_deals"), domainLabel(null), domainLabel("")]).toEqual(["Impact", "Audience", "Brand deals", null, null]);
  });
});

describe("C6 why Nomila sees this", () => {
  it("fixed strength words, basis counts by kind, and the cited statements", () => {
    const w = whyModel({ title: "Hero", slot: "throughline", text: "x", basis: [{ kind: "fact", id: "f1" }, { kind: "fact", id: "f3" }, { kind: "evidence", id: "e1" }, { kind: "state_finding", key: "k" }], strength: "reported" }, story.athleteStatements);
    expect(w.strengthLine).toMatch(/^Nomila holds this as reported/);
    expect(w.basisLine).toBe("Built from 2 facts, 1 source.");
    expect(w.quotes).toEqual([]);
    const sf = whyModel({ title: "Stands for", slot: "standsFor", text: "x", basis: [], strength: "athlete_approved" }, story.athleteStatements);
    expect(sf).toMatchObject({ strengthLine: "You approved this wording.", basisLine: null });
    expect(sf.quotes.map((q) => q.id)).toEqual(["evidence:e2"]);
  });
  it("source lines are fixed words around served names", () => {
    expect(statementSourceLine(story.athleteStatements[0])).toBe("Written to Nomila, in a form");
    expect(statementSourceLine(story.athleteStatements[1])).toBe("Outlet One · video");
    expect(statementSourceLine(story.athleteStatements[3])).toBe("Instagram caption");
    expect(statementSourceLine(st("b", { medium: "bio", source: { outlet: null, title: null, platform: "tiktok", url: null } }))).toBe("Tiktok bio");
    expect(statementSourceLine(st("o", { medium: "other", source: { outlet: null, title: null, platform: null, url: null } }))).toBe("Interview");
  });
});

describe("C7 imagery", () => {
  const photo = (asset_id: string, over: Partial<Parameters<typeof eligibleStoryPhotos>[0][number]> = {}) => ({ asset_id, url: `https://img.example/${asset_id}`, thumb_url: null, origin: "connected", ...over });
  it("keeps her connected posts and attested uploads only, never a reject, another person, nobody, an unknown subject, a generated or found image", () => {
    const pool = [photo("a"), photo("b", { origin: "upload", subject: "the_athlete" }), photo("c", { origin: "generated" }), photo("d", { origin: "discovery" }), photo("e", { reject: true }), photo("f", { subject: "another_person" }), photo("g", { subject: "nobody" }), photo("h", { madeHereNotHer: true }), photo("a"), photo("i", { url: null, thumb_url: null }), photo("j", { subject: "unknown" }), photo("k", { subject: null })];
    expect(eligibleStoryPhotos(pool).map((p) => p.asset_id)).toEqual(["a", "b", "k"]);
  });
  it("a poster or a captioned frame (shot_type text_graphic) is never eligible, whatever its origin or subject", () => {
    const pool = [photo("poster", { subject: "the_athlete", shot_type: "text_graphic", face: "clear" }), photo("her", { subject: "the_athlete", shot_type: "portrait", face: "clear" }), photo("up", { origin: "upload", shot_type: "text_graphic" })];
    expect(eligibleStoryPhotos(pool).map((p) => p.asset_id)).toEqual(["her"]);
    expect(meImagery(pool).hero?.asset_id).toBe("her");
    expect(storyImagery(pool, 1).hero).toBe("https://img.example/her");   // the only candidate: every screen reuses it
  });
  it("meImagery: one pool, one hero rule; the others are distinct and never the hero; avatarPhotoUrl prefers the record's photo, then the hero, else null", () => {
    const pool = [
      photo("poster", { subject: "the_athlete", shot_type: "text_graphic" }),
      photo("group", { subject: "the_athlete", shot_type: "group", face: "clear" }),
      photo("partial", { subject: "the_athlete", shot_type: "action", face: "partial" }),
      photo("hero", { subject: "the_athlete", shot_type: "portrait", face: "clear" }),
      photo("hero"),
      photo("other", { origin: "upload", subject: "the_athlete", shot_type: "lifestyle", face: "clear" }),
    ];
    const m = meImagery(pool);
    expect(m.hero?.asset_id).toBe("hero");
    expect(m.others.map((p) => p.asset_id)).toEqual(["group", "partial", "other"]);
    expect(m.ordered.map((p) => p.asset_id)).toEqual(["hero", "group", "partial", "other"]);
    // Two photos meet the hero bar ("hero", "other"): My Story takes the second, the screens after it reuse the best.
    expect(meImagery(pool, "story").hero?.asset_id).toBe("other");
    expect(meImagery(pool, "story").others.map((p) => p.asset_id)).toEqual(["group", "partial", "hero"]);
    expect(meImagery(pool, "intelligence").hero?.asset_id).toBe("hero");
    // the avatar: the Home hero's photo first (the record's photo is usually the sign-in picture), then the record's, else nothing
    expect(avatarPhotoUrl("https://img.example/record.jpg", m.ordered)).toBe("https://img.example/hero");
    expect(avatarPhotoUrl("https://img.example/record.jpg", [])).toBe("https://img.example/record.jpg");
    expect(thumbUri({ ...pool[3], thumb_url: "https://img.example/hero-thumb" })).toBe("https://img.example/hero-thumb");
    expect(avatarPhotoUrl("", m.ordered)).toBe("https://img.example/hero");
    expect(avatarPhotoUrl(null, m.ordered)).toBe("https://img.example/hero");
    expect(avatarPhotoUrl(null, [])).toBeNull();
    // no clear face anywhere ⇒ no hero; the pool still serves the tiles, nothing is invented
    const noHero = meImagery([pool[1], pool[2]]);
    expect(noHero.hero).toBeNull();
    expect(noHero.ordered.map((p) => p.asset_id)).toEqual(["group", "partial"]);
    expect(avatarPhotoUrl(null, noHero.ordered)).toBe("https://img.example/group");
    expect(meImagery([])).toEqual({ hero: null, others: [], ordered: [] });
  });
  it("the hero needs a clear face and no group shot, and prefers a portrait frame; pillars take clear or partial faces, never a group shot", () => {
    const pool = [
      photo("group", { subject: "the_athlete", shot_type: "group", face: "clear" }),
      photo("partial", { subject: "the_athlete", shot_type: "action", face: "partial" }),
      photo("land", { subject: "the_athlete", shot_type: "portrait", face: "clear", width: 1600, height: 900 }),
      photo("tall", { subject: "the_athlete", shot_type: "portrait", face: "clear", width: 900, height: 1600 }),
      photo("back", { subject: "the_athlete", shot_type: "action", face: "none" }),
    ];
    // Two hero candidates (tall, land): My Story's rank takes the second — the landscape — and the portrait stays Home's.
    expect(storyImagery(pool, 4)).toEqual({ hero: "https://img.example/land", pillars: ["https://img.example/partial", "https://img.example/tall", null, null] });
    expect(storyImagery(pool, 4, "home")).toEqual({ hero: "https://img.example/tall", pillars: ["https://img.example/partial", "https://img.example/land", null, null] });
    // no portrait frame known ⇒ the library's order decides: Home the first clear-faced non-group photo, My Story the next
    expect(storyImagery(pool.map((p) => ({ ...p, width: null, height: null })), 1, "home").hero).toBe("https://img.example/land");
    expect(storyImagery(pool.map((p) => ({ ...p, width: null, height: null })), 1).hero).toBe("https://img.example/tall");
    // only a partial face ⇒ no hero, but the pillar still has it
    expect(storyImagery([pool[0], pool[1], pool[4]], 2)).toEqual({ hero: null, pillars: ["https://img.example/partial", null] });
    // fields absent (library fields off) ⇒ both pass the bar; My Story takes the second, Home the first
    expect(storyImagery([photo("x"), photo("y")], 1)).toEqual({ hero: "https://img.example/y", pillars: ["https://img.example/x"] });
    expect(storyImagery([photo("x"), photo("y")], 1, "home")).toEqual({ hero: "https://img.example/x", pillars: ["https://img.example/y"] });
  });
  it("hero first, then one distinct photo per pillar; one photo ⇒ the hero owns it and the pillars go text-led (null → the light tile)", () => {
    // Fields absent (library fields off): every photo meets the hero bar, so My Story's rank takes the SECOND one.
    expect(storyImagery([photo("a"), photo("b"), photo("c")], 3)).toEqual({ hero: "https://img.example/b", pillars: ["https://img.example/a", "https://img.example/c", null] });
    expect(storyImagery([photo("a")], 2)).toEqual({ hero: "https://img.example/a", pillars: [null, null] });
    expect(storyImagery([], 2)).toEqual({ hero: null, pillars: [null, null] });
  });

  // ── the one picker: heroes by screen rank, a photo at most once per screen ──

  const her = (id: string, over: object = {}) => photo(id, { subject: "the_athlete", shot_type: "portrait", face: "clear", ...over });

  it("neighbouring screens prefer different heroes — by rank, and ONLY while another photo meets the hero bar", () => {
    const pool = [her("h0"), her("h1"), her("h2"), her("h3"), her("h4")];
    expect(heroFor(pool, "home")?.asset_id).toBe("h0");
    expect(heroFor(pool, "story")?.asset_id).toBe("h1");
    expect(heroFor(pool, "intelligence")?.asset_id).toBe("h2");
    expect(heroFor(pool, "knows")?.asset_id).toBe("h3");
    // Portrait frames rank ahead of landscapes whatever the library's order; the ranks follow.
    const framed = [her("land", { width: 1600, height: 900 }), her("tall", { width: 900, height: 1600 }), her("tall2", { width: 900, height: 1600 })];
    expect(heroCandidates(framed).map((p) => p.asset_id)).toEqual(["tall", "tall2", "land"]);
    expect(heroFor(framed, "home")?.asset_id).toBe("tall");
    expect(heroFor(framed, "story")?.asset_id).toBe("tall2");
    expect(heroFor(framed, "intelligence")?.asset_id).toBe("land");
  });

  it("falls back to the best suitable photo when only one meets the bar: suitability is never traded for variety", () => {
    const pool = [her("only"), photo("group", { subject: "the_athlete", shot_type: "group", face: "clear" }), photo("back", { subject: "the_athlete", shot_type: "action", face: "none" })];
    for (const screen of ["home", "story", "intelligence", "knows"] as const) expect(heroFor(pool, screen)?.asset_id).toBe("only");
    expect(meImagery(pool, "knows").hero?.asset_id).toBe("only");
    expect(storyImagery(pool, 2)).toEqual({ hero: "https://img.example/only", pillars: [null, null] });   // group + no face: not pillar material
    expect(heroFor([], "story")).toBeNull();
    // Two candidates: Home and My Story differ, the others reuse the best.
    const two = [her("a"), her("b")];
    expect([heroFor(two, "home")?.asset_id, heroFor(two, "story")?.asset_id, heroFor(two, "intelligence")?.asset_id, heroFor(two, "knows")?.asset_id]).toEqual(["a", "b", "a", "a"]);
  });

  it("one screen, one pool: the hero is never among the others, the others are distinct, and the pool runs out to null (the text-led tile), never to a repeat", () => {
    const pool = [her("h0"), her("h1"), photo("h1"), her("h2"), photo("land", { subject: "the_athlete", shot_type: "lifestyle", face: "partial" })];
    const home = meImagery(pool, "home");
    expect(home.hero?.asset_id).toBe("h0");
    expect(home.others.map((p) => p.asset_id)).toEqual(["h1", "h2", "land"]);
    expect(new Set([home.hero!.asset_id, ...home.others.map((p) => p.asset_id)]).size).toBe(4);
    // Taking the slots front to back (Me: a four-photo strip, then five doors) can never hand a photo out twice.
    const strip = home.others.slice(0, 4), doors = home.others.slice(strip.length, strip.length + 5);
    expect([...strip, ...doors].map((p) => p.asset_id)).toEqual(["h1", "h2", "land"]);
    expect(doors).toEqual([]);                                                        // exhausted ⇒ every door shows its icon tile
    // My Story on the same pool: its own hero (rank 1), then the pillars from what is left, in order; exhausted ⇒ null.
    expect(storyImagery(pool, 4)).toEqual({ hero: "https://img.example/h1", pillars: ["https://img.example/h0", "https://img.example/h2", "https://img.example/land", null] });
    // The avatar is the one allowed repeat: the face of the Home hero, never another photo.
    expect(avatarPhotoUrl(null, home.ordered)).toBe("https://img.example/h0");
  });

  it("recommendation cards: ONE photo per card, the same on every screen and on the detail deck's first page — never the hero, never a door's; distinct; past the pool, null", () => {
    const pool = Array.from({ length: 12 }, (_, i) => her(`h${i}`));          // h0 is the hero; h1..h5 are Home's doors
    const open = ["c", "a", "b", "d"];
    const home = cardPhotos(pool, open);
    // Order-free: the same open list in another order assigns the same photos.
    expect(cardPhotos(pool, [...open].reverse())).toEqual(home);
    const picked = [...home.values()].map((p) => p!.asset_id);
    expect(new Set(picked).size).toBe(4);                                        // no two open cards share a photo
    for (const id of picked) expect(["h0", "h1", "h2", "h3", "h4", "h5"]).not.toContain(id);   // never the hero or a door's
    // The detail deck opens on the card's own photo, then walks on to distinct ones.
    for (const id of open) {
      const deck = detailPhotos(pool, id, 3, open);
      expect(deck[0]).toBe(home.get(id));
      expect(new Set(deck.map((p) => p.asset_id)).size).toBe(3);
      expect(detailPhoto(pool, id, open)).toBe(home.get(id));
    }
    // Past the pool: the category default (null), never a repeat.
    const small = [her("h0"), her("h1"), her("h2")];                             // two others; too few to skip the doors
    const many = cardPhotos(small, ["a", "b", "c"]);
    expect([...many.values()].filter(Boolean)).toHaveLength(2);
    expect([...many.values()].filter((p) => p === null)).toHaveLength(1);
    expect(cardPhotos([], ["a"]).get("a")).toBeNull();
    expect(cardPhotos([her("only")], ["a"]).get("a")).toBeNull();               // the only photo is the hero
    // A record that has left the open list still gets a stable pick.
    expect(stableHash("a")).toBe(stableHash("a"));
    expect(detailPhoto(pool, "closed-1", open)).toBe(detailPhoto(pool, "closed-1", open));
    expect(detailPhoto([], "rec-1")).toBeNull();
  });
});

describe("page", () => {
  it("unavailable / learning / ready, and the image gap exactly", () => {
    expect(storyPage(null)).toBe("unavailable");
    expect(storyPage({ ...story, pageState: "learning" })).toBe("learning");
    expect(storyPage({ ...story, pageState: "updating" })).toBe("learning");
    expect(storyPage(story)).toBe("ready");
    expect(seesModel(story)?.text).toBe("Coverage frames the final; her direction is the coaching.");
    expect(seesModel({ ...story, imageGap: null })).toBeNull();
  });
});
