/**
 * brandBook/reel — "Make it a reel": the brand book as a short vertical motion piece, made with the Studio video engine
 * the post-kit previews already use (no model, no provider spend: sharp, satori and ffmpeg on this instance).
 *
 *   scenes    the book's strongest lines, each over one of her photos (the cover's promise, the big idea, each pillar,
 *             what she stands for, the story's closing line, the season) — at most MAX_SCENES
 *   motion    every photo becomes a moving still (studio/video/still.ts: a push-in or a slow zoom, alternating)
 *   words     each scene's line drawn once as a full-frame overlay (satori, Outfit from the app's own font package),
 *             inside Reels' safe zones, over a soft scrim — pixels and a place, never text in an ffmpeg argv
 *   joins     short crossfades; a brand-safe track from the curated catalogue under it, brought to the reference loudness
 *   output    1080×1920 mp4 + a poster, uploaded to her own space as a GENERATED media asset (draft): it appears in
 *             Studio and is never posted for her
 *
 * Two engines. With REMOTION_RENDER_URL set (dev), the book renders on the Remotion service (media/remotion: camera
 * moves, kinetic words, her palette, transitions, a closing card); any failure there falls back to the ffmpeg path below,
 * which needs nothing but this instance.
 *
 * Nothing here names an athlete, sport, school or brand.
 */
import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import satori from "satori";
import sharp from "sharp";
import { readFileSync } from "fs";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { brandBooks, mediaAssets } from "../../../shared/schema";
import { applyBookOverrides, type BookOverrides } from "./overrides";
import { createLogger } from "../../logger";
import { readObject, uploadLocalFile } from "../../lib/mediaStore";
import { STUDIO_PLATFORM } from "../../studio/config";
import { fontFaceFor } from "../../studio/fonts/fonts";
import { recommend } from "../../studio/music/recommend";
import { musicBedFor } from "../../studio/video/beds";
import { encodeStill } from "../../studio/video/still";
import { STITCH_TARGETS } from "../../studio/video/spec";
import { stitch } from "../../studio/video/stitch";
import { TRUE_PEAK_DBTP } from "../../studio/video/finishing";
import type { StitchClip } from "../../studio/video/types";
import type { BrandBookData, BrandBookReel } from "../../../shared/brandBook";
import { gcsRef, type BrandBookReelProps } from "../../../shared/remotionProps";
import { remotionRenderUrl, renderOnRemotion } from "../remotionRender";

const logger = createLogger("brandBook/reel");

export const MAX_SCENES = 7;
export const SCENE_SEC = 3.2;
export const CROSSFADE_SEC = 0.5;
const TARGET = STITCH_TARGETS.portrait;
const BUDGET_MS = 8 * 60_000;

export interface Scene { image: string; kicker: string; text: string }

/** The scenes, in the book's order: one strong line per photo. Pure. */
export function reelScenes(book: BrandBookData): Scene[] {
  const out: Scene[] = [];
  const page = (id: string) => book.pages.find((p) => p.id === id);
  const add = (image: string | undefined, kicker: string, text: string | undefined) => {
    if (image && text && out.length < MAX_SCENES) out.push({ image, kicker, text });
  };
  const cover = page("cover");
  add(cover?.images[0], book.firstName.toUpperCase(), cover?.lines.line?.text);
  const idea = page("big_idea");
  add(idea?.images[0], "THE BIG IDEA", idea?.lines.line?.text);
  const pillars = page("pillars");
  pillars?.images.forEach((img, i) => add(img, `PILLAR ${i + 1}`, pillars.lines[`pillar.${i}.name`]?.text));
  const story = page("story");
  add(story?.images[0], "YOUR STORY", story?.lines.line?.text);
  const look = page("voice_look");
  add(look?.images[0], "HOW YOU SHOW UP", look?.lines.line?.text);
  const plan = page("plan");
  add(plan?.images[0], "THIS SEASON", plan?.lines.line?.text);
  return out;
}

/** The Remotion props for this book: the same scenes, her palette, the bed. Pure. */
export function reelProps(book: BrandBookData, scenes: Scene[], musicPath: string | null): BrandBookReelProps {
  const palette = book.pages.find((p) => p.id === "voice_look")?.extra?.palette ?? [];
  return {
    firstName: book.firstName,
    scenes: scenes.map((s) => ({ image: gcsRef(s.image), kicker: s.kicker, text: s.text })),
    palette, music: musicPath ? gcsRef(musicPath) : null,
    sceneSec: SCENE_SEC, transitionSec: CROSSFADE_SEC, outroSec: 2.2,
  };
}

/** The brand-safe bed from the curated catalogue (the book is hers, but it may be shared anywhere). */
function bedPathFor(): string | null {
  const pick = recommend({ feel: ["uplifting", "confident"], forBrand: true })[0]?.id ?? null;
  return musicBedFor(pick)?.gcsPath ?? null;
}

async function storeReel(athleteId: string, caption: string, gcsPath: string, gcsPoster: string): Promise<string> {
  const [asset] = await db.insert(mediaAssets).values({
    athlete_id: athleteId, platform: STUDIO_PLATFORM, origin: "generated", media_type: "VIDEO", approval_status: "draft",
    content_format: "reel", status: "stored", gcs_path: gcsPath, gcs_thumb_path: gcsPoster, content_type: "video/mp4",
    caption, ingested_at: new Date(),
  } as never).returning({ id: mediaAssets.id });
  return asset.id;
}

/** The Remotion render of the book. Throws on any failure (the caller falls back). */
async function renderOnService(athleteId: string, book: BrandBookData, scenes: Scene[], requestedAt: string): Promise<BrandBookReel> {
  const base = `athletes/${athleteId}/studio/brand-book/v${book.version}-${Date.now()}`;
  const out = { video: `${base}/reel.mp4`, poster: `${base}/poster.jpg` };
  const r = await renderOnRemotion(athleteId, "BrandBookReel", reelProps(book, scenes, bedPathFor()), out);
  const assetId = await storeReel(athleteId, scenes[0].text, out.video, out.poster);
  logger.info({ athleteId, version: book.version, scenes: scenes.length, engine: "remotion", ms: r.ms }, "brand book reel ready");
  return { status: "ready", version: book.version, requestedAt, finishedAt: new Date().toISOString(), assetId, gcsPath: out.video, posterPath: out.poster };
}

let fontCache: { b600: Buffer; b800: Buffer } | null = null;
function fonts() {
  if (!fontCache) {
    fontCache = {
      b600: readFileSync(require.resolve(fontFaceFor("outfit", 600).file)),
      b800: readFileSync(require.resolve(fontFaceFor("outfit", 800).file)),
    };
  }
  return fontCache;
}

/** One scene's words as a full-frame overlay with alpha: a soft scrim at the foot, kicker over the line, inside the safe zone. */
export async function sceneOverlay(scene: Scene): Promise<Buffer> {
  const f = fonts();
  const size = scene.text.length > 70 ? 64 : scene.text.length > 40 ? 76 : 88;
  const svg = await satori(
    {
      type: "div", key: null,
      props: {
        style: {
          width: TARGET.width, height: TARGET.height, display: "flex", flexDirection: "column", justifyContent: "flex-end",
          // Reels' safe zones: clear of the bottom quarter and the right rail.
          paddingLeft: 72, paddingRight: 168, paddingBottom: Math.round(TARGET.height * 0.25) + 40,
          backgroundImage: "linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.62) 78%, rgba(0,0,0,0.75) 100%)",
        },
        children: [
          { type: "div", key: "k", props: { style: { color: "#F28DBB", fontSize: 30, fontWeight: 600, letterSpacing: 6, marginBottom: 18 }, children: scene.kicker } },
          { type: "div", key: "t", props: { style: { color: "#FFFFFF", fontSize: size, fontWeight: 800, lineHeight: 1.08, letterSpacing: -1 }, children: scene.text } },
        ],
      },
    } as any,
    {
      width: TARGET.width, height: TARGET.height,
      fonts: [
        { name: "Outfit", data: f.b600, weight: 600, style: "normal" },
        { name: "Outfit", data: f.b800, weight: 800, style: "normal" },
      ],
    },
  );
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function setReel(athleteId: string, reel: BrandBookReel): Promise<void> {
  await db.update(brandBooks).set({ reel, updated_at: new Date() }).where(eq(brandBooks.athlete_id, athleteId));
}

/** Render the reel for this book now. Returns the stored reel. */
export async function renderBookReel(athleteId: string, book: BrandBookData, requestedAt: string): Promise<BrandBookReel> {
  const scenes = reelScenes(book);
  if (scenes.length < 2) throw new Error("not enough pages with photos for a reel");
  if (remotionRenderUrl()) {
    try {
      return await renderOnService(athleteId, book, scenes, requestedAt);
    } catch (err: any) {
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "remotion reel failed — ffmpeg fallback");
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "brand-book-reel-"));
  const started = Date.now();
  const left = () => Math.max(30_000, BUDGET_MS - (Date.now() - started));
  try {
    const clips: StitchClip[] = [];
    for (const [i, s] of scenes.entries()) {
      const obj = await readObject(s.image, 25_000_000);
      if (!obj) continue;
      // Filled to the 9:16 frame first (the subject kept in view), so a 4:5 or landscape photo never lands with bars.
      const photo = join(dir, `photo-${i}.jpg`);
      await sharp(obj.buf, { failOn: "none" }).rotate().resize(TARGET.width, TARGET.height, { fit: "cover", position: "attention" })
        .jpeg({ quality: 92 }).toFile(photo);
      const still = await encodeStill(photo, dir, i, SCENE_SEC, TARGET, left(), i % 2 === 0 ? "dolly" : "zoom");
      const overlayPath = join(dir, `overlay-${i}.png`);
      await writeFile(overlayPath, await sceneOverlay(s));
      clips.push({
        source: still.path,
        overlay: { source: overlayPath, y: 0 },
        ...(clips.length ? { transitionIn: { kind: "crossfade" as const, durationSec: CROSSFADE_SEC } } : {}),
      });
    }
    if (clips.length < 2) throw new Error("her photos could not be read");

    // A brand-safe track from the curated catalogue (the book is hers, but it may be shared anywhere).
    let bedPath: string | null = null;
    const bedGcs = bedPathFor();
    if (bedGcs) {
      const obj = await readObject(bedGcs, 25_000_000).catch(() => null);
      if (obj) { bedPath = join(dir, "bed.m4a"); await writeFile(bedPath, obj.buf); }
    }

    const outputPath = join(dir, "reel.mp4");
    await stitch({
      clips, outputPath, target: TARGET, timeoutMs: left(),
      ...(bedPath ? { audioBed: { source: bedPath, level: 0.7, loop: true } } : {}),
      finishing: { cropToFill: true, truePeakDbtp: TRUE_PEAK_DBTP },
    });

    // The poster: the first scene's photo with its words, as the feed would show it.
    const first = await readObject(scenes[0].image, 25_000_000);
    const posterPath = join(dir, "poster.jpg");
    await sharp(first!.buf, { failOn: "none" }).rotate().resize(TARGET.width, TARGET.height, { fit: "cover", position: "attention" })
      .composite([{ input: await sceneOverlay(scenes[0]) }]).jpeg({ quality: 88 }).toFile(posterPath);

    const base = `athletes/${athleteId}/studio/brand-book/v${book.version}-${Date.now()}`;
    const gcsPath = `${base}/reel.mp4`;
    const gcsPoster = `${base}/poster.jpg`;
    await uploadLocalFile(outputPath, gcsPath, "video/mp4");
    await uploadLocalFile(posterPath, gcsPoster, "image/jpeg");
    const bytes = (await stat(outputPath)).size;
    const assetId = await storeReel(athleteId, scenes[0].text, gcsPath, gcsPoster);
    logger.info({ athleteId, version: book.version, scenes: clips.length, bytes, engine: "ffmpeg", ms: Date.now() - started }, "brand book reel ready");
    return { status: "ready", version: book.version, requestedAt, finishedAt: new Date().toISOString(), assetId, gcsPath, posterPath: gcsPoster };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Her tap: start the reel in the background. Null when there is no ready book. */
export async function startBookReel(athleteId: string): Promise<BrandBookReel | null> {
  const [row] = await db.select().from(brandBooks).where(eq(brandBooks.athlete_id, athleteId)).limit(1);
  // The reel shows the book she sees: her chosen and written lines over the engine's (overrides.ts).
  const book = row?.data ? applyBookOverrides(row.data as BrandBookData, row.overrides as BookOverrides | null).book : null;
  if (!row || !book) return null;
  const cur = row.reel as BrandBookReel | null;
  if (cur?.status === "rendering" && Date.now() - new Date(cur.requestedAt).getTime() < BUDGET_MS + 60_000) return cur;
  const requestedAt = new Date().toISOString();
  const pending: BrandBookReel = { status: "rendering", version: book.version, requestedAt };
  await setReel(athleteId, pending);
  void renderBookReel(athleteId, book, requestedAt)
    .then((r) => setReel(athleteId, r))
    .catch(async (err: any) => {
      logger.warn({ athleteId, error: String(err?.message ?? err).slice(0, 200) }, "brand book reel failed");
      await setReel(athleteId, { ...pending, status: "failed", finishedAt: new Date().toISOString(), error: "Mila couldn't make the reel this time. Try again in a minute." }).catch(() => {});
    });
  return pending;
}
