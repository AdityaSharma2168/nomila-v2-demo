/**
 * The render service (Cloud Run, dev): POST /render { composition, inputProps, output: { videoPutUrl, posterPutUrl? } }.
 *
 * It holds NO bucket access. The API checks every media ref is hers (or the product's shared music / atmosphere) and
 * sends short-lived signed URLs instead (server/services/remotionRender.ts); transfer.ts refuses any other host.
 *
 *   1. every signed READ URL in the props is fetched (storage.googleapis.com only, byte cap, timeout) into a job folder
 *      and served from this process (http://localhost:<port>/assets/<job>/<n>), so the headless browser reads local files
 *   2. the pre-built bundle (./build) renders the composition to H.264; the poster is one still from it
 *   3. both are PUT to the signed WRITE URLs the API sent (fixed content types); the job folder is removed
 *
 * Private: Cloud Run IAM decides who may call it (the API's service account). One render per instance at a time.
 */
import express from "express";
import path from "path";
import os from "os";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { replaceRefs } from "../../../shared/remotionProps";
import { checkRequest, fetchInput, putOutput, POSTER_CONTENT_TYPE, VIDEO_CONTENT_TYPE } from "./transfer";

const PORT = Number(process.env.PORT ?? 8080);
const SERVE_URL = path.join(__dirname, "..", "build");
const jobs = new Map<string, string>();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => { res.json({ ok: true }); });

app.get("/assets/:job/:file", (req, res) => {
  const dir = jobs.get(req.params.job);
  if (!dir || !/^[\w.-]+$/.test(req.params.file)) { res.status(404).end(); return; }
  res.sendFile(path.join(dir, req.params.file));
});

const extOf = (p: string) => (path.extname(p).toLowerCase().match(/^\.(jpe?g|png|webp|m4a|mp3|aac|wav|mp4)$/)?.[0] ?? ".bin");

app.post("/render", async (req, res) => {
  const started = Date.now();
  const checked = checkRequest(req.body);
  if ("error" in checked) {
    res.status(400).json({ ok: false, error: checked.error });
    return;
  }
  const { composition, inputProps, output, inputs } = checked;
  const job = randomUUID();
  const dir = await mkdtemp(path.join(os.tmpdir(), "render-"));
  jobs.set(job, dir);
  try {
    // 1. Her media, local.
    const map: Record<string, string> = {};
    await Promise.all(inputs.map(async (url, i) => {
      const file = `${i}${extOf(new URL(url).pathname)}`;
      await writeFile(path.join(dir, file), await fetchInput(url));
      map[url] = `http://localhost:${PORT}/assets/${job}/${file}`;
    }));
    const props = replaceRefs(inputProps, map);

    // 2. Render.
    const comp = await selectComposition({ serveUrl: SERVE_URL, id: composition, inputProps: props });
    const videoFile = path.join(dir, "out.mp4");
    await renderMedia({
      composition: comp, serveUrl: SERVE_URL, codec: "h264", outputLocation: videoFile, inputProps: props,
      crf: 20, audioBitrate: "192k", concurrency: Math.max(1, os.cpus().length - 1), timeoutInMilliseconds: 60_000,
    });
    let posterFile: string | null = null;
    if (output.posterPutUrl) {
      posterFile = path.join(dir, "poster.jpg");
      await renderStill({
        composition: comp, serveUrl: SERVE_URL, output: posterFile, inputProps: props, imageFormat: "jpeg", jpegQuality: 88,
        frame: Math.min(comp.durationInFrames - 1, Math.round(comp.fps * 1.6)),
      });
    }

    // 3. To the signed WRITE URLs (the paths are the API's; this service never sees the bucket).
    await putOutput(output.videoPutUrl, await readFile(videoFile), VIDEO_CONTENT_TYPE);
    if (posterFile && output.posterPutUrl) await putOutput(output.posterPutUrl, await readFile(posterFile), POSTER_CONTENT_TYPE);
    const durationSec = comp.durationInFrames / comp.fps;
    console.log(JSON.stringify({ msg: "rendered", composition, durationSec, ms: Date.now() - started }));
    res.json({ ok: true, poster: !!posterFile, durationSec, ms: Date.now() - started });
  } catch (err: any) {
    console.error(JSON.stringify({ msg: "render failed", composition, error: String(err?.message ?? err).slice(0, 500) }));
    res.status(500).json({ ok: false, error: String(err?.message ?? err).slice(0, 300) });
  } finally {
    jobs.delete(job);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(JSON.stringify({ msg: "render service up", port: PORT })));
