/**
 * joinWaitlist.ts — the waitlist switch for new accounts. (The dev-only JOIN_WAITLIST join flow was never switched on
 * and was deleted 2 Nov 2026, owner decision.)
 */

/**
 * WAITLIST_ALL_SIGNUPS (production, owner 24 Oct 2026): EVERY new account joins the waitlist, whatever door it came in
 * through — the app's /auth/signup (every branch), /auth/microsoft (both branches) and the landing's /waitlist (which is
 * waitlisted already). Without it, signing into app.nomila.co or the store app made a 'raw' account with the whole app
 * and no waitlist. Existing accounts are never touched; the admin's promote (status → 'active') is what lets anyone in.
 * Exactly "true" ⇒ on; anything else ⇒ today's behaviour. Read per call.
 */
export function waitlistAllSignupsEnabled(): boolean {
  return process.env.WAITLIST_ALL_SIGNUPS === "true";
}
