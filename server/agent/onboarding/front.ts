/**
 * agent/onboarding/front.ts — what the app needs BEFORE anyone is signed in to draw the agent onboarding front
 * (EXPO_PUBLIC_AGENT_V3 in the app, AGENT_ONBOARDING here). Public, read-only, no athlete data:
 *
 *   GET /api/v1/public/onboarding-front   → { agentOnboarding, signinPhotos: [{ id, url }], emailSignIn }
 *
 *   agentOnboarding   whether this server runs the agent onboarding. The app draws the new sign-in, sport grid and
 *                     "Is this you?" only when it is true; false (or no answer) keeps today's flow.
 *   signinPhotos      the shared atmosphere library's "signin" photos (0120), as short-lived signed URLs of OUR stored
 *                     copies; empty when there are none (the app then draws a neutral dark ground). Never sent while
 *                     agentOnboarding is false.
 *   emailSignIn       whether the front offers "Use email instead" (the 6-digit email code, server/routes/authEmailCode.ts):
 *                     EMAIL_CODE_SIGNIN on, EMAIL_CODE_SECRET set and email delivery on. Read per request, so the link
 *                     follows the switch without a build. Never true while agentOnboarding is false.
 *
 * The answer is cached for a few minutes (one list for everyone; the URLs outlive the cache).
 */
import { Router, type Request, type Response } from "express";
import { createLogger } from "../../logger";
import { emailCodeUnavailable } from "../../lib/emailCode";

/** AGENT_ONBOARDING exactly as routes.ts agentOnboardingEnabled() reads it (not imported: that module pulls the service). */
const agentOnboardingEnabled = () => process.env.AGENT_ONBOARDING === "true";

const logger = createLogger("agent/onboarding/front");

export interface SigninPhoto { id: string; url: string }

/**
 * A safety cap, not a curation choice: the app shows every active "signin" photo (owner intent is one close-up per
 * sport, all shown, not a rotating subset), bounded here only against a future list growing unreasonably large.
 */
export const MAX_SIGNIN_PHOTOS = 12;
/** How long one answer is reused; the signed URLs live longer than this. */
export const FRONT_CACHE_MS = 10 * 60 * 1000;
/** The signed URLs' lifetime. */
export const SIGNIN_URL_TTL_MS = 60 * 60 * 1000;

export interface FrontDeps {
  /** The active "signin" photos in the shared library, newest curated first (at most `limit`). */
  signinPhotos(limit: number): Promise<SigninPhoto[]>;
  now(): number;
}

let cache: { at: number; photos: SigninPhoto[] } | null = null;
export function resetFrontCache(): void { cache = null; }

export interface FrontState { agentOnboarding: boolean; signinPhotos: SigninPhoto[]; emailSignIn: boolean }

export async function frontState(deps: FrontDeps): Promise<FrontState> {
  if (!agentOnboardingEnabled()) return { agentOnboarding: false, signinPhotos: [], emailSignIn: false };
  const emailSignIn = emailCodeUnavailable() === null;
  if (cache && deps.now() - cache.at < FRONT_CACHE_MS) return { agentOnboarding: true, signinPhotos: cache.photos, emailSignIn };
  let photos: SigninPhoto[] = [];
  try {
    photos = (await deps.signinPhotos(MAX_SIGNIN_PHOTOS)).slice(0, MAX_SIGNIN_PHOTOS);
  } catch (err: any) {
    // No library yet, or storage unreachable: the app draws the dark ground. Never fails the front.
    logger.warn({ error: String(err?.message ?? err).slice(0, 200) }, "sign-in photos unavailable");
  }
  cache = { at: deps.now(), photos };
  return { agentOnboarding: true, signinPhotos: photos, emailSignIn };
}

/**
 * The real reads: the shared library's active "signin" photos (curated first, newest first) as signed URLs of our
 * stored copies. Shared data, no athlete id. Loaded lazily so the route module stays light.
 */
export const defaultFrontDeps: FrontDeps = {
  async signinPhotos(limit) {
    const [{ db }, { sql }, { signedUrl }] = await Promise.all([import("../../db"), import("drizzle-orm"), import("../../lib/mediaStore")]);
    const res: any = await db.execute(sql`select id::text as id, gcs_path from atmosphere_library where category = 'signin' and active order by curated desc, created_at desc limit ${limit}`);
    const rows: Array<{ id: string; gcs_path: string }> = Array.isArray(res) ? res : res?.rows ?? [];
    return Promise.all(rows.map(async (r) => ({ id: r.id, url: await signedUrl(r.gcs_path, SIGNIN_URL_TTL_MS) })));
  },
  now: () => Date.now(),
};

export function onboardingFrontRouter(deps: FrontDeps = defaultFrontDeps): Router {
  const router = Router();
  router.get("/onboarding-front", async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.json(await frontState(deps));
  });
  return router;
}
