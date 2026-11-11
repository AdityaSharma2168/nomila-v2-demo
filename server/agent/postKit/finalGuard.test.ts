/**
 * finalGuard.test.ts — the one check on the words a post kit hands the athlete to post (agent/postKit/finalGuard.ts),
 * and the disclosure rules it is given (agent/postKit/disclosure.ts). Pure: no database, no model. Made-up athletes,
 * events and brands only.
 *
 *   F1 numbers: sources (active facts, the event, the due date, the countdown as "N days"/"N weeks") stand; any other
 *      sentence with a number is removed and the rest re-checked; the number is the point → blocked. Not checked: a
 *      distance, a clock time, a year in year context, a jersey number near words about what is worn
 *   F1b round 2: a fact's DATE never sources its month or day ("Scored 3 goals." off a fact dated 2026-03-14 is caught);
 *      a countdown never sources a bare number; rankings and counts are checked ("#1 in the nation", "No. 1 seed",
 *      "Ranked number 1", "Rushed for 2000 yards", "10k+ followers", "10K new followers")
 *   F2 sentences: "St.", "vs.", "Jr." and initials never end one; "No." only before a number; a lower-case letter is
 *      not an initial
 *   F3 #ad: only when a real deal / gift / affiliate record matches — at the very START of the caption, once; never on
 *      an empty caption, never a caption that is only tags with #ad; a brand without a record is "ask"; the 2,200 limit
 *      holds after #ad (the words are trimmed, never the disclosure or the credit)
 *   F3b round 2: brands the words themselves name or @-tag are matched against the records too
 *   F3c round 3: an everyday-word brand ("Celsius", "Converse", "Vans", "Body Armor") counts only when written as a name
 *      (exact casing, or capitalised mid-sentence; never after "degrees"), or @-tagged; a credit-only caption that owes
 *      #ad is blocked
 *   F4 never-terms (in hashtags too), avoided wording, care text → blocked, in the caption, the on-card text and the
 *      music credit line
 *   F5 contact details, prices, the M.I.A. → removed at build; "pounds" is not money; a linked deal's code line stands
 *   F6 edit mode: never deletes the athlete's words — a refusal naming what it found; extra tokens (their own numbers)
 *   F7 guardKit: the kit back marked guarded (version, when, disclosure); the on-card text checked
 *   F8 disclosure.ts: brand names compared generically; a partner match is "required" with its codes
 */
import { POST_KIT_CAPTION_CHARS, type PostKit } from "../../../shared/postKit";
import { disclosureFor, disclosureInText, sameBrand } from "./disclosure";
import {
  GUARD_VERSION, guardKit, guardPostText, neverTermInTags, numberCandidates, numberParts, numberSourcesFor, numberTokens, sentencesOf,
  withAdLead, wouldRemoveRefusal, type GuardSources,
} from "./finalGuard";

const NOW = new Date("2026-11-09T12:00:00Z");
const SRC: GuardSources = {
  numberSources: numberSourcesFor({
    facts: [
      { claim: "Ran a 4:05 mile at the 2026 Spring Invitational, placing 3rd.", date: "2026-03-14", subject: { kind: "athlete", name: "Sam Example" } as never },
      { claim: "The team beat Rival U 3-1 in the opener.", date: "2026-10-02", subject: { kind: "team", name: "Example U" } as never },
    ],
    event: { label: "Conference final", date: "2026-11-21" }, moment: null, dueOn: "2026-11-14", today: "2026-11-09",
  }),
  neverTerms: ["Emma"], avoidWords: ["grind"],
  careFacts: [{ claim: "Sam Example missed the spring season with a knee injury in March." }],
  disclosure: "none", mode: "build",
};
const run = (caption: string, over: Partial<GuardSources> = {}, onCard: string[] = ["The work nobody sees."]) =>
  guardPostText({ caption, onCard }, { ...SRC, ...over });
const ok = (caption: string, fixes: string[] = [], disclosure: "ad" | "ask" | null = null) => ({ ok: true, caption, fixes, disclosure });
const kinds = (t: string) => numberParts(t).map((p) => [p.raw, p.kind]);

describe("F1: numbers", () => {
  it("reads numbers by kind", () => {
    expect(kinds("Won the 100m, a 5K and 10km; 7 pm, 4:59, Class of 2027, wearing No. 23, 3-1, 1.2k followers, 4th, 50%")).toEqual([
      ["100m", "exempt"], ["5K", "exempt"], ["10km", "exempt"], ["7 pm", "exempt"], ["4:59", "exempt"], ["2027", "exempt"],
      ["No. 23", "exempt"], ["3-1", "score"], ["1.2k", "value"], ["4th", "value"], ["50%", "value"],
    ]);
    expect(numberParts("1.2k followers")[0].tokens).toEqual(["1.2", "1200"]);
  });

  it.each([
    ["Won the 100m at state.", "a distance names the event"],
    ["Game day at 7 pm.", "a clock time"],
    ["Ran it in 4:59, again.", "a clock-shaped time"],
    ["Class of 2027, here we go.", "a year in year context"],
    ["Wearing No. 23 with pride.", "a jersey number near a word about what is worn — never cut to \"Wearing No.\""],
    ["Won 3-1 last week.", "a score the facts hold"],
    ["Won 1-3? No: won 3-1.", "a score in either order"],
    ["Twelve days. 12 days to the final.", "the countdown from today, with its unit"],
    ["7 days to go.", "the countdown from the due date"],
    ["Final on the 21st.", "the event's day, as an ordinal"],
    ["3rd last spring.", "a fact's ordinal"],
    ["Ready for the final, seven days out. #Class2027 #U19", "spelled-out numbers and word tags"],
  ])("%s — %s", (caption) => {
    expect(run(caption)).toEqual(ok(caption));
  });

  it("a sentence with a number no source holds is removed, the rest kept and re-checked", () => {
    expect(run("Ready for the final. We drew 5,000 fans last time. Let's go. #trackseason")).toEqual(ok("Ready for the final. Let's go. #trackseason", ["number"]));
    expect(run("Ready. Won 4-0 last week.")).toEqual(ok("Ready.", ["number"]));
    expect(run("Ready. Now at 1.2k followers.")).toEqual(ok("Ready.", ["number"]));
  });

  it("the number is the point → blocked: the first sentence, the on-card text, nothing left", () => {
    expect(run("Scored 41 points. Ready.")).toMatchObject({ ok: false, block: "number_is_the_point", found: ["41"] });
    expect(run("Ready for the final.", {}, ["9 wins in a row"])).toMatchObject({ ok: false, block: "number_is_the_point" });
    expect(run("#trackseason\nScored 41.")).toMatchObject({ ok: false, block: "number_is_the_point" });
  });
});

describe("F1b: round 2 — dates, countdowns, rankings and counts", () => {
  it("a fact's date lends only its year — never its month or its day", () => {
    expect([...numberTokens(["2026-03-14"])]).toEqual(["2026"]);
    expect(run("Ready. Scored 3 goals.")).toEqual(ok("Ready.", ["number"]));       // 3 is the fact's month
    expect(run("Ready. Scored 14 goals.")).toEqual(ok("Ready.", ["number"]));      // 14 is the fact's day
  });
  it("a countdown sources \"12 days\", never a bare 12; an ordinal sources \"3rd\", never a bare 3", () => {
    expect(run("Ready. Scored 12 goals.")).toEqual(ok("Ready.", ["number"]));
    expect(run("Ready. 12 days to go.")).toEqual(ok("Ready. 12 days to go."));
    expect([...numberTokens(["placing 3rd"])]).toEqual(["3o"]);
  });
  it.each([
    ["Ready. #1 in the nation.", "a number-only tag is a number"],
    ["Ready. The No. 1 seed.", "No. near \"seed\" is a ranking"],
    ["Ready. Ranked number 1 again.", "\"Ranked number 1\""],
    ["Ready. Wearing No. 1 for the No. 1 team in the state.", "a ranking word nearby wins over \"wearing\""],
    ["Ready. Rushed for 2000 yards.", "a 4-digit number outside year context is a number"],
    ["Ready. Hit 10k+ followers!", "\"10k+ followers\" is a count"],
    ["Ready. 10K new followers this week.", "a count word within the next three words"],
    ["Ready. 1.2M views on that one.", "M is millions"],
  ])("%s — %s → removed", (caption) => {
    expect(run(caption)).toEqual(ok("Ready.", ["number"]));
  });
  it("…while years, jersey numbers and races in their own context still stand", () => {
    expect(run("Ready for the 2026 season.")).toEqual(ok("Ready for the 2026 season."));
    expect(run("Back in 2019 it started.")).toEqual(ok("Back in 2019 it started."));
    expect(run("Wearing #23 again.")).toEqual(ok("Wearing #23 again."));
    expect(run("A 10K this weekend.")).toEqual(ok("A 10K this weekend."));
  });
});

describe("F2: sentences", () => {
  it("abbreviations and initials never end a sentence; \"No.\" only before a number", () => {
    expect(sentencesOf("Wearing No. 23 with pride. Next one.")).toEqual(["Wearing No. 23 with pride.", "Next one."]);
    expect(sentencesOf("Off to St. Louis vs. the best. Jr. year, U.S. soil.")).toEqual(["Off to St. Louis vs. the best.", "Jr. year, U.S. soil."]);
    expect(sentencesOf("They said no. Then yes.")).toEqual(["They said no.", "Then yes."]);
    expect(sentencesOf("Plan a. Plan b.")).toEqual(["Plan a.", "Plan b."]);
  });
});

describe("F3: #ad only for a real record — at the start", () => {
  const required = { disclosure: "required" as const };
  it("at the very start, once (any other #ad taken out)", () => {
    expect(run("New spikes, same work.\n\n#trackseason #gear", required)).toEqual(ok("#ad New spikes, same work.\n\n#trackseason #gear", ["ad"], "ad"));
    expect(run("New spikes, same work. #trackseason #AD", required)).toEqual(ok("#ad New spikes, same work. #trackseason", ["ad"], "ad"));
    expect(run("#ad New spikes.", required)).toEqual(ok("#ad New spikes.", [], "ad"));
    expect(withAdLead("Big #GameDay energy. #ad")).toBe("#ad Big #GameDay energy.");
  });
  it("never on an empty caption; never a caption that is only tags with #ad", () => {
    expect(run("", required)).toEqual(ok("", [], "ad"));
    expect(run("#ad", { ...required, mode: "edit" })).toMatchObject({ ok: false, block: "nothing_left" });
    expect(run("#ad #gear", { ...required, mode: "edit" })).toMatchObject({ ok: false, block: "nothing_left" });
  });
  it("a brand with no record is \"ask\": nothing is added; no brand is left alone", () => {
    expect(run("New spikes, same work. #gear", { disclosure: "ask" })).toEqual(ok("New spikes, same work. #gear", [], "ask"));
    expect(run("New spikes, same work. #gear")).toEqual(ok("New spikes, same work. #gear"));
  });
  it("the 2,200 limit holds after #ad: the words shrink, never the disclosure or the credit", () => {
    const credit = "Music: Track by Someone (CC BY 4.0)";
    const long = `${"word ".repeat(600).trim()}.\n\n${credit}`;
    const r = run(long, { ...required, keep: [credit] }, []);
    expect(r.ok && r.caption.length).toBeLessThanOrEqual(POST_KIT_CAPTION_CHARS);
    expect(r.ok && r.caption.startsWith("#ad word")).toBe(true);
    expect(r.ok && r.caption.endsWith(credit)).toBe(true);
  });
});

describe("F3b: brands the words name or @-tag", () => {
  const connections = [{ brand: "Partner Co", kind: "deal" as const, codes: ["RUN10"] }];
  it("a record's brand named or tagged in the words → #ad, even with no partner on the deliverable", () => {
    expect(run("Training in my new Partner Co spikes.", { connections })).toEqual(ok("#ad Training in my new Partner Co spikes.", ["ad"], "ad"));
    expect(run("New spikes from @partnerco today.", { connections })).toEqual(ok("#ad New spikes from @partnerco today.", ["ad"], "ad"));
  });
  it("a tag or a known brand with no record → \"ask\"; nothing named → none", () => {
    expect(run("Thanks @someshoes for these.", { connections })).toEqual(ok("Thanks @someshoes for these.", [], "ask"));
    expect(run("Laced up my Nike spikes.", { connections, knownBrands: ["Nike"] })).toEqual(ok("Laced up my Nike spikes.", [], "ask"));
    expect(disclosureInText("Just a training day.", connections, ["Nike"])).toEqual({ need: "none", codes: [] });
  });
  it("a code from the record named in the words is allowed", () => {
    expect(run("Gear day with Partner Co. Use code RUN10 for $10 off.", { connections }))
      .toEqual(ok("#ad Gear day with Partner Co. Use code RUN10 for $10 off.", ["ad"], "ad"));
  });
});

describe("F3c: round 3 — everyday-word brands count only when written as a name", () => {
  const word = (brand: string) => [{ brand, kind: "deal" as const, codes: [] }];
  it.each([
    ["30 degrees Celsius at kickoff.", "Celsius", "none", "\"degrees Celsius\" is a temperature"],
    ["It hit 30° Celsius today.", "Celsius", "none", "after °"],
    ["We love to converse after practice.", "Converse", "none", "lower case: the verb"],
    ["Converse with your team before the game.", "Converse", "none", "sentence-initial, one ordinary word: ambiguous"],
    ["Two vans of fans showed up.", "Vans", "none", "lower case: the vehicles"],
    ["Drank body armor all day.", "Body Armor", "none", "lower case"],
    ["Thanks @celsius for the fuel.", "Celsius", "ad", "@-tagged"],
    ["Fueled by Celsius before the final.", "Celsius", "ad", "capitalised mid-sentence"],
    ["Laced up my new Converse spikes.", "Converse", "ad", "capitalised mid-sentence"],
    ["Body Armor before every rep.", "Body Armor", "ad", "two words, exact casing: distinctive even at the start"],
    ["love my gorjana stack.", "gorjana", "ad", "a brand recorded in lower case, written that way"],
  ])("%s (%s) → %s — %s", (caption, brand, want) => {
    const r = run(caption, { connections: word(brand), extraTokens: ["30"] }, []);
    expect(r).toMatchObject({ ok: true, disclosure: want === "ad" ? "ad" : null });
  });
  it("the same rule for the product's known brands (\"ask\")", () => {
    expect(run("We love to converse.", { knownBrands: ["Converse"] }, [])).toMatchObject({ ok: true, disclosure: null });
    expect(run("Laced up my Converse.", { knownBrands: ["Converse"] }, [])).toMatchObject({ ok: true, disclosure: "ask" });
  });
  it("the deliverable's partner still counts however the words write it", () => {
    expect(run("we love to converse.", { disclosure: "required", connections: word("Converse") }, [])).toMatchObject({ ok: true, disclosure: "ad" });
  });
  it("tidy: #ad required and the caption is only the music credit → blocked, never a credit-only caption marked ad", () => {
    const credit = "Music: Track by Someone (CC BY 4.0)";
    expect(run(credit, { disclosure: "required", keep: [credit] }, [])).toMatchObject({ ok: false, block: "nothing_left" });
    expect(run(credit, { keep: [credit] }, [])).toMatchObject({ ok: true, caption: credit });
  });
});

describe("F4: never-terms (in tags too), avoided wording, care text → blocked", () => {
  it.each([
    ["a never-use name", "Thanks Emma for the ride.", "never_content"],
    ["a never-use name inside a tag", "Big day. #TeamEmma", "never_content"],
    ["…in lower case", "Big day. #teamemma", "never_content"],
    ["avoided wording", "Back to the GRIND.", "avoided_wording"],
    ["care text", "Coming back after I missed the spring season with a knee injury.", "care_text"],
  ])("%s in the caption", (_n, caption, block) => {
    expect(run(caption)).toMatchObject({ ok: false, block });
  });
  it("in the on-card text and the music credit line too", () => {
    expect(run("Ready.", {}, ["For Emma"])).toMatchObject({ ok: false, block: "never_content" });
    const credit = "Music: Song for Emma by Someone (CC BY 4.0)";
    expect(run(`Ready.\n\n${credit}`, { keep: [credit] })).toMatchObject({ ok: false, block: "never_content" });
    expect(neverTermInTags("#gameday #TeamEmma", ["Emma"])).toBe(true);
    expect(neverTermInTags("#gameday", ["Emma"])).toBe(false);
  });
});

describe("F5: contact details, prices, the M.I.A.", () => {
  it("the sentence comes out", () => {
    expect(run("Ready for the final. Bookings: sam@example.com. Let's go.")).toEqual(ok("Ready for the final. Let's go.", ["contact"]));
    expect(run("Ready for the final. Posts from $500. Let's go.")).toEqual(ok("Ready for the final. Let's go.", ["rate"]));
    expect(run("Ready for the final. My M.I.A. is climbing. Let's go.")).toEqual(ok("Ready for the final. Let's go.", ["mia"]));
  });
  it("\"pounds\" is a weight, not a price (its number is still checked)", () => {
    expect(numberParts("200 pounds")[0].kind).toBe("value");
    expect(run("Ready. Squatted 200 pounds today.", { numberSources: [...SRC.numberSources, "Squat best 200 lb"] }))
      .toEqual(ok("Ready. Squatted 200 pounds today."));
  });
  it("a linked deal's discount-code line stands; with codes on the record, only its own", () => {
    const line = "New gear day. Use code RUN10 for $10 off.";
    expect(run(line, { disclosure: "required" })).toEqual(ok(`#ad ${line}`, ["ad"], "ad"));
    expect(run(line, { disclosure: "required", codes: ["RUN10"] })).toMatchObject({ ok: true });
    expect(run(line, { disclosure: "required", codes: ["OTHER"] })).toEqual(ok("#ad New gear day.", ["rate", "ad"], "ad"));
    expect(run(line, { disclosure: "ask" })).toEqual(ok("New gear day.", ["rate"], "ask"));
  });
  it("on the on-card text it blocks; nothing left blocks", () => {
    expect(run("Ready.", {}, ["DM 555-010-2030"])).toMatchObject({ ok: false, block: "on_card" });
    expect(run("Email sam@example.com.")).toMatchObject({ ok: false, block: "nothing_left" });
  });
});

describe("F6: edit mode never deletes the athlete's words", () => {
  const edit = { mode: "edit" as const };
  it("what build would remove is a refusal naming what it found", () => {
    const r = run("Ready. Email sam@example.com. Posts from $500. We drew 5,000 fans.", edit, []);
    expect(r).toMatchObject({ ok: false, block: "would_remove", fixes: ["contact", "rate", "number"] });
    expect(wouldRemoveRefusal((r as { found: string[] }).found))
      .toBe("That caption has a contact detail, a price or rate and a number Nomila can't check against your facts (5,000). Take it out, then save again.");
  });
  it("their own typed numbers stand (extraTokens); #ad still put in for a real deal; without one it may come out", () => {
    expect(run("Scored 41 today.", { ...edit, extraTokens: [...numberCandidates(["Scored 41 today."])] }, [])).toEqual(ok("Scored 41 today."));
    expect(run("New gear.", { ...edit, disclosure: "required" }, [])).toEqual(ok("#ad New gear.", ["ad"], "ad"));
    expect(run("New gear.", { ...edit, disclosure: "ask" }, [])).toEqual(ok("New gear.", [], "ask"));
  });
  it("numberTokens / numberCandidates", () => {
    expect([...numberTokens(["3-1 and 1,200 and 4th and 12 days"])]).toEqual(["3-1", "1-3", "1200", "4o", "12d"]);
    expect([...numberCandidates(["3-1 and 4th and 12 days, in 2026"])]).toEqual(["3-1", "1-3", "4", "4o", "12", "12d"]);
  });
});

describe("F7: guardKit", () => {
  const kit = (text: string, hook = "Ready."): PostKit => ({
    idea: { hook, format: "reel", platform: "instagram", timing: "" }, caption: { text, hashtags: [], edited: false },
    treatmentPlan: { overlayText: hook },
  } as unknown as PostKit);
  it("the kit back marked guarded, its caption and tags re-listed", () => {
    const r = guardKit(kit("New spikes, same work. #gear"), { ...SRC, disclosure: "required" }, NOW);
    expect(r.ok && r.kit.caption).toEqual({ text: "#ad New spikes, same work. #gear", hashtags: ["#ad", "#gear"], edited: false });
    expect(r.ok && r.kit.guard).toEqual({ version: GUARD_VERSION, at: NOW.toISOString(), disclosure: "ad" });
    expect(guardKit(kit("Plain words."), { ...SRC, disclosure: "ask" }, NOW)).toMatchObject({ ok: true, kit: { guard: { disclosure: "ask" } } });
  });
  it("the hook and the overlay are on-card text", () => {
    expect(guardKit(kit("Ready.", "41 points"), SRC, NOW)).toMatchObject({ ok: false, block: "number_is_the_point" });
  });
});

describe("F8: disclosure", () => {
  const records = [{ brand: "Partner Co", kind: "deal" as const, codes: [] }, { brand: "Café Brand", kind: "affiliate" as const, codes: ["RUN10"] }];
  it("brand names compared generically", () => {
    expect(sameBrand("Partner Co", "partner co.")).toBe(true);
    expect(sameBrand("Partner", "Partner Co")).toBe(true);
    expect(sameBrand("Cafe Brand", "Café Brand")).toBe(true);
    expect(sameBrand("Co", "Co Op")).toBe(false);
    expect(sameBrand("Other Co", "Partner Co")).toBe(false);
  });
  it("a match is required (with its codes); a named brand without one is ask; no brand is none", () => {
    expect(disclosureFor({ subjectKind: "brand", name: "PARTNER CO" }, records)).toEqual({ need: "required", codes: [] });
    expect(disclosureFor({ subjectKind: "brand", name: "Cafe Brand" }, records)).toEqual({ need: "required", codes: ["RUN10"] });
    expect(disclosureFor({ subjectKind: "brand", name: "Unknown Co" }, records)).toEqual({ need: "ask", codes: [] });
    expect(disclosureFor({ subjectKind: "person", name: "A Coach" }, records)).toEqual({ need: "none", codes: [] });
    expect(disclosureFor(null, records)).toEqual({ need: "none", codes: [] });
  });
});
