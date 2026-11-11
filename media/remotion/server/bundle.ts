/** Build-time: bundle the compositions once into ./build so a render never re-bundles. */
import path from "path";
import { bundle } from "@remotion/bundler";

(async () => {
  const out = await bundle({
    entryPoint: path.join(__dirname, "..", "src", "index.ts"),
    outDir: path.join(__dirname, "..", "build"),
  });
  console.log("bundled", out);
})().catch((e) => { console.error(e); process.exit(1); });
