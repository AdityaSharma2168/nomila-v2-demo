/**
 * studioInterpreterPronoun — is the interpreter RELIABLE on the cross-clause pronoun class? (F-WB6)
 *
 * ─── THE QUESTION, AND WHY IT IS WORTH ASKING BEFORE ANYTHING DEPENDS ON THE ANSWER ─────────────
 *
 * F-WB6's sentence class — a brand compound, then a colour for "them" — now routes deterministically
 * (the resolver in studio/classify.ts and the freeze's `fromPronoun` branch). Before this branch, and
 * for every sentence the resolver does NOT reach, the answer is C2's interpreter: the ask is eligible
 * and the interpreter proposes. So "how often does the interpreter get THIS shape right" decides
 * whether an interpreter handoff is a sound floor under the deterministic path or a coin flip.
 *
 * Adi has run this class live and seen it work every time. The nondeterminism on record (ledger F-I5)
 * was measured on SCENE sentences, not this shape. This script confirms or refutes that, on the only
 * thing that can: n repeats of the same two sentences through the product transport.
 *
 * ⚠️ IT MEASURES THE INTERPRETER, NOT THE RESOLVER. `route()` is reported per sentence so it is always
 * visible whether the deterministic path already answers it — and on this branch it does, which is why
 * `--force` exists: the interpreter only ever sees an eligible ASK in production, so without it the
 * script would correctly refuse to send anything at all.
 *
 * DRY RUN IS THE DEFAULT: it prints each sentence, what route() does with it today, the prompt size,
 * the per-call quote and the total, and makes NO call and reads NO row.
 *
 *   npx tsx --require dotenv/config server/scripts/studioInterpreterPronoun.ts --force
 *   npx tsx --require dotenv/config server/scripts/studioInterpreterPronoun.ts --force --run --cap 0.05
 *
 * ⚠️ IT WRITES NO RECORDING. `studioInterpreterRecord.ts` owns interpret/fixtures/*.json, keyed by
 * PROMPT_VERSION, and a probe that quietly rewrote them would invalidate every replay test. This one
 * writes raw replies to `--out` and nothing else. READ-ONLY otherwise: one SELECT of the frame's path
 * under Adi's own athlete id, and a signed GCS read.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { route } from "../studio/classify";
import { probeBytesFor } from "../studio/autoMask";
import { displayTextEnabled, interpreterModel } from "../studio/config";
import { adPlan } from "../studio/interpret/ad";
import { propose, type MenuSwitches } from "../studio/interpret/core";
import { interpretableAsk } from "../studio/interpret/eligibility";
import { PROMPT_VERSION, interpreterPrompt } from "../studio/interpret/prompt";
import { recordedInput } from "../studio/interpret/recorded";
import {
  geminiTransport,
  type TransportUsage,
} from "../studio/interpret/transport";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
/** Send even though route() now answers these deterministically — see the header. */
const FORCE = flag("force");
const N = Number(arg("n", "5"));
const CAP_USD = Number(arg("cap", "0.05"));
/** R1's own figure, and it is an OVER-estimate: measured calls came in well under it. */
const QUOTE_PER_CALL_USD = 0.004;
/** Adi's own athlete row — the only one this touches, read-only. */
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
/** The Q1 frame: 1008x1476, the same frame R1 and R2 used. */
const FRAME_ID = arg("frame", "afc78262-f4ce-4637-bc26-658b5f63ca0e")!;
const OUT_DIR = arg(
  "out",
  "/Users/adi/nomila-v2-worktrees/tools/wb/out/pronoun",
)!;

const MENU: MenuSwitches = {
  text: !flag("text-off"),
  exclusion: !flag("exclusion-off"),
};

/** The two live forms. The stop form is the sentence acceptance raised; the and-joined form is its twin. */
const CELLS: { id: string; sentence: string }[] = [
  {
    id: "stop",
    sentence:
      "make my uniform, shoes and socks adidas. make them the color blue too.",
  },
  {
    id: "and",
    sentence: "make my uniform, shoes and socks adidas and make them blue",
  },
];

/** The garments a correct plan has to end up recolouring — her three nouns, however it words them. */
const GARMENTS = ["uniform", "shoe", "sock"];

async function frame(): Promise<{ bytes: Buffer; mimeType: string }> {
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { and, eq } = await import("drizzle-orm");
  // TENANCY: the athlete id is in the predicate, not checked after the fact.
  const [row] = await db
    .select({ path: mediaAssets.gcs_path })
    .from(mediaAssets)
    .where(
      and(eq(mediaAssets.id, FRAME_ID), eq(mediaAssets.athlete_id, ATHLETE_ID)),
    )
    .limit(1);
  if (!row?.path)
    throw new Error(`No stored pixels for ${FRAME_ID} under this athlete`);
  const probe = await probeBytesFor(row.path);
  if (!probe) throw new Error("The frame could not be read");
  return probe;
}

/**
 * What one reply did, in the terms the question is asked in.
 *
 * ⚠️ `verdict` IS MECHANICAL AND DELIBERATELY BLUNT. It reads the canonical sentence the interpreter
 * proposed, not the render: whether the colour is there, whether all three garments are, and whether
 * anything scene-shaped crept in. A "resolved" here means the PLAN is right — it says nothing about
 * what the image would look like, and every raw reply is saved so Adi can read them himself.
 */
function classify(canonical: string | null, kind: string, outcome?: string) {
  if (kind !== "proposal")
    return {
      verdict:
        kind === "new_image" ? "new_image" : `declined:${outcome ?? "?"}`,
      detail: "",
    };
  const c = (canonical ?? "").toLowerCase();
  const missing = GARMENTS.filter((g) => !c.includes(g));
  const colour = /\bblue\b/.test(c);
  const scene =
    /background|stadium|beach|field|lighting|golden hour|warmer|moodier/.test(
      c,
    );
  if (scene)
    return {
      verdict: "MISREAD:scene",
      detail: `scene words in the plan; missing ${missing.join("/") || "none"}`,
    };
  if (!colour)
    return {
      verdict: "MISREAD:no-colour",
      detail: `no "blue"; missing ${missing.join("/") || "none"}`,
    };
  if (missing.length)
    return { verdict: "PARTIAL:dropped", detail: `no ${missing.join("/")}` };
  return { verdict: "RESOLVED", detail: "colour + all three garments" };
}

async function main(): Promise<void> {
  const prepared = CELLS.map((c) => ({
    ...c,
    input: recordedInput(c.sentence, {
      attached: { objects: 0 },
      brand: null,
      menu: MENU,
      swapTo: null,
      competitors: [],
      category: null,
    }),
    today: route(c.sentence, true, { objects: 0 }),
  }));

  const eligible = prepared.filter(
    (p) => p.today.initialPath === "ASK" && interpretableAsk(p.today.reason),
  );
  const calls = (FORCE ? prepared.length : eligible.length) * N;

  console.log(
    `F-WB6 interpreter reliability — ${PROMPT_VERSION}, ${interpreterModel()}, ` +
      `menu text=${MENU.text} exclusion=${MENU.exclusion} ` +
      `(STUDIO_DISPLAY_TEXT=${displayTextEnabled() ? "true" : "off"}).`,
  );
  console.log(
    `n=${N} per sentence · ${calls} calls · quote ~$${(calls * QUOTE_PER_CALL_USD).toFixed(4)} ` +
      `at $${QUOTE_PER_CALL_USD}/call (R1's over-estimate) · cap $${CAP_USD} · ` +
      `${RUN ? "LIVE." : "DRY RUN — no call, no row read."}`,
  );
  for (const p of prepared) {
    const fate =
      p.today.initialPath !== "ASK"
        ? `ROUTES today (${p.today.steps.map((s) => s.op).join("+")}) — production never sends it${FORCE ? "; --force sends anyway" : "; skipped"}`
        : interpretableAsk(p.today.reason)
          ? `asks ${p.today.reason} — eligible, sent`
          : `asks ${p.today.reason} — not eligible, never sent`;
    console.log(`  [${p.id}] ${p.sentence}`);
    console.log(
      `        ${fate} · prompt ${interpreterPrompt(p.input).length} chars`,
    );
  }
  if (!FORCE && !eligible.length) {
    console.log(
      "\nNothing to send: both sentences route deterministically on this branch, which is F-WB6's " +
        "whole point. Pass --force to measure the interpreter on them anyway.",
    );
    return;
  }
  if (!RUN) return;

  const image = await frame();
  await mkdir(OUT_DIR, { recursive: true });
  const rows: unknown[] = [];
  const tally: Record<string, number> = {};
  let spent = 0;

  for (const p of FORCE ? prepared : eligible) {
    for (let i = 1; i <= N; i++) {
      if (spent + QUOTE_PER_CALL_USD > CAP_USD) {
        console.log(
          `BUDGET STOP before ${p.id}#${i}: ~$${spent.toFixed(4)} estimated, cap $${CAP_USD}.`,
        );
        break;
      }
      const started = Date.now();
      let text: string;
      let usage: TransportUsage | null;
      try {
        const r = await geminiTransport({
          prompt: interpreterPrompt(p.input),
          image,
        });
        text = r.text;
        usage = r.usage;
      } catch (err) {
        // Vertex's WHOLE answer: the field that failed is in it, and a cut message is how that gets lost.
        console.log(
          `  ${p.id}#${i} CALL FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        tally["call_failed"] = (tally["call_failed"] ?? 0) + 1;
        continue;
      }
      const ms = Date.now() - started;
      spent += usage
        ? usage.inputTokens * 0.3e-6 + usage.outputTokens * 2.5e-6
        : QUOTE_PER_CALL_USD;
      const out = propose(p.input, text, adPlan);
      const canonical = out.kind === "proposal" ? out.canonical : null;
      const { verdict, detail } = classify(
        canonical,
        out.kind,
        out.kind === "ask" ? out.outcome : undefined,
      );
      tally[verdict] = (tally[verdict] ?? 0) + 1;
      rows.push({
        id: p.id,
        run: i,
        verdict,
        detail,
        kind: out.kind,
        canonical,
        ms,
        usage,
        raw: text,
      });
      console.log(
        `  ${p.id}#${i} ${String(ms).padStart(5)}ms ${verdict.padEnd(18)} ${canonical ?? detail}`,
      );
    }
  }

  await writeFile(
    join(OUT_DIR, "replies.json"),
    JSON.stringify(rows, null, 2),
    "utf8",
  );
  console.log(`\nTALLY ${JSON.stringify(tally)}`);
  console.log(
    `~$${spent.toFixed(4)} estimated · ${rows.length} replies · ${join(OUT_DIR, "replies.json")}`,
  );
  console.log(
    "RESOLVED = the plan carries the colour and all three garments. Every raw reply is saved; the " +
      "verdicts are mechanical and the read is Adi's.",
  );
}

void main();
