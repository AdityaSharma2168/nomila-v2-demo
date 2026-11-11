/**
 * readOnly.ts — no imports on purpose: the dry-run sets this BEFORE anything that loads server/db.
 *
 * node-postgres reads PGOPTIONS when it opens each connection, so every session the pool opens
 * starts with `default_transaction_read_only=on` and any write statement fails.
 */
export function readOnlyPgOptions(existing?: string | null): string {
  const flag = "-c default_transaction_read_only=on";
  const prior = (existing ?? "").trim();
  return prior.includes("default_transaction_read_only") ? prior : [prior, flag].filter(Boolean).join(" ");
}
