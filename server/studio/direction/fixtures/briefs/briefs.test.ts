/**
 * briefs.test — the committed fixture PDFs are what lines.ts says, read through the product's own
 * extractor: every stated line of the full brief, the injection twice and the fence attempt, nothing
 * from the scanned page — and the parser-breaking PDF never throws.
 *
 * Comparisons are whitespace-folded (summarize.ts `norm`): the CUPS text filter pads lines and a
 * two-line paragraph joins with a newline, and that is exactly how the tool compares a quote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPdfTextDetailed } from "../../../../lib/pdfExtract";
import { norm } from "../../summarize";
import {
  BRAND,
  FENCE_CLOSE_ATTEMPT,
  FIXTURES,
  INJECTION,
  STATED_LINES,
  textOf,
  type FixtureName,
} from "./lines";

const read = (name: FixtureName | "parser-breaking") =>
  readFileSync(join(__dirname, `${name}.pdf`));
const textOfPdf = async (name: FixtureName | "parser-breaking") =>
  (await extractPdfTextDetailed(read(name), 50_000)).text;
const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

describe("the brief fixture PDFs", () => {
  it("every committed PDF is a PDF, and every rendered one is what lines.ts says it is", () => {
    for (const name of [
      ...(Object.keys(FIXTURES) as FixtureName[]),
      "parser-breaking",
    ] as const)
      expect({
        name,
        magic: read(name).subarray(0, 5).toString("latin1"),
      }).toEqual({ name, magic: "%PDF-" });
    // lines.ts is the source of truth: the stated lines are in the text make.ts renders.
    const fullText = textOf(FIXTURES.full);
    for (const s of STATED_LINES) expect(fullText).toContain(s.saidIn);
    expect(textOf(FIXTURES.injection)).toContain(
      INJECTION.split(" ").slice(0, 4).join(" "),
    );
  });

  it("the full brief: the extractor sees every stated line", async () => {
    const text = norm(await textOfPdf("full"));
    for (const s of STATED_LINES)
      expect({ path: s.path, seen: text.includes(norm(s.saidIn)) }).toEqual({
        path: s.path,
        seen: true,
      });
    expect(text).toContain(norm(`Brand: ${BRAND}`));
    expect(text).not.toContain(norm(INJECTION));
  });

  it("the injection brief: the instruction is there twice, and so is the fence attempt", async () => {
    const text = norm(await textOfPdf("injection"));
    expect(count(text, norm(INJECTION))).toBe(2);
    expect(count(text, norm(FENCE_CLOSE_ATTEMPT))).toBe(1);
    for (const s of STATED_LINES) expect(text).toContain(norm(s.saidIn)); // otherwise the full brief
  });

  it("the thin brief: brand and product, nothing about feel or story", async () => {
    const text = await textOfPdf("thin");
    expect(text).toContain(`Brand: ${BRAND}`);
    expect(text).toContain("Product: the Tidewater bottle");
    expect(text).not.toMatch(/Tone:|Story:|Energy:|Visual style:|Deliverable:/);
  });

  it("the scanned page: a valid PDF with no text at all", async () => {
    expect(await extractPdfTextDetailed(read("scanned"), 50_000)).toEqual({
      text: "",
      totalChars: 0,
      truncated: false,
    });
  });

  /**
   * PARITY with the parser this replaced (3 Nov 2026: pdf-parse 1.1.1 → pdfjs-dist 6 in a worker).
   * pdf-parse-1.1.1.golden.json is pdf-parse's own output on these files, captured before it was
   * removed, through the same normalisation. The text is the same — every line, in order, joined the
   * same way. One difference, by design of pdf.js >= 2: a line that is ONLY spaces (how the CUPS
   * filter draws a blank line) is no longer a text item, so the blank line between paragraphs folds
   * into a single newline. Those are compared with blank lines folded; the rest exactly.
   */
  it("parity: every fixture reads as pdf-parse 1.1.1 read it (blank lines folded)", async () => {
    const golden = JSON.parse(
      readFileSync(join(__dirname, "pdf-parse-1.1.1.golden.json"), "utf8"),
    ) as Record<string, string>;
    const fold = (s: string) => s.replace(/\n\n/g, "\n");
    for (const name of Object.keys(golden) as Array<FixtureName | "parser-breaking">) {
      const now = await textOfPdf(name);
      expect({ name, text: fold(now) }).toEqual({ name, text: fold(golden[name]) });
    }
    // Exact, not folded, where pdf-parse had no whitespace-only lines to lose.
    expect(await textOfPdf("parser-breaking")).toBe(golden["parser-breaking"]);
    expect(await textOfPdf("scanned")).toBe(golden.scanned);
  });

  it("the parser-breaking PDF: the extractor resolves — text or empty — and never throws", async () => {
    const r = await extractPdfTextDetailed(read("parser-breaking"), 50_000);
    expect(typeof r.text).toBe("string");
    expect(r.truncated).toBe(false);
  });
});
