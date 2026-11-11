/**
 * completeOnboardingStep.ts — Mila tool: answer the onboarding step the athlete is on.
 *
 * Offered ONLY in an onboarding conversation (the loop appends it when context.type is
 * "onboarding"; see registry.ts onboardingTools). It is the one door from the conversation
 * into the workflow runner's await_human steps:
 *
 *   greet  → { confirmed, corrections[] }  the athlete's reaction to what Mila found; each
 *            correction is a profile fact in their own words, written by the step's complete()
 *            through recordAssertions (receipted, undoable — the onboarding write exception).
 *   doors  → { door }                       which way they want to go first.
 *
 * TENANCY: athleteId comes from the loop. The run is resolved from it (activeRunFor), never
 * from model args, and completeStep re-checks ownership. The model cannot name a run.
 *
 * Every failure is a plain { error } so Mila can say what happened instead of inventing it.
 */

import { z } from "zod";
import type { MilaTool } from "../types";
import { FIRST_ENTRY_FIELD_NAMES, DOORS, MAX_CORRECTIONS, OnboardingFieldError, ONBOARDING_STEPS, type SavedFact } from "../onboarding";
import { activeRunFor, completeStep, getRun, WorkflowError } from "../../workflow/runner";

const args = z.object({
  step: z.enum(ONBOARDING_STEPS).describe("Which onboarding step this answers: 'greet' (their reaction to what you found) or 'doors' (where they want to start)."),
  confirmed: z.boolean().optional().describe("greet only: true when they said what you found is right."),
  corrections: z
    .array(
      z.object({
        field: z.enum(FIRST_ENTRY_FIELD_NAMES).describe("The profile fact: position, class_year, hometown, sport, school (team or school), nickname (what they go by), note, affiliations (their teams — one per line: `org | kind | level | role | from-to | primary`, kind = school/club/pro/national/olympic, a current team has no end year), or career_status ('playing', 'between teams', 'out this season', 'retired 2024')."),
        value: z.string().describe("The tidy value, e.g. 'forward', '2027', 'Dublin, Ohio', 'retired 2024', or for affiliations the team lines."),
        said: z.string().optional().describe("Their own words this came from, verbatim and short."),
      }),
    )
    .max(MAX_CORRECTIONS)
    .optional()
    .describe("greet only: the facts they corrected or added. Omit or leave empty when nothing changed."),
  door: z.enum(DOORS).optional().describe("doors only: 'profile' to build their public profile with you now, 'deals' to look at their deals and inbox first."),
});

export interface CompleteOnboardingResult {
  ok: true;
  run_id: string;
  step: (typeof ONBOARDING_STEPS)[number];
  saved: SavedFact[];
  /** What the conversation does next: offer the doors, or nothing — onboarding is finished. */
  next: "doors" | "done";
  door: (typeof DOORS)[number] | null;
}

export const completeOnboardingStepTool: MilaTool<typeof args> = {
  name: "complete_onboarding_step",
  description:
    "Record the athlete's answer to the onboarding step they are on. Step 'greet': pass confirmed " +
    "true when what you found is right, and/or corrections — one per profile fact they corrected or " +
    "added (position, class_year, hometown, sport, school, nickname, note), each with the tidy value " +
    "and their own words in `said`. Only these fields are saved; do not invent others. Step 'doors': " +
    "pass door 'profile' or 'deals' once they have chosen. Returns what was saved (say only that was " +
    "saved) and what comes next. Renders the receipt card and, after the greeting, the two doors.",
  argsSchema: args,
  timeoutMs: 20_000,
  async execute(athleteId, a) {
    const active = await activeRunFor(athleteId, "onboarding");
    if (!active || !active.waiting) return { error: "No onboarding step is waiting for an answer — onboarding is finished or has not started." };
    if (active.waiting.step !== a.step) {
      return { error: `The step waiting for an answer is '${active.waiting.step}', not '${a.step}'.` };
    }
    const fields =
      a.step === "greet"
        ? { confirmed: a.confirmed === true, corrections: a.corrections ?? [], mode: "chat" }
        : { door: a.door, mode: "chat" };
    if (a.step === "doors" && !a.door) return { error: "Step 'doors' needs door 'profile' or 'deals'." };

    try {
      const { run } = await completeStep({ runId: active.run.id, step: a.step, fields, mode: "chat", athleteId });
      const found = await getRun(run.id);
      const done = found?.steps.find((s) => s.step === a.step && s.status === "done");
      const output = (done?.output ?? {}) as { saved?: SavedFact[]; door?: (typeof DOORS)[number] };
      const stillWaiting = found?.steps.find((s) => s.status === "waiting")?.step;
      const result: CompleteOnboardingResult = {
        ok: true,
        run_id: run.id,
        step: a.step,
        saved: output.saved ?? [],
        next: stillWaiting === "doors" ? "doors" : "done",
        door: output.door ?? null,
      };
      return result;
    } catch (err) {
      if (err instanceof OnboardingFieldError || err instanceof WorkflowError) return { error: err.message };
      throw err;
    }
  },
};
