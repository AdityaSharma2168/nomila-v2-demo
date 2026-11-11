/**
 * identity.test.ts — the sign-up identity filter on the page shapes the 26 Oct 2026 dev comparison got wrong (the
 * athlete's own coverage rejected as "someone else"), the namesakes it must still reject, the two-person question, the
 * official-source query and the search-fee record. Fictional fixtures only: no network, no provider.
 */
import { isAthletePage, pageIdentity, pickFollowLinks, rankPassages, urlNamesAthlete } from "./rank";
import { distinctiveTeamWords, otherSportTermsOf, sportTermsOf } from "./sportTerms";
import { extractInput, candidatesOf, EXTRACT_SCHEMA } from "./extract";
import { questionFrom, runNarrowResearch } from "./pipeline";
import { discover, type DiscoverQuery } from "./discover";
import { cleanHtml } from "./fetchClean";
import { planQueries } from "./plan";
import { V2 } from "./config";
import { passResultFrom } from "../research";

const filler = "The program thanked its seniors, staff and families before kickoff. ".repeat(14);

describe("sport vocabulary", () => {
  test("a word two sports share anchors either and never counts as the other", () => {
    expect(sportTermsOf("soccer")).toEqual(expect.arrayContaining(["soccer", "football", "nwsl"]));
    expect(otherSportTermsOf("soccer")).not.toContain("football");
    expect(otherSportTermsOf("soccer")).toContain("basketball");
    expect(sportTermsOf("kabaddi")).toEqual(["kabaddi"]);           // an unlisted sport is matched by its own name
  });
  test("distinctive team words drop the generic ones", () => {
    expect(distinctiveTeamWords("Rivertown University")).toEqual(["rivertown"]);
    expect(distinctiveTeamWords("Lakeside City FC")).toEqual(["lakeside", "city"]);
    expect(distinctiveTeamWords(null)).toEqual([]);
  });
});

describe("the athlete's own coverage is anchored (the comparison's false rejections)", () => {
  test("the team's own site: distinctive team word in the host, no sport word and no full team name in the text", () => {
    const page = { url: "https://gorivertown.com/news/2026/10/16/senior-night-rivalry-win", title: "Senior night rivalry win", text: `Jordan Sample was honoured on senior night. ${filler}` };
    expect(pageIdentity(page, { name: "Jordan Sample", sport: "soccer", team: "Rivertown University" }, { strict: true }).verdict).toBe("anchored");
  });
  test("a local paper: the sport is only in the URL slug", () => {
    const page = { url: "https://localpaper.example.com/sports/valley-girls-soccer-snags-win-in-section-finale/", title: "Valley snags win in section finale", text: `Jordan Sample scored twice. ${filler}` };
    expect(pageIdentity(page, { name: "Jordan Sample", sport: "soccer" }, { strict: true }).verdict).toBe("anchored");
  });
  test("an encyclopedia list page: the sport is in the title, the name far down a roster", () => {
    const page = { url: "https://encyclopedia.example.org/wiki/National_under-16_team", title: "United States girls' national under-16 soccer team", text: `${filler}\n\nRoster: Alex One, Jordan Sample, Casey Two.` };
    expect(pageIdentity(page, { name: "Jordan Sample", sport: "soccer" }, { strict: true }).verdict).toBe("anchored");
  });
  test("a league's abbreviation in the URL is the sport (basketball ↔ wnba)", () => {
    const page = { url: "https://stats.example.com/wnba/players/s/samplejo01.html", title: "Jordan Sample Stats", text: `Jordan Sample career totals. ${filler}` };
    expect(pageIdentity(page, { name: "Jordan Sample", sport: "Basketball", team: "Lakeside Comets" }, { strict: true }).verdict).toBe("anchored");
  });
  test("a stats site calling soccer football in its structured data", () => {
    const page = { url: "https://players.example.com/123/jordan-sample", title: "Jordan Sample", text: `Jordan Sample profile. ${filler}`, identityHint: { names: ["Jordan Sample"], affiliations: ["Lakeside City", "Football"] } };
    expect(pageIdentity(page, { name: "Jordan Sample", sport: "soccer" }, { strict: true }).verdict).toBe("anchored");
  });
});

describe("namesakes are still rejected", () => {
  test("another sport named next to the name, theirs nowhere", () => {
    const page = { url: "https://news.example.com/a", title: "Weekend results", text: `Outside hitter Jordan Sample led the volleyball team with 14 kills. ${filler}` };
    const id = pageIdentity(page, { name: "Jordan Sample", sport: "soccer" }, { strict: true });
    expect(id.verdict).toBe("other");
  });
  test("structured data naming another sport", () => {
    const page = { url: "https://players.example.com/9", title: "Jordan Sample", text: "Jordan Sample profile.", identityHint: { names: ["Jordan Sample"], affiliations: ["Hill Hawks Baseball"] } };
    expect(pageIdentity(page, { name: "Jordan Sample", sport: "soccer" }, { strict: true }).verdict).toBe("other");
  });
  test("their sport near the name wins over another sport on the same page (a school roundup)", () => {
    const page = { url: "https://school.example.com/roundup", title: "Fall roundup", text: `Jordan Sample scored the soccer team's winner; the volleyball team swept Hill.` };
    expect(pageIdentity(page, { name: "Jordan Sample", sport: "soccer" }, { strict: true }).verdict).toBe("anchored");
  });
});

describe("neutral pages", () => {
  const anchored = { url: "https://gorivertown.com/roster/jordan-sample", title: "Jordan Sample - Soccer", date: null, text: `Jordan Sample is a forward on the soccer roster and a team captain this season.\n\n${filler}` };
  const neutral = { url: "https://nil.example.com/profile/jordan-sample", title: "Jordan Sample", date: null, text: `Jordan Sample is available for partnerships and appearances in the region.\n\n${filler}` };
  test("read beside an anchored page, scored lower, and labelled for the extract model", () => {
    const r = rankPassages([anchored, neutral], { name: "Jordan Sample", sport: "soccer", team: "Rivertown University" }, { strict: true });
    expect(r.anchoredPages).toBe(1);
    expect(r.neutralPages).toBe(1);
    expect(r.wrongPerson).toEqual([]);
    expect(r.passages[0].url).toBe(anchored.url);
    const n = r.passages.find((p) => p.url === neutral.url)!;
    expect(n.unverified).toBe(true);
    const text = extractInput({ name: "Jordan Sample", sport: "soccer" }, [], r.passages, "2026-10-26");
    expect(text).toContain("Identity: this page does not itself show it is this athlete");
  });
  test("never read on their own (nothing shows who the athlete is)", () => {
    const r = rankPassages([neutral], { name: "Jordan Sample", sport: "soccer" }, { strict: true });
    expect(r.passages).toEqual([]);
    expect(r.neutralPages).toBe(1);
  });
});

describe("two people fit: \"which one are you?\"", () => {
  const html = (body: string) => `<html><head><title>Roster</title></head><body><article><p>${body}</p><p>${body}</p><p>${filler}</p></article></body></html>`;
  test("the schema asks for candidates; only given source ids survive", () => {
    expect((EXTRACT_SCHEMA as any).properties.identity.required).toContain("candidates");
    const c = candidatesOf({ identity: { candidates: [{ label: "Forward at a university", team: "", school: "Rivertown", years: "2024–2027", sources: ["S1", "S9"] }, { label: "", team: "x", school: "", years: "", sources: [] }] } }, [{ id: "S1", url: "u1", title: "", date: null, text: "", score: 1 }]);
    expect(c).toEqual([{ label: "Forward at a university", team: "", school: "Rivertown", years: "2024–2027", sources: ["S1"] }]);
  });
  test("one candidate is not a question", () => {
    expect(questionFrom([{ label: "A", team: "", school: "", years: "", sources: [] }], [])).toBeNull();
  });
  test("sign-up, two same-sport people: no facts kept, the question carries what tells them apart and their pages", async () => {
    const f = jest.fn(async (u: any) => String(u).endsWith("robots.txt") ? new Response("", { status: 404 })
      : new Response(html(String(u).includes("rivertown") ? "Jordan Sample, a soccer forward at Rivertown, scored twice." : "Jordan Sample signed with Lakeside City soccer club after college."), { headers: { "content-type": "text/html" } })) as any;
    const discoverQuery: DiscoverQuery = async () => ({ costMicroUsd: 0, results: [{ url: "https://gorivertown.com/roster/sample" }, { url: "https://lakesidecity.example.com/news/sample" }] });
    const extract = jest.fn(async (passages: any[]) => ({
      ...passResultFrom({ runId: "x", reused: false, cost: { microUsd: 1 }, sources: passages.map((p) => ({ url: p.url })), json: {
        identity: { resolved: false, description: "", ambiguity: "Two soccer players share this name." }, gaps: [], narrative: "",
        facts: [{ claim: "Jordan Sample scored twice.", topic: "competition", source_url: passages[0].url, source_title: "", source_type: "official", date: "2026", confidence: 0.5, subject_kind: "athlete", subject_name: "Jordan Sample", sensitivity: "none", never_reason: "none", care_kind: "none" }],
      } }, { name: "Jordan Sample", sport: "soccer" }, "a", "v"),
      candidates: candidatesOf({ identity: { candidates: passages.map((p, i) => ({ label: `Player ${i + 1}`, team: "", school: "", years: "", sources: [p.id] })) } }, passages),
    }));
    const out = await runNarrowResearch({ store: {} as any, athleteId: "a1", parentPrefix: null }, { athlete: { name: "Jordan Sample", sport: "soccer" }, known: [], today: "2026-10-26" }, { provider: "openai_search", discoverQuery, fetchImpl: f, extract }, "p");
    expect(out.metrics.outcome).toBe("unconfirmed");
    expect(out.result!.facts).toEqual([]);
    expect(out.identityQuestion?.kind).toBe("which_one");
    expect(out.identityQuestion!.candidates.length).toBe(2);
    expect(out.identityQuestion!.candidates.flatMap((c) => c.urls).sort()).toEqual(["https://gorivertown.com/roster/sample", "https://lakesidecity.example.com/news/sample"]);
  });
});

describe("recall and cost", () => {
  test("sign-up plans an official-source query: the team's own athletics site, else the governing bodies", () => {
    expect(planQueries({ name: "Jordan Sample", sport: "soccer", team: "Rivertown University", today: "2026-10-26" }).map((q) => q.q))
      .toContain('"Jordan Sample" Rivertown University soccer roster OR bio OR profile');
    expect(planQueries({ name: "Jordan Sample", sport: "soccer", today: "2026-10-26" }).map((q) => q.q))
      .toContain('"Jordan Sample" soccer roster OR bio OR "national team" OR federation');
  });
  test("sign-up plans few searches: overlapping identity queries merged, results + honours one query", () => {
    expect(planQueries({ name: "Jordan Sample", sport: "soccer", team: "Rivertown University", today: "2026-10-26" })).toHaveLength(5);
    expect(planQueries({ name: "Jordan Sample", sport: "soccer", handles: ["jsample"], today: "2026-10-26" })).toHaveLength(6);
  });
  test("most found pages are read; the passage budget, not the page count, caps the model's input", () => {
    expect(V2.maxFetch).toBeGreaterThanOrEqual(20);
    expect(V2.maxPassageChars).toBe(48_000);
  });
  test("search fees are recorded: queries the provider ran and their fee, inside the discovery cost", async () => {
    const q: DiscoverQuery = async () => ({ costMicroUsd: 2_000 + 2 * 14_000, searchQueries: 2, searchFeeMicroUsd: 2 * 14_000, results: [] });
    const r = await discover([{ aim: "identity", q: "a" }, { aim: "results", q: "b" }], q, "openai_search");
    expect(r.searchQueries).toBe(4);
    expect(r.searchFeeMicroUsd).toBe(4 * 14_000);
    expect(r.costMicroUsd).toBe(2 * (2_000 + 28_000));
  });
});

describe("the athlete's own pages are read whole; links from them are followed (26 Oct recall fix)", () => {
  const athlete = { name: "Jordan Sample", sport: "soccer", team: "Rivertown University" };
  // A roster/bio page: the name once at the top, then stats and honours rows that never repeat it.
  const rows = Array.from({ length: 30 }, (_, i) => `${2020 + (i % 6)} | Rivertown | ${i + 3} GP | ${i % 4} G | ${i % 3} A`).join("\n\n");
  const honours = "All-Conference second team (2024)\n\nConference Freshman of the Year (2023)\n\nTeam captain (2026)";
  const roster = { url: "https://gorivertown.com/sports/womens-soccer/roster/player/jordan-sample", title: "Jordan Sample - Women's Soccer - Rivertown University", date: null,
    text: `Jordan Sample\n\nMidfielder · Senior\n\n${rows}\n\n${honours}\n\n${filler}`, quality: 1 };

  test("a roster page whose stats rows don't repeat the name reaches the model whole", () => {
    const r = rankPassages([roster], athlete, { strict: true });
    expect(r.wholePages).toBe(1);
    expect(r.passages).toHaveLength(1);
    expect(r.passages[0].text).toContain("Conference Freshman of the Year (2023)");
    expect(r.passages[0].text).toContain("2025 | Rivertown | 8 GP");
  });
  test("a whole page is capped; the budget for whole pages leaves room for other pages' passages", () => {
    const huge = { ...roster, text: `Jordan Sample ${"x ".repeat(V2.wholePageChars)}` };
    const report = { url: "https://news.example.com/match/rivertown-beats-lakeside", title: "Rivertown beats Lakeside", date: null, text: `Jordan Sample scored the soccer winner. ${filler}`, quality: 1 };
    const r = rankPassages([huge, report], athlete, { strict: true });
    expect(r.passages[0].text.length).toBe(V2.wholePageChars);
    expect(r.passages.some((p) => p.url === report.url)).toBe(true);
    expect(r.chars).toBeLessThanOrEqual(V2.maxPassageChars);
  });
  test("a page mentioning the athlete among others still sends only the passages that name them", () => {
    const list = { url: "https://news.example.com/soccer/all-conference-teams", title: "All-Conference soccer teams announced", date: null,
      text: `${filler}\n\nFirst team: Alex Other, Casey Else.\n\n${filler}\n\nSecond team: Jordan Sample (Rivertown).\n\n${filler}`, quality: 1 };
    const r = rankPassages([list], athlete, { strict: true });
    expect(r.wholePages).toBe(0);
    expect(r.passages.length).toBeGreaterThan(0);
    expect(r.passages.every((p) => p.text.includes("Jordan Sample"))).toBe(true);
  });
  test("a namesake's page is never read whole, even with the name in its title", () => {
    const other = { url: "https://hoops.example.com/jordan-sample", title: "Jordan Sample", date: null, text: `Jordan Sample, the basketball guard, scored 20 points. ${filler}`, quality: 1 };
    const r = rankPassages([roster, other], athlete, { strict: true });
    expect(r.wrongPerson.map((w) => w.url)).toEqual([other.url]);
    expect(r.passages.map((p) => p.url)).toEqual([roster.url]);
  });
  test("what counts as the athlete's own page: title, URL slug or structured data names them", () => {
    expect(urlNamesAthlete("https://x.example.com/player/jordan-sample", "Jordan Sample")).toBe(true);
    expect(urlNamesAthlete("https://x.example.com/wiki/Jordan_Sample", "Jordan Sample")).toBe(true);
    expect(urlNamesAthlete("https://x.example.com/player/jordan-other", "Jordan Sample")).toBe(false);
    expect(urlNamesAthlete("https://sample.example.com/jordan", "Jordan Sample")).toBe(false);   // the host never counts
    // A longer surname is another person (26 Oct run: an encyclopedia page for a "Clarke" read for a "Clark").
    const longer = { url: "https://encyclopedia.example.org/wiki/Jordan_Samples", title: "Jordan Samples", date: null, text: `Jordan Samples is an actor. ${filler}`, quality: 2 };
    expect(rankPassages([roster, longer], athlete, { strict: true }).passages.map((p) => p.url)).toEqual([roster.url]);
    expect(isAthletePage({ url: "https://x.example.com/a", title: "Feature", identityHint: { names: ["Jordan Sample"], affiliations: [] } }, "Jordan Sample")).toBe(true);
    expect(isAthletePage({ url: "https://x.example.com/a", title: "Match report", identityHint: null }, "Jordan Sample")).toBe(false);
  });
  test("links followed: same-site, naming the athlete, from their own anchored pages only, never files or already-read pages", () => {
    const links = [
      { url: "https://gorivertown.com/sports/womens-soccer/stats/jordan-sample", text: "Career stats" },
      { url: "https://gorivertown.com/news/2026/jordan-sample-named-captain", text: "Sample named captain" },
      { url: "https://gorivertown.com/sports/womens-soccer/roster/player/alex-other", text: "Alex Other" },
      { url: "https://gorivertown.com/media/jordan-sample.pdf", text: "Jordan Sample media guide" },
      { url: roster.url, text: "Bio" },
      { url: "https://gorivertown.com/roster?p=7", text: "Jordan Sample" },
    ];
    const fromOwn = pickFollowLinks([{ ...roster, anchored: true, links }], "Jordan Sample", [roster.url], 4);
    expect(fromOwn).toEqual([links[0].url, links[1].url, links[5].url]);
    expect(pickFollowLinks([{ ...roster, anchored: false, links }], "Jordan Sample", [], 4)).toEqual([]);
    expect(pickFollowLinks([{ ...roster, title: "Match report", url: "https://gorivertown.com/news/match", anchored: true, links }], "Jordan Sample", [], 4)).toEqual([]);
    expect(pickFollowLinks([{ ...roster, anchored: true, links }], "Jordan Sample", [], 1)).toHaveLength(1);
  });
  test("cleaned pages carry their same-site links (read before the cleaner edits the page)", () => {
    const html = `<html><head><title>Jordan Sample - Roster</title></head><body><nav><a href="/stats/jordan-sample">Stats</a><a href="https://elsewhere.example.com/x">Out</a></nav><article><p>Jordan Sample is a soccer midfielder.</p><p>${filler}</p></article></body></html>`;
    for (const cleaner of ["defuddle", "readability"] as const) {
      const page = cleanHtml(html, "https://gorivertown.com/roster/jordan-sample", cleaner)!;
      expect(page.links?.map((l) => l.url)).toEqual(["https://gorivertown.com/stats/jordan-sample"]);
    }
  });
  test("the pipeline follows the roster's link to the player's stats page itself (no extra search) and reads both whole", async () => {
    const statsUrl = "https://gorivertown.com/sports/womens-soccer/stats/jordan-sample";
    const html = (title: string, body: string, link = "") => `<html><head><title>${title}</title></head><body>${link}<article><p>${body}</p><p>${filler}</p></article></body></html>`;
    const f = jest.fn(async (u: any) => {
      const url = String(u);
      if (url.endsWith("robots.txt")) return new Response("", { status: 404 });
      if (url === statsUrl) return new Response(html("Jordan Sample career stats", "Jordan Sample: 2025 | 18 GP | 4 G"), { headers: { "content-type": "text/html" } });
      return new Response(html("Jordan Sample - Women's Soccer - Rivertown University", "Jordan Sample, soccer midfielder.", `<a href="${statsUrl}">Career stats</a>`), { headers: { "content-type": "text/html" } });
    }) as any;
    const discoverQuery: DiscoverQuery = async () => ({ costMicroUsd: 0, searchQueries: 1, results: [{ url: roster.url }] });
    const extract = jest.fn(async (passages: any[]) => passResultFrom({ runId: "x", reused: false, cost: { microUsd: 1 }, sources: passages.map((p) => ({ url: p.url })), json: { identity: { resolved: true, description: "", ambiguity: "" }, gaps: [], narrative: "", facts: [] } } as any, { name: "Jordan Sample", sport: "soccer" }, "a", "v"));
    const out = await runNarrowResearch({ store: {} as any, athleteId: "a1", parentPrefix: null }, { athlete: { name: "Jordan Sample", sport: "soccer" }, team: "Rivertown University", known: [], today: "2026-10-26" }, { provider: "openai_search", discoverQuery, fetchImpl: f, extract }, "p");
    expect(out.metrics.pagesFollowed).toBe(1);
    expect(out.metrics.wholePages).toBe(2);
    expect(out.passages.map((p) => p.url).sort()).toEqual([roster.url, statsUrl].sort());
  });
});
