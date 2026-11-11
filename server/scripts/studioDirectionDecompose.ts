/**
 * studioDirectionDecompose — Lane C's eval THROUGH THE REAL ROUTE: POST /studio/direction/decompose-reference
 * on a running server (this worktree's, started by Adi), n runs per source, each checked against the
 * pre-registered prediction: 100 % of emitted lines inferred, a valid envelope, the decomposition in
 * references[0], and a url stored as her reference row (origin 'reference', the id in the header).
 *
 *   DOTENV_CONFIG_PATH=.env npx tsx --require dotenv/config server/scripts/studioDirectionDecompose.ts \
 *       --text "a soccer ad with me in it, calm and clean" --n 2 --label c-text     dry
 *   … --run                                                                         sends
 *   … --asset <one of her media_assets ids> --n 2 --label c-image --run
 *   … --url https://brand.example/look.jpg --run           a direct image, fetched + stored as her reference
 *
 * Spends one Flash call per run through PR 3's engine (≈ $0.0017–0.0022 measured) and nothing else — no
 * plan, no preview, no generation (the hard gate). The bearer token is read from probe-out/<dir>/.token
 * and never printed. Writes probe-out/<dir>/runs/<label>-<date>.json.
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
const LABEL = arg("label", "decompose");
const DIR = arg("dir", "probe-out/mila-direction");
const BASE = arg("base", "http://localhost:8080/api/v1/me");
const ROLE = arg("role", "style_reference");
const TEXT = arg("text", "");
const ASSET = arg("asset", "");
const URL_ = arg("url", "");
const PER_CALL_CEILING_USD = 0.003;

const source = URL_
  ? { kind: "url", url: URL_ }
  : ASSET
    ? { kind: "image", assetId: ASSET }
    : {
        kind: "text",
        text: TEXT || "a soccer ad with me in it, calm and clean",
      };
const body = { source, role: ROLE };

async function main(): Promise<void> {
  console.log(
    `decompose-reference ${JSON.stringify({ ...body, source: { ...source, text: (source as { text?: string }).text?.slice(0, 60) } })} × n=${N} → ceiling ≈ $${(N * PER_CALL_CEILING_USD).toFixed(3)}`,
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
    const res = await fetch(`${BASE}/studio/direction/decompose-reference`, {
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
    // A link she gave is stored as her reference row; the id says the marker landed (origin 'reference').
    const referenceAssetId = res.headers.get("x-studio-reference-asset-id");
    if (referenceAssetId)
      console.log(`  stored as her reference row ${referenceAssetId}`);
    const json = (await res.json().catch(() => null)) as
      | (BriefProposal & { error?: string; field?: string })
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
        error: json?.error ?? String(res.status),
      });
      continue;
    }
    const v = validateBriefProposal(json);
    const inferred = json.flags.filter((f) => f.basis === "inferred").length;
    const intent = json.brief.references[0]?.intent;
    const dims = intent ? Object.values(intent).filter(Boolean).length : 0;
    console.log(
      `  #${run}: valid ${v.ok} · lines ${json.flags.length} · inferred ${inferred}/${json.flags.length} · unflagged ${unflaggedPaths(json).length} · style ${json.brief.creative_direction.style} · tone ${JSON.stringify(json.brief.creative_direction.tone)} · energy ${json.brief.creative_direction.energy} · intent dims ${dims}/12 · $${costUsd ?? "?"} · ${ms} ms`,
    );
    if (json.extras.notes?.length)
      console.log(`      notes: ${json.extras.notes.join(" | ")}`);
    records.push({
      run,
      status: res.status,
      ms,
      costUsd,
      referenceAssetId,
      valid: v.ok,
      lines: json.flags.length,
      inferred,
      unflagged: unflaggedPaths(json),
      brief: json.brief,
      flags: json.flags,
      notes: json.extras.notes,
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
