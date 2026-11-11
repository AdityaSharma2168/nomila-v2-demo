/**
 * NAMING — the athlete-facing words for the goal chain, in ONE place (owner deciding, 9 Oct 2026). Every agent screen and
 * card reads these; renaming is a change here and nowhere else.
 *
 *   goal      what the athlete wants, in their words
 *   gamePlan  1–2 lines on how Mila will get there
 *   actions   the concrete steps, shown under "This week"
 *
 * Never in athlete-facing copy: "objectives", "strategy", "recommendations" (agentNaming.test.ts scans the agent UI).
 */
export const NAMING = {
  /** The tab and the screen. */
  tab: "Goals",
  goal: "Goal",
  goals: "Goals",
  gamePlan: "Game plan",
  actions: "Actions",
  thisWeek: "This week",
} as const;

/** Words the agent UI never shows the athlete. */
export const BANNED_WORDS = ["objective", "objectives", "strategy", "strategies", "recommendation", "recommendations"] as const;
