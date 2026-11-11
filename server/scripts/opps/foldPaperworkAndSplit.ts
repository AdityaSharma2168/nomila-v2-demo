/**
 * foldPaperworkAndSplit.ts — fold pseudo-deals that today's ingest would never mint (docs/design/brand-page-deals.md).
 *
 * ─── AUTO MODE (every athlete; no hand-picked ids) ──────────────────────────────────────────────────────────────
 *
 *   1. DRY-RUN (default; read-only session) — scan, write ONE JSON plan (+ .md) per athlete that has anything:
 *        npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --all [--env <path/.env>] [--out <dir>]
 *        npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --athlete <uuid> [--athlete <uuid> …] [--env …] [--out …]
 *        (also --athletes a,b,c and --ids-file <path>; see ../athleteSelection)
 *   2. REVIEW the plan file: each fold names the pseudo-deal, its thread and the real deal it folds into.
 *   3. APPLY one reviewed plan — one transaction for that athlete; re-plans first and refuses a stale plan:
 *        npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --apply <plan .json> [--env …] [--out …]
 *   UNDO an applied receipt (the .json --apply writes) — puts every prior value back:
 *        npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --undo <receipt .json> [--env …]
 *
 *   Detection reuses the live classifiers (./foldAutoCore): e-sign / payment pseudo-deals (#777) and calendar-invite
 *   threads that minted their own deal (#840), each next to a real deal with the same counterparty. No model call.
 *
 * ─── MANUAL MODE (the split is ALWAYS manual) ───────────────────────────────────────────────────────────────────
 *
 *   npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --athlete <uuid> --split-chain <provider thread id> [--brand <id>]
 *       [--apply] [--env <path/.env>] [--out <dir>]
 *   npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --athlete <uuid> --fold-invite <invite deal uuid> --into <target deal uuid>
 *       [--apply] [--env <path/.env>] [--out <dir>]
 *   npx tsx server/scripts/opps/foldPaperworkAndSplit.ts --athlete <uuid> --undo-invite-fold <applied plan .json> --apply
 *
 * DRY-RUN by default, READ-ONLY by construction (PGOPTIONS default_transaction_read_only=on, verified with SHOW
 * before anything runs). Manual mode writes a Markdown report and a JSON plan (with every prior value — the rollback
 * record) to --out (default reports/opps-fold). --apply needs the owner's OK: it folds pre-#777 e-sign pseudo-deals
 * into paperwork markers on the real deal and, with --split-chain, splits that folded-in chain into its own deal
 * (receipted, reversible from The Week). It never marks anything signed. Which folded-in chain is really a separate
 * pitch is a judgement, so the split is never auto-detected.
 *
 * --fold-invite: a calendar invite that became its own deal (before skills/meetings) is folded into --into as a
 * meeting ("Call · Mon 12 Oct, 11am" on the brand page); see ./foldInviteCore. Reversible with
 * --undo-invite-fold <the applied plan's .json>.
 *
 * Model calls: the folds call none. The split (--split-chain, --apply only) re-summarises the two threads it leaves
 * behind through skills/threadSummarizer — a model call — and the script WAITS for it before it closes the pool.
 */
import { config as loadEnv } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readOnlyPgOptions } from "./readOnly";
import { forEachAthlete, parseAthleteSelection, resolveAthletes, type AthleteSelection } from "../athleteSelection";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Auto mode: --all, --apply <plan.json>, --undo <receipt.json>, or athletes with none of the manual ids. */
function autoMode(): "plan" | "apply" | "undo" | null {
  if (has("--undo")) return "undo";
  const a = arg("--apply");
  if (a && !a.startsWith("--") && /\.json$/i.test(a)) return "apply";
  if (["--brand", "--split-chain", "--fold-invite", "--into", "--undo-invite-fold"].some(has)) return null;
  return ["--all", "--athlete", "--athletes", "--ids-file"].some(has) ? "plan" : null;
}

async function runAuto(mode: "plan" | "apply" | "undo"): Promise<void> {
  const outDir = resolve(arg("--out") ?? "reports/opps-fold");
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  let selection: AthleteSelection | null = null;
  if (mode === "plan") {
    if (has("--apply")) { console.error("auto mode: --apply takes a reviewed plan file (--apply <plan.json>); the dry-run comes first"); process.exit(2); }
    try { selection = parseAthleteSelection(argv); } catch (e: any) { console.error(e.message); process.exit(2); }
    // Read-only BEFORE anything loads server/db: node-postgres reads PGOPTIONS on every new connection.
    process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);
  }
  const core = await import("./foldAutoCore");
  const { db, pool } = await import("../../db");
  const { sql } = await import("drizzle-orm");
  try {
    mkdirSync(outDir, { recursive: true });
    if (mode === "undo") {
      const receipt = core.assertAutoFoldPlan(JSON.parse(readFileSync(resolve(arg("--undo")!), "utf8")), "undo");
      await core.undoAutoFold(db, receipt);
      console.log(core.renderAutoFold(receipt, "undo"));
      console.log(`\nundone for athlete ${receipt.athlete_id}.`);
      return;
    }
    if (mode === "apply") {
      const reviewed = core.assertAutoFoldPlan(JSON.parse(readFileSync(resolve(arg("--apply")!), "utf8")), "apply");
      const receipt = await core.applyAutoFold(db, reviewed);
      const base = join(outDir, `opps-autofold-apply-${receipt.athlete_id.slice(0, 8)}-${receipt.applied!.at.replace(/[:.]/g, "-")}`);
      writeFileSync(`${base}.json`, JSON.stringify(receipt, null, 2));
      const md = core.renderAutoFold(receipt, "apply");
      writeFileSync(`${base}.md`, md);
      console.log(md);
      console.log(`\nwrote receipt ${base}.json (undo: --undo ${base}.json)`);
      return;
    }
    const ro = await db.execute(sql`SHOW default_transaction_read_only`);
    const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
    if (value !== "on") { console.error(`refusing to run: the DB session is not read-only (${value || "?"})`); process.exit(1); }
    const ids = await resolveAthletes(db, selection!);
    console.log(`scanning ${ids.length} athlete(s), read-only…`);
    const outcomes = await forEachAthlete(ids, async (id) => {
      const plan = await core.planAutoFold(db, id);
      if (core.isEmptyPlan(plan)) return { plan, file: null as string | null };
      const base = join(outDir, `opps-autofold-dryrun-${id.slice(0, 8)}-${plan.generated_at.replace(/[:.]/g, "-")}`);
      writeFileSync(`${base}.json`, JSON.stringify(plan, null, 2));
      writeFileSync(`${base}.md`, core.renderAutoFold(plan, "dry-run"));
      return { plan, file: `${base}.json` as string | null };
    });
    for (const o of outcomes) {
      if (!o.ok) { console.log(`${o.athlete_id}: FAILED — ${o.error}`); continue; }
      const p = o.result!.plan;
      console.log(`${o.athlete_id}: paperwork ${p.paperwork.folds.length} (left alone ${p.paperwork.unresolved.length}) · invites ${p.invites.length} (left alone ${p.invite_unresolved.length})${o.result!.file ? `  → ${o.result!.file}` : "  (nothing to fold)"}`);
    }
    console.log("\ndry run: nothing written to the database. Review a plan, then apply it with --apply <plan.json> (owner's OK required).");
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const auto = autoMode();
  if (auto) return runAuto(auto);
  const athleteId = arg("--athlete") ?? "";
  const foldInvite = arg("--fold-invite") ?? null;
  const into = arg("--into") ?? null;
  const undoInvite = arg("--undo-invite-fold") ?? null;
  if (!UUID_RE.test(athleteId) || (foldInvite && (!UUID_RE.test(foldInvite) || !UUID_RE.test(into ?? ""))) || (undoInvite && !has("--apply"))) {
    console.error("usage: foldPaperworkAndSplit.ts --athlete <uuid> [--brand <id>] [--split-chain <id>] [--apply] [--env path] [--out dir]\n" +
      "       foldPaperworkAndSplit.ts --athlete <uuid> --fold-invite <deal uuid> --into <deal uuid> [--apply] [--env path] [--out dir]\n" +
      "       foldPaperworkAndSplit.ts --athlete <uuid> --undo-invite-fold <plan.json> --apply [--env path]");
    process.exit(2);
  }
  const apply = has("--apply");
  const brandId = arg("--brand") ? Number(arg("--brand")) : null;
  const splitChain = arg("--split-chain") ?? null;
  const outDir = resolve(arg("--out") ?? "reports/opps-fold");
  loadEnv({ path: resolve(arg("--env") ?? ".env") });
  if (!apply) process.env.PGOPTIONS = readOnlyPgOptions(process.env.PGOPTIONS);

  const { planFold, applyFold, renderFold } = await import("./foldPaperworkCore");
  const { db, pool } = await import("../../db");
  const { sql } = await import("drizzle-orm");
  try {
    if (!apply) {
      const ro = await db.execute(sql`SHOW default_transaction_read_only`);
      const value = String((ro as any).rows?.[0]?.default_transaction_read_only ?? "");
      if (value !== "on") { console.error(`refusing to run: the DB session is not read-only (${value || "?"})`); process.exit(1); }
    }
    if (foldInvite || undoInvite) {
      const { planInviteFold, applyInviteFold, undoInviteFold, renderInviteFold } = await import("./foldInviteCore");
      if (undoInvite) {
        const receipt = JSON.parse(readFileSync(resolve(undoInvite), "utf8"));
        if (receipt.athlete_id !== athleteId) { console.error("refusing: the receipt is for another athlete"); process.exit(1); }
        await undoInviteFold(db, receipt);
        console.log(renderInviteFold(receipt, "undo"));
        return;
      }
      const planned = await planInviteFold(db, athleteId, foldInvite!, into!);
      const plan = apply ? await applyInviteFold(db, planned) : planned;
      mkdirSync(outDir, { recursive: true });
      const base = join(outDir, `opps-fold-invite-${apply ? "apply" : "dryrun"}-${foldInvite!.slice(0, 8)}-${plan.generated_at.replace(/[:.]/g, "-")}`);
      writeFileSync(`${base}.json`, JSON.stringify(plan, null, 2));
      const md = renderInviteFold(plan, apply ? "apply" : "dry-run");
      writeFileSync(`${base}.md`, md);
      console.log(md);
      console.log(`\nwrote ${base}.md and ${base}.json`);
      if (!apply) console.log("dry run: nothing written. Re-run with --apply (owner's OK required) to write.");
      return;
    }
    const planned = await planFold(db, athleteId, { brandId, splitChain });
    const plan = apply ? await applyFold(db, planned) : planned;
    mkdirSync(outDir, { recursive: true });
    const base = join(outDir, `opps-fold-${apply ? "apply" : "dryrun"}-${athleteId.slice(0, 8)}-${plan.generated_at.replace(/[:.]/g, "-")}`);
    writeFileSync(`${base}.json`, JSON.stringify(plan, null, 2));
    const md = renderFold(plan, apply ? "apply" : "dry-run");
    writeFileSync(`${base}.md`, md);
    console.log(md);
    console.log(`\nwrote ${base}.md and ${base}.json`);
    if (!apply) console.log("dry run: nothing written. Re-run with --apply (owner's OK required) to write.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
