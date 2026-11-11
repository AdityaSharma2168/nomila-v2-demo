/**
 * onboardingCostFlags.test.ts — the three onboarding cost cuts are separate flags, OFF in code (only the exact string
 * "true" turns one on); in prod only RESEARCH_MERGE_COMPACT is on (with the waitlist research switch, 24 Oct 2026),
 * and in the dev yaml only once its equivalence check passed:
 *   RESEARCH_MERGE_COMPACT               passed → ON in dev
 *   ONBOARDING_STATE_AFTER_CONVERSATION  no cache gain measured → not set (off)
 *   MIA_FACTS_NO_EVIDENCE_ECHO           scores moved outside the old version's spread for one athlete → not set (off)
 */
jest.mock("../db", () => ({ db: {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { researchMergeCompact } from "./research/research";
import { onboardingStateAfterConversation } from "./onboarding/turn";
import { miaFactsNoEvidenceEcho } from "../services/miaPreview/factsOnlySpec";

const GCP = join(__dirname, "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);
const FLAGS = { RESEARCH_MERGE_COMPACT: researchMergeCompact, ONBOARDING_STATE_AFTER_CONVERSATION: onboardingStateAfterConversation, MIA_FACTS_NO_EVIDENCE_ECHO: miaFactsNoEvidenceEcho };

afterEach(() => { for (const k of Object.keys(FLAGS)) delete process.env[k]; });

test("each flag is off by default and on only for the exact string \"true\"", () => {
  for (const [k, on] of Object.entries(FLAGS)) {
    expect(on()).toBe(false);
    process.env[k] = "1";
    expect(on()).toBe(false);
    process.env[k] = "true";
    expect(on()).toBe(true);
  }
});

test("dev and prod turn on only the change that passed", () => {
  const dev = envOf("cloud-run-dev.yaml"), prod = envOf("cloud-run-prod.yaml");
  expect(dev.filter((e) => e.name === "RESEARCH_MERGE_COMPACT")).toEqual([{ name: "RESEARCH_MERGE_COMPACT", value: "true" }]);
  expect(dev.filter((e) => e.name === "ONBOARDING_STATE_AFTER_CONVERSATION" || e.name === "MIA_FACTS_NO_EVIDENCE_ECHO")).toEqual([]);
  expect(prod.filter((e) => e.name in FLAGS)).toEqual([{ name: "RESEARCH_MERGE_COMPACT", value: "true" }]);
});
