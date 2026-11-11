/**
 * socialBlock.ts — CLI that renders the authoritative social block for the eight pilot athletes to disk, for the
 * blind-eval runner to read. The builder itself is production code at
 * server/services/marketabilityBeta1SocialBlock.ts; this file only orchestrates and writes files.
 *
 *   npx tsx --require dotenv/config server/scripts/calibration/blindEval/socialBlock.ts --run
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../../../db";
import { assertDevDatabase } from "../../../lib/devDatabaseGuard";
import { BLIND_EVAL_ATHLETES } from "../../../services/marketabilityBeta1EvaluatorSpec";
import {
  athleteRow, connectedBlock, citedHandles, discoveryBlock, renderBlock,
  type SocialBlockRecord,
} from "../../../services/marketabilityBeta1SocialBlock";

const OUT = join(__dirname, "..", "runs", "blind-eval-v2", "social");

async function main() {
  const run = process.argv.includes("--run");
  await assertDevDatabase(pool);   // dev only: the connected database must be dev, before any read, write or spend
  mkdirSync(OUT, { recursive: true });
  for (const a of BLIND_EVAL_ATHLETES) {
    const rec: SocialBlockRecord = { athlete: a, accounts: [], unavailable: [], candidates: [], text: "" };
    const row = await athleteRow(a);
    if (row) {
      const connected = await connectedBlock(row.id);
      rec.accounts.push(...connected);
      const handles = (await citedHandles(row.id)).filter((h) => !connected.some((c) => c.platform === h.platform));
      if (run) rec.accounts.push(...(await discoveryBlock(a, handles, rec)));
      else for (const h of handles) rec.candidates.push({ platform: h.platform, handle: h.handle, outcome: "dry run" });
    } else rec.candidates.push({ platform: "-", handle: "-", outcome: "no athlete row on dev" });
    for (const p of ["instagram", "youtube", "tiktok", "x"]) if (!rec.accounts.some((x) => x.platform === p)) rec.unavailable.push({ platform: p, reason: p === "tiktok" || p === "x" ? "no authoritative route" : "no confidently resolved account" });
    rec.text = renderBlock(rec);
    writeFileSync(join(OUT, `${a.key}.json`), JSON.stringify(rec, null, 2));
    writeFileSync(join(OUT, `${a.key}.txt`), rec.text);
    console.log(`${a.key}: accounts ${rec.accounts.map((x) => `${x.platform}@${x.handle}[${x.source}]`).join(", ") || "none"} · candidates ${rec.candidates.map((c) => `${c.platform}@${c.handle}: ${c.outcome}`).join(" | ") || "none"}`);
  }
}
main().then(() => pool.end()).catch((e) => { console.error(e?.message ?? e); process.exit(1); });
