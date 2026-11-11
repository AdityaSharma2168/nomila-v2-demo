/**
 * appCheck.ts — Firebase App Check (reCAPTCHA Enterprise) on requests that would CREATE an account (anti-fake plan,
 * owner, 24 Oct 2026).
 *
 * The landing (nomila.co) initialises App Check and sends its token in `X-Firebase-AppCheck` on POST /api/v1/waitlist
 * and the auth create paths. Only the branch that is about to make a NEW account calls appCheckAllows(): an existing
 * athlete updating her answers, a returning sign-in and a claim link are never checked.
 *
 * APP_CHECK_ENFORCE, read per request:
 *   off      (default, and any unknown value)  nothing is verified
 *   monitor  the token is verified with firebase-admin appCheck().verifyToken; a missing or invalid one is LOGGED
 *            (reason only, never the token) and the account is still made
 *   enforce  a missing or invalid token refuses the create: 403 { error: "app_check_failed" } (refuseAppCheck)
 * A verification that could not run (Firebase unreachable) is not the caller's fault: it fails OPEN in every mode,
 * logged. The native app sends no token yet, so "enforce" would refuse new accounts made in the app.
 */
import type { Request, Response } from "express";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAppCheck } from "firebase-admin/app-check";
import { createLogger } from "../logger";

const logger = createLogger("lib/appCheck");

export type AppCheckMode = "off" | "monitor" | "enforce";
export const APP_CHECK_HEADER = "x-firebase-appcheck";
export const APP_CHECK_FAILED_ERROR = "app_check_failed";

/** APP_CHECK_ENFORCE: "monitor" or "enforce" (any case); anything else is off. */
export function appCheckMode(): AppCheckMode {
  const v = (process.env.APP_CHECK_ENFORCE ?? "").trim().toLowerCase();
  return v === "monitor" || v === "enforce" ? v : "off";
}

export type AppCheckOutcome = "valid" | "missing" | "invalid" | "unavailable";

/** Verify the request's App Check token. Never throws. */
export async function verifyAppCheck(req: Request): Promise<AppCheckOutcome> {
  const raw = req.headers[APP_CHECK_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token || typeof token !== "string" || token.length > 4096) return token ? "invalid" : "missing";
  try {
    if (getApps().length === 0) initializeApp();
    await getAppCheck().verifyToken(token);
    return "valid";
  } catch (err: any) {
    const code = String(err?.code ?? err?.errorInfo?.code ?? "");
    const message = String(err?.message ?? "");
    // A bad or expired token is the caller's; anything else (fetching Google's keys, our credentials) is ours, and
    // fails open. firebase-admin maps a key-fetch failure to invalid-argument too, so its message decides.
    if (code === "app-check/app-check-token-expired") return "invalid";
    if (code === "app-check/invalid-argument" && !/fetch|network|socket|timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)) return "invalid";
    logger.warn({ code, error: message.slice(0, 200) }, "App Check verification unavailable (failing open)");
    return "unavailable";
  }
}

/**
 * Call ONLY on the branch about to create a new account. true ⇒ go ahead; false ⇒ answer with refuseAppCheck(res).
 * `path` names the route in the log (waitlist · signup · microsoft).
 */
export async function appCheckAllows(req: Request, path: string): Promise<boolean> {
  const mode = appCheckMode();
  if (mode === "off") return true;
  const outcome = await verifyAppCheck(req);
  if (outcome === "valid" || outcome === "unavailable") return true;
  logger.warn({ path, mode, outcome }, mode === "enforce" ? "new account refused: App Check token " + outcome : "App Check token " + outcome + " on a new account (monitor: allowed)");
  return mode !== "enforce";
}

/** The refusal for an enforced, failed App Check: nothing was created. */
export function refuseAppCheck(res: Response): void {
  res.status(403).json({ error: APP_CHECK_FAILED_ERROR, message: "We couldn't confirm this sign-up came from the Nomila site. Reload the page and try again." });
}
