/**
 * identity/provider.ts — the one place the uid → provider rule lives (pure; no db import so the backfill planner stays pure).
 * routes/auth.ts mints Microsoft uids as `microsoft:<id>`; everything else is Firebase.
 */
export type Provider = "firebase" | "microsoft";
export const providerOf = (uid: string): Provider => (uid.startsWith("microsoft:") ? "microsoft" : "firebase");
