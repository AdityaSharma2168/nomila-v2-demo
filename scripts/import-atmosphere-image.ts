/**
 * import-atmosphere-image.ts — add ONE hand-picked Unsplash or Pexels photo to the shared atmosphere library (0120;
 * DESIGN.md §9). The same pipeline as scripts/fill-atmosphere-library.ts (download — Unsplash's normal download
 * URL, Unsplash+ refused, or Pexels' image CDN directly — 1600 px WebP, check, store at
 * atmosphere/shared/<group>/<id>.webp, record), for a single photo given by flags.
 *
 * Before running: open the photo's page (unsplash.com/photos/<slug> or pexels.com/photo/<slug>-<id>) and confirm it
 * says "Free to use under the Unsplash License" (not Unsplash+) or is a Pexels photo page (always free); note the
 * photographer for our records.
 *
 * Usage (DEV only; a dry run by default — it writes nothing without --apply):
 *   npx tsx --require dotenv/config scripts/import-atmosphere-image.ts \
 *     --page https://unsplash.com/photos/<slug> --category sport --sport <id from the onboarding grid> \
 *     --purposes performance,audience --tags "pool,lanes,water" --photographer "Name" \
 *     --photographer-url https://unsplash.com/@handle [--title "what is in it"] \
 *     [--apply --reviewed-by "Name" | --apply --check model --max-usd 0.05] [--curated] [--out-dir ./atmo]
 * --category is sport | general | signin; --sport only for sport; --purposes from LIBRARY_PURPOSES. --page may be an
 * Unsplash or a Pexels page; the licence is filled in from the page's source, never passed by flag.
 */
import { basename } from "node:path";
import { LICENCE_BY_SOURCE, sourceOf } from "../server/services/atmosphere/library";
import { parseArgs, run } from "./fill-atmosphere-library";

function entryFrom(argv: string[]): Record<string, unknown> {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const list = (k: string) => (get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const page = get("--page");
  if (!page) throw new Error("--page <https://unsplash.com/photos/… or https://www.pexels.com/photo/…> is required");
  const source = sourceOf(page);
  if (!source) throw new Error(`--page must be an Unsplash or a Pexels photo page: ${page}`);
  return {
    page, category: get("--category"), sport: get("--sport") ?? null, purposes: list("--purposes"), tags: list("--tags"),
    photographer: get("--photographer") ?? null, photographerUrl: get("--photographer-url") ?? null,
    title: get("--title"), licence: LICENCE_BY_SOURCE[source],
  };
}

if (basename(process.argv[1] ?? "").startsWith("import-atmosphere-image")) {
  const argv = process.argv.slice(2);
  Promise.resolve()
    .then(() => run(parseArgs(argv, false), [entryFrom(argv)]))
    .catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
}
