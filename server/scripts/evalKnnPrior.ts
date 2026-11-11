/**
 * evalKnnPrior.ts — does the nearest-neighbour prior actually work, before it is allowed
 * anywhere near the ingestion path?
 *
 * Leave-one-out over a SYNTHETIC labelled fixture: embed every labelled row, then for each row in
 * turn hide it and ask the remaining rows to classify it. That is the honest measure on a
 * small set — a train/test split of 48 rows would be measuring the split, not the method.
 *
 * It sweeps model × k × threshold and prints the grid, because every one of those was a
 * guess when the layer was written and none of them should stay a guess. In particular:
 *   · absolute cosine is compressed with these models, so a threshold that reads high
 *     (0.8) may be unreachable and one that reads low (0.5) may be reckless;
 *   · k too small overfits a single near-duplicate, k too large drowns a real signal in
 *     an imbalanced corpus (real inboxes are mostly junk).
 *
 * The number that decides deployment is PRECISION ON THE JUNK CALL: of the mails this
 * layer would file on its own, how many were really junk. A false positive here hides a
 * real deal, which is the one outcome the whole system is built to avoid, so the bar is
 * higher than for the classifier itself.
 *
 *   npx tsx --require dotenv/config server/scripts/evalKnnPrior.ts
 *   ... --fixture <path>   default the synthetic classifier-eval.dev.jsonl
 *
 * Fixtures are synthetic only. Real Gmail content is never written to a file, a corpus
 * or an eval set (Google API Limited Use) — there is no harvest of real decisions.
 */

import fs from "node:fs";
import path from "node:path";
import { corpusText, embedDealTexts, knnPrior, type CorpusRow } from "../lib/dealEmbed";

const fIdx = process.argv.indexOf("--fixture");
const FIXTURE = fIdx >= 0
  ? process.argv[fIdx + 1]
  : path.join("server", "skills", "__fixtures__", "classifier-eval.dev.jsonl");

const MODELS = (process.env.DEAL_EMBED_MODELS ?? "text-embedding-004,text-multilingual-embedding-002")
  .split(",").map((s: string) => s.trim()).filter(Boolean);
const KS = [3, 5, 7, 9];
const THRESHOLDS = [0.55, 0.65, 0.75, 0.85];

type Row = { id: string; from: string; subject: string; body: string; isDeal: boolean };

function load(): Row[] {
  const out: Row[] = [];
  for (const line of fs.readFileSync(FIXTURE, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    try {
      const o = JSON.parse(t);
      out.push({
        id: o.id,
        from: o.from ?? "",
        subject: o.subject ?? "",
        body: o.body ?? "",
        isDeal: !(o.label?.category === "NOISE" || o.label?.is_deal === false),
      });
    } catch { /* skip a malformed line rather than fail the sweep */ }
  }
  return out;
}

async function main() {
  const rows = load();
  const deals = rows.filter((r) => r.isDeal).length;
  console.log(`Corpus: ${rows.length} rows — ${deals} deal / ${rows.length - deals} junk`);
  console.log(`Fixture: ${FIXTURE}\n`);

  if (rows.length < 10) {
    console.log("Too few rows to evaluate. Add synthetic rows to the fixture first.");
    return;
  }

  for (const model of MODELS) {
    const texts = rows.map((r) => corpusText(r));
    const vecs = await embedDealTexts(texts, model);
    const usable = rows
      .map((r, i) => ({ r, v: vecs[i] }))
      .filter((x): x is { r: Row; v: number[] } => Array.isArray(x.v) && x.v.length > 0);

    if (usable.length < rows.length) {
      console.log(`  ${model}: ${rows.length - usable.length} row(s) failed to embed`);
    }
    if (!usable.length) { console.log(`  ${model}: no embeddings — skipping\n`); continue; }

    console.log(`── ${model} (dims ${usable[0].v.length}) ──`);
    console.log("   k  thresh   junk-calls  precision   recall   (of junk correctly filed)");

    for (const k of KS) {
      for (const thresh of THRESHOLDS) {
        let called = 0, correct = 0;
        const junkTotal = usable.filter((u) => !u.r.isDeal).length;

        for (let i = 0; i < usable.length; i++) {
          // Leave one out: this row must not vote on itself.
          const corpus: CorpusRow[] = usable
            .filter((_, j) => j !== i)
            .map((u) => ({ id: u.r.id, isDeal: u.r.isDeal, category: "", embedding: u.v }));

          const prior = knnPrior(usable[i].v, corpus, k);
          if (!prior) continue;
          if (prior.junkScore >= thresh) {
            called++;
            if (!usable[i].r.isDeal) correct++;
          }
        }

        const precision = called ? (correct / called) * 100 : 0;
        const recall = junkTotal ? (correct / junkTotal) * 100 : 0;
        const flag = called && precision === 100 ? "  <-- no real deal harmed" : "";
        console.log(
          `  ${String(k).padStart(2)}  ${thresh.toFixed(2)}   ${String(called).padStart(9)}` +
          `   ${precision.toFixed(1).padStart(7)}%  ${recall.toFixed(1).padStart(6)}%${flag}`,
        );
      }
    }
    console.log("");
  }

  console.log("Read PRECISION first: anything under 100% means this layer would have");
  console.log("hidden a real deal on its own. Recall is how much LLM cost it saves.");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
