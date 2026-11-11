/** roleClaims.ts — the Firebase roles claim, added to and never overwritten. No imports: callers pass the auth client. */
export interface ClaimsAuth {
  getUser(uid: string): Promise<{ customClaims?: Record<string, unknown> | null } | undefined>;
  setCustomUserClaims(uid: string, claims: Record<string, unknown>): Promise<void>;
}

/**
 * Add `role` to the login's Firebase roles claim WITHOUT dropping roles it already holds (e.g. "admin"). Overwriting
 * with [role] wiped admin access on every app sign-in (prod, 25 Oct 2026); the login is shared by dev and prod, so either
 * environment's sign-up path could wipe it. Other custom claims are kept as they are.
 */
export async function setRoleClaimKeepingOthers(auth: ClaimsAuth, uid: string, role: string): Promise<void> {
  let current: Record<string, unknown> = {};
  try { current = ((await auth.getUser(uid))?.customClaims ?? {}) as Record<string, unknown>; } catch { /* unreadable: set the role alone, as before */ }
  const roles = Array.isArray(current.roles) ? (current.roles as unknown[]).filter((r): r is string => typeof r === "string") : [];
  if (roles.includes(role)) return;
  await auth.setCustomUserClaims(uid, { ...current, roles: [...roles, role] });
}
