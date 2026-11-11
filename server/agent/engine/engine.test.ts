/**
 * engine.test.ts — the engine seam and the Mastra engine's policy pins. Pure: no database, no Mastra runtime, no
 * provider (the Mastra turn is mocked).
 *
 *   seam       runMilaTurn runs the Mastra turn, always: whatever MILA_ENGINE or MILA_MASTRA_ATHLETES still say (read by
 *              nothing since Mastra-only PR 2); all four surfaces call runMilaTurn; TrueForge (agent/tf), the /mcp
 *              server (agent/mcp) and TrueForge's session clean-up are gone (PR 3), nothing imports them and nothing
 *              mounts /mcp; the harness (harness.ts, agent/chat.ts) is gone (PR 2)
 *   alone      the engine's own code imports nothing from TrueForge (agent/tf), /mcp (agent/mcp) or the harness (P1,
 *              5 Nov 2026; both deleted since)
 *   gates      proactive and the waitlist need only their own flag: no MILA_ENGINE, NOMILA_MCP_ENABLED, MILA_TF_CHAT or
 *              TRUEFORGE_* setting
 *   ZDR        every Mastra model call sends store:false, and the AI SDK OpenAI provider puts it on the wire
 *   env        the dev YAML carries no MILA_ENGINE / MILA_MASTRA_ATHLETES / MILA_TF_CHAT, no TRUEFORGE_* and no
 *              NOMILA_MCP_ENABLED / NOMILA_MCP_CALLER_SECRET, but keeps NOMILA_MCP_PASS_KEY (the pass every Mastra tool
 *              call runs under); the prod YAML is changed only in a release (its leftovers are inert)
 *   deps       exact pins of the security review; no @mastra/server, @mastra/deployer or @mastra/mcp anywhere in the
 *              tree; no --legacy-peer-deps anywhere; Node 22.22 in the image and CI
 *   policy     memory = history only (working memory, semantic recall, observational memory, titles off); the model
 *              is a provider instance and only openai/…; no Mastra server/auth/editor/durable/workflow/cache APIs used
 */
jest.mock("../../db", () => ({ db: {} }));
jest.mock("./mastra/turn", () => ({ runMastraTurn: jest.fn(async () => ({ engine: "mastra" })) }));

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { runMilaTurn } from "./index";
import { MASTRA, milaWaitlistEnabled } from "./config";
import { milaProactiveEnabled } from "../proactive/config";
import { memoryOptions, modelFor } from "./mastra/runtime";

const ROOT = join(__dirname, "..", "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const p = { athleteId: "a", message: "hi", sse: {} as never };

describe("Mila runs on Mastra, always", () => {
  const KEYS = ["MILA_ENGINE", "MILA_MASTRA_ATHLETES"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("runs the Mastra turn whatever the retired MILA_ENGINE / MILA_MASTRA_ATHLETES say", async () => {
    for (const v of [undefined, "mastra", "harness", "trueforge", ""]) {
      if (v === undefined) delete process.env.MILA_ENGINE; else process.env.MILA_ENGINE = v;
      process.env.MILA_MASTRA_ATHLETES = "x";
      expect([v, await runMilaTurn(p)]).toEqual([v, { engine: "mastra" }]);
    }
  });

  it("nothing in server/ reads MILA_ENGINE or MILA_MASTRA_ATHLETES any more", () => {
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        const f = `${d}/${e.name}`;
        if (e.isDirectory()) walk(f);
        else if (f.endsWith(".ts") && !f.endsWith(".test.ts") && /process\.env\.(MILA_ENGINE|MILA_MASTRA_ATHLETES)\b|"(MILA_ENGINE|MILA_MASTRA_ATHLETES)"/.test(read(f))) bad.push(f);
      }
    };
    walk("server");
    expect(bad).toEqual([]);
  });

  it("every Mila surface runs its turn through runMilaTurn, never a single engine directly", () => {
    for (const f of ["server/routes/chat.ts", "server/agent/proactive/turn.ts", "server/agent/waitlist/turn.ts", "server/agent/onboarding/milaTurn.ts"]) {
      const src = read(f);
      expect([f, /runMilaTurn/.test(src)]).toEqual([f, true]);
      expect([f, /\brunTfChatTurn\s*\(/.test(src) || /\(deps\.runTurn \?\? runTfChatTurn\)/.test(src)]).toEqual([f, false]);
    }
  });

  it("TrueForge, /mcp and TrueForge's session clean-up are gone and nothing imports or mounts them; the harness is gone", () => {
    const exists = (f: string) => { try { readdirSync(join(ROOT, f)); return true; } catch { try { read(f); return true; } catch { return false; } } };
    for (const f of ["server/agent/tf", "server/agent/mcp", "server/lib/privacy/trueforgeSessions.ts", "server/agent/harness.ts", "server/agent/chat.ts", "server/agent/chat/turn.ts"]) {
      expect([f, exists(f)]).toEqual([f, false]);
    }
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        const f = `${d}/${e.name}`;
        if (e.isDirectory()) { walk(f); continue; }
        if (!f.endsWith(".ts")) continue;
        if (/from "(\.\.?\/)+(agent\/)?(tf|mcp)\/|import\("(\.\.?\/)+(agent\/)?(tf|mcp)\/|privacy\/trueforgeSessions"/.test(read(f))) bad.push(f);
      }
    };
    walk("server");
    expect(bad).toEqual([]);
    expect(read("server/index.ts")).not.toMatch(/createMcpRouter|mcpEnabled|"\/mcp"/);
  });

  it("the dev YAML no longer carries the engine switch, MILA_TF_CHAT, TrueForge's settings or /mcp's; it keeps the pass key", () => {
    const env = (f: string) => new Map((parse(read(f))?.spec?.template?.spec?.containers?.[0]?.env ?? []).map((e: any) => [e.name, e.value]));
    const dev = env("gcp/cloud-run-dev.yaml");
    for (const k of ["MILA_ENGINE", "MILA_MASTRA_ATHLETES", "MILA_TF_CHAT", "NOMILA_MCP_ENABLED", "NOMILA_MCP_CALLER_SECRET"]) expect([k, dev.has(k)]).toEqual([k, false]);
    expect([...dev.keys()].map(String).filter((k) => k.startsWith("TRUEFORGE_"))).toEqual([]);
    expect(dev.has("NOMILA_MCP_PASS_KEY")).toBe(true);
  });

  it("the prod YAML no longer carries the inert engine switch, MILA_TF_CHAT or /mcp's flag either; it carries the pass key", () => {
    const env = (f: string) => new Map((parse(read(f))?.spec?.template?.spec?.containers?.[0]?.env ?? []).map((e: any) => [e.name, e.value]));
    const prod = env("gcp/cloud-run-prod.yaml");
    for (const k of ["MILA_ENGINE", "MILA_MASTRA_ATHLETES", "MILA_TF_CHAT", "NOMILA_MCP_ENABLED", "NOMILA_MCP_CALLER_SECRET"]) expect([k, prod.has(k)]).toEqual([k, false]);
    expect([...prod.keys()].map(String).filter((k) => k.startsWith("TRUEFORGE_"))).toEqual([]);
    expect(prod.has("NOMILA_MCP_PASS_KEY")).toBe(true);
  });
});

describe("Mastra stands on its own (P1)", () => {
  const KEYS = ["MILA_ENGINE", "MILA_PROACTIVE", "MILA_TF_WAITLIST", "MILA_TF_CHAT", "NOMILA_MCP_ENABLED", "TRUEFORGE_BASE_URL", "TRUEFORGE_IAP_AUDIENCE", "TRUEFORGE_CALLER_SA", "TRUEFORGE_API_KEY"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("the engine's code imports nothing from TrueForge, /mcp or the harness", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        const f = `${d}/${e.name}`;
        if (e.isDirectory()) walk(f); else if (f.endsWith(".ts") && !f.endsWith(".test.ts")) files.push(f);
      }
    };
    walk("server/agent/engine");
    const bad: string[] = [];
    for (const f of files) {
      // A type-only import loads nothing at run time.
      for (const m of read(f).matchAll(/^import (?!type )[^;]*?from "([^"]+)"/gm)) {
        if (/\/(tf|mcp)\/|\/harness$|^(\.\.\/)+chat$/.test(m[1])) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
    expect(files.length).toBeGreaterThan(15);
  });

  it("proactive and the waitlist need only their own flag (no MILA_ENGINE, no /mcp, no MILA_TF_CHAT, no TRUEFORGE_*)", () => {
    for (const k of KEYS) delete process.env[k];
    expect([milaProactiveEnabled(), milaWaitlistEnabled()]).toEqual([false, false]);
    process.env.MILA_PROACTIVE = "true";
    process.env.MILA_TF_WAITLIST = "true";
    expect([milaProactiveEnabled(), milaWaitlistEnabled()]).toEqual([true, true]);
    // A leftover engine value changes nothing.
    process.env.MILA_ENGINE = "trueforge";
    expect([milaProactiveEnabled(), milaWaitlistEnabled()]).toEqual([true, true]);
  });
});

describe("ZDR: store:false on every Mastra OpenAI call", () => {
  const actualTurn = () => jest.requireActual("./mastra/turn") as typeof import("./mastra/turn");

  it("the turn's provider options carry store:false next to the effort", () => {
    expect(actualTurn().mastraProviderOptions("low")).toEqual({ openai: { reasoningEffort: "low", store: false } });
  });

  it("every Mastra model call in the engine passes them", () => {
    const src = read("server/agent/engine/mastra/turn.ts");
    const calls = [...src.matchAll(/\.(stream|generate)\(/g)].length;
    expect(calls).toBeGreaterThan(0);
    expect([...src.matchAll(/providerOptions: mastraProviderOptions\(/g)].length).toBe(calls);
    for (const f of ["runtime.ts", "skills.ts", "tools.ts", "guards.ts", "lifecycle.ts", "chatV2Stream.ts", "webSearch.ts"]) {
      expect([f, /\.(stream|generate)\(/.test(read(`server/agent/engine/mastra/${f}`))]).toEqual([f, false]);
    }
  });

  it("the AI SDK OpenAI provider (the one Mastra's model is built with) puts store:false in the request body", async () => {
    const bodies: any[] = [];
    const { createOpenAI } = await import("@ai-sdk/openai");
    const model: any = createOpenAI({
      apiKey: "test-key-not-real",
      fetch: (async (_url: unknown, init?: { body?: unknown }) => { bodies.push(JSON.parse(String(init?.body))); throw new Error("no network in tests"); }) as never,
    })("gpt-6-luna");
    const prompt = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    await expect(model.doStream({ prompt, providerOptions: actualTurn().mastraProviderOptions("low") })).rejects.toThrow();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].store).toBe(false);
    expect(bodies[0].reasoning).toMatchObject({ effort: "low" });
    // Without the option the SDK sends no store field, and OpenAI's default for the Responses API is to store.
    await expect(model.doStream({ prompt })).rejects.toThrow();
    expect(bodies[1].store).toBeUndefined();
  });
});

describe("dependencies (security review 28 Oct 2026)", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));

  it("pins the Mastra and AI SDK packages exactly", () => {
    expect(pkg.dependencies).toMatchObject({ "@mastra/core": "1.79.0", "@mastra/memory": "1.39.0", "@mastra/pg": "1.32.0", "@ai-sdk/openai": "4.0.103", "@mastra/ai-sdk": "1.11.3" });
    for (const name of ["@mastra/core", "@mastra/memory", "@mastra/pg", "@ai-sdk/openai", "@mastra/ai-sdk"]) expect(lock.packages[`node_modules/${name}`].version).toBe(pkg.dependencies[name]);
  });

  it("has no Mastra server, deployer, MCP client, or observability exporter in the tree", () => {
    const forbidden = ["@mastra/server", "@mastra/deployer", "@mastra/mcp", "@mastra/observability", "@mastra/langfuse", "@mastra/auth", "@mastra/editor"];
    const present = Object.keys(lock.packages).filter((k) => forbidden.some((f) => k === `node_modules/${f}` || k.endsWith(`/node_modules/${f}`)));
    expect(present).toEqual([]);
  });

  it("keeps local Mastra Studio (tools/mila-studio, its own package and lock) out of the root install and the image", () => {
    // Studio's CLI brings @mastra/server and @mastra/deployer; they live only in tools/mila-studio's own lockfile.
    expect(pkg.workspaces).toBeUndefined();
    expect(Object.keys(lock.packages).filter((k) => k.startsWith("tools/"))).toEqual([]);
    expect({ ...pkg.dependencies, ...pkg.devDependencies }.mastra).toBeUndefined();
    // The image copies named paths only: never tools/ and never the whole build context.
    const copies = read("Dockerfile").split("\n").filter((l) => /^COPY\s/.test(l) && !/--from=/.test(l));
    expect(copies.filter((l) => /\btools\b/.test(l) || /^COPY\s+(\.|\.\/)\s/.test(l))).toEqual([]);
  });

  it("installs without --legacy-peer-deps anywhere (CI, deploys, image)", () => {
    const files = ["Dockerfile", ...readdirSync(join(ROOT, ".github", "workflows")).map((f) => `.github/workflows/${f}`)];
    for (const f of files) expect([f, read(f).includes("legacy-peer-deps")]).toEqual([f, false]);
  });

  it("runs on Node 22.22 (Mastra's engines): the image, CI, and package engines", () => {
    expect(read("Dockerfile")).toMatch(/^FROM node:22\.22[\w.-]* AS builder$/m);
    expect(read("Dockerfile")).toMatch(/^FROM node:22\.22[\w.-]* AS runtime$/m);
    expect(read("Dockerfile")).toMatch(/^ENV MASTRA_TELEMETRY_DISABLED=1$/m);
    expect(pkg.engines?.node).toBe(">=22.22.0");
    const ci = read(".github/workflows/ci-checks.yml");
    expect(ci).not.toMatch(/node-version: '20'/);
    expect(ci).toMatch(/node-version: '22\.22'/);
  });
});

describe("Mastra policy", () => {
  it("memory is thread history only: every automatic memory feature is off", () => {
    expect(memoryOptions(40)).toEqual({ lastMessages: 40, semanticRecall: false, generateTitle: false, workingMemory: { enabled: false }, observationalMemory: false });
  });

  it("the model is an openai provider instance; anything else is refused", async () => {
    expect(MASTRA.model).toBe("openai/gpt-6-luna");
    expect(MASTRA.priceModel).toBe("gpt-6-luna");
    await expect(modelFor("google/gemini-x")).rejects.toThrow(/openai\/<model> only/);
    await expect(modelFor("gpt-6-luna")).rejects.toThrow(/openai\/<model> only/);
  });

  it("the engine code uses none of the APIs that are off by policy", () => {
    const dir = join(ROOT, "server", "agent", "engine", "mastra");
    // Code only: the comments name what is off, on purpose.
    const src = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    for (const banned of [
      /@mastra\/(server|deployer|mcp|editor|auth)/, /ResponseCache|responseCache/, /DurableAgent|EventedAgent|durable:/, /createWorkflow|createStep/,
      /\bauth:|MastraAuth|experimental_auth/, /\bSession\b|respondToToolApproval/, /sendSignal|queueMessage|sendMessage\(/,
      /MASTRA_LICENSE|MASTRA_EE/, /handleChatStream|chatRoute|networkRoute|workflowRoute/, /requireApproval|resumeStream|approveToolCall/, /workingMemory: \{ enabled: true/, /semanticRecall: true/, /observationalMemory: true/, /generateTitle: true/,
      /model: "[a-z]+\//,   // a model id string handed to Mastra (gateway lookup) instead of a provider instance
    ]) expect([String(banned), banned.test(src)]).toEqual([String(banned), false]);
  });

  it("no EE features configured: no FGA provider, no licence key (the @mastra/core package itself ships EE code)", () => {
    const dir = join(ROOT, "server", "agent", "engine", "mastra");
    const src = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bfga\b|FGAProvider|\bfga\s*:/i);
    // Mastra's licence env names (MASTRA_EE_LICENSE, MASTRA_LICENSE_KEY, MASTRA_LICENSE_URL) are set nowhere we deploy.
    const files = ["Dockerfile", "gcp/cloud-run-dev.yaml", "gcp/cloud-run-prod.yaml", ...readdirSync(join(ROOT, ".github", "workflows")).map((f) => `.github/workflows/${f}`)];
    for (const f of files) expect([f, /MASTRA_(EE_)?LICEN[CS]E/.test(read(f))]).toEqual([f, false]);
  });
});
