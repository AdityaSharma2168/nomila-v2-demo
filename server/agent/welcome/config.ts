/**
 * agent/welcome/config.ts — the switch for the welcome flow's capability model (design "Mila welcome flow", owner-
 * approved 28 Oct 2026).
 *
 *   MILA_WELCOME   the capability registry's choices are live: the athlete's answers are recorded in mila_choices, and
 *                  the always-on OPTIONAL jobs (moments scan, post ideas, weekly plan refresh, the "post took off"
 *                  message, auto-archive, the monthly research refresh) run only for athletes who said yes (checked again
 *                  when each job's step runs), and the Mila tools an optional capability unlocks are refused per turn and
 *                  per call until the athlete turns it on (toolGate.ts). Only the
 *                  exact string "true" turns it on. ON in dev, OFF in prod (pinned by welcomeFlag.test.ts, guarded in
 *                  prod by prod-flag-guard.ts); with it off nothing reads or writes mila_choices and every job
 *                  behaves exactly as before.
 *
 * Engine-independent: nothing here (or anywhere in agent/welcome) knows which engine runs Mila's turns.
 * A getter, so env is read at call time (tests and late env injection rely on that).
 */
export function milaWelcomeEnabled(): boolean {
  return process.env.MILA_WELCOME === "true";
}
