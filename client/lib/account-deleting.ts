/**
 * account-deleting — the app-wide "this account is being deleted" signal.
 *
 * From the moment an account deletion is confirmed, the server answers every request of that account with
 * 410 { error: "account_deleting" } (server/lib/auth.ts ACCOUNT_DELETING). A second phone still signed in would
 * otherwise just see errors. The shared request paths (query-client's apiRequest and default queryFn, the profile
 * load in auth-context, account-api) report such an answer here; AuthProvider listens and RootGate shows
 * AccountDeletingScreen, whose OK signs out.
 *
 * The phone that just deleted the account shows its own "Your account is closed" screen instead, so it silences the
 * signal (`silenceAccountDeleting(true)`) until it has signed out.
 */

export const ACCOUNT_DELETING_ERROR = "account_deleting";

type Listener = () => void;
const listeners = new Set<Listener>();
let silenced = false;

/** True for the server's 410 account_deleting answer (status + raw body text). */
export function isAccountDeletingResponse(status: number, bodyText: string): boolean {
  if (status !== 410) return false;
  try { return (JSON.parse(bodyText) as { error?: unknown })?.error === ACCOUNT_DELETING_ERROR; }
  catch { return false; }
}

/** A request was refused because this account is being deleted. */
export function reportAccountDeleting(): void {
  if (silenced) return;
  for (const l of [...listeners]) l();
}

export function onAccountDeleting(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** This phone deleted the account itself: its own success screen shows, not the "being deleted" one. */
export function silenceAccountDeleting(on: boolean): void { silenced = on; }
