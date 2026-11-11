/**
 * studioGenerate — drive the Studio generation router from the command line.
 *
 * Wave 1 has no product surface, so this is how a generation is exercised end to end.
 * DRY RUN IS THE DEFAULT: it prints the resolved plan and the estimated cost and makes no billable
 * call. You have to pass --run to actually spend money.
 *
 *   npx tsx --require dotenv/config server/scripts/studioGenerate.ts \
 *     --task image.generate --prompt "her, mid-stride, hard evening light"
 *
 *   npx tsx --require dotenv/config server/scripts/studioGenerate.ts \
 *     --task image.edit --prompt "reframe, subject centred" --ref <assetId|https url> --run
 *
 *   npx tsx --require dotenv/config server/scripts/studioGenerate.ts \
 *     --task video.generate --prompt "..." --duration 6 --run
 *
 * --ref accepts a media_assets UUID (read-only lookup, signed via mediaStore) or a plain URL.
 * Output bytes are written to --out (default ./studio-out) — nothing is written to the DB or GCS.
 */
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { generate, estimate } from "../studio/router";
import type { GenerationInputs, GenerationTask, ImageRef } from "../studio/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function args(name: string): string[] {
  return process.argv.reduce<string[]>((acc, v, i) => (v === `--${name}` && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc), []);
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function resolveRef(ref: string): Promise<ImageRef> {
  if (!UUID_RE.test(ref)) return { kind: "url", url: ref };
  // A media_assets id → its durable path → a short-lived signed read url. Read-only.
  const { db } = await import("../db");
  const { mediaAssets } = await import("../../shared/schema");
  const { eq } = await import("drizzle-orm");
  const { signedUrl } = await import("../lib/mediaStore");
  const [row] = await db.select({ path: mediaAssets.gcs_path, thumb: mediaAssets.gcs_thumb_path })
    .from(mediaAssets).where(eq(mediaAssets.id, ref)).limit(1);
  const path = row?.thumb ?? row?.path;
  if (!path) throw new Error(`No stored pixels for asset ${ref}`);
  return { kind: "url", url: await signedUrl(path) };
}

async function main(): Promise<void> {
  const task = (arg("task") ?? "image.generate") as GenerationTask;
  const prompt = arg("prompt");
  if (!prompt) throw new Error('--prompt is required (e.g. --prompt "her, mid-stride")');

  const inputs: GenerationInputs = {
    prompt,
    references: await Promise.all(args("ref").map(resolveRef)),
    n: arg("n") ? Number(arg("n")) : undefined,
    seed: arg("seed") ? Number(arg("seed")) : undefined,
    aspectRatio: arg("aspect"),
    width: arg("width") ? Number(arg("width")) : undefined,
    height: arg("height") ? Number(arg("height")) : undefined,
    durationSeconds: arg("duration") ? Number(arg("duration")) : undefined,
  };

  const plan = estimate(task, inputs, { model: arg("model") });
  console.log("\nPLAN");
  console.log(`  task      ${plan.task}`);
  console.log(`  provider  ${plan.provider}`);
  console.log(`  model     ${plan.model}`);
  console.log(`  refs      ${plan.inputs.references}`);
  console.log(`  cost      ${plan.cost.unpriced ? "unknown (no configured price)" : `$${plan.cost.amountUsd}`}  [${plan.cost.basis}] ${plan.cost.detail ?? ""}`);

  if (!flag("run")) {
    console.log("\nDry run — no call made. Pass --run to generate for real.\n");
    return;
  }

  console.log("\nGenerating…");
  const res = await generate(task, inputs, {
    model: arg("model"),
    onProgress: (e) => console.log(`  [${Math.round(e.elapsedMs / 1000)}s] ${e.status}${e.jobId ? ` (${e.jobId})` : ""}`),
  });

  const outDir = arg("out") ?? "studio-out";
  await mkdir(outDir, { recursive: true });
  for (const [i, a] of res.assets.entries()) {
    if (a.bytes) {
      const ext = (a.mimeType.split("/")[1] ?? "bin").replace("jpeg", "jpg");
      const f = join(outDir, `${Date.now()}-${i}.${ext}`);
      await writeFile(f, a.bytes);
      console.log(`  wrote ${f} (${a.bytes.byteLength} bytes)`);
    } else if (a.url) {
      console.log(`  url   ${a.url}`);
    }
  }
  console.log(`\n  cost  $${res.cost.amountUsd} [${res.cost.basis}]   ${res.timings.ms}ms\n`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(`\n${err?.message ?? err}\n`); process.exit(1); });
