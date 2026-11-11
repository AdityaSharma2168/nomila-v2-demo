/**
 * make.ts — renders the fixture PDFs from lines.ts with macOS's CUPS text filter, a well-formed PDF 1.3
 * from a maintained producer (decision, 23 Sep 2026: no hand-authored PDF internals — pdf-parse 1.1.1
 * rejected those nondeterministically, see docs/probes/mila-direction.md, Lane A). Run once when
 * lines.ts changes; the PDFs are committed and the tests read the committed bytes, so this script is
 * optional tooling, not load-bearing:
 *
 *   npx tsx server/studio/direction/fixtures/briefs/make.ts
 *
 * 12 characters per inch → 96 columns; lines.ts keeps every line under 88 so nothing wraps.
 * parser-breaking.pdf is deliberately NOT rendered here (lines.ts says what it is).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURES, textOf } from "./lines";

const CUPSFILTER = "/usr/sbin/cupsfilter";

if (require.main === module) {
  const scratch = mkdtempSync(join(tmpdir(), "brief-fixtures-"));
  for (const [name, pages] of Object.entries(FIXTURES)) {
    const txt = join(scratch, `${name}.txt`);
    writeFileSync(txt, textOf(pages));
    const pdf = execFileSync(CUPSFILTER, ["-o", "cpi=12", txt], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!pdf.length || pdf.subarray(0, 5).toString("latin1") !== "%PDF-")
      throw new Error(`${name}: cupsfilter produced no PDF`);
    writeFileSync(join(__dirname, `${name}.pdf`), pdf);
    console.log(`${name}.pdf  ${pdf.length} bytes  ${pages.length} page(s)`);
  }
}
