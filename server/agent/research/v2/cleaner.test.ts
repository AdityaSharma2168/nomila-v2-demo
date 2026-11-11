/**
 * cleaner.test.ts — the selectable page cleaner (Readability or Defuddle) and Defuddle's schema.org identity hint.
 * Fixtures only: no network, no provider.
 */
import { cleanHtml, htmlToText, identityHintOf } from "./fetchClean";
import { pageIdentity, rankPassages } from "./rank";
import { cleanerOf } from "./config";

const ATHLETE = { name: "Riley Example", sport: "soccer", team: "Rivertown" };
const filler = "The program hosts community clinics and alumni events throughout the fall season. ".repeat(8);

const profile = (schema: object | null) => `<!doctype html><html><head><title>Riley Example - Rivertown Athletics</title>
<meta property="article:published_time" content="2026-09-14T10:00:00Z">
${schema ? `<script type="application/ld+json">${JSON.stringify(schema)}</script>` : ""}
</head><body><nav>Home | Schedule | Roster | Tickets | Shop</nav><main><article><h1>Riley Example</h1>
<p>Riley Example is a junior forward for Rivertown and was named player of the week on Sept. 14 after scoring twice.</p>
<table><thead><tr><th>Season</th><th>GP</th><th>Goals</th></tr></thead><tbody><tr><td>2025</td><td>19</td><td>11</td></tr><tr><td>2026</td><td>8</td><td>7</td></tr></tbody></table>
<p>${filler}</p></article></main><footer>Privacy | Contact</footer></body></html>`;

const PERSON = { "@context": "https://schema.org", "@type": "Person", name: "Riley Example", affiliation: { "@type": "SportsTeam", name: "Rivertown Soccer", sport: "Soccer" } };

describe("cleanerOf", () => {
  test("Defuddle by default (won the dev comparison); Readability only when set exactly", () => {
    expect(cleanerOf({} as any)).toBe("defuddle");
    expect(cleanerOf({ RESEARCH_V2_CLEANER: "readability" } as any)).toBe("readability");
    expect(cleanerOf({ RESEARCH_V2_CLEANER: "Readability" } as any)).toBe("defuddle");
  });
});

describe("both cleaners", () => {
  test.each(["readability", "defuddle"] as const)("%s keeps the article, drops navigation, reads the stated date", (cleaner) => {
    const page = cleanHtml(profile(null), "https://example.edu/roster/riley", cleaner)!;
    expect(page).not.toBeNull();
    expect(page.text).toContain("player of the week");
    expect(page.text).not.toContain("Tickets");
    expect(page.date).toBe("2026-09-14");
  });

  test("Defuddle keeps a stats table as readable rows", () => {
    const page = cleanHtml(profile(null), "https://example.edu/roster/riley", "defuddle")!;
    expect(page.text).toContain("Season | GP | Goals");
    expect(page.text).toContain("2026 | 8 | 7");
  });

  test("Defuddle reads schema.org Person data as an identity hint; Readability adds none", () => {
    expect(cleanHtml(profile(PERSON), "https://example.edu/r", "defuddle")!.identityHint).toEqual({ names: ["Riley Example"], affiliations: ["Rivertown Soccer", "Soccer"] });
    expect(cleanHtml(profile(PERSON), "https://example.edu/r", "readability")!.identityHint).toBeUndefined();
  });
});

describe("htmlToText", () => {
  test("one block per paragraph or heading; list items kept; scripts never become text", () => {
    const t = htmlToText("<h2>Bio</h2><p>First  line.</p><ul><li>Captain</li><li>All-region</li></ul><script>var x=1</script>");
    expect(t).toBe("Bio\n\nFirst line.\n\nCaptain\n\nAll-region");
  });
});

describe("identityHintOf", () => {
  test("Person in a @graph, with memberOf and sport strings", () => {
    expect(identityHintOf({ "@graph": [{ "@type": "WebPage" }, { "@type": ["Person"], name: "Riley Example", memberOf: [{ name: "Rivertown" }], sport: "Soccer" }] }))
      .toEqual({ names: ["Riley Example"], affiliations: ["Rivertown", "Soccer"] });
  });
  test("no Person → no hint", () => {
    expect(identityHintOf([{ "@type": "Organization", name: "Rivertown" }])).toBeNull();
    expect(identityHintOf(null)).toBeNull();
  });
});

describe("structured data in pageIdentity", () => {
  const plain = { url: "https://stats.example.org/p/1", title: "Player page", text: "Riley Example profile." };
  const hinted = (names: string[], affiliations: string[]) => pageIdentity({ ...plain, identityHint: { names, affiliations } }, ATHLETE, { strict: true });
  test("anchored when the Person names the athlete with their sport or team", () => {
    expect(hinted(["Riley Example"], ["Rivertown Soccer"]).verdict).toBe("anchored");
  });
  test("other when the same name is tied to another sport", () => {
    expect(hinted(["Riley Example"], ["Lakeside Basketball"]).verdict).toBe("other");
  });
  test("a team name alone never says other (athletes change teams); soccer called football anchors", () => {
    expect(hinted(["Riley Example"], ["Lakeside City"]).verdict).toBe("neutral");
    expect(hinted(["Riley Example"], ["Lakeside City", "Football"]).verdict).toBe("anchored");
  });
  test("no structured verdict without a matching name or without sport/team strings", () => {
    expect(hinted(["Someone Else"], ["Lakeside Basketball"]).verdict).toBe("neutral");
    expect(hinted(["Riley Example"], []).verdict).toBe("neutral");
  });
});

describe("rank uses the hint", () => {
  const page = (affiliations: string[]) => ({
    url: "https://example.org/p", title: "Profile", date: null,
    text: `Riley Example scored again this weekend.\n\n${filler}\n\nThe ${ATHLETE.sport} season continues with ${ATHLETE.team}.`,
    identityHint: { names: ["Riley Example"], affiliations },
  });
  test("structured data for another sport → wrong-person rejection, even if the text mentions the sport far away", () => {
    const r = rankPassages([page(["Lakeside Basketball"])], ATHLETE, { strict: true });
    expect(r.passages).toHaveLength(0);
    expect(r.wrongPerson[0].reason).toMatch(/structured data/);
  });
  test("structured data naming their team → kept, even when the text puts the sport far from the name", () => {
    const r = rankPassages([page(["Rivertown Soccer"])], ATHLETE, { strict: true });
    expect(r.wrongPerson).toHaveLength(0);
    expect(r.passages.length).toBeGreaterThan(0);
  });
});
