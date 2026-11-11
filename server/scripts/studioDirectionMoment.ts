/**
 * studioDirectionMoment — Lane D's eval THROUGH THE REAL ROUTE: POST /studio/direction/research-moment on
 * a running server (this worktree's, started by Adi with STUDIO_DIRECTION_MOMENTS=true), n runs of one
 * ask, each checked against the pre-registered prediction: a valid envelope, every line inferred except
 * a Timing constraint that is HER date, no date anywhere the model could have put one, the sources the
 * provider's, the cost ≥ the search's own $0.035.
 *
 *   DOTENV_CONFIG_PATH=.env npx tsx --require dotenv/config server/scripts/studioDirectionMoment.ts \
 *       --ask "the next big women's soccer final" --n 2 --label d-moment       dry
 *   … --run                                                                  sends
 *   … --date "Saturday 4 Oct" --brand Adidas                                 her lines beside the ask
 *
 * Spends one grounded Flash call per run (≈ $0.035 + tokens ≈ $0.04) and nothing else — no plan, no
 * preview, no generation (the hard gate); the research lane's ledger is never touched. The bearer
 * token is read from probe-out/<dir>/.token and never printed. Writes probe-out/<dir>/runs/<label>-<date>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  unflaggedPaths,
  validateBriefProposal,
  type BriefProposal,
} from "../studio/direction/envelope";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const N = Number(arg("n", "2"));
const LABEL = arg("label", "moment");
const DIR = arg("dir", "probe-out/mila-direction");
const BASE = arg("base", "http://localhost:8080/api/v1/me");
const ASK = arg("ask", "the next big women's soccer final");
const BRAND = arg("brand", "");
const DATE = arg("date", "");
const PER_CALL_CEILING_USD = 0.05;
// Any timing signal the search could have supplied — a calendar date, a month-and-day, a bare year —
// scanned over what the PLAN reads (the brief, the concept, the constraints minus her own date).
const DATE_RE =
  /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:19|20)\d{2}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b)/i;

const body = {
  ask: ASK,
  ...(BRAND ? { brand: BRAND } : {}),
  ...(DATE ? { date: DATE } : {}),
};

async function main(): Promise<void> {
  console.log(
    `research-moment ${JSON.stringify(body)} × n=${N} → ceiling ≈ $${(N * PER_CALL_CEILING_USD).toFixed(3)}`,
  );
  if (!RUN) {
    console.log("dry — add --run to send");
    return;
  }
  const token = readFileSync(join(DIR, ".token"), "utf8").trim();
  const records: Record<string, unknown>[] = [];
  let spent = 0;
  for (let run = 1; run <= N; run++) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/studio/direction/research-moment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    const costUsd = Number(res.headers.get("x-studio-cost-usd") ?? "") || null;
    if (costUsd) spent += costUsd;
    const json = (await res.json().catch(() => null)) as
      | (BriefProposal & { error?: string })
      | null;
    if (res.status === 401) {
      console.log("token rejected — stopping");
      break;
    }
    if (res.status !== 200 || !json || json.error) {
      console.log(`  #${run}: ${res.status} ${json?.error ?? ""} (${ms} ms)`);
      records.push({
        run,
        status: res.status,
        ms,
        costUsd,
        error: json?.error ?? String(res.status),
      });
      continue;
    }
    const v = validateBriefProposal(json);
    const inferred = json.flags.filter((f) => f.basis === "inferred").length;
    const literal = json.flags.filter((f) => f.basis === "literal");
    const moment = json.extras.moment;
    const read = JSON.stringify({
      brief: json.brief,
      concept: json.extras.concept,
      constraints: json.extras.constraints,
    });
    // A timing signal the model could have put there, anywhere the plan reads, outside her own line.
    const strayDate = DATE_RE.test(DATE ? read.split(DATE).join("") : read);
    console.log(
      `  #${run}: valid ${v.ok} · lines ${json.flags.length} · inferred ${inferred} · literal ${literal.length} (${literal.map((f) => f.path).join(",") || "none"}) · unflagged ${unflaggedPaths(json).length} · dateBasis ${moment?.dateBasis} · stray date ${strayDate} · timing removed ${JSON.stringify(moment?.timingRemoved ?? [])} · sources ${moment?.sources.length} (${moment?.sources
        .map((s) => s.domain)
        .filter(Boolean)
        .join(
          ", ",
        )}) · queries ${moment?.searchQueries.length} · $${costUsd ?? "?"} · ${ms} ms`,
    );
    console.log(`      story: ${json.brief.story}`);
    console.log(
      `      tone: ${JSON.stringify(json.brief.creative_direction.tone)}`,
    );
    if (json.extras.concept)
      console.log(
        `      concept: ${json.extras.concept.angle} · ${json.extras.concept.feeling} · "${json.extras.concept.line}"`,
      );
    if (json.extras.notes?.length)
      console.log(`      notes: ${json.extras.notes.join(" | ")}`);
    records.push({
      run,
      status: res.status,
      ms,
      costUsd,
      valid: v.ok,
      lines: json.flags.length,
      inferred,
      literal: literal.map((f) => f.path),
      unflagged: unflaggedPaths(json),
      strayDate,
      brief: json.brief,
      flags: json.flags,
      extras: json.extras,
    });
  }
  mkdirSync(join(DIR, "runs"), { recursive: true });
  const out = join(
    DIR,
    "runs",
    `${LABEL}-${new Date().toISOString().slice(0, 10)}.json`,
  );
  writeFileSync(
    out,
    JSON.stringify(
      {
        label: LABEL,
        base: BASE,
        body,
        n: N,
        spentUsd: Number(spent.toFixed(4)),
        records,
      },
      null,
      2,
    ),
  );
  console.log(`\n≈ $${spent.toFixed(4)} by the route's own estimates → ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
