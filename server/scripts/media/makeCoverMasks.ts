/**
 * makeCoverMasks — body masks for an athlete's COVER candidates only (not the whole library), for the cover cut-out
 * (lib/photoTreat "cutout", behind PHOTO_CUTOUT_V1). Runs rembg's BiRefNet-lite on THIS machine's CPU ($0, ~6 s a photo)
 * and stores each mask at photoTreat.maskPath(source), where the treatment step looks for it.
 *
 * Why a script and not the server: rembg is Python with a ~200 MB model; it does not belong in the Node API image. When
 * the cut-out earns its keep, this moves to a small Cloud Run job (the render service pattern).
 *
 *   npx tsx server/scripts/media/makeCoverMasks.ts --athlete <id> [--top 5] [--apply]
 *
 * Dry run by default (lists the candidates). Needs Python with rembg (pip install "rembg[cpu]").
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { searchMedia } from "../../services/mediaSearch";
import { CAST_MIN_QUALITY } from "../../services/curator";
import { maskPath } from "../../lib/photoTreat";
import { headObject, readObject, uploadLocalFile } from "../../lib/mediaStore";
import { pool } from "../../db";

// rembg's Python API (its CLI needs extra packages): only the mask, at most 1600 px on the long edge.
const REMBG_PY = "import sys; from PIL import Image; from rembg import new_session, remove; im = Image.open(sys.argv[1]).convert('RGB'); im.thumbnail((1600, 1600)); remove(im, session=new_session('birefnet-general-lite'), only_mask=True).save(sys.argv[2])";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const athleteId = arg("athlete");
  if (!athleteId) throw new Error("--athlete <id> is required");
  const top = Number(arg("top") ?? 5);
  const apply = process.argv.includes("--apply");
  // The cover brief's own kind of photo: a portrait of her facing the camera.
  const res = await searchMedia(athleteId, {
    brief: "confident hero portrait of the athlete facing the camera", purpose: "hero", diverse: true, k: top,
    filters: { athletePresent: true, onlyHer: true, noBurnedText: true, noPromo: true, includeFrames: true, minQuality: CAST_MIN_QUALITY, needFace: true },
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "masks-"));
  let made = 0, skipped = 0;
  for (const r of res) {
    const dest = maskPath(r.gcsPath);
    if (await headObject(dest)) { skipped++; console.log(`exists  ${r.gcsPath}`); continue; }
    if (!apply) { console.log(`would   ${r.gcsPath}`); continue; }
    const src = await readObject(r.gcsPath, 40_000_000);
    if (!src) { console.log(`missing ${r.gcsPath}`); continue; }
    const inFile = path.join(tmp, `in-${made}.jpg`), outFile = path.join(tmp, `mask-${made}.png`);
    fs.writeFileSync(inFile, src.buf);
    execFileSync("python", ["-c", REMBG_PY, inFile, outFile], { stdio: "ignore" });
    await uploadLocalFile(outFile, dest, "image/png");
    made++;
    console.log(`made    ${r.gcsPath}`);
  }
  console.log(JSON.stringify({ athleteId, candidates: res.length, made, skipped, apply }));
}

main().then(() => pool.end()).catch(async (e) => { console.error(e?.message ?? e); await pool.end(); process.exit(1); });
