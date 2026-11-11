/**
 * ownershipGuard.test.ts — Phase A Step 3a: who may write the identity tables and who may read a provider uid (plan §4).
 *   users / athlete_users / identity_claims / user_roles are written only by services/intelligence/identity/** and
 *   scripts/backfillIdentityUsers.ts; connected_by_user_id only by routes/connections.ts + the backfill;
 *   users.provider_uid is read only by lib/auth.ts and the identity module (+ the identity scripts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "../../../..");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "client") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = [...walk(join(ROOT, "server")), ...walk(join(ROOT, "shared"))].map((p) => ({ rel: relative(ROOT, p).replace(/\\/g, "/"), src: readFileSync(p, "utf8") }));

const IDENTITY_WRITERS = /^(server\/services\/intelligence\/identity\/|server\/scripts\/backfillIdentityUsers\.ts$)/;
const TABLE_WRITE = /\.(insert|update|delete)\(\s*(users|athleteUsers|identityClaims|userRoles)\b/;
const RAW_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(users|athlete_users|identity_claims|user_roles)\b/i;

it("only the identity module and the backfill write users / athlete_users / identity_claims / user_roles", () => {
  const offenders = files.filter((f) => !IDENTITY_WRITERS.test(f.rel) && (TABLE_WRITE.test(f.src) || RAW_WRITE.test(f.src)) && f.rel !== "shared/schema.ts")
    // routes/auth.ts may add a user_roles row beside the account_roles row on the 2c linked branch (the membership itself is written by linkUserToAthlete)
    .filter((f) => !(f.rel === "server/routes/auth.ts" && !/\.(insert|update|delete)\(\s*(users|athleteUsers|identityClaims)\b/.test(f.src)));
  expect(offenders.map((f) => f.rel)).toEqual([]);
});

it("connected_by_user_id is written only by routes/connections.ts and the backfill", () => {
  const offenders = files.filter((f) => /\.(set|values)\(\{[^}]*connected_by_user_id\s*:/s.test(f.src) && !["server/routes/connections.ts", "server/scripts/backfillIdentityUsers.ts", "shared/schema.ts"].includes(f.rel));
  expect(offenders.map((f) => f.rel)).toEqual([]);
});

it("no file outside lib/auth.ts and the identity module reads users.provider_uid", () => {
  const allowed = /^(server\/lib\/auth\.ts$|server\/services\/intelligence\/identity\/|server\/scripts\/(backfillIdentityUsers|checkIdentityCollisions)\.ts$|shared\/schema\.ts$)/;
  const offenders = files.filter((f) => !allowed.test(f.rel) && /provider_uid/.test(f.src));
  expect(offenders.map((f) => f.rel)).toEqual([]);
});

it("the active connected_verified promotion has exactly one writer: identity/ownership.ts (ensureIdentity delegates)", () => {
  const ingest = files.find((f) => f.rel === "server/services/intelligence/social/ingest.ts")!;
  expect(ingest.src).toMatch(/claimAccountOwnership\(/);
  const direct = files.filter((f) => f.rel !== "server/services/intelligence/identity/ownership.ts" && f.rel !== "server/services/intelligence/social/identityRow.ts" && /upsertIdentityRow\(/.test(f.src) && !/sourceClass === "connected_verified"/.test(f.src));
  expect(direct.map((f) => f.rel)).toEqual([]);
});
