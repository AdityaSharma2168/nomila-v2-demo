/**
 * studio/qa/corpus — read the assembled calibration corpus off disk.
 *
 * `scripts/studioQaFixtures.ts` puts it there; this reads it back. Split because the puller needs a
 * database and the readers must not: the calibration probe and the acceptance run open image files
 * and nothing else, so neither can accidentally depend on the proxy being up, and neither can
 * accidentally write.
 *
 * Files are named by the DOCUMENT's id prefix, not the asset id, so a reader holding a sweep cell
 * can find its picture without re-resolving anything. `manifest.json` carries the mapping between
 * the two for anyone who needs the real asset id.
 */
import { readdir, readFile } from "fs/promises";
import { join } from "path";

import type { LabeledOutput } from "./labeledSet";

export const FIXTURE_ROOT = process.env.STUDIO_QA_FIXTURE_DIR ?? "qa-fixtures";

export interface LoadedImage {
  bytes: Buffer;
  mimeType: string;
  path: string;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Directory listings, cached — the acceptance run asks for the same directories ~40 times. */
const listings = new Map<string, string[]>();
async function list(dir: string): Promise<string[]> {
  const hit = listings.get(dir);
  if (hit) return hit;
  let names: string[] = [];
  try {
    names = await readdir(join(FIXTURE_ROOT, dir));
  } catch {
    names = [];
  }
  listings.set(dir, names);
  return names;
}

async function loadByPrefix(
  dir: string,
  shortId: string,
): Promise<LoadedImage | null> {
  const names = await list(dir);
  const hit = names.find((n) => n.startsWith(shortId + "."));
  if (!hit) return null;
  const path = join(FIXTURE_ROOT, dir, hit);
  const ext = hit.split(".").pop()?.toLowerCase() ?? "";
  return {
    bytes: await readFile(path),
    mimeType: MIME[ext] ?? "image/jpeg",
    path,
  };
}

async function loadByPath(rel: string): Promise<LoadedImage | null> {
  const path = join(FIXTURE_ROOT, rel);
  try {
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    return {
      bytes: await readFile(path),
      mimeType: MIME[ext] ?? "image/jpeg",
      path,
    };
  } catch {
    return null;
  }
}

/** A source frame, by the `src` id the documents print. */
export function loadSource(shortId: string): Promise<LoadedImage | null> {
  return loadByPrefix("sources", shortId);
}

/**
 * The picture a labeled row names — from the DB-backed outputs directory, or from the probe/q5
 * files that were never in the database at all.
 */
export async function loadOutput(
  o: LabeledOutput,
): Promise<LoadedImage | null> {
  if (o.outputFile) return loadByPath(o.outputFile);
  if (o.outputId) return loadByPrefix("outputs", o.outputId);
  return null;
}

/**
 * Both halves of one comparison, or null if either is missing.
 *
 * The source is the row's OWN source. Chained-edit drift is a property of the live path, where the
 * chain root is walked through `derived_from_asset_id`; nothing in this corpus is a chained edit —
 * every row is one edit on one frame — so here the row's source IS the chain root.
 */
export async function loadPair(
  o: LabeledOutput,
): Promise<{ source: LoadedImage; output: LoadedImage } | null> {
  if (!o.sourceId) return null;
  const [source, output] = await Promise.all([
    loadSource(o.sourceId),
    loadOutput(o),
  ]);
  return source && output ? { source, output } : null;
}
