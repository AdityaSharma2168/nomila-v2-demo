/**
 * agent/events/config.ts — the game-day signals' flag (content engine step 2c).
 *
 * GAME_DAY_SIGNALS — the after-game wake-up (games.ts sweepPassedGames, from the plan-refresh cron) logs "event_passed"
 * app events, and Mila's ask_once may ask a TYPED question (a result in their words). Off unless exactly "true"; set in
 * neither Cloud Run yaml and guarded in prod (scripts/prod-flag-guard.ts GUARDED_FLAGS). It stays off until the app's
 * one-time question card can take a typed answer (MILA_PROACTIVE and MILA_CARDS_V2 are already on in dev, so without
 * this flag a merge would send pushes and cards the current app cannot answer). Saving a game with its date
 * (remember_fact) is not behind it: that is plain memory.
 */
export function gameDaySignalsEnabled(): boolean {
  return process.env.GAME_DAY_SIGNALS === "true";
}
