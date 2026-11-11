/**
 * formatScheduleMoney — the money line on a card for a deal that has a schedule.
 *
 * The line has to be true on its own, with no context around it. A bare "$105K" reads as
 * this year's money; "4 yrs" asserts a duration the adidas contract does not have, since
 * its term runs to "the earlier of December 31 of the second Professional Contract Year, or
 * December 31 2028".
 */

import { formatScheduleMoney, scheduleSummary } from "./scheduleMoney";

const C = (dollars: number) => dollars * 100;

describe("the money line leads with the year", () => {
  const adidas = {
    acvCents: C(30_000),
    tcvCents: C(105_000),
    termMonths: 48,
    currentPeriod: { ends_on: "2028-12-31" },
  };

  it("puts the annual figure first", () => {
    expect(formatScheduleMoney(adidas)).toMatch(/^\$30K\/yr/);
  });

  it("labels the total rather than leaving a bare number", () => {
    expect(formatScheduleMoney(adidas)).toContain("$105K total");
  });

  // Every other system in the app reasons annually or per-unit. A card leading with the
  // term total would disagree with the score grid, the composer and escrow at once.
  it("never leads with the total", () => {
    expect(formatScheduleMoney(adidas)).not.toMatch(/^\$105K/);
  });

  it("gives the outer bound as a year, never a confident duration", () => {
    const line = formatScheduleMoney(adidas)!;
    expect(line).toContain("through 2028");
    expect(line).not.toContain("4 yrs");
    expect(line).not.toContain("years");
  });
});

describe("it says only what it knows", () => {
  it("omits the annual figure when the current year is conditional", () => {
    // acv is null when the period she is in is not guaranteed.
    const line = formatScheduleMoney({
      acvCents: null, tcvCents: C(30_000), termMonths: 48,
      currentPeriod: { ends_on: "2028-12-31" },
    });
    expect(line).not.toContain("/yr");
    expect(line).toContain("$30K total");
  });

  it("omits the end date when there is no current period", () => {
    const line = formatScheduleMoney({
      acvCents: C(20_000), tcvCents: C(20_000), termMonths: null, currentPeriod: null,
    });
    expect(line).toBe("$20K/yr");
  });

  it("does not repeat itself when the year IS the whole deal", () => {
    const line = formatScheduleMoney({
      acvCents: C(20_000), tcvCents: C(20_000), termMonths: 12,
      currentPeriod: { ends_on: "2024-12-31" },
    });
    expect(line).toBe("$20K/yr · through 2024");
  });

  it("returns null when there is no money at all", () => {
    expect(formatScheduleMoney(null)).toBeNull();
    expect(formatScheduleMoney({ acvCents: null, tcvCents: null, termMonths: null, currentPeriod: null }))
      .toBeNull();
  });

  it("writes small figures in full rather than rounding to $0K", () => {
    expect(formatScheduleMoney({ acvCents: C(750), tcvCents: null, termMonths: null, currentPeriod: null }))
      .toBe("$750/yr");
  });
});

describe("it says when it does not know", () => {
  it("refuses to print a per-year figure when the amount is unconfirmed", () => {
    const line = formatScheduleMoney({
      acvUnknown: true, acvCents: null, tcvCents: null, termMonths: 48,
      currentPeriod: { ends_on: "2028-12-31" },
    });
    expect(line).toBe("Amount unconfirmed — check the contract");
  });

  it("never shows a total built on an unconfirmed year", () => {
    const line = formatScheduleMoney({
      acvUnknown: true, acvCents: null, tcvCents: 10_500_000, termMonths: 48, currentPeriod: null,
    })!;
    expect(line).not.toContain("$105K");
  });

  it("is unaffected when everything is known", () => {
    const line = formatScheduleMoney({
      acvUnknown: false, acvCents: 3_000_000, tcvCents: 10_500_000, termMonths: 48,
      currentPeriod: { ends_on: "2028-12-31" },
    });
    expect(line).toBe("$30K/yr · through 2028 · $105K total");
  });
});

describe("the named summary teaches the vocabulary", () => {
  const adidas = {
    acvCents: C(30_000), tcvCents: C(105_000), aavCents: C(26_250),
    remainingCents: C(75_000), conditionalCents: C(95_000),
  };

  it("pairs every acronym with the words it stands for", () => {
    const rows = scheduleSummary(adidas);
    expect(rows.find((r) => r.abbr === "ACV")!.name).toBe("Annual Contract Value");
    expect(rows.find((r) => r.abbr === "TCV")!.name).toBe("Total Contract Value");
    expect(rows.find((r) => r.abbr === "AAV")!.name).toBe("Average Annual Value");
  });

  it("leads with this year, not the term total", () => {
    expect(scheduleSummary(adidas)[0].abbr).toBe("ACV");
  });

  // On a one-year deal the two are the same number; printing it twice teaches nothing.
  it("omits AAV when it equals ACV", () => {
    const oneYear = { acvCents: C(14_000), tcvCents: C(14_000), aavCents: C(14_000) };
    expect(scheduleSummary(oneYear).map((r) => r.abbr)).not.toContain("AAV");
  });

  it("names conditional money separately so it is never read as part of a total", () => {
    const row = scheduleSummary(adidas).find((r) => r.abbr === "If")!;
    expect(row.name).toBe("Conditional");
    expect(row.note).toContain("only if");
  });

  it("says it does not know rather than showing a zero", () => {
    const rows = scheduleSummary({ acvUnknown: true, acvCents: null, tcvCents: null, aavCents: null });
    expect(rows[0].value).toBe("—");
    expect(rows[0].note).toContain("couldn't confirm");
  });

  it("returns nothing when there is no schedule", () => {
    expect(scheduleSummary(null)).toEqual([]);
  });
});

describe("the collapsed card stays lean", () => {
  const adidas = {
    acvCents: C(30_000), tcvCents: C(105_000), termMonths: 48,
    currentPeriod: { ends_on: "2028-12-31" },
  };

  // A list is read at a glance: the rate and the horizon are what tell one deal from
  // another. The total, and the named breakdown, belong where there is room to label them.
  it("drops the term total on a card", () => {
    expect(formatScheduleMoney(adidas, { compact: true })).toBe("$30K/yr · through 2028");
  });

  it("keeps it everywhere else", () => {
    expect(formatScheduleMoney(adidas)).toBe("$30K/yr · through 2028 · $105K total");
  });

  it("still refuses to print a figure it cannot stand behind", () => {
    expect(formatScheduleMoney({ ...adidas, acvUnknown: true, acvCents: null }, { compact: true }))
      .toBe("Amount unconfirmed — check the contract");
  });
});
