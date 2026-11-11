/**
 * census.test.ts — THE FLOW CENSUS, standing (PR 16, R-4). Every flow driven end to end against the
 * real router on PGlite with the model mocked, twice: every Studio flag on, and the pre-roadmap
 * baseline with the six new gates off (R-5). Every artifact is captured (R-2); every census row is
 * measured (census/measure.ts) and held to its verdict (census/verdicts.ts).
 *
 * What is stood in, at the edge only: the model (`genai`), embeddings, URL signing and storage, the
 * video runner the route kicks. What is WRAPPED, never replaced: `derivePlan` (to read the library the
 * planner was handed) and `assembleBrief` (to read the BriefInput the route built) — each calls the
 * real function. Nothing here edits production code, and nothing reaches Cloud SQL: `server/db` is
 * PGlite, `DATABASE_URL` must be unset, and every fetch that is not this suite's own server throws.
 *
 * Set CENSUS_OUT=<dir> to write every capture point and the measured census to disk
 * (server/scripts/studioFlowCensus.ts does, and renders the ledger section from it).
 */
jest.mock("../../../../db", () => require("../../../../testUtils/pgliteDb"));
jest.mock("../../../../lib/auth", () => ({
  requireAuth: (
    req: { athleteId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.athleteId = (
      globalThis as { __CENSUS_ATHLETE?: string }
    ).__CENSUS_ATHLETE;
    next();
  },
}));
const mockGenerateContent = jest.fn();
jest.mock("../../../../lib/models", () => ({
  genai: () => ({
    models: { generateContent: (...a: unknown[]) => mockGenerateContent(...a) },
  }),
  GEMINI: {
    pro: "census-pro",
    flash: "census-flash",
    flashLite: "census-flash-lite",
  },
}));
// The OpenAI web search (research_moment, agent/research/llm callStructured), stood in: answered by the same
// flow routes as the Gemini calls above, its sources taken from the route's grounding list. No provider is reached.
const mockCallStructured = jest.fn();
jest.mock("../../../../agent/research/llm", () => ({
  ...jest.requireActual("../../../../agent/research/llm"),
  callStructured: (...a: unknown[]) => mockCallStructured(...a),
}));
jest.mock("../../../../lib/mediaEmbed", () => ({
  embedText: jest.fn(async () => [1, 0, 0]),
  embedImageGcs: jest.fn(),
  embedImageGcsWithReason: jest.fn(),
  cosine: (a: number[], b: number[]) => {
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  },
}));
jest.mock("../../../../lib/inboxAttachmentStore", () => ({
  signedAttachmentUploadUrl: jest.fn(
    async (p: string) => `https://signed-put.example/${p}`,
  ),
  getAttachment: jest.fn(async () => null),
  putAttachment: jest.fn(async () => true),
}));
jest.mock("../../../../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(async (_b: unknown, base: string) => ({
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
  rehostFromUrl: jest.fn(async (_u: string, base: string) => ({
    gcs_path: `${base}.png`,
    content_type: "image/png",
    bytes: 1234,
  })),
  // A real image's bytes for any stored object — what a reference or an edit source resolves to.
  readObject: jest.fn(async () => ({
    buf: mockImageBytes(),
    contentType: "image/png",
  })),
  deleteObject: jest.fn(async () => undefined),
  headObject: jest.fn(async () => ({ bytes: 4096, contentType: "video/mp4" })),
  // The stitch limits read this at request time; a stand-in of the same shape (the real module builds a
  // GCS client at load, which this suite never does).
  UPLOAD_LIMITS: {
    image: { max: 25 * 1024 * 1024, types: ["image/jpeg", "image/png"] },
    video: { max: 200 * 1024 * 1024, types: ["video/mp4", "video/quicktime"] },
  },
}));
// The runner a queued clip is kicked into after the response — a real tick would claim and submit it.
jest.mock("../../../videoRunner", () => ({
  videoTick: jest.fn(async () => ({})),
}));
// The reference engine's image loader: bytes of a picture, no storage read.
jest.mock("../../../autoMask", () => {
  const actual = jest.requireActual("../../../autoMask");
  return {
    ...actual,
    probeBytesFor: jest.fn(async () => ({
      bytes: mockImageBytes(),
      mimeType: "image/png",
    })),
    // Detection, stood in: one region on her jersey, labelled by the sentence's own words.
    detectRegionsMemoized: jest.fn(async () => ({
      ok: true,
      regions: [
        { label: "ZQ160 jersey", left: 0.3, top: 0.3, width: 0.3, height: 0.3 },
      ],
    })),
  };
});
jest.mock("../../../imageSize", () => ({
  ...jest.requireActual("../../../imageSize"),
  probeImageSize: jest.fn(async () => ({
    width: 1080,
    height: 1350,
    orientation: 1,
  })),
}));
// THE BILLABLE DOOR'S FAR SIDE, stood in: the router is REAL (so it writes its own cost line); the
// provider adapters answer with a real PNG and record exactly what they were sent.
const mockAdapterCalls: unknown[] = [];
const mockAdapter = (name: string) => {
  const actual = jest.requireActual(`../../../adapters/${name}`);
  const key = `${name}Adapter`;
  return {
    ...actual,
    [key]: {
      ...actual[key],
      generate: jest.fn(
        async (
          task: string,
          inputs: {
            prompt: string;
            references?: { kind: string; slot?: string; label?: string }[];
            aspectRatio?: string;
          },
          model: string,
          opts: {
            refIds?: string[];
            providerParams?: unknown;
            attribution?: unknown;
          },
        ) => {
          mockAdapterCalls.push({
            task,
            model,
            prompt: inputs.prompt,
            aspectRatio: inputs.aspectRatio ?? null,
            references: (inputs.references ?? []).map((r) => ({
              kind: r.kind,
              slot: r.slot ?? null,
              label: r.label ?? null,
            })),
            refIds: opts?.refIds ?? [],
            providerParams: opts?.providerParams ?? null,
            attribution: opts?.attribution ?? null,
          });
          const now = new Date().toISOString();
          return {
            task,
            provider: name,
            model,
            assets: [{ bytes: mockImageBytes(), mimeType: "image/png" }],
            cost: { amountUsd: 0.134, currency: "USD", basis: "estimated" },
            timings: { startedAt: now, completedAt: now, ms: 1 },
          };
        },
      ),
    },
  };
};
jest.mock("../../../adapters/vertex", () => mockAdapter("vertex"));
jest.mock("../../../adapters/openrouter", () => mockAdapter("openrouter"));
/** A real 64×80 PNG, made once — every stood-in read of an image returns it. */
let mockPng: Buffer | null = null;
function mockImageBytes(): Buffer {
  if (!mockPng) {
    // A minimal valid PNG (sharp is not reached for at module load: this is built on first call).
    const { execFileSync } = jest.requireActual(
      "node:child_process",
    ) as typeof import("node:child_process");
    mockPng = execFileSync(process.execPath, [
      "-e",
      "require('sharp')({create:{width:64,height:80,channels:3,background:{r:40,g:90,b:120}}}).png().toBuffer().then(b=>process.stdout.write(b))",
    ]);
  }
  return mockPng;
}
// The container probe the clip read runs on a signed URL — no ffprobe spawns here.
jest.mock("../../../enrich/provenanceSignal", () => ({
  ...jest.requireActual("../../../enrich/provenanceSignal"),
  ffprobeContainer: jest.fn(async () => null),
}));
// WRAPPED, not replaced: the real planner runs; the library it was handed is read on the way in.
const mockLibrary: unknown[] = [];
jest.mock("../../plan", () => {
  const actual = jest.requireActual("../../plan");
  return {
    ...actual,
    derivePlan: jest.fn(
      (athleteId: string, ask: { library: unknown[] }, transport?: unknown) => {
        mockLibrary.push(...ask.library);
        return actual.derivePlan(athleteId, ask, transport);
      },
    ),
  };
});
// WRAPPED, not replaced: the real brief builder runs; the BriefInput it was handed is read.
const mockBriefInputs: unknown[] = [];
jest.mock("../../../brief", () => {
  const actual = jest.requireActual("../../../brief");
  return {
    ...actual,
    assembleBrief: jest.fn((input: unknown, ...rest: unknown[]) => {
      mockBriefInputs.push(input);
      return actual.assembleBrief(input, ...rest);
    }),
  };
});

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import studioRouter from "../../../../routes/studio";
import { athletes } from "../../../../../shared/schema";
import {
  db,
  client,
  initTestDb,
  closeTestDb,
} from "../../../../testUtils/pgliteDb";
import { CaptureStore, CONSUMING } from "./capture";
import { VERDICTS } from "./verdicts";
import { checkFidelity, type FidelityPrompt } from "../fidelity";
import { censusRows } from "./rows";
import { CENSUS_CAMPAIGN, fixtureNonces } from "./fixture";
import { measure, type Measured } from "./measure";
import { getAttachment } from "../../../../lib/inboxAttachmentStore";
import type { FlowCtx, ModelAnswer, ModelRoute } from "./flows/common";
import { FULL_PDF, runBrandBriefFlow, seedLibrary } from "./flows/brief";
import { runReferenceFlow } from "./flows/reference";
import { runMomentFlow } from "./flows/moment";
import { runIdeasFlow } from "./flows/ideas";
import { runCarouselFlow } from "./flows/carousel";
import { costLines, runMakeItFlow } from "./flows/makeIt";
import { runClipReadFlow } from "./flows/clipRead";
import { runIdentityFlow } from "./flows/identity";

/** The six gates the roadmap added (R-5): off in the baseline run, on in the other. */
export const ROADMAP_GATES = [
  "STUDIO_BRIEF_CARRIER",
  "STUDIO_COMPOSER",
  "STUDIO_LIBRARY_FIELDS",
  "STUDIO_IDENTITY_PACK",
  "STUDIO_CLIP_READ",
  "STUDIO_QA_DISPLAY",
] as const;
/** On in both runs: the surfaces the flows need to exist at all. */
const BASE_FLAGS = [
  "STUDIO_ENABLED",
  "STUDIO_AGENT",
  "STUDIO_VIDEO_ENABLED",
  "STUDIO_BRAND_PROFILES",
  "STUDIO_DIRECTION_MOMENTS",
  "STUDIO_INTERPRETER",
  "STUDIO_NATIVE_EDIT",
  "STUDIO_IMAGE_EDIT_OPS",
  "STUDIO_DISPLAY_TEXT",
  "STUDIO_VIDEO_ENRICH",
  // Asset readiness, not behaviour: the curated tracks are "available" so a stitch spec can name one.
  "STUDIO_STITCH_BEDS_READY",
] as const;

/** The measured fidelity state at the merged tip — the standing expectation (see the describe below). */
const FIDELITY_EXPECTED: Record<"on" | "off", Record<string, boolean>> = {
  // Measured at the merged tip (5494adb3+): the carrier honours the do-not and the tone on every clip;
  // the confirmed 4:5 never shapes a clip (every clip is 9:16 by deliverable), and the confirmed product
  // line reaches no clip prompt (the carrier does not render it: card K36).
  on: { constraints: true, output: false, product: false, tone: true },
  // The pre-roadmap baseline: nothing she confirmed reaches a clip prompt.
  off: { constraints: false, output: false, product: false, tone: false },
};

const RUNS = [
  { on: true, athlete: "c0c0c0c0-1111-4111-8111-000000000001" },
  { on: false, athlete: "c0c0c0c0-1111-4111-8111-000000000002" },
] as const;

let server: Server;
let base: string;
const realFetch = global.fetch;
const ENV = { ...process.env };
const COST_DIR = mkdtempSync(join(tmpdir(), "census-cost-"));
let routes: readonly ModelRoute[] = [];
let current: CaptureStore | null = null;

function setFlags(on: boolean): void {
  process.env = {
    ...ENV,
    LOG_LEVEL: "silent",
    STUDIO_COST_LOG: join(COST_DIR, `cost-${on ? "on" : "off"}.jsonl`),
  };
  for (const f of BASE_FLAGS) process.env[f] = "true";
  for (const f of ROADMAP_GATES)
    if (on) process.env[f] = "true";
    else delete process.env[f];
}

/** Every text part of a generateContent request, and its system instruction — what the model read. */
function promptText(req: {
  contents?: unknown;
  config?: { systemInstruction?: unknown };
}): string {
  const texts: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") texts.push(o.text);
    for (const [k, x] of Object.entries(o))
      if (k !== "inlineData" && k !== "text") walk(x);
  };
  walk(req?.contents);
  if (typeof req?.config?.systemInstruction === "string")
    texts.push(req.config.systemInstruction);
  else walk(req?.config?.systemInstruction);
  return texts.join("\n");
}

const ctxFor = (
  on: boolean,
  athleteId: string,
  store: CaptureStore,
): FlowCtx => ({
  athleteId,
  base,
  flagsOn: on,
  store,
  db,
  model: (r) => {
    routes = r;
  },
  spies: {
    library: () => mockLibrary.splice(0),
    briefInputs: () => mockBriefInputs.splice(0),
  },
});

beforeAll(async () => {
  // ⚠️ THE CENSUS NEVER TOUCHES A REAL DATABASE: server/db is PGlite above, and a DATABASE_URL in this
  // process would mean a module could have reached for Cloud SQL. Refuse to run at all.
  if (process.env.DATABASE_URL)
    throw new Error("census: DATABASE_URL is set — refusing to run");
  // Every fetch that is not this suite's own server is a network call the mocks missed.
  global.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(
      typeof input === "object" && "url" in input ? input.url : input,
    );
    if (!url.startsWith("http://127.0.0.1:"))
      throw new Error(`census: a network call escaped the mocks: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  // THE MODEL, STOOD IN: every call is answered by the flow's route for that kind of prompt, and the
  // prompt is filed at that route's capture point. A prompt no route expects fails the flow by name.
  mockGenerateContent.mockImplementation(
    async (req: {
      contents?: unknown;
      config?: { systemInstruction?: unknown };
    }) => {
      const prompt = promptText(req);
      const route = routes.find((r) => prompt.includes(r.when));
      if (!route)
        throw new Error(
          `census: an unexpected model call: ${prompt.slice(0, 160)}`,
        );
      current?.add(route.point, prompt, false);
      const a = route.reply(prompt);
      const ans: ModelAnswer = typeof a === "string" ? { text: a } : a;
      // The planner's answer is fixture, not a field — recorded beside its prompt for the reader.
      if (route.point === "planner_prompt")
        current?.add("plan_answer", ans.text, false);
      return {
        text: ans.text,
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
        candidates: [
          {
            content: { parts: [{ text: ans.text }] },
            groundingMetadata: {
              groundingChunks: (ans.grounding ?? []).map((g) => ({ web: g })),
            },
          },
        ],
      };
    },
  );
  mockCallStructured.mockImplementation(
    async (req: { skill: { instructions: string }; input: unknown }) => {
      const prompt = `${typeof req.input === "string" ? req.input : JSON.stringify(req.input)}
${req.skill.instructions}`;
      const route = routes.find((r) => prompt.includes(r.when));
      if (!route)
        throw new Error(
          `census: an unexpected model call: ${prompt.slice(0, 160)}`,
        );
      current?.add(route.point, prompt, false);
      const a = route.reply(prompt);
      const ans: ModelAnswer = typeof a === "string" ? { text: a } : a;
      let json: unknown = null;
      try {
        json = JSON.parse(ans.text);
      } catch {
        json = null;
      }
      return {
        json,
        text: ans.text,
        sources: (ans.grounding ?? []).map((g) => ({ url: g.uri, title: g.title })),
        queries: [],
        status: "completed",
        responseId: null,
        durationMs: 1,
        usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, reasoningTokens: 0, webSearchCalls: 1 },
        cost: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, reasoningTokens: 0, webSearchCalls: 1, microUsd: 10_200 },
      };
    },
  );
  (getAttachment as jest.Mock).mockResolvedValue(FULL_PDF);
  await initTestDb();
  // The generation guards the edit and generate paths write through (the edit suite applies the same).
  await client.exec(
    readFileSync(
      join(__dirname, "..", "..", "..", "sql", "generationGuards.sql"),
      "utf8",
    ),
  );
  await db.insert(athletes).values(
    RUNS.map((r) => ({
      id: r.athlete,
      full_name: "Census Athlete",
    })) as (typeof athletes.$inferInsert)[],
  );
  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  global.fetch = realFetch;
  process.env = ENV;
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

const measured: Record<"on" | "off", Map<string, Measured>> = {
  on: new Map(),
  off: new Map(),
};
const identity: Record<"on" | "off", { pack: string[] } | null> = {
  on: null,
  off: null,
};
const fidelityPrompts: Record<"on" | "off", FidelityPrompt[]> = {
  on: [],
  off: [],
};

describe.each(RUNS)("the census, flags on = $on", ({ on, athlete }) => {
  const store = new CaptureStore(`census-${on ? "on" : "off"}`);

  beforeAll(async () => {
    setFlags(on);
    (globalThis as { __CENSUS_ATHLETE?: string }).__CENSUS_ATHLETE = athlete;
    current = store;
    const ctx = ctxFor(on, athlete, store);
    const lib = await seedLibrary(ctx);
    // Fidelity's code-checked half is collected on flow 1 alone: its brief is the census's confirmed
    // nonce campaign (summarize-brief answered CENSUS_CAMPAIGN's lines), so every field is traceable.
    ctx.fidelity = [];
    const proposal = await runBrandBriefFlow(ctx, lib);
    fidelityPrompts[on ? "on" : "off"] = ctx.fidelity;
    ctx.fidelity = undefined;
    await runReferenceFlow(ctx, lib);
    await runMomentFlow(ctx, lib);
    await runIdeasFlow(ctx, lib);
    await runCarouselFlow(ctx, lib, proposal);
    await runMakeItFlow(ctx, lib);
    await runClipReadFlow(ctx, lib);
    identity[on ? "on" : "off"] = await runIdentityFlow(ctx, lib);
    for (const c of mockAdapterCalls.splice(0)) store.add("adapter_inputs", c);
    for (const line of costLines(process.env.STUDIO_COST_LOG as string))
      store.add("cost_lines", line);
    const tokens = fixtureNonces();
    // The one op param the census cannot know before it runs: her product photo's id.
    tokens.set("opParams:product.productAssetId", [lib.product]);
    measured[on ? "on" : "off"] = measure(store, censusRows(), tokens, [
      athlete,
    ]);
    if (process.env.CENSUS_OUT || ENV.CENSUS_OUT) {
      const out = (process.env.CENSUS_OUT || ENV.CENSUS_OUT) as string;
      mkdirSync(out, { recursive: true });
      store.write(out);
      writeFileSync(
        join(out, `measured-${on ? "on" : "off"}.json`),
        JSON.stringify([...measured[on ? "on" : "off"].values()], null, 2),
      );
    }
  });

  it("captured the flow's artifacts", () => {
    expect(store.text("planner_prompt")).toContain("ZQ001");
    expect(store.objects("cast_items").length).toBeGreaterThan(0);
  });
});

/**
 * THE STANDING ASSERTION (R-4). Every row the flows measure is held to its verdict, per flag state: a
 * CONSUMED row reaches EXACTLY the consuming points its verdict names — fewer is a field gone dead,
 * more is a field that came alive where the table says it does not (the off-run differing from the
 * on-run is what this makes observable) — and a row verdicted anything else reaches none. A failure
 * names the row, the point, and where it was last seen.
 */
describe.each(RUNS)(
  "the census holds its verdicts, flags on = $on",
  ({ on }) => {
    it("every measured row reaches exactly the consuming points its verdict names", () => {
      const state = on ? "on" : "off";
      const broken: string[] = [];
      for (const [row, v] of Object.entries(VERDICTS)) {
        if (v.check !== "flow") continue;
        const m = measured[state].get(row);
        if (!m) continue; // a verdict for no row is rows.test's to name
        const verdict = on ? v.v : (v.off ?? v.v);
        const reached = m.reach.filter((p) => CONSUMING.has(p));
        const want =
          verdict === "CONSUMED" ? ((on ? v.at : (v.offAt ?? v.at)) ?? []) : [];
        for (const p of want)
          if (!reached.includes(p))
            broken.push(
              `${row}: CONSUMED at ${p} (flags ${state}) — not reached now; last seen at ${m.lastSeen ?? "nowhere downstream"}`,
            );
        for (const p of reached)
          if (!want.includes(p))
            broken.push(
              `${row}: verdicted ${verdict} (flags ${state}) but now reaches ${p} — re-verdict it`,
            );
      }
      expect(broken).toEqual([]);
    });
  },
);

/**
 * FIDELITY'S CODE-CHECKED HALF, ON THE CENSUS'S OWN NONCE CAMPAIGN (R-10; Adi, 24 Sep 2026: the 13 plan-
 * eval briefs are fixed on purpose and carry no confirmed campaign, so fidelity is measured here, where
 * every field is traceable). Flow 1's Board clips, checked against what she confirmed. STANDING: the
 * expected pass/fail per check is the measured state at the merged tip; a check that flips reds by name.
 */
describe.each(RUNS)(
  "brief fidelity on the census campaign, flags on = $on",
  ({ on }) => {
    it("each check holds its measured state", () => {
      const prompts = fidelityPrompts[on ? "on" : "off"];
      expect(prompts.length).toBeGreaterThan(0);
      const c = CENSUS_CAMPAIGN;
      const checks = checkFidelity(
        {
          constraints: [...c.constraints],
          output: { type: c.output.type, aspect_ratio: c.output.aspect_ratio },
          productLine: c.product.line,
          tone: [...c.creative_direction.tone],
        },
        prompts,
      );
      const got = Object.fromEntries(checks.map((x) => [x.check, x.pass]));
      if (process.env.CENSUS_OUT)
        console.log(JSON.stringify({ on, fidelity: checks }, null, 1));
      expect(got).toEqual(FIDELITY_EXPECTED[on ? "on" : "off"]);
    });
  },
);
