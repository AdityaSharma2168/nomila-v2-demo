/**
 * callTool.guard.test.ts — GUARD: a registered tool's execute runs only on the shared per-call path.
 *
 * The fence, the policy, the per-athlete enablement and the tap all live on that path:
 *   agent/callTool.ts    every model call, on the one engine that runs the loop (Mastra)
 *   agent/approvals.ts   the athlete's approve tap (executeAgentAction), behind the same fence and opt-in checks
 * Any other `x.execute(...)` on a tool skips them. This test reads every server source file (tests excluded) and fails
 * on a direct call outside those two, so a new surface reads through callTool instead (as milaCards/surface.ts does).
 *
 * Grep-based on purpose: AgentTool.execute must stay callable by the path itself, so a type-level lock would need a
 * brand only those two files can mint; the connector layer (design 5 Nov) adds that. Until then this is the lock.
 *
 * What counts as a call: `.execute(` / `.execute!(` / `?.execute?.(`, `["execute"](`, `.execute.call|apply|bind(`, a call
 * split across lines, an alias (`const run = x.execute;`), and destructuring `{ execute } =`. A SQL client's `.execute(` (db, dbx, tx, exec) is not a tool. The allow-list below names every other
 * file and receiver that may, with the reason; an entry that no longer matches anything fails too, so it only shrinks.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

const ROOT = join(__dirname, "..", "..");
const SCAN = ["server", "shared"];

/** Receivers that are SQL clients, not tools. */
const SQL_RECEIVERS = new Set(["db", "dbx", "tx", "trx", "exec", "client", "pool", "conn"]);

/** The shared path itself: any receiver. */
const PATH_FILES = new Set(["server/agent/callTool.ts", "server/agent/approvals.ts"]);

/**
 * Known direct calls outside the agent registry's path, each `file → receivers`. These are the LEGACY v1 Mila tools
 * (server/mila/tools, MilaTool: `execute(athleteId, args)`, their own registry server/mila/registry.ts), not the agent
 * registry's AgentTools; they retire with the v1 loop. Nothing new may join this list.
 */
const LEGACY_V1: Record<string, { receivers: string[]; why: string }> = {
  "server/mila/loop.ts": { receivers: ["tool"], why: "the v1 loop's own per-call path (legacyToolRefusal + timeout)" },
  "server/voice/brandFitFill.ts": { receivers: ["getBrandFitTool"], why: "voice worker read of a v1 tool" },
  "server/voice/dealBriefRoute.ts": { receivers: ["getDealTool"], why: "voice worker read of a v1 tool" },
  "server/voice/dealRoutes.ts": { receivers: ["listDealsTool", "getDealTool"], why: "voice worker reads of v1 tools" },
  "server/voice/scoreRoute.ts": { receivers: ["getScoreTool"], why: "voice worker read of a v1 tool" },
  "server/voice/scripts/sampleBrandFitCopy.ts": { receivers: ["getBrandFitTool"], why: "offline sampling script, v1 tool" },
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !p.includes(`${sep}__tests__${sep}`)) out.push(p);
  }
  return out;
}

interface Hit { file: string; line: number; receiver: string; text: string }

// Matched over the whole file (comments blanked, line breaks kept), so a call split across lines is still seen.
// The receiver: a name, or the result of a call or index (`tools[0].execute(`).
const RECV = String.raw`([A-Za-z_$][\w$]*|[\])])\s*!?\s*\??`;
const PATTERNS: RegExp[] = [
  // x.execute(  x!.execute!(  x?.execute?.(  x.execute.call|apply|bind(
  new RegExp(RECV + String.raw`\.\s*execute\s*!?\s*(?:\?\.\s*)?(?:\.\s*(?:call|apply|bind)\s*)?\(`, "g"),
  // x["execute"](  x?.["execute"](
  new RegExp(RECV + String.raw`\.?\s*\[\s*["'\x60]execute["'\x60]\s*\]\s*!?\s*(?:\?\.\s*)?\(`, "g"),
  // an alias that is called later: const run = x.execute;  { f: x.execute }  return x.execute
  new RegExp(String.raw`(?:[^=!<>]=|:|\breturn|=>)\s*` + RECV + String.raw`\.\s*execute\b\s*!?\s*(?=[;,)}\]]|$)`, "gm"),
];
/** Destructuring, per line: `const { execute } = x`. */
const DESTRUCTURE = /\{[^}=]*\bexecute\b[^}=]*\}\s*=/;

/** The source with comments blanked (line breaks kept, so a match's offset still gives its line). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (_m, pre: string) => pre);
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const top of SCAN) {
    for (const abs of sources(join(ROOT, top))) {
      const file = relative(ROOT, abs).split(sep).join("/");
      const raw = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
      const lines = raw.split("\n");
      const code = stripComments(raw);
      const at = (index: number) => code.slice(0, index).split("\n").length;
      for (const re of PATTERNS) {
        re.lastIndex = 0;
        for (let m = re.exec(code); m; m = re.exec(code)) {
          const receiver = m[1];
          if (SQL_RECEIVERS.has(receiver)) continue;
          const line = at(m.index + m[0].indexOf(receiver));
          hits.push({ file, line, receiver, text: (lines[line - 1] ?? "").trim() });
        }
      }
      code.split("\n").forEach((text, i) => {
        if (DESTRUCTURE.test(text)) hits.push({ file, line: i + 1, receiver: "{ execute }", text: (lines[i] ?? "").trim() });
      });
    }
  }
  return hits;
}

describe("guard: a registered tool's execute runs only through the shared per-call path", () => {
  const hits = scan();

  it("finds the path's own calls (the scan works)", () => {
    expect(hits.some((h) => h.file === "server/agent/callTool.ts")).toBe(true);
    expect(hits.some((h) => h.file === "server/agent/approvals.ts")).toBe(true);
  });

  it("no direct execute call outside callTool.ts, approvals.ts and the named legacy v1 calls", () => {
    const offenders = hits.filter((h) => !PATH_FILES.has(h.file) && !LEGACY_V1[h.file]?.receivers.includes(h.receiver));
    expect(offenders.map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
  });

  it("every legacy allow-list entry still matches (the list only shrinks)", () => {
    const stale = Object.entries(LEGACY_V1).flatMap(([file, { receivers }]) =>
      receivers.filter((r) => !hits.some((h) => h.file === file && h.receiver === r)).map((r) => `${file} ${r}`));
    expect(stale).toEqual([]);
  });

  it("the legacy entries are v1 MilaTools, never agent-registry tools", () => {
    for (const file of Object.keys(LEGACY_V1).filter((f) => f.startsWith("server/voice/"))) {
      const src = readFileSync(join(ROOT, file), "utf8");
      for (const r of LEGACY_V1[file].receivers) expect(src).toMatch(new RegExp(`import \\{[^}]*\\b${r}\\b[^}]*\\} from "(\\.\\./)+mila/tools/`));
    }
  });
});
