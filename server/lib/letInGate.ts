/**
 * letInGate.ts — which API paths an athlete who is still on the waitlist may call (owner, 25 Oct 2026: launch board f14).
 *
 * A waitlisted athlete never sees the app's screens (client/App.tsx shows the waitlist screen instead), but with their own
 * Firebase token they could call app-only endpoints directly — Mila chat, Studio, brand book, decks, research refresh —
 * which cost model and provider money and expose features not yet released to them. requireAuth (lib/auth.ts) refuses
 * those with 403 {error:"not_let_in"} for status 'waitlisted', and lets through only what the waitlist itself uses:
 *
 *   /api/v1/auth*, /api/v1/waitlist*, /api/v1/identity*, /api/v1/public*, /api/v1/admin*   sign-in, the landing's join
 *       flow and spot, admin (admin has its own role gate)
 *   /api/v1/me/account, /me/export                          account deletion and data export (always theirs)
 *   /api/v1/me/connections*, /me/connect/*, /me/disconnect/*   connecting Instagram from the landing
 *   /api/v1/me/push/*                                       push registration, so "you're in" reaches them
 *   /api/v1/me/atmosphere/pick                              the landing's share-card imagery
 *
 * Every other status ('raw', 'enriched', 'claimed', 'active') is unchanged: those accounts predate the waitlist or have
 * been let in. Admins (role "admin") always pass. WAITLIST_API_GATE="false" turns the gate off (escape hatch).
 * Pure: no imports.
 */

const OPEN_ROOTS = ["/api/v1/auth", "/api/v1/waitlist", "/api/v1/identity", "/api/v1/public", "/api/v1/admin"];
const ME_OPEN_EXACT = ["/api/v1/me/account", "/api/v1/me/export", "/api/v1/me/connections", "/api/v1/me/atmosphere/pick"];
const ME_OPEN_PREFIXES = ["/api/v1/me/connections/", "/api/v1/me/connect/", "/api/v1/me/disconnect/", "/api/v1/me/push/"];

const underRoot = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

type Env = Record<string, string | undefined>;

export function waitlistApiGateEnabled(env: Env = process.env): boolean {
  return (env.WAITLIST_API_GATE ?? "").trim().toLowerCase() !== "false";
}

/** The request path without query string or trailing slash. */
export function gatePath(originalUrl: string): string {
  const p = (originalUrl.split("?")[0] || "/").replace(/\/+$/, "");
  return p || "/";
}

/** May an athlete still on the waitlist call this path? */
export function waitlistedMayCall(path: string): boolean {
  if (OPEN_ROOTS.some((r) => underRoot(path, r))) return true;
  if (ME_OPEN_EXACT.includes(path)) return true;
  if (ME_OPEN_PREFIXES.some((p) => path.startsWith(p))) return true;
  return false;
}

/** Refuse this call? Only a waitlisted, non-admin athlete outside the open paths, with the gate on. */
export function refuseNotLetIn(input: {
  status: string | null | undefined;
  roles: readonly string[] | undefined;
  path: string;
  env?: Env;
}): boolean {
  if (!waitlistApiGateEnabled(input.env)) return false;
  if (input.status !== "waitlisted") return false;
  if ((input.roles ?? []).includes("admin")) return false;
  return !waitlistedMayCall(input.path);
}
