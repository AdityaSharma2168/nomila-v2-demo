/**
 * backgroundHost — may THIS server process run shared background work (workflow steps, Studio video jobs)?
 *
 * Only on Cloud Run (K_SERVICE is set there), in tests, or when a developer opts in with LOCAL_BACKGROUND_WORK=true.
 * A local `npm run server:dev` points at the shared dev database; without this guard it would pick up and run steps
 * that belong to the cloud (with a different environment, e.g. no model keys), spending money from a laptop. With the
 * guard, a local start still writes its run; the cloud's minute tick runs it.
 */
export function runsBackgroundWork(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.K_SERVICE) || env.NODE_ENV === "test" || env.LOCAL_BACKGROUND_WORK === "true";
}
