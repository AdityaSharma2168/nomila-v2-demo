/**
 * source-read/1 + research-spec/1.1 identity sources — pure: selection ranking, cap and reuse key; readable URLs; the request;
 * parsing; the extraction mapping (verbatim statement vs paraphrase, topics, timestamps, lineage); athlete_media discovery
 * mapping; outlet classification precedence; the plan table unchanged. No provider, no database.
 */

import { describe, expect, it } from "@jest/globals";
import { SPEC_V1_DOMAIN_QUERIES, v3AcceptanceDomains } from "../plans";
import { DEFAULT_RESEARCH_POLICY, modelOutletType, resolveSourceType } from "../policy";
import { contractForV2, directRequestV2, FORBIDDEN_IN_V2_CONTRACT, parseDirectEvidenceV2, type Finding } from "./directEvidenceV2";
import { mapFinding } from "./itemMapping";
import { FORBIDDEN_IN_REQUESTS, QUERIES, sectionsFor } from "./researchSpecV1";
import {
  chunkMatchText, groundedCandidates, isDomainTitle, isVerbatimAthleteStatement, slugText, mapSourceRead, matchHintToChunk, parseSourceRead, rankReadCandidates, readKeyUrl, readModeOf, readRank,
  registrableDomain, sameSourceDomain, selectReadTargets, SOURCE_READ_VERSION, sourceReadRequest, surnameToken, timestampSeconds, titleOverlap, titleTokens,
  toReadTarget, youtubeVideoUrl, type GroundedChunk, type MediaHint, type ReadCandidate,
} from "./sourceReadV1";

const cand = (url: string, over: Partial<ReadCandidate> = {}): ReadCandidate => ({ evidenceId: `e-${url}`, url, title: null, outlet: null, outletType: null, sourceType: "unknown", medium: "article", participation: "mention", athleteQuoted: false, date: null, lineage: "native_supported", ...over });
const SUBJECT = { fullName: "Jane Doe", sport: "basketball", anchor: "basketball athlete, Example University", isMinor: false };
const Q3 = QUERIES.find((q) => q.id === "Q3")!;

describe("readable URLs", () => {
  it("canonicalizes public YouTube video URLs and reads them as video; channels, redirects, audio-only podcasts are not readable", () => {
    for (const u of ["https://youtu.be/abcDEF12345", "https://www.youtube.com/watch?v=abcDEF12345&t=30", "https://m.youtube.com/shorts/abcDEF12345", "https://youtube.com/live/abcDEF12345"]) {
      expect(youtubeVideoUrl(u)).toBe("https://www.youtube.com/watch?v=abcDEF12345");
      expect(readModeOf(u, "video")).toBe("youtube");
    }
    expect(readModeOf("https://www.youtube.com/@somechannel", "video")).toBeNull();
    expect(readModeOf("https://vertexaisearch.cloud.google.com/grounding-api-redirect/xyz", "article")).toBeNull();
    expect(readModeOf("https://open.spotify.com/episode/1", "podcast")).toBeNull();
    expect(readModeOf("https://cdn.example.com/ep1.mp3", "other")).toBeNull();
    expect(readModeOf("https://show.example.com/episodes/12", "podcast")).toBeNull();                 // no video, no transcript page
    expect(readModeOf("https://show.example.com/episodes/12/transcript", "podcast")).toBe("page");
    expect(readModeOf("https://www.youtube.com/watch?v=abcDEF12345", "podcast")).toBe("youtube");      // a podcast's video version
    expect(readModeOf("https://news.example.com/a", "press_conference")).toBe("page");
    expect(readModeOf("ftp://x.example/a", "article")).toBeNull();
  });
  it("the reuse key is the canonical video URL or the conservatively normalized URL", () => {
    expect(readKeyUrl("https://youtu.be/abcDEF12345")).toBe("https://www.youtube.com/watch?v=abcDEF12345");
    expect(readKeyUrl("http://www.News.example.com/a/?utm_source=x#top")).toBe("https://news.example.com/a");
  });
});

describe("selection: participation > quoted in search > outlet authority > identity relevance > recency, capped, reuse by spec version", () => {
  const cs = [
    cand("https://blog.example.net/m", { participation: "mention", outletType: "aggregator_or_blog", athleteQuoted: true }),
    cand("https://news.example.com/profile", { participation: "profile", outletType: "major_news", date: "2025-01-01" }),
    cand("https://club.example.org/profile", { participation: "profile", outletType: "official_team_or_school", date: "2024-01-01" }),
    cand("https://news.example.com/interview", { participation: "interview", outletType: "regional_news" }),
    cand("https://youtu.be/abcDEF12345", { participation: "own_words", medium: "video", outletType: "major_news" }),
    cand("https://local.example.com/profile-new", { participation: "profile", outletType: "official_team_or_school", date: "2026-06-01" }),
    cand("https://open.spotify.com/episode/1", { participation: "interview", medium: "podcast" }),
  ];
  it("ranks deterministically and caps at max (default config 3)", () => {
    const s = selectReadTargets(cs, { max: 3, alreadyRead: new Set() });
    expect(s.targets.map((t) => t.readUrl)).toEqual(["https://www.youtube.com/watch?v=abcDEF12345", "https://news.example.com/interview", "https://local.example.com/profile-new"]);
    expect(s.targets.map((t) => t.mode)).toEqual(["youtube", "page", "page"]);
    expect(s.skipped).toEqual({ unreadable: 1, alreadyRead: 0, duplicate: 0, overCap: 3 });
    // own_words ties interview: the more authoritative outlet first (youtube.com is a platform host, so the model's major_news
    // decides; news.example.com is unlisted, so the model's regional_news stands); same participation + authority: newer first
    const all = selectReadTargets(cs, { max: 10, alreadyRead: new Set() }).targets.map((t) => t.readUrl);
    expect(all).toEqual(["https://www.youtube.com/watch?v=abcDEF12345", "https://news.example.com/interview", "https://local.example.com/profile-new", "https://club.example.org/profile", "https://news.example.com/profile", "https://blog.example.net/m"]);
    expect(selectReadTargets([...cs].reverse(), { max: 10, alreadyRead: new Set() }).targets.map((t) => t.readUrl)).toEqual(all);   // input order never matters
    expect(selectReadTargets(cs, { max: 0, alreadyRead: new Set() }).targets).toEqual([]);
  });
  it("a search-grounded athlete quote raises priority within the same participation; identity relevance breaks authority ties", () => {
    const a = cand("https://a.example.com/x", { participation: "mention", outletType: "major_news" });
    const b = cand("https://b.example.com/x", { participation: "mention", outletType: "aggregator_or_blog", athleteQuoted: true });
    expect(selectReadTargets([a, b], { max: 1, alreadyRead: new Set() }).targets[0].readUrl).toBe("https://b.example.com/x");
    const c = cand("https://c.example.com/x", { lineage: "asserted_only" }), d = cand("https://d.example.com/x", { lineage: "native_supported" });
    expect(selectReadTargets([c, d], { max: 1, alreadyRead: new Set() }).targets[0].readUrl).toBe("https://d.example.com/x");
  });
  it("skips sources already read for this spec version and keeps one target per URL", () => {
    const s = selectReadTargets([...cs, cand("https://www.youtube.com/watch?v=abcDEF12345", { participation: "mention" })], { max: 3, alreadyRead: new Set(["https://www.youtube.com/watch?v=abcDEF12345", "https://news.example.com/interview"]) });
    expect(s.targets.map((t) => t.readUrl)).toEqual(["https://local.example.com/profile-new", "https://club.example.org/profile", "https://news.example.com/profile"]);
    expect(s.skipped).toMatchObject({ alreadyRead: 3 });
    const dup = selectReadTargets([cand("https://x.example.com/a", { participation: "mention" }), cand("https://www.x.example.com/a/", { participation: "interview" })], { max: 3, alreadyRead: new Set() });
    expect(dup.targets).toHaveLength(1); expect(dup.targets[0].participation).toBe("interview"); expect(dup.skipped.duplicate).toBe(1);
  });
});

describe("grounded candidates: model items are hints; candidate URLs come only from grounding chunks", () => {
  // = config GROUNDED_READ_MATCH (config.ts imports the database module, so this pure suite restates the values)
  const TH = { domainTitleJaccard: 0.5, domainTitleContainment: 0.7, strongTitleJaccard: 0.6, strongTitleContainment: 0.8, minContainmentTokens: 3 };
  const R = (k: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ${k}`;
  const chunk = (k: string, domain: string, title: string): GroundedChunk => ({ chunkId: `Q3:${k}`, url: R(k), domain, title });
  const hint = (claimedUrl: string | null, title: string | null, over: Partial<MediaHint> = {}): MediaHint => ({ evidenceId: `e-${title}`, claimedUrl, title, outlet: null, outletType: null, sourceType: "unknown", medium: "video", participation: "interview", athleteQuoted: false, date: null, lineage: "native_supported", ...over });
  const none = new Map<string, string | null>();

  it("normalises titles and registrable domains simply and deterministically", () => {
    expect([...titleTokens("Jané Doe | National TV Interview - YouTube")]).toEqual(["jane", "doe", "national", "tv", "interview"]);
    expect(titleOverlap("Jane Doe national TV interview", "Jane Doe | National TV Interview - YouTube")).toEqual({ jaccard: 1, containment: 1 });
    expect(registrableDomain("www.news.example.com")).toBe("example.com");
    expect(registrableDomain("sport.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("youtu.be")).toBe("youtube.com");
    expect(sameSourceDomain("youtube.com", "https://youtu.be/FAKEfake001", null)).toBe(true);
    expect(sameSourceDomain("examplenetwork.com", null, "Example Network")).toBe(true);           // outlet name = the domain's first label
    expect(sameSourceDomain("youtube.com", R("x"), null)).toBe(false);                          // a redirect link says nothing about the outlet
    expect(surnameToken("Jane Q. Doe Jr.")).toBe("doe");
  });

  it("live grounding titles are only domains: a chunk's match text is its resolved URL's slug, or a video's oEmbed title", () => {
    expect(slugText("https://regional.example.com/news/2026/05/01/jane-doe-talks-leadership-and-community-12345")).toBe("jane doe talks leadership and community");
    expect(slugText("https://www.example.org/stories/Jos%C3%A9_Doe.Profile.html?id=7")).toBe("jose doe profile");
    expect(isDomainTitle("youtube.com", "youtube.com")).toBe(true);
    expect(isDomainTitle("sub.example-site.org", null)).toBe(true);
    expect(isDomainTitle("Jane Doe interview", "example.com")).toBe(false);
    expect(chunkMatchText("youtube.com", "youtube.com", "https://www.youtube.com/watch?v=GENUINEid01", "Jane Doe on National TV")).toBe("Jane Doe on National TV");
    expect(chunkMatchText("youtube.com", "youtube.com", "https://www.youtube.com/watch?v=GENUINEid01", null)).toBe("");
    expect(chunkMatchText("example.com", "example.com", "https://example.com/news/jane-doe-signs", null)).toBe("jane doe signs");
    const live = { chunkId: "Q3:a", url: R("a"), domain: "regional.example.com", title: chunkMatchText("regional.example.com", "regional.example.com", "https://regional.example.com/news/jane-doe-talks-leadership-and-community", null) };
    expect(matchHintToChunk(hint("https://regional.example.com/made-up", "Jane Doe talks leadership and community"), [live], none, TH)).toBe(live);
    const domainOnly = { chunkId: "Q3:b", url: R("b"), domain: "athletics.example.edu", title: chunkMatchText("athletics.example.edu", "athletics.example.edu", "https://athletics.example.edu/sports/roster/season/2026", null) };
    expect(matchHintToChunk(hint("https://athletics.example.edu/feature/jane-doe", "Jane Doe feature profile"), [domainOnly], none, TH)).toBeNull();
    // the athlete's name alone on the same domain is not enough (Jaccard 2/5 < 0.5)
    const roster = { chunkId: "Q1:r", url: "https://example.edu/roster/jane-doe", domain: "example.edu", title: chunkMatchText("Roster", "example.edu", "https://example.edu/roster/jane-doe", null) };
    expect(matchHintToChunk(hint("https://athletics.example.edu/feature/x", "Jane Doe feature profile"), [roster], none, TH)).toBeNull();
  });

  it("a fabricated video id matches the genuine grounded video by domain + title; the model URL never becomes a candidate URL", () => {
    const tv = chunk("tv", "youtube.com", "Jane Doe | National TV Interview - YouTube");
    const other = chunk("o", "youtube.com", "Jane Doe sits down with Club TV - YouTube");
    const h = hint("https://www.youtube.com/watch?v=FAKEfake001", "Jane Doe national TV interview");
    expect(matchHintToChunk(h, [other, tv], none, TH)).toBe(tv);
    const { candidates, ungrounded } = groundedCandidates([h], [other, tv], { resolved: none, surname: null, thresholds: TH });
    expect(ungrounded).toEqual([]);
    expect(candidates).toEqual([expect.objectContaining({ url: tv.url, domain: "youtube.com", origin: "item", participation: "interview", evidenceId: h.evidenceId })]);
    expect(JSON.stringify(candidates)).not.toContain("FAKEfake001");
  });

  it("same domain with weak title overlap is not a match; strong title overlap alone is; an exact (resolved) URL is", () => {
    const c = chunk("c", "youtube.com", "Jane Doe sits down with Club TV - YouTube");
    expect(matchHintToChunk(hint("https://www.youtube.com/watch?v=FAKEfake001", "Jane Doe national TV interview"), [c], none, TH)).toBeNull();
    const elsewhere = chunk("e", "regional.example.org", "Jane Doe on growing up and leading her team");
    expect(matchHintToChunk(hint("https://invented.example.net/x", "Jane Doe on growing up and leading her team"), [elsewhere], none, TH)).toBe(elsewhere);
    const exact = chunk("x", "feature.example.org", "Feature");
    expect(matchHintToChunk(hint("https://feature.example.org/story/", "Unrelated words"), [exact], new Map([[exact.url, "https://www.feature.example.org/story"]]), TH)).toBe(exact);
    expect(matchHintToChunk(hint(exact.url, null), [exact], none, TH)).toBe(exact);               // discovery repeated the grounding link itself
  });

  it("no match ⇒ ungrounded (never a candidate); a retrieved page about the athlete the model did not list enters as a grounding candidate", () => {
    const about = chunk("a", "local.example.com", "Quillfeather leads late rally");
    const unrelated = chunk("u", "weather.example.com", "Weekend weather outlook");
    const h = hint("https://invented.example.net/made-up", "Exclusive: an interview grounding never retrieved");
    const { candidates, ungrounded } = groundedCandidates([h], [about, unrelated], { resolved: none, surname: surnameToken("Jane Quillfeather"), thresholds: TH });
    expect(ungrounded).toEqual([h]);
    expect(candidates).toEqual([expect.objectContaining({ url: about.url, origin: "grounding", evidenceId: null, participation: null, lineage: "native_retrieved" })]);
    // unknown participation ranks as a mention: below a matched interview
    const interview = { ...cand(R("i"), { participation: "interview" }), domain: "news.example.com", origin: "item" as const };
    expect(rankReadCandidates([candidates[0], interview]).map((c) => c.url)).toEqual([R("i"), about.url]);
    expect(readRank(candidates[0], "unknown")[0]).toBe(readRank(cand("https://x.example.com", { participation: "mention" }), "unknown")[0]);
  });

  it("toReadTarget applies the readability and authority rules to the REAL url", () => {
    expect(toReadTarget(cand("https://youtu.be/REALreal001", { medium: "video" }))).toMatchObject({ readUrl: "https://www.youtube.com/watch?v=REALreal001", mode: "youtube" });
    expect(toReadTarget(cand(R("x")))).toBeNull();
  });
});

describe("the read request", () => {
  it("names the one source, asks for verbatim statements and the identity items, never a forbidden word; a minor is minimized", () => {
    const r = sourceReadRequest(SUBJECT, { readUrl: "https://news.example.com/a", mode: "page", title: "T", outlet: "O" }, "2026-10-03");
    expect(r).toContain("Source to read (web page): https://news.example.com/a");
    expect(r).toContain(`"contract": "${SOURCE_READ_VERSION}"`);
    expect(r).toMatch(/"timestamp": null/);
    for (const id of ["origin_background", "motivations", "interests", "playing_style", "leadership_mentality", "signature_moments", "values_causes"]) expect(r).toContain(`"${id}"`);
    for (const re of FORBIDDEN_IN_REQUESTS) expect(r).not.toMatch(re);
    const v = sourceReadRequest({ ...SUBJECT, isMinor: true }, { readUrl: "https://www.youtube.com/watch?v=abcDEF12345", mode: "youtube", title: null, outlet: null }, "2026-10-03");
    expect(v).toContain("public video, attached"); expect(v).toMatch(/H:MM:SS or MM:SS/); expect(v).toContain("This athlete is a minor");
  });
});

describe("parsing and extraction mapping", () => {
  const target = { readUrl: "https://www.youtube.com/watch?v=abcDEF12345", mode: "youtube" as const, title: "Listed", outlet: "Listed Outlet", outletType: "regional_news" };
  const answer = (o: Record<string, unknown>) => parseSourceRead("```json\n" + JSON.stringify({ contract: SOURCE_READ_VERSION, source: { url: target.readUrl, title: "Sit-down", outlet: "Club TV", outlet_type: "official_team_or_school", published_at: "2026-04-02", medium: "video", about_athlete: "yes", read: "true" }, statements: [], items: {}, ...o }) + "\n```");

  it("a verbatim statement in the athlete's own voice → athlete_statement; paraphrase / reported speech / someone else → narrative_claim", () => {
    const p = answer({ statements: [
      { text: "I play for my grandmother.", verbatim: true, speaker: "athlete", topics: ["motivation", "values", "nonsense"], timestamp: "1:02:03" },
      { text: "She said that she plays for her grandmother.", verbatim: true, speaker: "athlete", topics: ["motivation"] },
      { text: "Playing for her grandmother drives her.", verbatim: false, speaker: "athlete", topics: ["values"] },
      { text: "She leads by example.", verbatim: true, speaker: "other", topics: ["leadership"] },
      { text: "Leadership is earned.", verbatim: "true", speaker: "athlete", timestamp: 95 },
    ] });
    const m = mapSourceRead(p, target, "r0");
    expect(m).toMatchObject({ statements: 2, paraphrases: 3, dropped: null });
    const st = m.claims.filter((c) => c.kind === "athlete_statement");
    expect(st.map((c) => c.claim)).toEqual([
      { text: "I play for my grandmother.", topics: ["motivation", "values"], medium: "video", speaker: "athlete", timestampSeconds: 3723, sourceTitle: "Sit-down", outlet: "Club TV", readSpec: SOURCE_READ_VERSION },
      { text: "Leadership is earned.", topics: ["other"], medium: "video", speaker: "athlete", timestampSeconds: 95, sourceTitle: "Sit-down", outlet: "Club TV", readSpec: SOURCE_READ_VERSION },
    ]);
    for (const c of m.claims) {
      expect(c.lineage).toMatchObject({ level: "source_read", boundChunkIds: ["r0:c0"], boundSources: [{ url: target.readUrl, domain: "youtube.com" }] });
      expect(c.sources[0]).toMatchObject({ url: target.readUrl, outletType: "official_team_or_school", publishedAt: "2026-04-02" });
    }
    const para = m.claims.filter((c) => c.kind === "narrative_claim");
    expect(para.map((c) => [c.claim.topic, c.claim.paraphrase])).toEqual([["motivation", true], ["values_causes", true], ["leadership", true]]);
    expect(para.some((c) => c.kind === ("athlete_statement" as string))).toBe(false);
  });

  it("timestamps only for video; page statements never carry one", () => {
    const p = answer({ statements: [{ text: "I grew up on that court.", verbatim: true, speaker: "athlete", topics: ["origin"], timestamp: "12:34" }] });
    expect(mapSourceRead(p, { ...target, mode: "page", readUrl: "https://news.example.com/a" }, "r1").claims[0].claim).not.toHaveProperty("timestampSeconds");
    expect(timestampSeconds("12:34")).toBe(754); expect(timestampSeconds("1:02:03")).toBe(3723); expect(timestampSeconds("95s")).toBe(95); expect(timestampSeconds("about a minute in")).toBeNull();
    expect(isVerbatimAthleteStatement({ text: "He says he loves it", verbatim: true, speaker: "athlete", topics: [], timestamp: null })).toBe(false);
  });

  it("items map through the existing item mapping with source_read lineage; unasked items are ignored", () => {
    const p = answer({ items: {
      playing_style: [{ value: { text: "relentless in transition", described_by: "scout" }, statement: "Scouts call her relentless in transition." }],
      signature_moments: [{ value: { event: "scored the winner in the final", date: "2025-12-01" }, statement: "She scored the winner in the final." }],
      hometown: [{ value: { city: "Springfield", country: "USA" }, statement: "She grew up in Springfield." }],
      reported_allegations: [{ value: { event: "x" }, statement: "x" }],
    } });
    const m = mapSourceRead(p, target, "r2");
    expect(m.claims.map((c) => [c.kind, c.item])).toEqual([["narrative_claim", "playing_style"], ["career_event", "signature_moments"], ["profile_attribute", "hometown"]]);
    expect(m.claims[0].claim).toMatchObject({ topic: "playing_style", text: "relentless in transition", describedBy: "scout", readSpec: SOURCE_READ_VERSION });
    expect(m.claims[1].claim).toMatchObject({ eventKind: "signature", event: "scored the winner in the final" });
    expect(m.claims[2].claim).toMatchObject({ factKey: "hometown", value: { city: "Springfield", country: "USA" } });
    expect(m.claims.every((c) => c.lineage.level === "source_read")).toBe(true);
  });

  it("a source that is not about the athlete, could not be read, or did not parse yields nothing", () => {
    expect(mapSourceRead(answer({ source: { about_athlete: "no", read: true }, statements: [{ text: "I x", verbatim: true, speaker: "athlete" }] }), target, "r3")).toMatchObject({ claims: [], dropped: "the source is not about this athlete" });
    expect(mapSourceRead(answer({ source: { read: "false" } }), target, "r3")).toMatchObject({ claims: [], dropped: "the model could not read the source" });
    expect(mapSourceRead(parseSourceRead("no json here"), target, "r3")).toMatchObject({ claims: [], dropped: expect.stringMatching(/^unparseable/) });
  });
});

describe("research-spec/1.1 discovery: athlete_media and the identity items", () => {
  const f = (item: string, value: Record<string, unknown>, section: any = "S5"): Finding => ({ section, item, value, statement: "s", asOf: null, sources: [{ url: "https://x.example.com/a", title: null, publishedAt: null, quote: "q" }], lineage: { level: "native_supported", match: "index_support", boundChunkIds: ["d2:c0"], boundSources: [], detail: null, bindingMethod: "quote_exact" } });
  it("Q3 asks for athlete_media with outlet type, URL, medium and participation; every source carries an outlet_type; no forbidden word", () => {
    const req = directRequestV2(SUBJECT, Q3, sectionsFor(false), "2026-10-03");
    for (const w of ['"athlete_media"', '"outlet_type"', '"participation"', '"signature_moments"', '"playing_style"', '"leadership_mentality"', '"origin_background"', '"motivations"', '"interests"', '"associations"']) expect(req).toContain(w);
    expect(req).toMatch(/interview \| own_words \| profile \| mention/);
    expect(req).toMatch(/official_governing_body \| official_team_or_school \| major_news/);
    for (const re of [...FORBIDDEN_IN_REQUESTS, ...FORBIDDEN_IN_V2_CONTRACT]) expect(contractForV2(Q3, sectionsFor(false))).not.toMatch(re);
    for (const re of FORBIDDEN_IN_REQUESTS) expect(req).not.toMatch(re);
    const parsed = parseDirectEvidenceV2(JSON.stringify({ items: { athlete_media: { status: "found", findings: [{ value: { url: "https://n.example.com/a" }, statement: "s", sources: [{ url: "https://n.example.com/a", quote: "q", outlet_type: "Major_News" }] }] } } }), Q3, sectionsFor(false));
    expect(parsed.items.athlete_media!.findings[0].sources[0].outletType).toBe("major_news");
  });
  it("athlete_media → press_mention (podcast → crossover_appearance); medium/participation normalized; a search quote is a flag, never text", () => {
    const [a] = mapFinding(f("athlete_media", { title: "T", outlet: "O", outlet_type: "Major News", url: "https://n.example.com/a", medium: "Press Conference", participation: "own words", athlete_quote: "I am ready." }));
    expect(a).toMatchObject({ kind: "press_mention", claim: { topic: "athlete_media", outlet: "O", outletType: "major_news", title: "T", headline: "T", url: "https://n.example.com/a", medium: "press_conference", participation: "own_words", athleteQuoted: true } });
    expect(JSON.stringify(a.claim)).not.toContain("I am ready.");
    const [p] = mapFinding(f("athlete_media", { url: "https://p.example.com/1", medium: "podcast", participation: "guest" }));
    expect(p.kind).toBe("crossover_appearance");
    expect(p.claim).not.toHaveProperty("participation");                                  // unknown participation is never guessed
    expect(mapFinding(f("athlete_media", { medium: "hologram" }))[0].claim.medium).toBe("other");
  });
  it("S6 identity items map to narrative_claim topics; signature moments to career_event (signature)", () => {
    const one = (item: string, v: Record<string, unknown>) => mapFinding(f(item, v, "S6"))[0];
    expect(one("playing_style", { text: "t", described_by: "coach" })).toMatchObject({ kind: "narrative_claim", claim: { topic: "playing_style", text: "t", describedBy: "coach" } });
    expect(one("leadership_mentality", { text: "t" }).claim.topic).toBe("leadership");
    expect(one("origin_background", { text: "t" }).claim.topic).toBe("origin");
    expect(one("motivations", { text: "t" }).claim.topic).toBe("motivation");
    expect(one("interests", { text: "t" }).claim.topic).toBe("interests");
    expect(one("associations", { text: "t", associated_with: "a show" })).toMatchObject({ claim: { topic: "association", associatedWith: "a show" } });
    expect(one("signature_moments", { event: "e", date: "2020-01-01", competition: "c" })).toMatchObject({ kind: "career_event", claim: { eventKind: "signature", event: "e", competition: "c" } });
  });
  it("planning is unchanged (the #709 table); Q3 additionally ACCEPTS signature moments' profile evidence", () => {
    expect(SPEC_V1_DOMAIN_QUERIES).toEqual({ identity: ["Q1"], affiliations: ["Q1"], achievements: ["Q2"], press: ["Q3", "Q6"], narrative: ["Q3"], brand_mentions: ["Q4"], social_handles: ["Q5"], profile: ["Q1", "Q6"], signals: [] });
    expect(v3AcceptanceDomains("Q3")).toEqual(["profile", "press", "narrative"]);
  });
});

describe("outlet classification precedence", () => {
  it("a real outlet domain the list classifies keeps its class whatever the model says (.edu, governing body, news)", () => {
    for (const t of ["major_news", "aggregator_or_blog", "official_governing_body", "athlete_authored_public", null, "unknown", "tier_1"]) expect(resolveSourceType(t as any, "athletics.example.edu", DEFAULT_RESEARCH_POLICY)).toBe("official_team_or_school");
    for (const t of ["major_news", "official_team_or_school", "athlete_authored_public"]) expect(resolveSourceType(t, "www.ncaa.org")).toBe("official_governing_body");
    expect(resolveSourceType("official_governing_body", "espn.com")).toBe("major_news");
    expect(resolveSourceType("athlete_authored_public", "www.cbssports.com")).toBe("major_news");
  });

  describe("platform hosts (youtube, youtu.be, instagram, tiktok, x, twitter, facebook, threads, linktr.ee) are publisher-ambiguous", () => {
    const VIDEO = "https://www.youtube.com/watch?v=abcDEF12345";
    const mine = { knownHandles: ["@janedoehoops", "jane.doe"] };
    it("the athlete's own YouTube video: model says own → athlete_authored_public; model silent + channel matches her handle → athlete_authored_public; silent + no match → unknown", () => {
      expect(resolveSourceType("athlete_authored_public", "youtube.com", undefined, { urls: [VIDEO] })).toBe("athlete_authored_public");
      expect(resolveSourceType(null, "youtube.com", undefined, { urls: [VIDEO], names: ["Jane Doe Hoops"], ...mine })).toBe("athlete_authored_public");      // channel name
      expect(resolveSourceType(null, "youtube.com", undefined, { urls: ["https://www.youtube.com/@JaneDoeHoops/videos"], ...mine })).toBe("athlete_authored_public");   // channel handle in the URL
      expect(resolveSourceType("unknown", "www.instagram.com", undefined, { urls: ["https://www.instagram.com/jane.doe/reel/xyz"], ...mine })).toBe("athlete_authored_public");
      expect(resolveSourceType(null, "youtube.com", undefined, { urls: [VIDEO], names: ["Some Fan Channel"], ...mine })).toBe("unknown");
      expect(resolveSourceType(null, "youtube.com", undefined, { urls: [VIDEO], names: ["Jane Doe Hoops"] })).toBe("unknown");                                // no handle on file
      expect(resolveSourceType("tier_1", "youtu.be", undefined, { urls: ["https://youtu.be/abcDEF12345"] })).toBe("unknown");
    });
    it("a network / news interview on YouTube → major_news; a team or school interview → official_team_or_school", () => {
      expect(resolveSourceType("major_news", "youtube.com", undefined, { urls: [VIDEO], names: ["CBS Sports"], ...mine })).toBe("major_news");
      expect(resolveSourceType("official_team_or_school", "m.youtube.com", undefined, { urls: [VIDEO], names: ["Example U Athletics"] })).toBe("official_team_or_school");
      expect(resolveSourceType("regional_news", "x.com", undefined, { urls: ["https://x.com/localpaper/status/1"] })).toBe("regional_news");
    });
    it("a podcast interview on YouTube takes the model's class — never her own unless it is", () => {
      expect(resolveSourceType("aggregator_or_blog", "youtube.com", undefined, { urls: [VIDEO], names: ["The Locker Room Pod"], ...mine })).toBe("aggregator_or_blog");
      expect(resolveSourceType("major_news", "youtube.com", undefined, { urls: [VIDEO], names: ["Network Pod"], ...mine })).toBe("major_news");
      expect(resolveSourceType(null, "youtube.com", undefined, { urls: [VIDEO], names: ["The Locker Room Pod"], ...mine })).toBe("unknown");
    });
    it("selection ranks with the corrected classes", () => {
      const own = cand("https://www.youtube.com/@JaneDoeHoops", { participation: "own_words", medium: "video" });
      const network = cand("https://youtu.be/abcDEF12345", { participation: "own_words", medium: "video", outletType: "major_news" });
      // the own-channel page is not a video: read as a page, classified hers through the handle match (tier 6) vs the network's major_news (tier 3)
      const s = selectReadTargets([own, network], { max: 2, alreadyRead: new Set(), knownHandles: mine.knownHandles });
      expect(s.targets.map((t) => [t.readUrl, t.sourceTypeResolved])).toEqual([["https://www.youtube.com/watch?v=abcDEF12345", "major_news"]]);
      expect(s.skipped.unreadable).toBe(1);   // a channel page is not a readable video
      const ownVideo = cand("https://www.youtube.com/watch?v=ownVID12345", { participation: "own_words", medium: "video", outlet: "Jane Doe Hoops" });
      const t = selectReadTargets([ownVideo, network], { max: 2, alreadyRead: new Set(), knownHandles: mine.knownHandles }).targets;
      expect(t.map((x) => [x.readUrl, x.sourceTypeResolved])).toEqual([["https://www.youtube.com/watch?v=abcDEF12345", "major_news"], ["https://www.youtube.com/watch?v=ownVID12345", "athlete_authored_public"]]);
      expect(selectReadTargets([ownVideo], { max: 1, alreadyRead: new Set() }).targets[0].sourceTypeResolved).toBe("unknown");   // no handle on file
    });
  });
  it("an unclassified domain takes the model's valid class; absent, unknown or outside the vocabulary stays unknown", () => {
    expect(resolveSourceType("major_news", "news.example.com")).toBe("major_news");
    expect(resolveSourceType(" Regional_News ", null)).toBe("regional_news");
    expect(resolveSourceType("official_team_or_school", "club.example.org")).toBe("official_team_or_school");
    for (const t of [null, undefined, "", "unknown", "tier_1", "newspaper"]) expect(resolveSourceType(t as any, "random.example.com")).toBe("unknown");
  });
  it("the model's type for the BOUND source: host match, else the one type all sources agree on, else the claim's own outletType", () => {
    const c = (sources: Array<{ url: string; outletType?: string }>) => ({ kind: "press_mention", sources: sources.map((s) => ({ title: null, publishedAt: null, quote: "", ...s })) }) as any;
    expect(modelOutletType(c([{ url: "https://www.a.example.com/x", outletType: "major_news" }, { url: "https://b.example.com/y", outletType: "reference" }]), {}, "b.example.com")).toBe("reference");
    expect(modelOutletType(c([{ url: "https://a.example.com/x", outletType: "major_news" }, { url: "https://b.example.com/y", outletType: "major_news" }]), {}, "z.example.com")).toBe("major_news");
    expect(modelOutletType(c([{ url: "https://a.example.com/x", outletType: "major_news" }, { url: "https://b.example.com/y", outletType: "reference" }]), { outletType: "regional_news" }, "z.example.com")).toBe("regional_news");
    expect(modelOutletType(c([]), {}, null)).toBeNull();
  });
});
