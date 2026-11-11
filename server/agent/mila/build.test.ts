/**
 * mila/build.test.ts — Mila's definition (draft) assembles in order, stays within budget, and keeps the owner's
 * standing rules in its own wording.
 *
 *   B1  the core files assemble in file-name order, then the surface file
 *   B2  authoring comments never reach the model
 *   B3  the static chat instructions stay within the budget (~4,400 tokens incl. the surface and the fuller product block;
 *       4,000 until 3 Nov 2026; 4,100 for the attachments rule (4,049 then); 4,400 when the harness chat prompt and its
 *       preambles were folded into the core (~4,300 on TrueForge, ~4,120 on the harness, which leaves out 35-delegate))
 *   B4  Mila is never gendered in the definition (no she/he/her/his for Mila)
 *   B5  calm wording: no ALL-CAPS alarm words
 *   B6  every playbook in the index exists and loads
 *   B7  no real athlete name is hardcoded (examples use made-up people)
 *   B8  every section is wrapped in a matching tag
 *   B9  4–5 examples, each tagged and each with its reason; at most two end by offering a draft
 *   B10 the M.I.A. is defined once, in the product block, as the marketability score (0–850)
 *   B11 no hard-coded capability claims in the examples (what Mila can do comes from CAN DO NOW)
 *   B12 no helper (sub-agent) section is served: Mastra has no helper tool (35-delegate removed 9 Nov 2026)
 *   B13 memory is checked (recall_facts, read_scouting) before Mila says it doesn't know something about the athlete,
 *       in chat and voice (first TrueForge smoke, 26 Oct 2026: "I don't have any details about you" with no lookup)
 *   B14 the content-safety principle (no legal risk, defamation, contract or deal-term breach, or unsafe claim) is in
 *       the core for every athlete-facing surface and engine, word for word (kept apart from principle 9, 4 Nov 2026)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MILA_DIR, MILA_PLAYBOOKS, MILA_SURFACES, approxTokens, buildMilaInstructions, coreFiles, readPlaybook,
} from "./build";
import { MILA_TEXT_ENGINES, corePath } from "./load";

describe("Mila's definition (draft)", () => {
  test("B1 core files in order, then the surface", () => {
    const files = coreFiles();
    expect(files).toEqual([...files].sort());
    expect(files[0]).toBe("00-identity.md");
    const text = buildMilaInstructions({ surface: "chat" });
    expect(text.indexOf("# Who you are")).toBeLessThan(text.indexOf("# Mila's character"));
    expect(text.indexOf("# Playbooks")).toBeLessThan(text.indexOf("# Where you are: the Mila tab"));
  });

  test("B1b the public page takes only the identity line plus its own surface", () => {
    const pub = buildMilaInstructions({ surface: "public" });
    expect(pub).toContain("# Who you are");
    expect(pub).toContain("# Where you are: the athlete's public page");
    expect(pub).not.toContain("# Mila's character");
    expect(pub).not.toContain("# Principles");
  });

  test("B2 authoring comments are stripped", () => {
    for (const s of MILA_SURFACES) expect(buildMilaInstructions({ surface: s })).not.toMatch(/<!--|-->/);
    for (const p of MILA_PLAYBOOKS) expect(readPlaybook(p)).not.toMatch(/<!--|-->/);
  });

  test("B3 the chat instructions stay within budget", () => {
    // 4,000 → 4,100 on 3 Nov 2026 for the owner-approved attachments rule (surfaces/chat.md, ~50 tokens; 4,049 then);
    // → 4,400 the same day when the harness chat prompt and its preambles were folded into the core (PR #1200).
    expect(approxTokens(buildMilaInstructions({ surface: "chat" }))).toBeLessThanOrEqual(4400);
    expect(approxTokens(buildMilaInstructions({ surface: "chat", engine: "mastra" }))).toBeLessThanOrEqual(4400);
  });

  test("B4 Mila is never gendered", () => {
    const all = MILA_SURFACES.map((s) => buildMilaInstructions({ surface: s })).join("\n");
    expect(all).not.toMatch(/\bMila(?:'s)?\b[^.\n]{0,40}\b(she|he|her|his|hers|him)\b/i);
    expect(all).not.toMatch(/\b(she|he)\b\s+(is|will|can|knows)\s+Mila\b/i);
  });

  test("B5 calm wording", () => {
    const all = MILA_SURFACES.map((s) => buildMilaInstructions({ surface: s })).join("\n");
    expect(all).not.toMatch(/\b(CRITICAL|IMPORTANT|MUST|NEVER|ALWAYS)\b/);
  });

  test("B6 every indexed playbook exists", () => {
    const index = readFileSync(corePath("60-playbooks-index.md"), "utf8");
    for (const p of MILA_PLAYBOOKS) {
      expect(index).toContain(`- ${p}:`);
      expect(readPlaybook(p).length).toBeGreaterThan(100);
    }
  });

  test("B7 no hardcoded real athlete", () => {
    const all = MILA_SURFACES.map((s) => buildMilaInstructions({ surface: s })).join("\n");
    expect(all).not.toMatch(/\b(Mia|Bhuta|Lilia|Riya)\b/);
  });

  test("B8 every section is wrapped in a matching tag", () => {
    const files = [
      ...coreFiles().map((f) => corePath(f)),
      ...MILA_SURFACES.map((s) => join(MILA_DIR, "surfaces", `${s}.md`)),
    ];
    for (const f of files) {
      const body = readFileSync(f, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
      const open = body.match(/^<([a-z_]+)>/);
      expect(open).not.toBeNull();
      expect(body.endsWith(`</${open![1]}>`)).toBe(true);
    }
  });

  test("B9 examples: 4–5, tagged, each with its reason, not mostly ending in a draft offer", () => {
    const ex = readFileSync(corePath("50-examples.md"), "utf8");
    const blocks = ex.match(/<example name="[^"]+">[\s\S]*?<\/example>/g) ?? [];
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(blocks.length).toBeLessThanOrEqual(5);
    for (const b of blocks) expect(b).toMatch(/Why this is right:/);
    expect(blocks.filter((b) => /Not this:/.test(b)).length).toBeGreaterThanOrEqual(2);
    expect(blocks.filter((b) => /want me to draft/i.test(b)).length).toBeLessThanOrEqual(2);
  });

  test("B10 M.I.A. is the marketability score, defined once in the product block", () => {
    const chat = buildMilaInstructions({ surface: "chat" });
    const product = readFileSync(corePath("45-product.md"), "utf8");
    expect(product).toMatch(/marketability score/i);
    expect(product).toMatch(/0 to 850/);
    expect(chat.match(/The M\.I\.A\. score\./g)?.length).toBe(1);
    expect(chat).toMatch(/Your knowledge of Nomila's product ends here/);
  });

  test("B11 no hard-coded capability claims in the examples", () => {
    const ex = readFileSync(corePath("50-examples.md"), "utf8");
    expect(ex).not.toMatch(/(isn't|is not|aren't) something I can do|can't (post|publish|book|pay) (from here|yet)/i);
  });

  test("B12 no helper (sub-agent) section is served: Mastra has no helper tool", () => {
    expect(coreFiles()).not.toContain("35-delegate.md");
    for (const surface of MILA_SURFACES) {
      for (const engine of MILA_TEXT_ENGINES) {
        const text = buildMilaInstructions({ surface, engine });
        expect([surface, engine, /<delegating>|hand work to a helper|sub-agent/i.test(text)]).toEqual([surface, engine, false]);
      }
    }
  });

  test("B14 the content-safety principle is in the core, word for word, on every athlete-facing surface and engine", () => {
    const line = "**Nothing that could damage them.** Never suggest content that creates legal risk, defames anyone, breaches a contract or deal terms, or makes an unsafe claim (such as an unconfirmed return date), because it is their name on it.";
    for (const surface of ["chat", "voice", "waitlist"] as const) {
      for (const engine of MILA_TEXT_ENGINES) {
        expect([surface, engine, buildMilaInstructions({ surface, engine }).replace(/\s+/g, " ").includes(line)]).toEqual([surface, engine, true]);
      }
    }
  });

  test("B13 memory is checked before saying it doesn't know", () => {
    for (const surface of ["chat", "voice"] as const) {
      const text = buildMilaInstructions({ surface });
      expect(text).toMatch(/Check memory before saying you don't know\./);
      expect(text).toMatch(/don't know something about them,[\s\S]{0,60}call recall_facts \(and read_scouting/);
    }
  });
});
