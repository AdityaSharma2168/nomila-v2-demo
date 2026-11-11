/**
 * catalogue/build.ts — "see everything": ONE generated catalogue of what Mila and the server are made of, read from the
 * REPO (the loaders, the registries and the source), never from a hand-written list.
 *
 *   npm run catalogue          writes docs/catalogue/catalogue.json, prompt-register.json and index.html
 *   npm run catalogue -- --check   exits 1 when the committed JSON differs from what the repo generates
 *
 * Sections: Mila CORE (instructions/* and the built text per surface), Mila SKILLS (playbooks), JOB PROMPTS (every
 * prompt the job loader serves), TOOLS (what Mila can call on the Mastra engine), CARDS (shared/milaCards.ts DTOs),
 * FLAGS (env reads vs the deploy files), WORKFLOWS and CRONS, INLINE PROMPTS (a heuristic TODO list).
 *
 * prompt-register.json is the generated Prompt Register: the exact served text of every CORE, SKILL and JOB prompt
 * with its digest and version.
 *
 * Deterministic: sorted everywhere, LF text, sha256 digests, no timestamps and no line numbers in the JSON (the HTML
 * shows lines). scripts/catalogue/catalogue.test.ts fails CI when the committed JSON is stale.
 *
 * Nothing here reaches a database or a provider: the server modules it imports are loaded with a placeholder
 * DATABASE_URL when none is set (server/db.ts builds its pool lazily and never connects at import) and nothing is called
 * but the loaders and registries. It never reads .env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderHtml } from "./html";
import {
  cloudRunEnv, easEnv, lf, readText, rel, scanClientEnv, scanServer, schedulerJobs, sha256, short,
  type InlinePrompt, type InProcessCron, type InternalRoute, type SchedulerJob,
} from "./scan";

export const OUT_DIR = join("docs", "catalogue");
export const CATALOGUE_FILE = "catalogue.json";
export const REGISTER_FILE = "prompt-register.json";
export const HTML_FILE = "index.html";

/** The job loader (server/agent/jobs.ts): every job prompt is listed and loaded through its API, never its folder. */
const JOB_LOADER = "server/agent/jobs";

// ─── shapes ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RegisterEntry {
  id: string;
  kind: "core-part" | "core-built" | "skill" | "job";
  source: string;
  version: string | null;
  sha256: string;
  chars: number;
  approxTokens: number;
  text: string;
}

export interface FlagRow {
  name: string;
  readIn: string[];
  read: "direct" | "helper" | "not read";
  values: Record<string, string | null>;
  boolean: boolean;
  defaultOn: boolean;
  status: "always-on" | "never-on" | "inverted" | "differs" | "config" | "unread" | "script";
}

export interface Catalogue {
  generator: string;
  counts: Record<string, number>;
  core: {
    dir: string;
    files: Array<{ file: string; bytes: number; sha256: string; servedChars: number; servedSha256: string }>;
    surfaces: Array<{ file: string; bytes: number; sha256: string }>;
    built: Array<{ surface: string; coreFiles: string[] | "all"; chars: number; approxTokens: number; sha256: string; registerId: string }>;
  };
  skills: Array<{
    name: string; description: string; version: string; register_id: string; surfaces: string[]; flag: string | null;
    tools: string[]; sends_externally: boolean; model_tier: string; evals: string | null; servedSha256: string; lockMatches: boolean;
  }>;
  jobs: { loader: string; dir: string; items: Array<{ id: string; version: string; description: string; model: string; effort: string; tools: string[]; inputs: string[]; outputs: string[]; promptDigest: string }> };
  tools: Array<{
    name: string; permission: string; kind: string; description: string; money: boolean; flagGated: boolean; toolset: string | null;
    milaCallable: boolean; passes: string[]; playbooks: string[]; displayRule: boolean; statusLine: string | null; cardTypes: string[];
    cardDtos: string[]; sends_externally: boolean; inSendingPlaybook: boolean; args: unknown;
  }>;
  cards: Array<{ type: string; fields: Record<string, string>; madeBy: string[] }>;
  flags: { sources: Record<string, string>; server: FlagRow[]; client: FlagRow[] };
  workflows: Array<{ process: string; versions: Array<{ version: number; steps: string[] }>; defaultVersion: number | null }>;
  internalRoutes: Array<Omit<InternalRoute, "line">>;
  schedulerJobs: Array<SchedulerJob & { routeFound: boolean }>;
  inProcessCrons: Array<Omit<InProcessCron, "line">>;
  inlinePrompts: Array<Omit<InlinePrompt, "line">>;
}

export interface BuildResult {
  catalogue: Catalogue;
  register: { generator: string; count: number; entries: RegisterEntry[] };
  html: string;
}

const approxTokens = (t: string) => Math.round(t.length / 4);
const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const byKey = <T>(k: (x: T) => string) => (a: T, b: T) => k(a).localeCompare(k(b));
const omitLine = <T extends { line: number }>({ line: _line, ...rest }: T): Omit<T, "line"> => rest;
const CR = String.fromCharCode(13);
const TRUTHY = /^(true|1|on|yes)$/i;
const BOOLEANISH = /^(true|false|on|off|yes|no)$/i;

/** Zod v3 → a short type string, for the card field table. */
function zodType(s: any): string {
  const d = s?._def;
  switch (d?.typeName) {
    case "ZodOptional": return `${zodType(d.innerType)}?`;
    case "ZodNullable": return `${zodType(d.innerType)} | null`;
    case "ZodDefault": return zodType(d.innerType);
    case "ZodEffects": return zodType(d.schema);
    case "ZodPipeline": return zodType(d.in);
    case "ZodArray": { const t = zodType(d.type); return / \| /.test(t) ? `(${t})[]` : `${t}[]`; }
    case "ZodLiteral": return JSON.stringify(d.value);
    case "ZodEnum": return d.values.map((v: string) => JSON.stringify(v)).join(" | ");
    case "ZodUnion": return d.options.map(zodType).join(" | ");
    case "ZodObject": return `{ ${Object.keys(s.shape).join(", ")} }`;
    default: return d?.typeName ? String(d.typeName).replace(/^Zod/, "").toLowerCase() : "unknown";
  }
}

function unwrapObject(s: any): any {
  let x = s;
  while (x?._def && x._def.typeName !== "ZodObject") x = x._def.schema ?? x._def.innerType ?? x._def.in;
  return x;
}

// ─── build ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function buildCatalogue(root: string = process.cwd()): Promise<BuildResult> {
  if (!existsSync(join(root, "server", "agent", "mila", "load.ts"))) throw new Error(`catalogue: ${root} is not the nomila-v2 repo root`);
  // server/db.ts refuses to load without a URL; it never connects at import. Never .env (and never a real URL needed).
  process.env.DATABASE_URL ||= "postgres://catalogue:catalogue@127.0.0.1:9/catalogue";

  const load = await import("../../server/agent/mila/load");
  const build = await import("../../server/agent/mila/build");
  const register: RegisterEntry[] = [];
  const entry = (e: Omit<RegisterEntry, "sha256" | "chars" | "approxTokens">): RegisterEntry => {
    const text = lf(e.text);
    const r = { ...e, text, sha256: sha256(text), chars: text.length, approxTokens: approxTokens(text) };
    register.push(r);
    return r;
  };

  // ── Mila CORE
  const milaDir = rel(root, load.MILA_DIR);
  const coreFiles = load.coreFiles();
  const core: Catalogue["core"] = { dir: milaDir, files: [], surfaces: [], built: [] };
  for (const f of coreFiles) {
    const raw = readText(load.corePath(f));
    const served = load.readCore(f);
    core.files.push({ file: `instructions/${f}`, bytes: Buffer.byteLength(raw), sha256: sha256(raw), servedChars: served.length, servedSha256: sha256(served) });
    entry({ id: `mila.core.${f.replace(/\.md$/, "")}`, kind: "core-part", source: `${milaDir}/instructions/${f}`, version: null, text: served });
  }
  for (const s of uniqSorted([...build.MILA_SURFACES, "proactive"])) {
    const file = s === "proactive" ? "proactive.md" : `surfaces/${s}.md`;
    const raw = readText(join(load.MILA_DIR, file));
    core.surfaces.push({ file, bytes: Buffer.byteLength(raw), sha256: sha256(raw) });
    entry({ id: s === "proactive" ? "mila.proactive" : `mila.surface.${s}`, kind: "core-part", source: `${milaDir}/${file}`, version: null,
      text: s === "proactive" ? load.readProactive() : load.readSurface(s) });
  }
  for (const surface of [...build.MILA_SURFACES].sort()) {
    const text = build.buildMilaInstructions({ surface });
    const e = entry({ id: `mila.instructions.${surface}`, kind: "core-built", source: `buildMilaInstructions({ surface: "${surface}" })`, version: null, text });
    core.built.push({ surface, coreFiles: build.SURFACE_CORE[surface], chars: e.chars, approxTokens: e.approxTokens, sha256: e.sha256, registerId: e.id });
  }
  // On Mastra (the only engine) the agent runs the chat surface in Mastra's words (load.ts ENGINE_TERMS), and the
  // waitlist turns send the waitlist surface in them too (waitlist/turn.ts waitlistPreface). Since TrueForge went
  // (Mastra-only PR 3) the default render above IS Mastra's, so these two equal mila.instructions.chat and
  // mila.surface.waitlist; they keep their ids (and hashes) so a catalogue diff shows Mastra's text did not move.
  {
    const text = build.buildMilaInstructions({ surface: "chat", engine: "mastra" });
    const e = entry({ id: "mila.instructions.chat.mastra", kind: "core-built", source: `buildMilaInstructions({ surface: "chat", engine: "mastra" })`, version: null, text });
    core.built.push({ surface: "chat (mastra)", coreFiles: build.SURFACE_CORE.chat, chars: e.chars, approxTokens: e.approxTokens, sha256: e.sha256, registerId: e.id });
    entry({ id: "mila.surface.waitlist.mastra", kind: "core-part", source: `${milaDir}/surfaces/waitlist.md (engine "mastra")`, version: null, text: load.readSurface("waitlist", undefined, "mastra") });
    // Our words in place of Mastra's SkillsProcessor text (engine/mastra/skills.ts): the playbooks message (here with the
    // chat surface's playbooks) and the three skill tools' descriptions.
    const sk = await import("../../server/agent/engine/mastra/skills");
    const chatNames = load.listSkillNames().filter((n) => load.readSidecar(n).surfaces.includes("chat"));
    entry({ id: "mila.mastra.skills.catalog", kind: "core-part", source: "server/agent/engine/mastra/skills.ts playbooksCatalog (chat surface)", version: null,
      text: sk.playbooksCatalog(chatNames.map((n) => load.readSkillFrontMatter(n))) });
    entry({ id: "mila.mastra.skills.tools", kind: "core-part", source: "server/agent/engine/mastra/skills.ts MILA_SKILL_TOOL_DESCRIPTIONS", version: null,
      text: Object.entries(sk.MILA_SKILL_TOOL_DESCRIPTIONS).map(([t, d]) => `${t}: ${d}`).join("\n") });
    // Mila's web_search on Mastra (P1): our own tool in place of the provider built-in; each call runs job chat/web-search.
    const ws = await import("../../server/agent/engine/mastra/webSearch");
    entry({ id: "mila.mastra.tools.web_search", kind: "core-part", source: "server/agent/engine/mastra/webSearch.ts WEB_SEARCH_DESCRIPTION", version: null,
      text: `${ws.WEB_SEARCH_TOOL}: ${ws.WEB_SEARCH_DESCRIPTION}` });
  }

  // ── Mila SKILLS (playbooks)
  const lockPath = join(load.MILA_DIR, load.LOCK_FILE);
  const lock: Record<string, { version: string; body_sha256: string }> = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : {};
  const skills: Catalogue["skills"] = [];
  for (const name of load.listSkillNames()) {
    const fm = load.readSkillFrontMatter(name);
    const sc = load.readSidecar(name);
    const text = load.readSkill(name);
    const digest = sha256(text);
    skills.push({
      name: fm.name, description: fm.description, version: sc.version, register_id: sc.register_id, surfaces: [...sc.surfaces], flag: sc.flag,
      tools: [...sc.tools], sends_externally: sc.sends_externally, model_tier: sc.model_tier, evals: sc.evals, servedSha256: digest,
      lockMatches: lock[name]?.version === sc.version && lock[name]?.body_sha256 === load.skillBodyDigest(name),
    });
    entry({ id: sc.register_id, kind: "skill", source: `${milaDir}/skills/${name}/SKILL.md`, version: sc.version, text });
  }

  // ── JOB PROMPTS, through the loader's own API (whichever directory it serves)
  const { listJobs, loadJob, instructionsFor, promptDigest, jobsDir } = await import("../../server/agent/jobs");
  const jobDir = jobsDir();
  const jobItems: Catalogue["jobs"]["items"] = [];
  for (const { id } of listJobs()) {
    const s = loadJob(id);
    // promptDigest hashes the text as read. On a CRLF (Windows) checkout that differs from the LF text CI and the
    // container serve, so the catalogue records the LF digest: the loader's own value wherever the files are LF.
    const served = instructionsFor(s);
    const digest = served.includes(CR) ? sha256(lf(served)) : promptDigest(s);
    jobItems.push({
      id: s.id, version: s.version, description: s.description, model: s.model, effort: s.effort, tools: [...s.tools],
      inputs: (s.inputs ?? []).map((f: any) => f.name), outputs: (s.outputs ?? []).map((f: any) => f.name), promptDigest: digest,
    });
    const ext = existsSync(join(jobDir, ...s.id.split("/")) + ".md") ? ".md" : ".yaml";
    const e = entry({ id: `job.${s.id}`, kind: "job", source: `${rel(root, jobDir)}/${s.id}${ext}`, version: s.version, text: served });
    if (e.sha256 !== digest) throw new Error(`catalogue: job ${s.id} digest mismatch (register text is not what promptDigest covers)`);
  }
  jobItems.sort(byKey((j) => j.id));

  // ── TOOLS, from the registry the Mastra engine uses (engine/tools/registry.ts passRegistry → engine/mastra/tools.ts)
  const registryMod = await import("../../server/agent/engine/tools/registry");
  const display = await import("../../server/agent/engine/mastra/display");
  const toolStatus = await import("../../server/agent/engine/toolStatus");
  const cardsMod = await import("../../shared/milaCards");
  const { zodToJsonSchema } = await import("../../server/agent/tools");
  const registry = registryMod.passRegistry();
  const passesOf = new Map<string, string[]>();
  for (const { id } of listJobs()) {
    if (id.startsWith("echo/")) continue; // the plumbing check, never a Mila pass (display.test.ts uses the same rule)
    for (const t of registryMod.passSkill(loadJob(id), registry).tools) passesOf.set(t, [...(passesOf.get(t) ?? []), id]);
  }
  const playbooksOf = new Map<string, string[]>();
  for (const s of skills) for (const t of s.tools) playbooksOf.set(t, [...(playbooksOf.get(t) ?? []), s.name]);
  const sendingPlaybooks = new Set(skills.filter((s) => s.sends_externally).map((s) => s.name));
  const tools: Catalogue["tools"] = registry.all().filter((t) => t.kind !== "builtin").map((t) => {
    const cardTypes = [...(display.MILA_TOOL_CARDS[t.name] ?? [])];
    const playbooks = (playbooksOf.get(t.name) ?? []).sort();
    let args: unknown;
    try { args = zodToJsonSchema(t.args); } catch (err: any) { args = { error: String(err?.message ?? err) }; }
    return {
      name: t.name, permission: t.permission, kind: t.kind, description: lf(t.description), money: !!t.money, flagGated: typeof t.enabled === "function",
      toolset: t.toolset?.id ?? null, milaCallable: passesOf.has(t.name), passes: (passesOf.get(t.name) ?? []).sort(), playbooks,
      displayRule: display.hasDisplayRule(t.name), statusLine: toolStatus.TOOL_STATUS_LABELS[t.name] ?? null, cardTypes,
      cardDtos: cardTypes.filter((k) => cardsMod.isMilaCardType(k)),
      // The permission vocabulary's own line (shared/agent.ts): "act" is what leaves Nomila or moves money, and only on
      // the athlete's tap. inSendingPlaybook: listed by a playbook whose nomila.yaml says its work can go out (a draft
      // reply, for one, goes out later through its approval).
      sends_externally: t.permission === "act",
      inSendingPlaybook: playbooks.some((p) => sendingPlaybooks.has(p)),
      args,
    };
  }).sort(byKey((t) => t.name));

  // ── CARDS
  const madeBy = new Map<string, string[]>();
  for (const [tool, kinds] of Object.entries(display.MILA_TOOL_CARDS)) for (const k of kinds) madeBy.set(k, [...(madeBy.get(k) ?? []), tool]);
  for (const k of display.TURN_CARDS) madeBy.set(k, [...(madeBy.get(k) ?? []), "(the turn)"]);
  const cards: Catalogue["cards"] = [...cardsMod.MILA_CARD_TYPES].sort().map((type) => {
    const obj = unwrapObject((cardsMod.MILA_CARD_SCHEMAS as Record<string, unknown>)[type]);
    const fieldsObj = unwrapObject(obj?.shape?.fields);
    const shape: Record<string, unknown> = fieldsObj?.shape ?? {};
    return { type, fields: Object.fromEntries(Object.keys(shape).sort().map((k) => [k, zodType(shape[k])])), madeBy: (madeBy.get(type) ?? []).sort() };
  });

  // ── FLAGS
  const scan = scanServer(root);
  const devRun = cloudRunEnv(join(root, "gcp", "cloud-run-dev.yaml"));
  const prodRun = cloudRunEnv(join(root, "gcp", "cloud-run-prod.yaml"));
  const eas = easEnv(join(root, "eas.json"));
  const easProfiles = Object.keys(eas).sort();
  const flagRows = (reads: Array<{ name: string; file: string; how?: "direct" | "helper"; defaultOn: boolean; boolean?: boolean }>, sources: Record<string, Record<string, string>>, setNames: string[]): FlagRow[] => {
    const names = uniqSorted([...reads.map((r) => r.name), ...setNames]);
    return names.map((name) => {
      const mine = reads.filter((r) => r.name === name);
      const values = Object.fromEntries(Object.entries(sources).map(([src, env]) => [src, env[name] ?? null]));
      const set = Object.values(values).filter((v): v is string => v !== null);
      const defaultOn = mine.some((r) => r.defaultOn);
      const boolean = defaultOn || mine.some((r) => r.boolean) || (set.length > 0 && set.every((v) => BOOLEANISH.test(v)));
      const on = Object.values(values).map((v) => (v === null ? defaultOn : defaultOn ? !/^(false|0|off|no)$/i.test(v) : TRUTHY.test(v)));
      const read: FlagRow["read"] = !mine.length ? "not read" : mine.some((r) => r.how !== "helper") ? "direct" : "helper";
      const scriptOnly = mine.length > 0 && mine.every((r) => r.file.startsWith("server/scripts/"));
      const status: FlagRow["status"] = read === "not read" ? "unread"
        : scriptOnly && !set.length ? "script"
        : !boolean ? "config"
        : defaultOn ? "inverted"
        : on.every(Boolean) ? "always-on"
        : on.every((x) => !x) ? "never-on" : "differs";
      return { name, readIn: uniqSorted(mine.map((r) => r.file)), read, values, boolean, defaultOn, status };
    });
  };
  const serverFlags = flagRows(scan.env, { "cloud-run-dev": devRun, "cloud-run-prod": prodRun }, [...Object.keys(devRun), ...Object.keys(prodRun)])
    .filter((f) => !f.name.startsWith("EXPO_PUBLIC_"));
  const clientReads = scanClientEnv(root);
  const clientFlags = flagRows(clientReads, Object.fromEntries(easProfiles.map((p) => [`eas:${p}`, eas[p]])),
    easProfiles.flatMap((p) => Object.keys(eas[p]).filter((k) => k.startsWith("EXPO_PUBLIC_"))));

  // ── WORKFLOWS and CRONS
  await import("../../server/workflow/definitions");
  const wf = await import("../../server/workflow/registry");
  const workflows: Catalogue["workflows"] = wf.listProcesses().map(({ process: p, versions }) => {
    let defaultVersion: number | null = null;
    try { defaultVersion = wf.getDefinition(p).version; } catch { defaultVersion = null; }
    return { process: p, versions: [...versions].sort((a, b) => a - b).map((v) => ({ version: v, steps: wf.getDefinition(p, v).steps.map((s) => `${s.name}:${s.kind}`) })), defaultVersion };
  }).sort(byKey((w) => w.process));
  const routePaths = new Set(scan.routes.map((r) => r.path));
  const jobsSched = schedulerJobs(join(root, "scripts", "provision-schedulers.sh")).map((j) => ({ ...j, routeFound: routePaths.has(j.path) }));

  const catalogue: Catalogue = {
    generator: "scripts/catalogue/build.ts (npm run catalogue) — generated, do not edit",
    counts: {},
    core,
    skills: skills.sort(byKey((s) => s.name)),
    jobs: { loader: JOB_LOADER, dir: rel(root, jobDir), items: jobItems },
    tools,
    cards,
    flags: { sources: { server: "gcp/cloud-run-dev.yaml, gcp/cloud-run-prod.yaml", client: easProfiles.map((p) => `eas.json build.${p}`).join(", ") }, server: serverFlags, client: clientFlags },
    workflows,
    internalRoutes: scan.routes.map(omitLine).filter((r, i, a) => a.findIndex((x) => x.method === r.method && x.path === r.path && x.file === r.file) === i).sort(byKey((r) => `${r.path} ${r.method} ${r.file}`)),
    schedulerJobs: jobsSched,
    inProcessCrons: scan.crons.map(omitLine),
    inlinePrompts: scan.prompts.map(omitLine),
  };
  catalogue.counts = {
    coreFiles: core.files.length, coreSurfaces: core.built.length, skills: skills.length, jobs: jobItems.length,
    tools: tools.length, milaTools: tools.filter((t) => t.milaCallable).length, cards: cards.length,
    serverFlags: serverFlags.length, clientFlags: clientFlags.length, workflows: workflows.length, internalRoutes: catalogue.internalRoutes.length,
    schedulerJobs: jobsSched.length, inProcessCrons: scan.crons.length, inlinePrompts: scan.prompts.length,
  };
  register.sort(byKey((e) => e.id));
  const reg = { generator: catalogue.generator, count: register.length, entries: register };
  return { catalogue, register: reg, html: renderHtml(catalogue, reg, { crons: scan.crons, prompts: scan.prompts, routes: scan.routes }) };
}

/** The exact bytes each output file holds. */
export function outputs(r: BuildResult): Record<string, string> {
  return {
    [CATALOGUE_FILE]: JSON.stringify(r.catalogue, null, 2) + "\n",
    [REGISTER_FILE]: JSON.stringify(r.register, null, 2) + "\n",
    [HTML_FILE]: r.html,
  };
}

/** The JSON files whose committed copy differs from what the repo generates (the CI staleness check). */
export function staleFiles(root: string, r: BuildResult): string[] {
  return Object.entries(outputs(r)).filter(([f]) => f.endsWith(".json")).filter(([f, text]) => {
    const p = join(root, OUT_DIR, f);
    return !existsSync(p) || lf(readFileSync(p, "utf8")) !== text;
  }).map(([f]) => `${OUT_DIR.split("\\").join("/")}/${f}`);
}

async function main() {
  const root = process.cwd();
  const r = await buildCatalogue(root);
  if (process.argv.includes("--check")) {
    const stale = staleFiles(root, r);
    if (stale.length) { console.error(`catalogue is stale: ${stale.join(", ")} — run \`npm run catalogue\` and commit the result`); process.exit(1); }
    console.log("catalogue is up to date");
    process.exit(0);
  }
  mkdirSync(join(root, OUT_DIR), { recursive: true });
  for (const [f, text] of Object.entries(outputs(r))) writeFileSync(join(root, OUT_DIR, f), text);
  console.log(`catalogue written to ${OUT_DIR}: ${Object.entries(r.catalogue.counts).map(([k, v]) => `${k} ${v}`).join(", ")}; register ${r.register.count}`);
  // The server modules imported above may hold timers or pools; this is a one-shot script.
  process.exit(0);
}

if (process.argv[1] && /catalogue[\\/]build\.ts$/.test(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
