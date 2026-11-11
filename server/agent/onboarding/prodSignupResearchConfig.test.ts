/**
 * prodSignupResearchConfig.test.ts — the prod Cloud Run yaml for the waitlist's agent research path (design: one
 * research route for every sign-up, §4), switched ON for the waitlist (owner, 24 Oct 2026):
 *   declared   OPENAI_API_KEY from prod's own secret OPENAI_API_KEY_PROD (never a literal), SIGNUP_RESEARCH_AGENT,
 *              and RESEARCH_MERGE_COMPACT "true", the daily research cap set (MIA_FACTS_ONLY_EVALUATOR is gone: facts-only
 *              is the only M.I.A. evaluator since 4 Nov 2026)
 *   stay off   the dev-only or unproven switches the design lists (each absent or not "true"). Stage 1 (owner, 25 Oct
 *              2026) switched the new app on in prod, so AGENT_MOMENTS, AGENT_RESEARCH_REFRESH (one athlete at a time),
 *              RESEARCH_SUBSTRATE_WRITE, AGENT_PLAYBOOK, AGENT_IDEA_BANK, AGENT_LEARNING_LOOP, AGENT_PLAN, STUDIO_ALL_ON and
 *              the "direct" provider left this list. Identity resolution stays off: RESEARCH_REFRESH_ENABLED is still off.
 * Every name appears at most once (Cloud Run takes the last duplicate silently).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { PLATFORM_DAY_CAP_DEFAULT_USD, PLATFORM_DAY_CAP_MAX_USD } from "../../lib/platformSpend";

type Env = { name: string; value?: string; valueFrom?: unknown };
const prod = parse(readFileSync(join(__dirname, "..", "..", "..", "gcp", "cloud-run-prod.yaml"), "utf8")).spec.template.spec.containers[0].env as Env[];
const one = (name: string) => prod.filter((e) => e.name === name);

test("the agent research path is declared, on", () => {
  expect(one("OPENAI_API_KEY")).toEqual([{ name: "OPENAI_API_KEY", valueFrom: { secretKeyRef: { name: "OPENAI_API_KEY_PROD", key: "latest" } } }]);
  for (const name of ["SIGNUP_RESEARCH_AGENT", "RESEARCH_MERGE_COMPACT"]) expect(one(name)).toEqual([{ name, value: "true" }]);
  expect(one("DAILY_RESEARCH_CAP_USD")).toHaveLength(1);
  expect(Number(one("DAILY_RESEARCH_CAP_USD")[0].value)).toBeGreaterThan(0);
});

test("the switches the design keeps off in prod are not on", () => {
  const OFF = [
    "AGENT_RESEARCH_REFRESH_COHORT", "AGENT_REFRESH_LIGHT", "MIA_FACTS_NO_EVIDENCE_ECHO",
    "ONBOARDING_STATE_AFTER_CONVERSATION", "RESEARCH_REFRESH_ENABLED",
  ];
  expect(prod.filter((e) => OFF.includes(e.name) && e.value === "true")).toEqual([]);
});

test("the optimized waitlist (owner, 10 Nov 2026): lean research and the quick score are on in prod, matching the live flip", () => {
  for (const name of ["LEAN_SIGNUP_RESEARCH", "QUICK_SCORE_ONE_CALL"]) expect(one(name)).toEqual([{ name, value: "true" }]);
});

test("no variable is declared twice", () => {
  const seen = new Map<string, number>();
  for (const e of prod) seen.set(e.name, (seen.get(e.name) ?? 0) + 1);
  expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
});

test("anti-fake plan (owner, 24 Oct 2026): the cap is a backstop ($200 since the prod catch-up, under the platform cap); App Check monitors account creation", () => {
  expect(one("DAILY_RESEARCH_CAP_USD")).toEqual([{ name: "DAILY_RESEARCH_CAP_USD", value: "200" }]);
  expect(one("APP_CHECK_ENFORCE")).toEqual([{ name: "APP_CHECK_ENFORCE", value: "monitor" }]);
});

test("anti-fake plan PR B: the \"real athlete?\" check is on in prod", () => {
  expect(one("ATHLETE_FOOTPRINT_CHECK")).toEqual([{ name: "ATHLETE_FOOTPRINT_CHECK", value: "true" }]);
});

test("prod catch-up (10 Nov 2026): the platform cap is set above its $25 default, and the sign-up cap sits under it so research queues first", () => {
  // The platform cap counts sign-up research too; the sign-up cap QUEUES runs (owner: research must queue, never fail). So the
  // sign-up cap must bind first: below the platform cap as the code clamps it, with room left for the other paid work.
  expect(one("PLATFORM_DAY_COST_CAP_USD")).toHaveLength(1);
  const platform = Math.min(Number(one("PLATFORM_DAY_COST_CAP_USD")[0].value), PLATFORM_DAY_CAP_MAX_USD);
  const signup = Number(one("DAILY_RESEARCH_CAP_USD")[0].value);
  expect(platform).toBeGreaterThan(PLATFORM_DAY_CAP_DEFAULT_USD);
  expect(signup).toBeLessThan(platform);
  expect(platform - signup).toBeGreaterThanOrEqual(25);
});
