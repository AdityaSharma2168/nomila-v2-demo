/**
 * signInFailure — why a Google / Apple / Microsoft sign-in failed, as the agent front tells it. Pure (no React, no
 * Firebase import), so the front and its tests read it without the auth provider.
 *
 *   account_exists   Firebase's auth/account-exists-with-different-credential: the address already has a Nomila account
 *                    made another way (e.g. an email code on a non-Gmail address) and this provider can't prove it owns
 *                    the address. `email` is the address Firebase names (customData.email), when it does.
 *   failed           anything else.
 */
export type SignInFailure = { kind: "failed" } | { kind: "account_exists"; email: string | null };

export function signInFailureOf(err: unknown): SignInFailure {
  const e = err as { code?: string; customData?: { email?: unknown } } | null;
  if (e?.code === "auth/account-exists-with-different-credential") {
    return { kind: "account_exists", email: typeof e.customData?.email === "string" ? e.customData.email : null };
  }
  return { kind: "failed" };
}
