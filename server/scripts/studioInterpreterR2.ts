/**
 * studioInterpreterR2 — R2: measure what the interpreter would SEND, before it is allowed to propose it
 * (the interpreter, I.3; plan v1 §7 "R2", v2 §5/§6, C-8; M4's engineering gate).
 *
 * Two questions, both about the model tier, each on the Q1 frame (Nike jersey, socks and cleats):
 *
 *   EXCLUSION   sentence 4's C with `exclude_marks { nike }` — "DO NOT: show a Nike logo anywhere in the
 *               photograph." Is ANY Nike mark left anywhere, socks included? Did anything else change?
 *               Fails → that clause asks until it is fixed (the menu's `exclusion` switch stays off).
 *   HEADLINE    a headline beside kit swaps (cell 1a's shape) — is it legible and spelled right, run after
 *               run (C-8)? Garbled → STUDIO_DISPLAY_TEXT stays off and ads ship hero-only.
 *
 * The cells are compiled by the PRODUCT path — the real classifier and freeze over C, the constraints
 * riding as a version 2 intent, the real compile tier (studio/compile) — and run through `runGeneration`
 * exactly as a spend would, minus the rows: no preview, no job, no asset written. So R2 measures the
 * prompt the interpreter will send, not a hand-written one.
 *
 *   r2-exclusion   sentence 4's C + exclude_marks{nike}                                  n=2
 *   r2-headline    cell 1a's C (three adidas swaps + "OWN THE MOMENT") + preserve_person  n=2
 *   r2-combined    sentence 4's C + "OWN THE MOMENT" + exclude_marks{nike}               n=2 — both questions
 *                  in the same two images, and text inside a three-change call (F-C's open reach)
 *
 * DRY RUN IS THE DEFAULT: every cell prints its compiled prompt and its quote, and nothing is sent and no
 * row is read. `--run --cell <id>` spends, under `--cap`.
 *
 *   npx tsx --require dotenv/config server/scripts/studioInterpreterR2.ts
 *   npx tsx --require dotenv/config server/scripts/studioInterpreterR2.ts --run --cell r2-combined --cap 0.35
 *
 * The verdicts are Adi's, at 1:1, on the saved outputs.
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { estimate } from "../studio/router";
import { routeFor, vertexModelFor, MODELS } from "../studio/config";
import { freezeEditIntent } from "../studio/nativeIntent";
import type { EditConstraint } from "../studio/nativeEdit";
import { plannedInputs, runGeneration } from "../studio/preview";
import type { AthleteHalf, CreativeBrief, SourceAsset } from "../studio/brief";

// ─── CLI ────────────────────────────────────────────────────────────────────────────────────────

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RUN = flag("run");
const CELL = arg("cell");
const CAP_USD = Number(arg("cap", "0.35"));
const N = Number(arg("n", "2"));
/** Adi's own athlete row — the only one this touches (read-only). */
const ATHLETE_ID = arg("athlete", "3811cedd-ec59-44b0-b613-b39d03f9d5ca")!;
/** The Q1 frame: 1008x1476. */
const FRAME_ID = arg("frame", "afc78262-f4ce-4637-bc26-658b5f63ca0e")!;
const OUT_DIR = arg("out", "probe-out/interpreter-r2")!;

// ─── The cells ──────────────────────────────────────────────────────────────────────────────────

const C4 =
  "change my uniform to a black adidas uniform, and change my cleats to pink adidas cleats";
const C4_HEADLINE =
  'change my uniform to a black adidas uniform, change my cleats to pink adidas cleats, and add the headline "OWN THE MOMENT" across the top';
const C1A =
  'change my jersey to an adidas jersey, change my socks to adidas socks, change my cleats to adidas cleats, and add the headline "OWN THE MOMENT" across the top';

interface Cell {
  id: string;
  canonical: string;
  constraints: EditConstraint[];
  headline: boolean;
  question: string;
}

const CELLS: Cell[] = [
  {
    id: "r2-exclusion",
    canonical: C4,
    constraints: [{ kind: "exclude_marks", brand: "nike" }],
    headline: false,
    question:
      "Any Nike mark left ANYWHERE — socks included? Anything changed beyond the uniform and the cleats?",
  },
  {
    id: "r2-headline",
    canonical: C1A,
    constraints: [{ kind: "preserve_person" }],
    headline: true,
    question:
      "Is OWN THE MOMENT legible and spelled right? Are her face, hair, body and pose held? Is her kit adidas?",
  },
  {
    id: "r2-combined",
    canonical: C4_HEADLINE,
    constraints: [{ kind: "exclude_marks", brand: "nike" }],
    headline: true,
    question:
      "Any Nike mark left ANYWHERE? Is OWN THE MOMENT legible and spelled right? Anything else changed?",
  },
];

// ─── Material — READ ONLY ───────────────────────────────────────────────────────────────────────

/** A synthetic athlete half: nothing about a real person reaches this brief. */
const ATHLETE: AthleteHalf = {
  athleteId: ATHLETE_ID,
  identity: {
    name: "R2",
    firstName: "R2",
    identityLine: "Soccer",
    sport: "soccer",
    org: "",
    division: null,
    conference: null,
    segment: null,
    marqueeTag: null,
  },
  voice: { storyArc: "", highlights: [] },
  audience: {
    descriptor: "",
    ageRange: null,
    topCity: null,
    topMarket: null,
    share: null,
  },
  aesthetic: { register: "", notes: [] },
  goal: "",
  commercialState: "none",
};

async function frame(): Promise<{
  source: SourceAsset;
  bytes: Buffer;
  mimeType: string;
}> {
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { and, eq } = await import("drizzle-orm");
  const { signedUrl } = await import("../lib/mediaStore");
  const { probeImageSize } = await import("../studio/imageSize");
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
  const size = await probeImageSize(row.path);
  if (!size) throw new Error("The frame's dimensions could not be read");
  const res = await fetch(await signedUrl(row.path));
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  // Upright, because the model ignores EXIF (studio/orient.ts measured it).
  const upright = await sharp(Buffer.from(await res.arrayBuffer()))
    .rotate()
    .jpeg({ quality: 95 })
    .toBuffer();
  return {
    source: {
      mediaAssetId: FRAME_ID,
      ref: row.path,
      width: size.width,
      height: size.height,
      orientation: size.orientation,
      editRegions: [],
    },
    bytes: upright,
    mimeType: "image/jpeg",
  };
}

/** The brief a spend would carry for this cell: C as the statement, the intent frozen from C. */
function briefFor(cell: Cell, source: SourceAsset): CreativeBrief {
  const saved = process.env.STUDIO_DISPLAY_TEXT;
  if (cell.headline) process.env.STUDIO_DISPLAY_TEXT = "true";
  try {
    const frozen = freezeEditIntent({
      ask: cell.canonical,
      origin: "system",
      source,
      references: [],
      constraints: cell.constraints,
    });
    if (!frozen.ok)
      throw new Error(`${cell.id}: C did not freeze — ${frozen.reason}`);
    return {
      briefId: `r2-${cell.id}`,
      createdAt: new Date().toISOString(),
      job: {
        origin: "system",
        objective: "concept",
        deliverable: "post",
        mode: "edit",
        source,
        direction: {
          set: "chosen",
          statement: cell.canonical,
          untrusted: false,
          featuredPieces: [],
        },
        references: [],
        editIntent: frozen.intent,
      },
      athlete: ATHLETE,
      brand: null,
      gaps: [],
    };
  } finally {
    if (saved === undefined) delete process.env.STUDIO_DISPLAY_TEXT;
    else process.env.STUDIO_DISPLAY_TEXT = saved;
  }
}

/** The shipped edit model, or no spend — a local override would measure a different model (Q6's rule). */
function assertShippedEditModel(): void {
  const r = routeFor("image.edit");
  const model = vertexModelFor(MODELS.nanoPro);
  if (r.provider !== "vertex" || r.model !== model) {
    throw new Error(
      `image.edit resolves to ${r.model} via ${r.provider}, not the shipped ${model} via vertex. Refusing to spend.`,
    );
  }
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const chosen = CELL ? CELLS.filter((c) => c.id === CELL) : CELLS;
  if (CELL && !chosen.length)
    throw new Error(
      `No cell "${CELL}". Cells: ${CELLS.map((c) => c.id).join(", ")}`,
    );
  if (RUN && !CELL)
    throw new Error("--run needs --cell: R2 spends one cell at a time.");

  // A dry run compiles against the Q1 frame's measured shape and reads no row.
  const dry: SourceAsset = {
    mediaAssetId: FRAME_ID,
    ref: "athletes/…/q1-frame.png",
    width: 1008,
    height: 1476,
    editRegions: [],
  };
  const material = RUN ? await frame() : null;
  if (RUN) assertShippedEditModel();

  let spent = 0;
  for (const cell of chosen) {
    const brief = briefFor(cell, material?.source ?? dry);
    const { inputs, task } = plannedInputs(brief);
    const plan = estimate("image.edit", inputs, {});
    console.log(`\n── ${cell.id}  n=${N}`);
    console.log(`   C        ${cell.canonical}`);
    console.log(
      `   frozen   version ${brief.job.editIntent?.version}, constraints ${JSON.stringify(brief.job.editIntent?.constraints ?? [])}`,
    );
    console.log(
      `   task     ${task}   aspect ${inputs.aspectRatio ?? "(none)"}   model ${plan.model} via ${plan.provider}`,
    );
    console.log(
      `   prompt\n${inputs.prompt
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")}`,
    );
    console.log(
      `   quote    $${plan.cost.amountUsd.toFixed(4)} each, $${(plan.cost.amountUsd * N).toFixed(4)} for n=${N}`,
    );
    console.log(`   verdict  ${cell.question}`);
    if (!RUN || !material) {
      console.log("   DRY RUN — no call made.");
      continue;
    }
    await mkdir(OUT_DIR, { recursive: true });
    for (let i = 1; i <= N; i++) {
      if (spent + plan.cost.amountUsd > CAP_USD) {
        console.log(
          `   BUDGET STOP before run ${i}: $${spent.toFixed(4)} spent, cap $${CAP_USD}.`,
        );
        return;
      }
      const res = await runGeneration(brief, {
        resolveReference: () => ({
          kind: "bytes",
          bytes: material.bytes,
          mimeType: material.mimeType,
        }),
      });
      spent += res.cost.amountUsd;
      const asset = res.assets[0];
      if (!asset?.bytes)
        throw new Error(`${cell.id} run ${i}: no bytes came back`);
      const ext = (asset.mimeType.split("/")[1] ?? "png").replace(
        "jpeg",
        "jpg",
      );
      const out = join(OUT_DIR, `${cell.id}-${i}.${ext}`);
      await writeFile(out, asset.bytes);
      console.log(
        `   run ${i}    $${res.cost.amountUsd.toFixed(4)} (${res.cost.basis})  ${res.timings.ms}ms  → ${out}`,
      );
    }
  }
  if (RUN)
    console.log(`\nSpent $${spent.toFixed(4)}. Verdicts are Adi's, at 1:1.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
