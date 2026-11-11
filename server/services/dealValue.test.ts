/**
 * dealValue — the arithmetic of a real endorsement.
 *
 * The fixture is Mia's adidas agreement as the hardened extractor actually read it: four
 * NIL years (Year 1 guaranteed, Years 2-4 marked "*if applicable*"), then six professional
 * retainer years that only apply if she turns professional, $10,000/yr of product she keeps
 * and $15,000/yr of product she directs to charity and never receives.
 */

import {
  resolveDealValue, currentPeriod, livePeriods, termMonths,
  type PeriodRow, type InstallmentRow,
} from "./dealValue";

const C = (dollars: number) => dollars * 100;

const period = (over: Partial<PeriodRow> & { seq: number }): PeriodRow => ({
  label: null, starts_on: null, ends_on: null,
  cash_cents: null, product_cents: null, product_directed_cents: null,
  guaranteed: true, condition: null, superseded_at: null,
  ...over,
});

/** Year n of a term beginning 1 Jan 2023. */
const year = (seq: number, cash: number, guaranteed: boolean): PeriodRow =>
  period({
    seq,
    label: `NIL Contract Year ${seq}`,
    starts_on: `${2022 + seq}-01-01`,
    ends_on:   `${2022 + seq}-12-31`,
    cash_cents: C(cash),
    product_cents: C(10_000),
    product_directed_cents: C(15_000),
    guaranteed,
    condition: guaranteed ? null : "if applicable — while competing in NCAA athletics",
  });

const ADIDAS: PeriodRow[] = [
  year(1, 20_000, true),
  year(2, 20_000, false),
  year(3, 15_000, false),
  year(4, 10_000, false),
];

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("guaranteed and conditional money are never mixed", () => {
  it("TCV counts only the guaranteed year", () => {
    const v = resolveDealValue(ADIDAS, [], at("2023-06-01"));
    expect(v.tcvCents).toBe(C(30_000));          // $20k cash + $10k product, Year 1 only
  });

  it("conditional money is reported separately, not summed in", () => {
    const v = resolveDealValue(ADIDAS, [], at("2023-06-01"));
    expect(v.conditionalCents).toBe(C(75_000));  // years 2-4: 30k + 25k + 20k
    expect(v.tcvCents).not.toBe(C(105_000));
  });

  it("a conditional current year yields no ACV rather than its figure", () => {
    // 2025 is Year 3, marked "*if applicable*". Reporting $15,000 would assert she is
    // still NCAA-eligible, which the contract does not tell us.
    expect(resolveDealValue(ADIDAS, [], at("2025-06-01")).acvCents).toBeNull();
  });

  it("the guaranteed year does report an ACV", () => {
    expect(resolveDealValue(ADIDAS, [], at("2023-06-01")).acvCents).toBe(C(30_000));
  });
});

describe("charitable value is visible and never counted", () => {
  it("is reported on its own", () => {
    expect(resolveDealValue(ADIDAS, [], at("2023-06-01")).directedCents).toBe(C(60_000));
  });

  it("never reaches TCV, ACV or AAV", () => {
    const v = resolveDealValue(ADIDAS, [], at("2023-06-01"));
    expect(v.tcvCents).toBe(C(30_000));    // not 30k + 15k
    expect(v.acvCents).toBe(C(30_000));
    expect(v.aavCents).toBe(C(30_000));
  });
});

describe("the current period is found by date", () => {
  it.each([
    ["2023-06-01", 1],
    ["2024-06-01", 2],
    ["2026-06-01", 4],
  ])("at %s we are in year %i", (iso, seq) => {
    expect(currentPeriod(ADIDAS, at(iso as string))?.seq).toBe(seq);
  });

  it("is null past the end of the schedule", () => {
    expect(currentPeriod(ADIDAS, at("2030-06-01"))).toBeNull();
  });

  it("includes the final day of a period", () => {
    expect(currentPeriod(ADIDAS, at("2023-12-31"))?.seq).toBe(1);
  });

  it("refuses to guess among several undated periods", () => {
    const undated = [period({ seq: 1, cash_cents: C(5_000) }), period({ seq: 2, cash_cents: C(5_000) })];
    expect(currentPeriod(undated, at("2026-06-01"))).toBeNull();
  });

  it("but a single undated period is unambiguous", () => {
    expect(currentPeriod([period({ seq: 1, cash_cents: C(5_000) })], at("2026-06-01"))?.seq).toBe(1);
  });
});

describe("an amendment supersedes rather than overwrites", () => {
  it("superseded rows are excluded from every figure", () => {
    const amended: PeriodRow[] = [
      { ...year(1, 20_000, true), superseded_at: "2023-07-01" },
      { ...year(1, 25_000, true) },
    ];
    expect(livePeriods(amended)).toHaveLength(1);
    expect(resolveDealValue(amended, [], at("2023-09-01")).tcvCents).toBe(C(35_000));
  });
});

describe("installments are scheduled, not earned", () => {
  // adidas pays each annual amount in two installments.
  const halves: InstallmentRow[] = [
    { period_seq: 1, seq: 1, amount_cents: C(10_000), due_on: "2023-03-01", kind: "scheduled" },
    { period_seq: 1, seq: 2, amount_cents: C(10_000), due_on: "2023-09-01", kind: "scheduled" },
  ];

  it("counts only what was due by today", () => {
    expect(resolveDealValue(ADIDAS, halves, at("2023-06-01")).scheduledToDateCents).toBe(C(10_000));
    expect(resolveDealValue(ADIDAS, halves, at("2023-10-01")).scheduledToDateCents).toBe(C(20_000));
  });

  it("ignores installments belonging to a conditional period", () => {
    const y2: InstallmentRow[] = [
      { period_seq: 2, seq: 1, amount_cents: C(10_000), due_on: "2024-03-01", kind: "scheduled" },
    ];
    expect(resolveDealValue(ADIDAS, y2, at("2024-06-01")).scheduledToDateCents).toBe(0);
  });

  it("ignores bonuses — they are not scheduled money", () => {
    const bonus: InstallmentRow[] = [
      { period_seq: 1, seq: 1, amount_cents: C(50_000), due_on: "2023-01-01", kind: "bonus" },
    ];
    expect(resolveDealValue(ADIDAS, bonus, at("2023-06-01")).scheduledToDateCents).toBe(0);
  });

  it("reports when installments do not add up to the period's cash", () => {
    const wrong: InstallmentRow[] = [
      { period_seq: 1, seq: 1, amount_cents: C(5_000), due_on: "2023-03-01", kind: "scheduled" },
    ];
    expect(resolveDealValue(ADIDAS, wrong, at("2023-06-01")).reconciled).toBe(false);
    expect(resolveDealValue(ADIDAS, halves, at("2023-06-01")).reconciled).toBe(true);
  });
});

describe("remaining value looks forward", () => {
  it("counts guaranteed periods that have not ended", () => {
    expect(resolveDealValue(ADIDAS, [], at("2023-06-01")).remainingCents).toBe(C(30_000));
  });

  it("is zero once the guaranteed years are behind her", () => {
    expect(resolveDealValue(ADIDAS, [], at("2026-06-01")).remainingCents).toBe(0);
  });
});

describe("shape and edges", () => {
  it("a deal with no periods reports no basis and no figures", () => {
    const v = resolveDealValue([], [], at("2026-06-01"));
    expect(v.basis).toBe("none");
    expect(v.tcvCents).toBeNull();
    expect(v.aavCents).toBeNull();
  });

  it("AAV averages over guaranteed periods only", () => {
    const twoGuaranteed = [year(1, 20_000, true), year(2, 10_000, true), year(3, 15_000, false)];
    const v = resolveDealValue(twoGuaranteed, [], at("2023-06-01"));
    expect(v.tcvCents).toBe(C(50_000));          // (20k+10k) + (10k+10k)
    expect(v.aavCents).toBe(C(25_000));          // ÷ 2, not ÷ 3
  });

  it("termMonths spans the whole schedule", () => {
    expect(termMonths(ADIDAS)).toBe(48);
  });
});

describe("a figure we could not read is unknown, not zero", () => {
  // The reconciler nulls a period's cash when two reads disagree. Downstream that null was
  // read as 0, so a year we genuinely could not pin down displayed as a confident figure
  // beside real ones — the product credit alone, presented as the year's pay.
  const withHole = (): PeriodRow[] => [
    { ...year(1, 20_000, true), cash_cents: null },   // disputed
    year(2, 20_000, true),
  ];

  it("reports which periods have an unknown figure", () => {
    expect(resolveDealValue(withHole(), [], at("2023-06-01")).unknownCashPeriods).toEqual([1]);
  });

  it("refuses an ACV when the CURRENT period's cash is unknown", () => {
    const v = resolveDealValue(withHole(), [], at("2023-06-01"));
    expect(v.acvUnknown).toBe(true);
    expect(v.acvCents).toBeNull();
    expect(v.acvCents).not.toBe(C(10_000));   // the product credit alone
  });

  it("refuses a TOTAL rather than quietly reporting a short one", () => {
    // A partial total looks identical to a complete one on screen.
    const v = resolveDealValue(withHole(), [], at("2023-06-01"));
    expect(v.tcvCents).toBeNull();
    expect(v.aavCents).toBeNull();
  });

  it("still answers normally once every figure is known", () => {
    const v = resolveDealValue([year(1, 20_000, true), year(2, 20_000, true)], [], at("2023-06-01"));
    expect(v.unknownCashPeriods).toEqual([]);
    expect(v.acvUnknown).toBe(false);
    expect(v.tcvCents).toBe(C(60_000));
  });

  it("a conditional period with no figure is not a hole in the guaranteed total", () => {
    // Conditional money is excluded from TCV anyway, so its absence cannot short it.
    const v = resolveDealValue([year(1, 20_000, true), { ...year(2, 0, false), cash_cents: null }], [], at("2023-06-01"));
    expect(v.unknownCashPeriods).toEqual([]);
    expect(v.tcvCents).toBe(C(30_000));
  });
});
