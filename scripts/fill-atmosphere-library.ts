/**
 * fill-atmosphere-library.ts — add hand-picked Unsplash or Pexels photos to the SHARED atmosphere library (0120;
 * DESIGN.md §9).
 *
 * Input: a JSON list of photo pages, each with its category, sport, purposes and tags (server/services/atmosphere/
 * library.ts LibraryEntrySchema). Pick photos one page at a time (ordinary web search, no bulk scraping, no Unsplash
 * or Pexels API beyond the keyless Pexels CDN fetch) and confirm each page shows the free licence ("Free to use under
 * the Unsplash License", never Unsplash+; or a Pexels photo page, always free). For each entry not already in the
 * library and not marked `active: false` (a reviewed candidate kept for the record, never imported — no repeats, one
 * active pick per sport) this script: downloads the photo (Unsplash's normal download URL, refusing Unsplash+; or
 * Pexels' image CDN directly), resizes it to 1600 px on the long edge as WebP (~150–250 KB), checks it, uploads it to
 * the media bucket at atmosphere/shared/<sport|general|signin>/<id>.webp, and records it in atmosphere_library.
 *
 * The check is either the atmosphere/check vision skill (--check model: a live cheap-tier model call per photo, about
 * $0.002–0.003 each, capped by --max-usd) or a named person's review (--reviewed-by "<who>": they looked at every photo
 * in the list; nothing is called). One of the two is required to write.
 *
 * Usage (a person runs this; it writes to the bucket and DB that .env points at — DEV only):
 *   DRY RUN (default; downloads and encodes locally, writes nothing to the bucket or DB, calls no model):
 *     npx tsx --require dotenv/config scripts/fill-atmosphere-library.ts --list atmosphere-library.json --out-dir ./atmo --sheet ./atmo/contact-sheet.html
 *   APPLY:
 *     npx tsx --require dotenv/config scripts/fill-atmosphere-library.ts --list atmosphere-library.json --apply --reviewed-by "Name" [--limit 20]
 *
 * Flags: --list <json> (required) · --apply · --limit <n> (hard cap on photos added — or, in a dry run, processed — this run, default 100) ·
 *        --check model --max-usd <usd> (default 1.00) | --reviewed-by "<who>" · --out-dir <dir> (keep the WebP copies) ·
 *        --sheet <html> (a contact sheet of the processed photos; needs --out-dir) · --curated (mark them approved).
 * Resumable: a photo already in the library (same source + id) is never re-downloaded, so a stopped run is simply
 * run again. But a photo already in the library is NOT simply left alone: this run also compares the library's
 * current `active` flag against the list's for every (source, id) already present, and (on --apply) flips it to
 * match — a photo the list now marks inactive stops showing even though an earlier run already imported it, and one
 * re-activated shows again. A dry run previews these flips without writing them; it needs the database to do so
 * (unlike the rest of a dry run, which needs nothing but the list) and simply skips the preview if it cannot reach it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  downloadPexelsPhoto, downloadUnsplashPhoto, libraryVerdict, objectBase, parseEntry, photoIdOf, sportGrid,
  toLibraryWebp, UnsplashPlusError, type CheckAnswers, type LibraryEntry,
} from "../server/services/atmosphere/library";

/** The vision check's price per photo, quoted before each call against --max-usd (cheap tier, one ≤1600 px image). */
const CHECK_ESTIMATE_USD = 0.003;

export interface Args {
  list: string | null; apply: boolean; limit: number; check: "model" | null; maxUsd: number; reviewedBy: string | null;
  outDir: string | null; sheet: string | null; curated: boolean;
}

/** The shared flags. `needList` = false for the one-photo import, which builds its own entry. */
export function parseArgs(argv: string[], needList = true): Args {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const list = get("--list") ?? null;
  if (needList && !list) throw new Error("--list <json> is required");
  const check = get("--check");
  if (check && check !== "model") throw new Error("--check takes only \"model\"");
  const a: Args = {
    list, apply: argv.includes("--apply"), limit: Math.max(1, Math.floor(Number(get("--limit") ?? 100))),
    check: check === "model" ? "model" : null, maxUsd: Number(get("--max-usd") ?? 1), reviewedBy: get("--reviewed-by")?.trim() || null,
    outDir: get("--out-dir") ?? null, sheet: get("--sheet") ?? null, curated: argv.includes("--curated"),
  };
  if (!Number.isFinite(a.limit) || !Number.isFinite(a.maxUsd) || a.maxUsd < 0) throw new Error("--limit and --max-usd must be numbers");
  if (a.apply && !a.check && !a.reviewedBy) throw new Error("--apply needs --check model or --reviewed-by \"<who>\"");
  if (a.check && a.reviewedBy) throw new Error("use --check model OR --reviewed-by, not both");
  if (a.sheet && !a.outDir) throw new Error("--sheet needs --out-dir");
  return a;
}

export interface Processed {
  entry: LibraryEntry; id: string;
  status: "added" | "would_add" | "skipped_present" | "skipped_inactive"
    | "activated" | "deactivated" | "would_activate" | "would_deactivate" | "rejected" | "failed";
  detail: string; localFile?: string; width?: number; height?: number; kb?: number;
}

async function checkWithModel(entry: LibraryEntry, bytes: Buffer): Promise<{ answers: CheckAnswers; model: string; skillVersion: string; usd: number }> {
  const { checkImage } = await import("../server/services/atmosphere/model");
  const r = await checkImage(
    { bytes, contentType: "image/webp" },
    { type: "section_header", purpose: entry.purposes.join(", "), context: entry.title ?? null },
    [entry.sport, ...entry.tags].filter(Boolean).join(" "),
  );
  return { answers: r.answer, model: r.model, skillVersion: r.skillVersion, usd: r.cost.microUsd / 1e6 };
}

/** The library's current `active` per (source, id) already present, and the store (for `setActive` / `addPhoto` / `close`). */
async function loadPresentRows(photos: ReadonlyArray<{ source: LibraryEntry["source"]; id: string }>) {
  const store = await import("../server/services/atmosphere/libraryStore");
  const presentMap = await store.presentRows(photos);
  return { store, presentMap };
}

export async function run(a: Args, given?: unknown[]): Promise<Processed[]> {
  const sports = new Set(sportGrid().map((s) => s.id));
  const raw = given ?? JSON.parse(readFileSync(a.list!, "utf8"));
  if (!Array.isArray(raw)) throw new Error("--list must hold a JSON array");
  const entries = raw.map((r) => parseEntry(r, sports));
  const ids = entries.map((e) => photoIdOf(e.page)!);
  const keyOf = (e: LibraryEntry, id: string) => `${e.source}:${id}`;
  // Scoped by source: an Unsplash id can never collide with a same-looking Pexels one.
  const keys = entries.map((e, i) => keyOf(e, ids[i]));
  const dupKey = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dupKey) throw new Error(`photo ${dupKey} is listed twice`);

  // Both an apply and a dry run need the library's CURRENT state: not just to skip a photo already present, but to
  // sync (apply) or preview (dry run) `active` on a row the list's flag now disagrees with -- a photo retired here
  // must stop showing even though an earlier run already imported it. A dry run that cannot reach the database (no
  // .env) still runs; it just cannot preview that part (same as it always skipped the present-check before this
  // existed). An applying run has no such fallback: without the database it cannot write anything, so it throws.
  const photos = entries.map((e, i) => ({ source: e.source, id: ids[i] }));
  let got: Awaited<ReturnType<typeof loadPresentRows>> | null = null;
  if (a.apply) got = await loadPresentRows(photos);
  else { try { got = await loadPresentRows(photos); } catch { got = null; } }
  const store = got?.store ?? null;
  const presentMap = got?.presentMap ?? new Map<string, boolean>();
  if (a.outDir) mkdirSync(a.outDir, { recursive: true });

  const out: Processed[] = [];
  // `added` counts photos stored (apply) or that would be stored (dry run), so --limit bounds both kinds of run. An
  // active-sync (flipping an existing row's flag, never touching its image) is cheap and not limited.
  let added = 0; let spentUsd = 0; let attempted = 0;
  const todo = Math.min(a.limit, entries.filter((e, i) => e.active && !presentMap.has(keyOf(e, ids[i]))).length);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; const id = ids[i]; const key = keyOf(entry, id);
    const current = presentMap.get(key);
    if (current !== undefined) {
      if (current === entry.active) { out.push({ entry, id, status: "skipped_present", detail: `already in the library (active=${current})` }); continue; }
      const detail = `active: ${current} → ${entry.active}`;
      if (a.apply) { await store!.setActive(entry.source, id, entry.active); out.push({ entry, id, status: entry.active ? "activated" : "deactivated", detail }); }
      else { out.push({ entry, id, status: entry.active ? "would_activate" : "would_deactivate", detail }); }
      console.log(`${out[out.length - 1].status} ${id}: ${detail}`);
      continue;
    }
    if (!entry.active) { out.push({ entry, id, status: "skipped_inactive", detail: "marked inactive in the list; never imported" }); continue; }
    if (added >= a.limit) { console.log(`limit of ${a.limit} reached; run again to continue`); break; }
    attempted++;
    const say = (p: Processed) => { out.push(p); console.log(`[${attempted}/${todo}] ${p.status} ${id}: ${p.detail}`); };
    try {
      const file = entry.source === "pexels" ? await downloadPexelsPhoto(id) : await downloadUnsplashPhoto(id);
      const webp = await toLibraryWebp(file.bytes);
      const kb = Math.round(webp.bytes.byteLength / 1024);
      let localFile: string | undefined;
      if (a.outDir) {
        localFile = join(a.outDir, `${objectBase(entry, id).replace(/^atmosphere\/shared\//, "").replace(/\//g, "__")}.webp`);
        writeFileSync(localFile, webp.bytes);
      }
      const base = { entry, id, localFile, width: webp.width, height: webp.height, kb };
      if (!a.apply) { added++; say({ ...base, status: "would_add", detail: `${webp.width}×${webp.height} ${kb} KB q${webp.quality}` }); continue; }

      let checkResult: Record<string, unknown>;
      if (a.check === "model") {
        if (spentUsd + CHECK_ESTIMATE_USD > a.maxUsd) { console.log(`--max-usd ${a.maxUsd} reached; run again to continue`); break; }
        const c = await checkWithModel(entry, webp.bytes);
        spentUsd += c.usd;
        const v = libraryVerdict(entry.category, c.answers);
        checkResult = { method: "model", ...c.answers, model: c.model, skill_version: c.skillVersion, accepted: v.accepted, reasons: v.reasons };
        if (!v.accepted) { say({ ...base, status: "rejected", detail: v.reasons.join(",") }); continue; }
      } else {
        checkResult = { method: "person", reviewed_by: a.reviewedBy, reviewed_at: new Date().toISOString().slice(0, 10), accepted: true };
      }
      await store!.addPhoto({ entry, id, webp, checkResult, curated: a.curated });
      added++;
      say({ ...base, status: "added", detail: `${objectBase(entry, id)}.webp ${kb} KB` });
    } catch (err: any) {
      say({ entry, id, status: err instanceof UnsplashPlusError ? "rejected" : "failed", detail: String(err?.message ?? err).slice(0, 200) });
    }
  }
  if (a.sheet) writeFileSync(a.sheet, contactSheet(out, dirname(resolve(a.sheet))));
  if (store) await store.close();
  const count = (s: Processed["status"]) => out.filter((p) => p.status === s).length;
  console.log(
    `added ${count("added")} · would add ${count("would_add")} · already present ${count("skipped_present")} · inactive ${count("skipped_inactive")} · ` +
    `activated ${count("activated")} · deactivated ${count("deactivated")} · would activate ${count("would_activate")} · would deactivate ${count("would_deactivate")} · ` +
    `rejected ${count("rejected")} · failed ${count("failed")}` + (a.check ? ` · model spend ≈ $${spentUsd.toFixed(3)}` : ""),
  );
  for (const p of out.filter((x) => x.status === "rejected" || x.status === "failed")) console.log(`  ${p.status} ${p.id}: ${p.detail}`);
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]!));

/** A plain local HTML page of thumbnails with group, purposes, tags, size and credit (internal review only). */
export function contactSheet(rows: Processed[], sheetDir: string): string {
  const groups = new Map<string, Processed[]>();
  for (const r of rows.filter((x) => x.localFile)) {
    const g = r.entry.category === "sport" ? `sport · ${r.entry.sport}` : r.entry.category;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const card = (r: Processed) => `<figure><img src="${esc(relative(sheetDir, resolve(r.localFile!)).replace(/\\/g, "/"))}" loading="lazy" alt="${esc(r.entry.title ?? r.id)}">
<figcaption><b>${esc(r.entry.purposes.join(" · "))}</b><br>${esc(r.entry.tags.join(", "))}<br><span>${r.width}×${r.height} · ${r.kb} KB · ${esc(r.status)}</span><br>
<a href="${esc(r.entry.page)}">${esc(r.entry.photographer ?? r.entry.source)}</a> · ${esc(r.entry.licence)}</figcaption></figure>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atmosphere contact sheet</title><style>
:root{--bg:#fff;--ink:#111;--muted:#666;--line:#e6e6e6}@media (prefers-color-scheme:dark){:root{--bg:#111;--ink:#eee;--muted:#999;--line:#333}}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:13px/1.4 system-ui,sans-serif}h1{font-size:20px}h2{font-size:15px;margin:28px 0 8px;text-transform:uppercase;letter-spacing:.04em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}figure{margin:0;border:1px solid var(--line);border-radius:4px;overflow:hidden}
img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}figcaption{padding:8px;color:var(--ink)}span{color:var(--muted)}a{color:inherit}
</style></head><body><h1>Atmosphere library — ${rows.filter((r) => r.localFile).length} photos</h1>
${[...groups].map(([g, rs]) => `<h2>${esc(g)} (${rs.length})</h2><div class="grid">${rs.map(card).join("\n")}</div>`).join("\n")}
</body></html>`;
}

if (basename(process.argv[1] ?? "").startsWith("fill-atmosphere-library")) {
  run(parseArgs(process.argv.slice(2))).catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
}
