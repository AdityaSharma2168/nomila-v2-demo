/**
 * filteredLogic — pure-function unit tests (no React, no RN, no network).
 * Covers the "Filtered / not a deal" core:
 *   - isJunkFiling: only action='file' + payload.kind='junk' counts
 *   - buildFiltered: sender/reason extraction, undone exclusion, reason grouping, order
 *   - empty state
 *
 * Jest is scoped to server/ by the repo config, so run this suite explicitly:
 *   npx jest --roots client/components/deals/week
 */

import { buildFiltered, isJunkFiling, titleizeReason } from "./filteredLogic";
import type { AgentActionRow } from "../../../hooks/use-agent-actions";

/**
 * A fixed clock, pinned in LOCAL time and at midday.
 *
 * It used to be `Date.UTC(2026, 7, 15)` — midnight UTC — while `dateLabel` reads the timestamp back
 * with `getMonth()`/`getDate()`, which are local. Anywhere west of Greenwich that midnight fell on
 * the previous day, so the suite failed for every developer in the Americas and passed in CI, which
 * runs UTC. Local construction and local reading, and midday so no offset can cross a day boundary.
 *
 * The product behaviour is correct as it stands: an athlete should see a date in her own timezone.
 * It was the test that was in the wrong one.
 */
const NOW = new Date(2026, 7, 15, 12, 0, 0, 0).getTime(); // fixed clock, local midday
const daysAgoISO = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

function action(over: Partial<AgentActionRow> = {}): AgentActionRow {
  return {
    id:         "a1",
    athlete_id: "ath1",
    action:     "file",
    deal_id:    null,
    thread_id:  "t1",
    reason:     "affiliate program recruitment",
    reversible: true,
    held_until: null,
    undone_at:  null,
    payload:    { kind: "junk", category: "affiliate", brand_name: "Acme", confidence: 0.9 },
    result:     null,
    created_at: daysAgoISO(1),
    ...over,
  };
}

describe("isJunkFiling", () => {
  it("accepts a file action with payload.kind='junk'", () => {
    expect(isJunkFiling(action())).toBe(true);
  });
  it("rejects a plain file action (a real filed deal, no junk kind)", () => {
    expect(isJunkFiling(action({ payload: { brand_name: "Acme" } }))).toBe(false);
  });
  it("rejects non-file actions even when payload says junk", () => {
    expect(isJunkFiling(action({ action: "auto_archive" }))).toBe(false);
  });
});

describe("buildFiltered", () => {
  it("is empty when there are no junk filings", () => {
    const out = buildFiltered([action({ payload: { brand_name: "Acme" } })], NOW);
    expect(out.isEmpty).toBe(true);
    expect(out.total).toBe(0);
    expect(out.groups).toHaveLength(0);
  });

  it("extracts sender + reason and drops undone rows", () => {
    const out = buildFiltered(
      [
        action({ id: "a1" }),
        action({ id: "a2", undone_at: daysAgoISO(0) }), // recovered → excluded
      ],
      NOW,
    );
    expect(out.total).toBe(1);
    expect(out.items[0].sender).toBe("Acme");
    expect(out.items[0].reason).toBe("affiliate program recruitment");
    expect(out.items[0].dateLabel).toBe("Aug 14");
  });

  it("falls back to honest generics when labels are missing", () => {
    const out = buildFiltered(
      [action({ id: "x", reason: null, payload: { kind: "junk" } })],
      NOW,
    );
    expect(out.items[0].sender).toBe("Unknown sender");
    expect(out.items[0].reason).toBe("Filtered as noise");
  });

  it("groups by reason (case-insensitive), biggest group first", () => {
    const out = buildFiltered(
      [
        action({ id: "1", reason: "loyalty/birthday promo", created_at: daysAgoISO(1) }),
        action({ id: "2", reason: "Affiliate program recruitment", created_at: daysAgoISO(2) }),
        action({ id: "3", reason: "affiliate program recruitment", created_at: daysAgoISO(3) }),
      ],
      NOW,
    );
    expect(out.groups).toHaveLength(2);
    // Affiliate (2 items) outranks loyalty (1 item).
    expect(out.groups[0].reason).toBe("Affiliate program recruitment");
    expect(out.groups[0].items).toHaveLength(2);
    expect(out.groups[1].items).toHaveLength(1);
  });
});

describe("titleizeReason", () => {
  it("sentence-cases the first letter only", () => {
    expect(titleizeReason("cold app/SaaS pitch")).toBe("Cold app/SaaS pitch");
  });
});
