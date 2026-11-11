/**
 * mila/load.ts — the ONE loader for Mila's text. Everything that reads Mila's definition goes through here (build.ts
 * keeps its exported API and delegates).
 *
 *   server/agent/mila/
 *     instructions/NN-*.md      the numbered core, assembled in file-name order (buildMilaInstructions in build.ts)
 *     surfaces/<surface>.md     the part that says where Mila is
 *     proactive.md              the proactive part
 *     skills/<name>/SKILL.md    one playbook: Agent Skills front-matter (agentskills.io/specification) + the body
 *     skills/<name>/nomila.yaml Nomila's own fields for that playbook (sidecarSchema below)
 *     skills.lock.json          served-text sha256 + version per skill (mila.guard.test.ts; `npm run mila:lock`)
 *
 * A file's served text is cleanSection(body): front-matter out, HTML comments (authoring notes) out, trailing spaces
 * trimmed, at most one blank line in a row. The front-matter and the sidecar never reach the model.
 *
 * Engine terms (3 Nov 2026): a core or surface file may write an engine-specific word as {{term}} (ENGINE_TERMS): the
 * tool that loads a playbook (Mastra's own `skill` tool, engine/mastra/skills.ts) and {{context_holds}}, what CONTEXT
 * holds. Mastra is the only engine now (TrueForge's column went with TrueForge, Mastra-only PR 3; the harness's with
 * the harness, PR 2), so readCore / readSurface render Mastra's words, the text served.golden.json pins. The terms
 * stay so the files need no edit when a word differs again. Skills carry no terms.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * This folder. In the server image the code is one esbuild bundle (server_dist/index.cjs), so __dirname is server_dist
 * there; the definition's markdown is copied next to it at server/agent/mila (Dockerfile), read from the working
 * directory as server/agent/jobs is (jobs.ts).
 */
export const MILA_DIR = existsSync(join(__dirname, "proactive.md")) ? __dirname : join(process.cwd(), "server", "agent", "mila");
export const INSTRUCTIONS_SUBDIR = "instructions";
export const SKILLS_SUBDIR = "skills";
export const SKILL_FILE = "SKILL.md";
export const SIDECAR_FILE = "nomila.yaml";
export const LOCK_FILE = "skills.lock.json";

/** Authoring comments out, trailing spaces trimmed, at most one blank line in a row. */
export function cleanSection(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── engine terms ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Mastra only: TrueForge's column went with TrueForge (Mastra-only PR 3), the harness's with the harness (PR 2). */
export const MILA_TEXT_ENGINES = ["mastra"] as const;
export type MilaTextEngine = (typeof MILA_TEXT_ENGINES)[number];

/**
 * What the lean CONTEXT leaves out (agent/engine/context.ts): the words 30-how-to-work said before terms existed
 * (3 Nov 2026), unchanged.
 */
const LEAN_CONTEXT_HOLDS =
  "It holds no facts, no M.I.A. detail and no past conversations: get facts with\nrecall_facts, and their M.I.A., strengths and partners with read_scouting; this conversation's earlier turns are above.";

/**
 * What a core or surface file's {{term}} says, per engine: a word, or for context_holds the sentences on what CONTEXT
 * holds. Model-facing (Prompt Register).
 */
export const ENGINE_TERMS: Readonly<Record<MilaTextEngine, Readonly<Record<string, string>>>> = {
  mastra: { playbook_tool: "the skill tool", context_holds: LEAN_CONTEXT_HOLDS },
};

const TERM_RE = /\{\{([a-z_]+)\}\}/g;

/** A text's {{term}}s rendered for one engine. An unknown engine or term throws (a typo never reaches the model). */
export function renderEngineTerms(text: string, engine: MilaTextEngine = "mastra"): string {
  const terms = ENGINE_TERMS[engine];
  if (!terms) throw new Error(`unknown Mila engine "${engine}"`);
  return text.replace(TERM_RE, (_, term: string) => {
    if (!Object.prototype.hasOwnProperty.call(terms, term)) throw new Error(`unknown Mila engine term {{${term}}}`);
    return terms[term];
  });
}

// ─── front-matter (Agent Skills spec) ──────────────────────────────────────────────────────────────────────────────

/** Agent Skills `name`: lowercase a-z, 0-9 and single hyphens, no leading or trailing hyphen, at most 64 characters. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const skillFrontMatterSchema = z.object({
  name: z.string().min(1).max(64).regex(SKILL_NAME_RE),
  description: z.string().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  "allowed-tools": z.string().optional(),
}).strict();
export type SkillFrontMatter = z.infer<typeof skillFrontMatterSchema>;

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a file into its YAML front-matter (null when there is none) and its body. */
export function splitFrontMatter(text: string): { frontMatter: unknown; body: string } {
  const m = FRONT_MATTER_RE.exec(text);
  if (!m) return { frontMatter: null, body: text };
  return { frontMatter: parseYaml(m[1]) ?? {}, body: m[2] };
}

// ─── the sidecar (nomila.yaml) ─────────────────────────────────────────────────────────────────────────────────────

export const MILA_SKILL_SURFACES = ["chat", "voice", "proactive", "waitlist", "public"] as const;

export const sidecarSchema = z.object({
  /** semver; bump it whenever the skill's served text changes (skills.lock.json). */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** The Prompt Register entry, e.g. mila.playbook.deals. */
  register_id: z.string().regex(/^mila\.playbook\.[a-z0-9-]+$/),
  /** Where the playbook is meant to be used. */
  surfaces: z.array(z.enum(MILA_SKILL_SURFACES)).min(1),
  /** The flag the playbook's tools sit behind, or null. */
  flag: z.string().min(1).nullable(),
  /**
   * The tools the playbook's text refers to. Declarative only: nothing grants a pass these tools from here (a pass's
   * tools come from its skill front-matter under server/agent/jobs, and loading a playbook never changes them).
   */
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)),
  /** The playbook's work can put something in front of someone outside Nomila (a brand, a buyer), always on their tap. */
  sends_externally: z.boolean(),
  model_tier: z.literal("athlete-facing"),
  /** The eval cases that cover it, or null. */
  evals: z.string().min(1).nullable(),
}).strict();
export type MilaSkillSidecar = z.infer<typeof sidecarSchema>;

// ─── reading ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The numbered core files, in order (00-…, 10-…, …), as file names inside instructions/.
 *
 * 35-delegate.md ("When to hand work to a helper", the <delegating> section) was removed on 9 Nov 2026: it came from
 * TrueForge, which had sub-agents, and Mastra has no helper tool, so it told Mila about a capability it does not have.
 * Bring it back when helpers are built on Mastra; git history holds the text.
 */
export function coreFiles(dir: string = MILA_DIR): string[] {
  return readdirSync(join(dir, INSTRUCTIONS_SUBDIR)).filter((f) => /^\d{2}-.+\.md$/.test(f)).sort();
}

/** The path of a core file (a name coreFiles returned). */
export function corePath(file: string, dir: string = MILA_DIR): string {
  return join(dir, INSTRUCTIONS_SUBDIR, file);
}

/** One core file as served, its {{term}}s rendered for `engine` (Mastra, the only one). */
export function readCore(file: string, dir: string = MILA_DIR, engine: MilaTextEngine = "mastra"): string {
  return renderEngineTerms(cleanSection(readFileSync(corePath(file, dir), "utf8")), engine);
}

/** One surface file (surfaces/<surface>.md) as served, its {{term}}s rendered for `engine` (Mastra, the only one). */
export function readSurface(surface: string, dir: string = MILA_DIR, engine: MilaTextEngine = "mastra"): string {
  return renderEngineTerms(cleanSection(readFileSync(join(dir, "surfaces", `${surface}.md`), "utf8")), engine);
}

/** proactive.md as served (the proactive pass's preface). */
export function readProactive(dir: string = MILA_DIR): string {
  return cleanSection(readFileSync(join(dir, "proactive.md"), "utf8"));
}

/** Every skill folder that holds a SKILL.md, sorted. */
export function listSkillNames(dir: string = MILA_DIR): string[] {
  const root = join(dir, SKILLS_SUBDIR);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SKILL_NAME_RE.test(e.name) && existsSync(join(root, e.name, SKILL_FILE)))
    .map((e) => e.name)
    .sort();
}

export function skillPath(name: string, dir: string = MILA_DIR): string {
  return join(dir, SKILLS_SUBDIR, name, SKILL_FILE);
}

/** A skill's raw body (after the front-matter), line endings as on disk. */
export function readSkillBody(name: string, dir: string = MILA_DIR): string {
  return splitFrontMatter(readFileSync(skillPath(name, dir), "utf8")).body;
}

/** A skill's served text: the body, cleaned, with one trailing newline (what Mastra's skill tool serves). */
export function readSkill(name: string, dir: string = MILA_DIR): string {
  return cleanSection(readSkillBody(name, dir)) + "\n";
}

/** A skill's front-matter, validated. Throws on a missing or invalid block. */
export function readSkillFrontMatter(name: string, dir: string = MILA_DIR): SkillFrontMatter {
  const { frontMatter } = splitFrontMatter(readFileSync(skillPath(name, dir), "utf8"));
  if (frontMatter === null) throw new Error(`skills/${name}/${SKILL_FILE} has no front-matter`);
  return skillFrontMatterSchema.parse(frontMatter);
}

/** A skill's sidecar (nomila.yaml), validated. */
export function readSidecar(name: string, dir: string = MILA_DIR): MilaSkillSidecar {
  return sidecarSchema.parse(parseYaml(readFileSync(join(dir, SKILLS_SUBDIR, name, SIDECAR_FILE), "utf8")));
}

/**
 * sha256 (hex) of a skill's SERVED text (readSkill, what Mastra's skill tool serves), so an edit to an authoring comment or to
 * whitespace, which the model never sees, needs no version bump. cleanSection drops the CRs, so a Windows checkout gives
 * the same digest.
 */
export function skillBodyDigest(name: string, dir: string = MILA_DIR): string {
  return createHash("sha256").update(readSkill(name, dir)).digest("hex");
}

export type SkillsLock = Record<string, { version: string; body_sha256: string }>;

/** -1, 0 or 1 as semver a is lower than, equal to or higher than b (plain x.y.z, as sidecarSchema allows). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * What stops the lock on disk (`before`) being replaced by the lock for the skills on disk (`after`): a served-text
 * change whose version was not bumped, or a version lower than the locked one (versions only go up). Used by the guard
 * (G6) and by `npm run mila:lock`, which refuses to write while any is left.
 */
export function lockProblems(before: SkillsLock, after: SkillsLock): Array<{ name: string; message: string }> {
  const out: Array<{ name: string; message: string }> = [];
  for (const [name, e] of Object.entries(after)) {
    const was = before[name];
    if (!was) continue;
    if (compareVersions(e.version, was.version) < 0) out.push({ name, message: `version ${e.version} is lower than the locked ${was.version}; versions only go up` });
    else if (was.version === e.version && was.body_sha256 !== e.body_sha256) out.push({ name, message: `the served text changed without a version bump (still ${e.version})` });
  }
  return out;
}

/** The lock as it should be for the skills on disk (`npm run mila:lock` writes it; the guard test compares). */
export function buildSkillsLock(dir: string = MILA_DIR): SkillsLock {
  const lock: SkillsLock = {};
  for (const name of listSkillNames(dir)) lock[name] = { version: readSidecar(name, dir).version, body_sha256: skillBodyDigest(name, dir) };
  return lock;
}
