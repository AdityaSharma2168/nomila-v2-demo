/**
 * mila/mila.guard.test.ts — CI guard for Mila's definition (server/agent/mila). Fails when:
 *
 *   G1 a skill's folder name and its front-matter `name` differ
 *   G2 a SKILL.md front-matter is missing or invalid (Agent Skills spec: name, description ≤ 1024, …)
 *   G3 a skill's nomila.yaml fails its schema (load.ts sidecarSchema), or is missing
 *   G4 a SKILL.md body is over 500 lines
 *   G5 a skill references a file more than one level deep (links like a/b/c.md or ../x, or nested folders)
 *   G6 a skill's served text changed without a version bump, or its version went down (skills.lock.json; bump the
 *      version, then `npm run mila:lock`). The lock hashes the served text, so an authoring-comment edit needs no bump
 *   G7 Mila is gendered in an instructions/, surfaces/, proactive or skills/ file ("Mila never guesses; she asks")
 *   G8 a register_id is missing or used twice
 *
 * Each rule is also run against a throwaway folder that breaks it, so a guard that stopped firing fails too. And one
 * loader: no file under server/ except mila/load.ts reads Mila's files with readFileSync.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  INSTRUCTIONS_SUBDIR, LOCK_FILE, MILA_DIR, SIDECAR_FILE, SKILLS_SUBDIR, SKILL_FILE, buildSkillsLock, compareVersions,
  lockProblems, readSkill, readSkillBody, sidecarSchema, skillBodyDigest, skillFrontMatterSchema, splitFrontMatter,
  type SkillsLock,
} from "./load";

const MAX_BODY_LINES = 500;
const LOCK_HINT = "bump `version` in its nomila.yaml, then run `npm run mila:lock`";

/**
 * G7. A gendered pronoun is flagged when the nearest person before it, in the same sentence, is Mila: "Mila never
 * guesses; she asks." A semicolon or a colon does not end the sentence; a full stop, ?, !, a blank line, a heading or a
 * list item does. A person in between takes the pronoun ("Mila tells the athlete what he earned."), so the athlete's
 * pronouns are not caught; "it" and they/them/you cannot take a she/he, so they leave Mila the nearest person. Also
 * "she/he is … Mila". Authoring comments are linted too: they are where a pronoun slips in first.
 */
const GENDERED_PRONOUN = /^(she|he|her|his|hers|him|herself|himself)$/i;
/** People a gendered pronoun can refer to instead of Mila. */
const PERSON = /^(athletes?|fans?|visitors?|buyers?|parents?|coach(es)?|agents?|managers?|teammates?|friends?|persons?|people|users?|creators?|players?|guests?|clients?|founders?|reps?|representatives?|moms?|dads?|mothers?|fathers?|brothers?|sisters?|sons?|daughters?|husbands?|wife|wives|boyfriends?|girlfriends?|partners?)$/i;
const SHE_IS_MILA = /\b(she|he)\b\s+(is|was|will|can|knows)\s+Mila\b/i;
/**
 * The exact sentences that state the rule; they name the pronouns on purpose. Exact matches only: any other sentence
 * with a pronoun after Mila is linted. Add a sentence here only when it IS the rule.
 */
export const G7_RULE_SENTENCES = ["Never gender Mila: no she, he, her or his for Mila."];

/** Every place in one file's text where Mila is gendered, as [1-based line of the pronoun, the words that caught it]. */
export function genderedMila(text: string): Array<[number, string]> {
  let t = text.replace(/\r\n/g, "\n");
  for (const rule of G7_RULE_SENTENCES) t = t.split(rule).join(" ".repeat(rule.length));
  const out: Array<[number, string]> = [];
  let last: { who: "mila" | "person"; word: string } | null = null;
  t.split("\n").forEach((line, i) => {
    // a blank line, a heading, a list item, a table row or a tag line starts a new sentence (and a heading ends one)
    if (/^\s*$/.test(line) || /^\s*(#|[-*+] |\d+\. |\||<)/.test(line)) last = null;
    const sm = SHE_IS_MILA.exec(line);
    if (sm) out.push([i + 1, sm[0]]);
    for (const m of line.matchAll(/[A-Za-z]+(?:'s|s')?|[.!?](?=\s|$)/g)) {
      const tok = m[0];
      if (/^[.!?]$/.test(tok)) { last = null; continue; }
      const word = tok.replace(/'s$|'$/, "");
      if (/^Mila$/i.test(word)) last = { who: "mila", word: tok };
      else if (PERSON.test(word)) last = { who: "person", word: tok };
      else if (GENDERED_PRONOUN.test(word) && last?.who === "mila") out.push([i + 1, `${last.word} … ${tok}`]);
    }
    if (/^\s*#/.test(line)) last = null;
  });
  return out;
}

function skillFolders(dir: string): string[] {
  const root = join(dir, SKILLS_SUBDIR);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory()).sort();
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every problem in one Mila folder, as messages a developer can act on. */
export function guardProblems(dir: string): string[] {
  const out: string[] = [];
  const registerIds = new Map<string, string>();

  for (const folder of skillFolders(dir)) {
    const where = `skills/${folder}`;
    const skillFile = join(dir, SKILLS_SUBDIR, folder, SKILL_FILE);
    if (!existsSync(skillFile)) { out.push(`G2 ${where}: no ${SKILL_FILE}`); continue; }
    const text = readFileSync(skillFile, "utf8");

    // G1 + G2
    let fm: unknown;
    try { fm = splitFrontMatter(text).frontMatter; } catch (err: any) { out.push(`G2 ${where}: front-matter is not valid YAML: ${err.message}`); fm = undefined; }
    if (fm === null) out.push(`G2 ${where}: ${SKILL_FILE} has no front-matter (--- name / description ---)`);
    else if (fm !== undefined) {
      const parsed = skillFrontMatterSchema.safeParse(fm);
      if (!parsed.success) out.push(`G2 ${where}: invalid front-matter: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      const name = (fm as any)?.name;
      if (name !== folder) out.push(`G1 ${where}: front-matter name "${name}" differs from the folder name "${folder}"`);
    }

    // G3 + G8
    const sidecarFile = join(dir, SKILLS_SUBDIR, folder, SIDECAR_FILE);
    if (!existsSync(sidecarFile)) out.push(`G3 ${where}: no ${SIDECAR_FILE}`);
    else {
      let raw: any;
      try { raw = parseYaml(readFileSync(sidecarFile, "utf8")); } catch (err: any) { out.push(`G3 ${where}: ${SIDECAR_FILE} is not valid YAML: ${err.message}`); }
      if (raw !== undefined) {
        if (!raw || typeof raw.register_id !== "string" || !raw.register_id) out.push(`G8 ${where}: ${SIDECAR_FILE} has no register_id (e.g. mila.playbook.${folder})`);
        else if (registerIds.has(raw.register_id)) out.push(`G8 ${where}: register_id ${raw.register_id} is also used by ${registerIds.get(raw.register_id)}`);
        else registerIds.set(raw.register_id, where);
        const parsed = sidecarSchema.safeParse(raw);
        if (!parsed.success) out.push(`G3 ${where}: invalid ${SIDECAR_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
      }
    }

    // G4
    const body = splitFrontMatter(text).body;
    const lines = body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
    if (lines > MAX_BODY_LINES) out.push(`G4 ${where}: body is ${lines} lines (at most ${MAX_BODY_LINES}); move detail into a file one level down`);

    // G5: links in the body and files in the folder go at most one level down from SKILL.md
    const visible = body.replace(/<!--[\s\S]*?-->/g, "");
    for (const m of visible.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split("#")[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;   // anchors, http(s):, mailto:
      if (target.startsWith("/") || target.split("/").includes("..") || target.replace(/^\.\//, "").split("/").length > 2) {
        out.push(`G5 ${where}: reference "${m[1]}" goes more than one level deep from ${SKILL_FILE}`);
      }
    }
    for (const f of walk(join(dir, SKILLS_SUBDIR, folder))) {
      if (relative(join(dir, SKILLS_SUBDIR, folder), f).split(sep).length > 2) out.push(`G5 ${where}: ${relative(dir, f).split(sep).join("/")} is more than one level deep`);
    }
  }

  // G6: the lock
  const lockFile = join(dir, LOCK_FILE);
  const lock: SkillsLock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, "utf8")) : {};
  let now: SkillsLock = {};
  try { now = buildSkillsLock(dir); } catch { /* an invalid sidecar is reported above */ }
  const blocked = lockProblems(lock, now);
  for (const p of blocked) out.push(`G6 skills/${p.name}: ${p.message}; ${LOCK_HINT}`);
  for (const [name, e] of Object.entries(now)) {
    const was = lock[name];
    if (!was) out.push(`G6 skills/${name}: not in ${LOCK_FILE}; run \`npm run mila:lock\``);
    else if (blocked.some((p) => p.name === name)) continue;
    else if (was.body_sha256 !== e.body_sha256 || was.version !== e.version) out.push(`G6 skills/${name}: ${LOCK_FILE} is out of date (${was.version} → ${e.version}); run \`npm run mila:lock\``);
  }
  for (const name of Object.keys(lock)) if (!now[name] && !existsSync(join(dir, SKILLS_SUBDIR, name))) out.push(`G6 ${LOCK_FILE}: "${name}" has no skill; run \`npm run mila:lock\``);

  // G7: Mila is never gendered (genderedMila)
  const textFiles = [
    ...(existsSync(join(dir, INSTRUCTIONS_SUBDIR)) ? walk(join(dir, INSTRUCTIONS_SUBDIR)) : []),
    ...(existsSync(join(dir, "surfaces")) ? walk(join(dir, "surfaces")) : []),
    ...(existsSync(join(dir, "proactive.md")) ? [join(dir, "proactive.md")] : []),
    ...(existsSync(join(dir, SKILLS_SUBDIR)) ? walk(join(dir, SKILLS_SUBDIR)) : []),
  ].filter((f) => f.endsWith(".md"));
  for (const f of textFiles) {
    for (const [line, words] of genderedMila(readFileSync(f, "utf8"))) {
      out.push(`G7 ${relative(dir, f).split(sep).join("/")}:${line}: Mila is gendered ("${words}"); Mila is never she/he`);
    }
  }
  return out;
}

describe("Mila's definition guard", () => {
  test("the real definition passes every rule", () => {
    expect(guardProblems(MILA_DIR)).toEqual([]);
  });

  test("every skill folder has a lock entry and nothing else does", () => {
    const lock = JSON.parse(readFileSync(join(MILA_DIR, LOCK_FILE), "utf8"));
    expect(Object.keys(lock).sort()).toEqual(skillFolders(MILA_DIR));
  });

  describe("each rule fires on a folder that breaks it", () => {
    let dir: string;
    const good = (name: string, body = "# Title\n\nDo the thing.\n") =>
      `---\nname: ${name}\ndescription: Does one thing for an athlete. Use when they ask for it.\n---\n${body}`;
    const sidecar = (name: string, extra: Record<string, string> = {}) =>
      Object.entries({
        version: "1.0.0", register_id: `mila.playbook.${name}`, surfaces: "[chat]", flag: "null", tools: "[]",
        sends_externally: "false", model_tier: "athlete-facing", evals: "null", ...extra,
      }).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${v}`).join("\n") + "\n";
    const put = (rel: string, text: string) => {
      const p = join(dir, ...rel.split("/"));
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text, "utf8");
    };
    const skill = (name: string, md = good(name), yaml = sidecar(name)) => {
      put(`skills/${name}/SKILL.md`, md);
      put(`skills/${name}/nomila.yaml`, yaml);
    };
    const lockNow = () => {
      let lock: SkillsLock = {};
      try { lock = buildSkillsLock(dir); } catch { /* an invalid sidecar: nothing to lock */ }
      writeFileSync(join(dir, LOCK_FILE), JSON.stringify(lock), "utf8");
    };
    const rules = () => guardProblems(dir).map((p) => p.slice(0, 2));

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "mila-guard-"));
      put("instructions/00-identity.md", "<identity>\n# Who you are\n\nYou are Mila.\n</identity>\n");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("a clean folder passes", () => {
      skill("deals");
      lockNow();
      expect(guardProblems(dir)).toEqual([]);
    });

    test("G1 folder name and name differ", () => {
      skill("deals", good("dealz"));
      lockNow();
      expect(rules()).toContain("G1");
    });

    test("G2 no front-matter, or an invalid one", () => {
      skill("deals", "# Deals\n");
      skill("bookings", "---\nname: bookings\n---\nbody\n");                          // description missing
      skill("docs", `---\nname: docs\ndescription: ${"x".repeat(1025)}\n---\nbody\n`); // too long
      skill("bad--name", good("bad--name"));
      lockNow();
      expect(guardProblems(dir).filter((p) => p.startsWith("G2")).length).toBeGreaterThanOrEqual(4);
    });

    test("G3 the sidecar fails its schema", () => {
      skill("deals", good("deals"), sidecar("deals", { surfaces: "[chat, email]", model_tier: "fast" }));
      lockNow();
      expect(rules()).toContain("G3");
    });

    test("G4 a body over 500 lines", () => {
      skill("deals", good("deals", Array.from({ length: 501 }, (_, i) => `line ${i}`).join("\n") + "\n"));
      lockNow();
      expect(rules()).toContain("G4");
    });

    test("G5 references more than one level deep", () => {
      skill("deals", good("deals", "See [the terms](references/terms.md) and [more](references/deep/more.md).\n"));
      put("skills/deals/references/deep/more.md", "x\n");
      lockNow();
      const g5 = guardProblems(dir).filter((p) => p.startsWith("G5"));
      expect(g5).toHaveLength(2);   // the link and the nested file; references/terms.md is fine
      expect(g5.join("\n")).not.toContain("references/terms.md\"");
    });

    test("G6 a body change without a version bump, and a stale lock", () => {
      skill("deals");
      lockNow();
      skill("deals", good("deals", "# Title\n\nDo the other thing.\n"));
      expect(guardProblems(dir).find((p) => p.startsWith("G6"))).toMatch(/without a version bump.*npm run mila:lock/);
      skill("deals", good("deals", "# Title\n\nDo the other thing.\n"), sidecar("deals", { version: "1.0.1" }));
      expect(guardProblems(dir).find((p) => p.startsWith("G6"))).toMatch(/out of date.*npm run mila:lock/);
      lockNow();
      expect(guardProblems(dir)).toEqual([]);
    });

    test("G7 Mila gendered, with few false positives", () => {
      skill("deals", good("deals", "Mila reads the deal, then she drafts a reply.\n"));
      // "His" is in the next sentence, and the rule sentence is allowlisted exactly: neither is caught
      put("instructions/10-soul.md", "Mila is warm. His tone is calm.\nNever gender Mila: no she, he, her or his for Mila.\n");
      lockNow();
      expect(guardProblems(dir).filter((p) => p.startsWith("G7"))).toHaveLength(1);
      // a negation is no exemption: only the exact rule sentence is
      put("instructions/10-soul.md", "Never gender Mila; she is calm.\n");
      expect(guardProblems(dir).filter((p) => p.startsWith("G7"))).toHaveLength(2);
      put("instructions/10-soul.md", "Mila is warm.\n");
      // the athlete's pronouns are fine, and so are words that merely contain "he"
      skill("deals", good("deals", "Mila reads the deal. They decide; then Mila tells them the next step.\n"));
      lockNow();
      expect(rules()).not.toContain("G7");
    });

    test("G8 a register_id missing or used twice", () => {
      skill("deals", good("deals"), sidecar("deals", { register_id: "" }));
      skill("bookings", good("bookings"), sidecar("bookings", { register_id: "mila.playbook.same" }));
      skill("documents", good("documents"), sidecar("documents", { register_id: "mila.playbook.same" }));
      lockNow();
      const g8 = guardProblems(dir).filter((p) => p.startsWith("G8"));
      expect(g8).toHaveLength(2);
    });
  });

  describe("G7 genderedMila", () => {
    test.each([
      ["Mila never guesses; she asks."],
      ["Mila does not send it; she drafts it."],
      ["Mila reads the deal, then she drafts a reply."],
      ["Mila's job is hard,\nbut she does it."],          // one sentence wrapped over two lines
      ["Never gender Mila. Mila, she is calm."],          // not the exact rule sentence
      ["Then he is Mila."],
    ])("flags %j", (text) => {
      expect(genderedMila(text)).not.toEqual([]);
    });
    test.each([
      ["Mila tells the athlete what he earned."],
      ["Mila checks the athlete's deal: is it hers?"],
      ["Mila is warm. His tone is calm."],
      ["# Mila\n\nHer coach called."],
      ["- Mila drafts it.\n- She signs it."],
      ["Mila tells them the next step, and their coach says he agrees."],
      ["Never gender Mila: no she, he, her or his for Mila."],
    ])("passes %j", (text) => {
      expect(genderedMila(text)).toEqual([]);
    });
    test("reports the pronoun's line", () => {
      expect(genderedMila("Intro.\nMila reads it\nand then she replies.")).toEqual([[3, "Mila … she"]]);
    });
  });

  test("the lock hashes the served text (readSkill), not the raw body", () => {
    expect(readSkillBody("deals")).toMatch(/<!--/);
    expect(readSkill("deals")).not.toMatch(/<!--/);
    expect(skillBodyDigest("deals")).toBe(createHash("sha256").update(readSkill("deals")).digest("hex"));
  });

  describe("G6 and npm run mila:lock (lockProblems)", () => {
    let dir: string;
    const put = (rel: string, text: string) => {
      const p = join(dir, ...rel.split("/"));
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text, "utf8");
    };
    const md = (comment: string, body = "Do the thing.") =>
      `---\nname: deals\ndescription: Does one thing. Use when asked.\n---\n<!-- ${comment} -->\n# Title\n\n${body}\n`;
    const yaml = (v: string) =>
      `version: ${v}\nregister_id: mila.playbook.deals\nsurfaces: [chat]\nflag: null\ntools: []\nsends_externally: false\nmodel_tier: athlete-facing\nevals: null\n`;
    const locked = (): SkillsLock => JSON.parse(readFileSync(join(dir, LOCK_FILE), "utf8"));
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "mila-lock-"));
      put("skills/deals/SKILL.md", md("one note"));
      put("skills/deals/nomila.yaml", yaml("1.2.0"));
      writeFileSync(join(dir, LOCK_FILE), JSON.stringify(buildSkillsLock(dir)), "utf8");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("an authoring-comment edit changes nothing served, so it needs no bump", () => {
      put("skills/deals/SKILL.md", md("another note"));
      expect(guardProblems(dir)).toEqual([]);
      expect(lockProblems(locked(), buildSkillsLock(dir))).toEqual([]);
    });

    test("a version lower than the locked one is refused", () => {
      put("skills/deals/SKILL.md", md("one note", "Do the other thing."));
      put("skills/deals/nomila.yaml", yaml("1.1.9"));
      expect(guardProblems(dir).filter((p) => p.startsWith("G6"))).toEqual([expect.stringMatching(/version 1\.1\.9 is lower than the locked 1\.2\.0/)]);
      expect(lockProblems(locked(), buildSkillsLock(dir))).toEqual([{ name: "deals", message: expect.stringMatching(/lower than the locked 1\.2\.0/) }]);
      put("skills/deals/nomila.yaml", yaml("1.10.0"));   // numeric, not string, order
      expect(lockProblems(locked(), buildSkillsLock(dir))).toEqual([]);
    });

    test("compareVersions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
      expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
      expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    });
  });

  describe("one loader: only load.ts reads Mila's files", () => {
    /** Non-test source files under `root` (except mila/load.ts) whose readFileSync reads a Mila definition path. */
    const MILA_PATH = /MILA_DIR|corePath\(|skillPath\(|proactive\.md|["']surfaces["']|["']agent["']\s*,\s*["']mila["']|agent[/\\]+mila/;
    const directReaders = (root: string, files = walk(root)): string[] =>
      files
        .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && relative(root, f).split(sep).join("/") !== "agent/mila/load.ts")
        .filter((f) => {
          const src = readFileSync(f, "utf8");
          return [...src.matchAll(/readFileSync\s*\(([^;]*)/g)].some((m) => MILA_PATH.test(m[1])) ||
            // MILA_DIR imported from the loader (not a file's own constant of that name, like routes/publicPage.ts)
            (/\breadFileSync\b/.test(src) && /import[^;]*\bMILA_DIR\b[^;]*from\s*["'][^"']*mila\/(build|load)["']/.test(src));
        })
        .map((f) => relative(root, f).split(sep).join("/"));
    const SERVER = join(MILA_DIR, "..", "..");

    test("no file under server/ but mila/load.ts", () => {
      expect(directReaders(SERVER)).toEqual([]);
    });

    test("the check catches the old direct reads", () => {
      const tmp = mkdtempSync(join(tmpdir(), "mila-readers-"));
      try {
        mkdirSync(join(tmp, "agent", "proactive"), { recursive: true });
        writeFileSync(join(tmp, "agent", "proactive", "turn.ts"), `cleanSection(readFileSync(join(MILA_DIR, "proactive.md"), "utf8"));\n`);
        writeFileSync(join(tmp, "agent", "x.ts"), `readFileSync(join(process.cwd(), "server", "agent", "mila", "surfaces", "waitlist.md"));\n`);
        writeFileSync(join(tmp, "agent", "ok.ts"), `readFileSync(join(jobsDir(), "waitlist.md"));\n`);
        writeFileSync(join(tmp, "agent", "y.ts"), `import { MILA_DIR } from "../mila/build";\nconst p = join(MILA_DIR, f);\nreadFileSync(p);\n`);
        writeFileSync(join(tmp, "agent", "own.ts"), `const MILA_DIR = () => "assets/mila";\nconst p = join(MILA_DIR(), f);\nreadFileSync(p);\n`);
        expect(directReaders(tmp).sort()).toEqual(["agent/proactive/turn.ts", "agent/x.ts", "agent/y.ts"]);
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    });
  });
});
