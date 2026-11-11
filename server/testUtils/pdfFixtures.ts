/**
 * Test-only PDF builders for pdfExtract.test — generated at test time, so no multi-megabyte bomb is
 * committed. Each builder writes a structurally valid PDF (correct xref offsets), so what a test
 * exercises is the LIMIT, not a parse error.
 */
import { createDeflate } from "node:zlib";

/** Serialise objects (1-based, in order) into a PDF with a correct xref table. */
export function buildPdf(objects: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  let offset = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"),
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

const FONT = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

/** A text PDF: one page per entry, one line of text per page. */
export function textPdf(pages: string[]): Buffer {
  // 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    FONT,
  ];
  pages.forEach((line, i) => {
    const content = `BT /F1 12 Tf 72 720 Td (${line.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  return buildPdf(objects);
}

/**
 * A text flood: `runs` copies of `run` per page, all printed at the same spot (pdf.js drops text
 * that falls outside the page, so a long line or many lines would not flood). Valid and plain.
 */
export function overprintPdf(pages: number, runs: number, run: string): Buffer {
  const content = "BT /F1 1 Tf 72 720 Td " + `0 0 Td (${run}) Tj `.repeat(runs) + "ET";
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i} 0 R`).join(" ");
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    FONT,
  ];
  const contentRef = 4 + pages;
  for (let i = 0; i < pages; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`,
    );
  }
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  return buildPdf(objects);
}

/** Deflate `repeat` copies of `unit` without ever holding the inflated bytes in memory. */
async function deflateRepeated(unit: string, repeat: number): Promise<Buffer> {
  const chunk = Buffer.from(unit.repeat(Math.max(1, Math.floor((1 << 20) / unit.length))), "latin1");
  const times = Math.ceil((unit.length * repeat) / chunk.length);
  const z = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  z.on("data", (d: Buffer) => out.push(d));
  const done = new Promise<void>((resolve, reject) => { z.on("end", resolve); z.on("error", reject); });
  for (let i = 0; i < times; i++) {
    if (!z.write(chunk)) await new Promise((r) => z.once("drain", r));
  }
  z.end();
  await done;
  return Buffer.concat(out);
}

/**
 * A decompression bomb: one page whose content stream is a few hundred KB of Flate that inflates to
 * `inflatedMb` of drawing operators. Valid PDF; it is the work, not a syntax error, that is hostile.
 */
export async function flateBombPdf(inflatedMb: number, unit = "0 0 m 1 1 l S\n"): Promise<Buffer> {
  const z = await deflateRepeated(unit, Math.ceil((inflatedMb * (1 << 20)) / unit.length));
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    Buffer.concat([
      Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      z,
      Buffer.from("\nendstream", "latin1"),
    ]),
  ]);
}

/**
 * A memory bomb: a page that uses a TrueType font whose embedded font file is Flate that inflates to
 * `inflatedMb` of zeros. pdf.js decodes a font file in one go, into an ArrayBuffer — memory outside
 * the V8 heap, which resourceLimits does not count.
 */
export async function fontBombPdf(inflatedMb: number): Promise<Buffer> {
  const z = await deflateRepeated("\0", inflatedMb * (1 << 20));
  const content = "BT /F1 12 Tf 72 720 Td (boom) Tj ET";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /TrueType /BaseFont /Bomb /FirstChar 32 /LastChar 126 /FontDescriptor 6 0 R >>",
    "<< /Type /FontDescriptor /FontName /Bomb /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>",
    Buffer.concat([
      Buffer.from(`<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      z,
      Buffer.from("\nendstream", "latin1"),
    ]),
  ]);
}

/** A page whose content stream is `depth` nested arrays — recursion in the object parser. */
export function nestedPdf(depth: number): Buffer {
  const content = "[".repeat(depth) + "]".repeat(depth) + " pop\nBT /F1 12 Tf 72 720 Td (after) Tj ET";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    FONT,
  ]);
}
