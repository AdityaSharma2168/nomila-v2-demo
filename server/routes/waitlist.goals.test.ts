/**
 * waitlist.goals.test.ts — the goal vocabulary is ONE list (shared/goals.ts).
 *
 * The landing page used to keep its own copy of the goal slugs for its goals step; the join flow (Oct 2026) no longer
 * asks goals on the web (Mila asks later), so the page keeps no list at all. This test pins that, and the slug helpers.
 */

import fs from "fs";
import path from "path";
import { GOALS, RETIRED_GOALS, isGoalSlug, toGoalSlug } from "../../shared/goals";

test("the landing page keeps no goal list of its own (goals are asked later, in the app)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "landing", "index.html"), "utf8");
  for (const g of [...GOALS, ...RETIRED_GOALS]) expect(html).not.toContain(`'${g.slug}'`);
});

test("toGoalSlug accepts a slug or an exact label and rejects prose", () => {
  expect(toGoalSlug("grow_my_following")).toBe("grow_my_following");
  expect(toGoalSlug("Get my first deal")).toBe("get_my_first_deal");
  expect(toGoalSlug("  GET FAIR VALUE FOR DEALS ")).toBe("get_fair_value");
  expect(toGoalSlug("grow my brand")).toBeNull();
  expect(toGoalSlug(42)).toBeNull();
  expect(isGoalSlug("build_partnerships")).toBe(true);
  expect(isGoalSlug("build partnerships")).toBe(false);
});
