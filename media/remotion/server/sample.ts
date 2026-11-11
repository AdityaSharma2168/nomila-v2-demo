/** Local check: render each composition with its studio sample props into ./out (no bucket, no service). */
import path from "path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

(async () => {
  const serveUrl = await bundle({ entryPoint: path.join(__dirname, "..", "src", "index.ts") });
  const only = process.argv[2];
  for (const id of ["BrandBookReel", "TitleCard", "Countdown"]) {
    if (only && only !== id) continue;
    const started = Date.now();
    const composition = await selectComposition({ serveUrl, id });
    const out = path.join(__dirname, "..", "out", `${id}.mp4`);
    await renderMedia({ composition, serveUrl, codec: "h264", outputLocation: out });
    console.log(id, `${composition.durationInFrames / composition.fps}s`, `${Date.now() - started}ms`, out);
  }
})().catch((e) => { console.error(e); process.exit(1); });
