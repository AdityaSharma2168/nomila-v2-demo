/**
 * routes.test — POST /studio/direction/echo over HTTP, through the real Studio router and its gate.
 *
 * What is REAL here: the router, the gate (requireStudio → requireAuth → requireAthlete), the flag,
 * the body checks, the tool and the envelope validator. Stood in at the network edge only, as
 * studio.agent.test does: the Gemini client, embedText, URL signing, storage.
 *
 * The assertion that matters most is about what did NOT happen — the PR's hard gate. Every spending
 * entry point the Studio has is spied (the planner's model call, the concept step, the preview quote,
 * a generation, a stitch, a library search) and after EVERY request none was called and no preview,
 * plan or job row exists. ⚠️ MUTATION: make the echo route call deriveConcepts, or generateContent —
 * "no direction route asks the planner, generates, stitches or quotes — the hard gate" reds by name.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.athleteId = (globalThis as any).__TEST_ATHLETE_ID;
    next();
  },
}));
jest.mock("../../lib/models", () => ({
  genai: jest.fn(),
  GEMINI: {
    pro: "test-pro",
    flash: "test-flash",
    flashLite: "test-flash-lite",
  },
}));
jest.mock("../../lib/mediaEmbed", () => ({
  embedText: jest.fn(async () => [1, 0, 0]),
  embedImageGcs: jest.fn(),
  embedImageGcsWithReason: jest.fn(),
  cosine: () => 0,
}));
jest.mock("../../lib/inboxAttachmentStore", () => ({
  signedAttachmentUploadUrl: jest.fn(
    async (p: string) => `https://signed-put.example/${p}`,
  ),
  getAttachment: jest.fn(async () => null),
  putAttachment: jest.fn(async () => true),
}));
// The direction tools' one model call, stood in: summarize_brief's reply is scripted per test.
jest.mock("./transport", () => {
  const actual = jest.requireActual("./transport");
  return { ...actual, geminiDirectionTransport: jest.fn() };
});
// PR 3's reference engine, reached by decompose_reference: its one model call and its image loader stood in.
jest.mock("../reference/transport", () => {
  const actual = jest.requireActual("../reference/transport");
  return { ...actual, geminiReferenceTransport: jest.fn() };
});
jest.mock("../autoMask", () => {
  const actual = jest.requireActual("../autoMask");
  return {
    ...actual,
    probeBytesFor: jest.fn(async () => ({
      bytes: Buffer.from("jpeg"),
      mimeType: "image/jpeg",
    })),
  };
});
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  saveBuffer: jest.fn(),
  rehostFromUrl: jest.fn(),
}));
// The URL door's one way to the network, stood in: no socket opens here; what a link "returns" is
// scripted per test. The real module's UnsafeUrlError is kept so the refusal path is the real one.
jest.mock("../../lib/safeFetch", () => {
  const actual = jest.requireActual("../../lib/safeFetch");
  return { ...actual, safeFetch: jest.fn() };
});
// Lane D's one way to the web, stood in: the OpenAI web search call (agent/research/llm callStructured)
// returns what a test scripts — no socket, no search, no spend. The research lane's ledger is stood in
// ONLY to prove it is never touched.
jest.mock("../../agent/research/llm", () => ({
  ...jest.requireActual("../../agent/research/llm"),
  callStructured: jest.fn(),
}));
jest.mock("../../services/intelligence/research/ledger", () => ({
  reserveLlmCall: jest.fn(),
  recordProviderCall: jest.fn(),
}));
// The spending entry points, each wrapped so the real module still loads and the call is counted.
jest.mock("../agent/concepts", () => {
  const actual = jest.requireActual("../agent/concepts");
  return { ...actual, deriveConcepts: jest.fn(actual.deriveConcepts) };
});
jest.mock("../preview", () => {
  const actual = jest.requireActual("../preview");
  return { ...actual, previewGeneration: jest.fn(actual.previewGeneration) };
});
jest.mock("../generate", () => {
  const actual = jest.requireActual("../generate");
  return {
    ...actual,
    runStudioGeneration: jest.fn(actual.runStudioGeneration),
  };
});
jest.mock("../stitchJobs", () => {
  const actual = jest.requireActual("../stitchJobs");
  return { ...actual, queueStitch: jest.fn(actual.queueStitch) };
});

import { and, eq } from "drizzle-orm";
import express from "express";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import studioRouter from "../../routes/studio";
import { genai } from "../../lib/models";
import { embedText } from "../../lib/mediaEmbed";
import { getAttachment, putAttachment } from "../../lib/inboxAttachmentStore";
import { saveBuffer } from "../../lib/mediaStore";
import { callStructured, ModelCallError } from "../../agent/research/llm";
import { momentModel } from "./moment";
import { MILA } from "../../mila/config";
import { webSearchLimiter } from "../../mila/webSearchLimiter";
import { safeFetch, UnsafeUrlError } from "../../lib/safeFetch";
import { searchMedia } from "../../services/mediaSearch";
import { herPhoto as herPhotoPredicate } from "../photoPredicate";
import { deriveConcepts } from "../agent/concepts";
import { previewGeneration } from "../preview";
import { runStudioGeneration } from "../generate";
import { queueStitch } from "../stitchJobs";
import {
  athletes,
  researchBudgetDays,
  generationJobs,
  studioGenerationPreviews,
  mediaAssets,
  studioPlans,
} from "../../../shared/schema";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { echoBrief } from "./echo";
import { unflaggedPaths, validateBriefProposal } from "./envelope";
import { BRAND, PRODUCT_LINE } from "./fixtures/briefs/lines";
import { MAX_UPLOAD_BYTES } from "./routes";
import { geminiDirectionTransport } from "./transport";

const HER = "33333333-1111-4444-8555-777777777777";
const SOMEONE_ELSE = "44444444-1111-4777-8666-555555555555";
const FULL_PDF = readFileSync(
  join(__dirname, "fixtures", "briefs", "full.pdf"),
);

let server: Server;
let base: string;
const generateContent = jest.fn();
const transport = geminiDirectionTransport as jest.Mock;
const fetched = getAttachment as jest.Mock;
const stored = putAttachment as jest.Mock;

/** What a good reader answers for the full brief — two literal lines are enough to prove the wire. */
const summaryReply = () => ({
  text: JSON.stringify({
    lines: [
      {
        path: "brand.name",
        value: BRAND,
        basis: "literal",
        quote: `Brand: ${BRAND}`,
      },
      {
        path: "product.line",
        value: PRODUCT_LINE,
        basis: "literal",
        quote: `Product: ${PRODUCT_LINE}`,
      },
      {
        path: "creative_direction.tone",
        value: ["calm", "focused", "unhurried"],
        basis: "literal",
        quote: "Tone: calm, focused, unhurried.",
      },
    ],
    notes: [],
  }),
  usage: { inputTokens: 2000, outputTokens: 600 },
  model: "test-flash",
});

const postJson = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json().catch(() => null)) as any,
  };
};
const postPdf = async (bytes: Buffer, contentType = "application/pdf") => {
  const res = await fetch(`${base}/studio/direction/summarize-brief/upload`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(bytes),
  });
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json().catch(() => null)) as any,
  };
};

const post = async (body: unknown) => {
  const res = await fetch(`${base}/studio/direction/echo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    text,
    json,
  };
};

const input = {
  brand: "Solstice",
  productLine: "the matte-black insulated bottle",
};

beforeAll(async () => {
  await initTestDb();
  await db
    .insert(athletes)
    .values([{ id: HER, full_name: "Direction Route Athlete" }] as never);
  const app = express();
  app.use(express.json());
  app.use("/", studioRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await closeTestDb();
});

beforeEach(() => {
  jest.clearAllMocks();
  (genai as jest.Mock).mockReturnValue({ models: { generateContent } });
  transport.mockResolvedValue(summaryReply());
  fetched.mockResolvedValue(null);
  stored.mockResolvedValue(true);
  process.env.STUDIO_ENABLED = "true";
  process.env.STUDIO_BRAND_PROFILES = "true";
  (globalThis as any).__TEST_ATHLETE_ID = HER;
});

/**
 * THE LIBRARY CARVE-OUT (decision, 23 Sep 2026). propose_campaign alone may read her library — the
 * planner's own assembly, ≤ 4 embeddings. Every other door makes exactly 0. The propose describe sets
 * this true in its own beforeEach; nothing else may. ⚠️ MUTATION "summarize gains library access": make
 * the summarize route call assembleLibrary — the summarize tests red in this afterEach, and "the library
 * is propose_campaign's alone: echo and summarize make no embedding, propose at most four" reds by name.
 */
let libraryAllowed = false;
const MAX_LIBRARY_EMBEDS = 4;

afterEach(async () => {
  delete process.env.STUDIO_BRAND_PROFILES;
  // ─── THE HARD GATE, after EVERY request on EVERY path ────────────────────────────────────────
  expect(generateContent).not.toHaveBeenCalled(); // the planner's (and any) model call
  expect(deriveConcepts).not.toHaveBeenCalled(); // the concept step
  expect(previewGeneration).not.toHaveBeenCalled(); // the quote
  expect(runStudioGeneration).not.toHaveBeenCalled(); // a generation
  expect(queueStitch).not.toHaveBeenCalled(); // a stitch
  // A library search: none, except propose_campaign's own, bounded.
  expect((embedText as jest.Mock).mock.calls.length).toBeLessThanOrEqual(
    libraryAllowed ? MAX_LIBRARY_EMBEDS : 0,
  );
  libraryAllowed = false;
  expect(await db.select().from(studioGenerationPreviews)).toHaveLength(0);
  expect(await db.select().from(studioPlans)).toHaveLength(0);
  expect(await db.select().from(generationJobs)).toHaveLength(0);
});

describe("POST /studio/direction/echo", () => {
  /** ⚠️ MUTATION: drop the `brandProfilesEnabled()` check. This reds, and nothing else does. */
  it("does not exist with STUDIO_BRAND_PROFILES off", async () => {
    delete process.env.STUDIO_BRAND_PROFILES;
    const { status } = await post(input);
    expect(status).toBe(404);
  });

  it("is behind the Studio gate: no athlete on the principal is a 403, not a proposal", async () => {
    (globalThis as any).__TEST_ATHLETE_ID = undefined;
    const { status, json } = await post(input);
    expect(status).toBe(403);
    expect(json?.brief).toBeUndefined();
  });

  it("refuses a body that is not two short lines, naming the field", async () => {
    expect((await post({ productLine: "x" })).json).toMatchObject({
      field: "brand",
    });
    expect((await post({ brand: "x" })).json).toMatchObject({
      field: "productLine",
    });
    expect(
      (await post({ brand: "x".repeat(81), productLine: "y" })).json,
    ).toMatchObject({ field: "brand" });
    expect(
      (await post({ brand: "x", productLine: "y".repeat(121) })).json,
    ).toMatchObject({ field: "productLine" });
    expect((await post([])).status).toBe(400);
  });

  /**
   * The channel, end to end. ⚠️ MUTATION: answer the brief as prose — `res.type("text").send(...)`, or
   * `res.json({ text: JSON.stringify(proposal) })` — "the echo brief arrives as data the client can
   * read, not prose" reds by name.
   */
  it("the echo brief arrives as data the client can read, not prose — valid, and byte-identical to what the tool built", async () => {
    const { status, type, text, json } = await post(input);
    expect(status).toBe(200);
    expect(type).toMatch(/^application\/json/);
    expect(typeof json?.brief).toBe("object");
    expect(Array.isArray(json?.flags)).toBe(true);
    // Zod-valid on arrival: the strict envelope, the strict brief inside it.
    const v = validateBriefProposal(json);
    expect(v.ok).toBe(true);
    // Byte-identical modulo transport: the wire is exactly the tool's answer, re-serialised.
    expect(text).toBe(JSON.stringify(echoBrief(input)));
    // Every filled line is flagged; her two lines literal with their quotes, the rest inferred.
    if (v.ok) {
      expect(unflaggedPaths(v.proposal)).toEqual([]);
      const literal = v.proposal.flags.filter((f) => f.basis === "literal");
      expect(literal.map((f) => [f.path, f.quote])).toEqual([
        ["brand.name", "Solstice"],
        ["product.line", "the matte-black insulated bottle"],
      ]);
      const inferred = v.proposal.flags.filter((f) => f.basis === "inferred");
      expect(inferred.length).toBeGreaterThan(0);
      expect(
        inferred.every(
          (f) => typeof f.because === "string" && f.because.length > 0,
        ),
      ).toBe(true);
      expect(v.proposal.sourceTool).toBe("echo_brief");
    }
  });

  it("no direction route asks the planner, generates, stitches or quotes — the hard gate", async () => {
    // One request per door this folder has. The afterEach holds the gate after each; this test
    // exists so the gate has a name a mutation can red.
    expect((await post(input)).status).toBe(200);
    expect((await postPdf(FULL_PDF)).status).toBe(200);
    fetched.mockResolvedValueOnce(FULL_PDF);
    expect(
      (
        await postJson("/studio/direction/summarize-brief", {
          briefFilePath: `studio-briefs/${HER}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf`,
        })
      ).status,
    ).toBe(200);
    expect(generateContent).not.toHaveBeenCalled();
    expect(deriveConcepts).not.toHaveBeenCalled();
    expect(previewGeneration).not.toHaveBeenCalled();
    expect(runStudioGeneration).not.toHaveBeenCalled();
    expect(queueStitch).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });
});

describe("POST /studio/direction/summarize-brief — a brief she uploaded, by its path", () => {
  const HERS = `studio-briefs/${HER}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf`;
  const THEIRS = `studio-briefs/${SOMEONE_ELSE}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.pdf`;

  it("does not exist with STUDIO_BRAND_PROFILES off", async () => {
    delete process.env.STUDIO_BRAND_PROFILES;
    expect(
      (
        await postJson("/studio/direction/summarize-brief", {
          briefFilePath: HERS,
        })
      ).status,
    ).toBe(404);
    expect(fetched).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  /** ⚠️ MUTATION: drop the isHerBriefPath check — this reds: another athlete's path is read. */
  it("another athlete's brief path is a 404 before anything is read; so is a path that is not a brief", async () => {
    for (const briefFilePath of [
      THEIRS,
      "studio-briefs/../etc/passwd",
      "athletes/x.pdf",
      42,
      undefined,
    ]) {
      const { status, json } = await postJson(
        "/studio/direction/summarize-brief",
        { briefFilePath },
      );
      expect(status).toBe(404);
      expect(json).toEqual({ error: "No such brief" });
    }
    expect(fetched).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("her path that storage does not have is a 404, and no model is called", async () => {
    const { status } = await postJson("/studio/direction/summarize-brief", {
      briefFilePath: HERS,
    });
    expect(status).toBe(404);
    expect(fetched).toHaveBeenCalledWith(HERS);
    expect(transport).not.toHaveBeenCalled();
  });

  it("her brief is read: the pages go to the model as a data part, and the proposal comes back valid with its cost as a header", async () => {
    fetched.mockResolvedValueOnce(FULL_PDF);
    const { status, headers, json } = await postJson(
      "/studio/direction/summarize-brief",
      { briefFilePath: HERS },
    );
    expect(status).toBe(200);
    const v = validateBriefProposal(json);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.proposal.sourceTool).toBe("summarize_brief");
    expect(v.proposal.brief.brand?.name).toBe(BRAND);
    expect(v.proposal.flags.find((f) => f.path === "brand.name")?.basis).toBe(
      "literal",
    );
    expect(v.proposal.extras.extraction).toBe("text");
    expect(unflaggedPaths(v.proposal)).toEqual([]);
    expect(headers.get("x-studio-cost-usd")).toBe("0.0021");
    expect(headers.get("x-studio-model")).toBe("test-flash");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].document).toEqual({
      bytes: FULL_PDF,
      mimeType: "application/pdf",
    });
  });

  it("a model that fails, or answers prose, is a 502 that planned nothing", async () => {
    fetched.mockResolvedValue(FULL_PDF);
    transport.mockRejectedValueOnce(new Error("deadline"));
    expect(
      (
        await postJson("/studio/direction/summarize-brief", {
          briefFilePath: HERS,
        })
      ).status,
    ).toBe(502);
    transport.mockResolvedValueOnce({
      text: "Sorry, I cannot.",
      usage: null,
      model: "test-flash",
    });
    expect(
      (
        await postJson("/studio/direction/summarize-brief", {
          briefFilePath: HERS,
        })
      ).status,
    ).toBe(502);
  });
});

describe("POST /studio/direction/summarize-brief/upload — the PDF itself", () => {
  it("does not exist with STUDIO_BRAND_PROFILES off — refused before the body is read", async () => {
    delete process.env.STUDIO_BRAND_PROFILES;
    expect((await postPdf(FULL_PDF)).status).toBe(404);
    expect(stored).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("only a PDF body is read: another content type is a 415, and so are bytes without the PDF magic", async () => {
    expect(
      (await postPdf(Buffer.from('{"briefFilePath":"x"}'), "application/json"))
        .status,
    ).toBe(415);
    expect(
      (await postPdf(Buffer.from("hello, this is not a pdf"))).status,
    ).toBe(415);
    expect(stored).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("over 10 MB is a 413, and nothing is stored or read", async () => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x20);
    big.write("%PDF-1.4\n", 0, "latin1");
    const { status, json } = await postPdf(big);
    expect(status).toBe(413);
    expect(json).toEqual({ error: "Too large — max 10MB" });
    expect(stored).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  /** ⚠️ MUTATION: store under a path that is not `briefPrefix(athleteId)` — this reds: the plan row could never name it as hers. */
  it("stores the PDF under HER prefix, reads it, and answers the proposal beside the path", async () => {
    const { status, headers, json } = await postPdf(FULL_PDF);
    expect(status).toBe(200);
    expect(stored).toHaveBeenCalledTimes(1);
    const [path, bytes, contentType] = stored.mock.calls[0];
    expect(path).toMatch(
      new RegExp(`^studio-briefs/${HER}/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(Buffer.from(bytes).equals(FULL_PDF)).toBe(true);
    expect(contentType).toBe("application/pdf");
    expect(json.briefFilePath).toBe(path);
    const v = validateBriefProposal(json.proposal);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.proposal.sourceTool).toBe("summarize_brief");
    expect(headers.get("x-studio-cost-usd")).toBe("0.0021");
  });

  it("a store that fails costs her the path, never the reading", async () => {
    stored.mockResolvedValueOnce(false);
    const { status, json } = await postPdf(FULL_PDF);
    expect(status).toBe(200);
    expect(json.briefFilePath).toBeNull();
    expect(validateBriefProposal(json.proposal).ok).toBe(true);
  });
});

describe("POST /studio/direction/propose-campaign — proposals from her objective", () => {
  /** Two photographs of HER in the library, so the planner's assembly has something to read. */
  async function photo(description: string): Promise<void> {
    await db.insert(mediaAssets).values({
      athlete_id: HER,
      platform: "studio",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${HER}/${Math.random().toString(36).slice(2)}.jpg`,
      content_type: "image/jpeg",
      ingested_at: new Date(),
      metadata: {
        vision: {
          athlete_present: true,
          athlete_prominence: 0.8,
          shot_type: "action",
          description,
          brands_visible: [],
          aesthetic_quality: 0.8,
          brand_safe: true,
          hero_suitability: 0.8,
          content_flags: {},
          setting: "a pitch",
          vibe: "focused",
        },
        embedding: [1, 0, 0],
      },
    } as never);
  }

  const proposeReply = () => ({
    text: JSON.stringify({
      proposals: [
        {
          concept: {
            angle: "the hour before floodlights",
            feeling: "quiet, then electric",
            line: "Nobody sees the boots go on; everybody sees the strike under the lights.",
          },
          lines: [
            {
              path: "creative_direction.tone",
              value: ["quiet", "electric"],
              because: "the feel her library carries",
            },
            {
              path: "story",
              value: "the walk from the locker room to the pitch",
              because: "her objective",
            },
          ],
        },
        {
          concept: {
            angle: "a week of touches, counted",
            feeling: "playful",
            line: "Ten thousand touches on the ball this week, and she counts every one out loud.",
          },
          lines: [
            {
              path: "creative_direction.tone",
              value: ["playful"],
              because: "a lighter door in",
            },
          ],
        },
        {
          concept: {
            angle: "the pitch from the ground",
            feeling: "intimate",
            line: "The camera stays on the grass while the game happens above it.",
          },
          lines: [
            {
              path: "creative_direction.energy",
              value: "slow",
              because: "a low angle asks for patience",
            },
          ],
        },
      ],
      notes: [],
    }),
    usage: { inputTokens: 2000, outputTokens: 600 },
    model: "test-pro",
  });

  beforeEach(async () => {
    libraryAllowed = true;
    transport.mockResolvedValue(proposeReply());
    await db.delete(mediaAssets);
    await photo("she strikes a ball at dusk, floodlights behind her");
    await photo("she laces her boots on a bench, head down");
  });

  it("does not exist with STUDIO_BRAND_PROFILES off — no library read, no model", async () => {
    delete process.env.STUDIO_BRAND_PROFILES;
    expect(
      (
        await postJson("/studio/direction/propose-campaign", {
          objective: "grow-following",
        })
      ).status,
    ).toBe(404);
    expect(embedText).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses an objective off the list and an unknown field before any library read", async () => {
    expect(
      (
        await postJson("/studio/direction/propose-campaign", {
          objective: "sell-more",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postJson("/studio/direction/propose-campaign", {
          objective: "recap",
          athleteId: HER,
        })
      ).json,
    ).toMatchObject({ field: "athleteId" });
    expect(embedText).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("the library is propose_campaign's alone: echo and summarize make no embedding, propose at most four — and the planner's own library lines reach the instruction", async () => {
    const { status, headers, json } = await postJson(
      "/studio/direction/propose-campaign",
      { objective: "grow-following" },
    );
    expect(status).toBe(200);
    const calls = (embedText as jest.Mock).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(MAX_LIBRARY_EMBEDS);
    expect(transport).toHaveBeenCalledTimes(1);
    const instruction: string = transport.mock.calls[0][0].instruction;
    expect(instruction).toContain("she laces her boots on a bench");
    expect(instruction).toContain("<<<LIBRARY>>>");
    expect(json.proposals).toHaveLength(3);
    for (const p of json.proposals) {
      const v = validateBriefProposal(p);
      expect(v.ok).toBe(true);
      if (v.ok) {
        expect(v.proposal.sourceTool).toBe("propose_campaign");
        expect(unflaggedPaths(v.proposal)).toEqual([]);
        expect(v.proposal.brief.product).toBeNull();
        expect(v.proposal.extras.concept).toBeDefined();
      }
    }
    expect(headers.get("x-studio-model")).toBe("test-pro");
    expect(headers.get("x-studio-cost-usd")).toBe("0.0021"); // test-pro is unpriced in the text table: the Flash rates apply
  });

  it("a proposal that sells the product never reaches the wire; too few left is a 502 that planned nothing", async () => {
    const r = proposeReply();
    const parsed = JSON.parse(r.text);
    parsed.proposals[1].concept.line =
      "A bottle built to keep drinks cold all day, and her whole morning around it.";
    transport.mockResolvedValue({ ...r, text: JSON.stringify(parsed) });
    const two = await postJson("/studio/direction/propose-campaign", {
      objective: "grow-following",
    });
    expect(two.status).toBe(200);
    expect(two.json.proposals).toHaveLength(2);
    expect(JSON.stringify(two.json)).not.toMatch(/built to keep/);
    parsed.proposals[2].concept.line =
      "Nobody sees the boots go on; everybody sees the strike under the lights, again.";
    transport.mockResolvedValue({ ...r, text: JSON.stringify(parsed) });
    const one = await postJson("/studio/direction/propose-campaign", {
      objective: "grow-following",
    });
    expect(one.status).toBe(502);
    expect(one.json.error).toMatch(/two distinct ideas/);
  });
});

describe("POST /studio/direction/decompose-reference — a reference she pasted or uploaded", () => {
  const referenceTransport = jest.requireMock("../reference/transport")
    .geminiReferenceTransport as jest.Mock;
  const recorded = JSON.parse(
    readFileSync(
      join(
        __dirname,
        "..",
        "reference",
        "fixtures",
        "probe-recorded-2026-09-22.json",
      ),
      "utf8",
    ),
  ) as { cells: { id: string; decomposition: unknown }[] };
  const reply = (id: string) => ({
    text: JSON.stringify(
      recorded.cells.find((c) => c.id === id)!.decomposition,
    ),
    usage: { inputTokens: 1949, outputTokens: 512 },
    model: "test-flash",
  });
  let herPhoto: string;
  let theirPhoto: string;

  beforeAll(async () => {
    await db
      .insert(athletes)
      .values([{ id: SOMEONE_ELSE, full_name: "Another Athlete" }] as never);
    const insert = async (owner: string) =>
      (
        await db
          .insert(mediaAssets)
          .values({
            athlete_id: owner,
            platform: "upload",
            origin: "upload",
            media_type: "IMAGE",
            status: "stored",
            gcs_path: `athletes/${owner}/uploads/ref.jpg`,
            content_type: "image/jpeg",
            ingested_at: new Date(),
            metadata: {},
          } as never)
          .returning({ id: mediaAssets.id })
      )[0].id;
    herPhoto = await insert(HER);
    theirPhoto = await insert(SOMEONE_ELSE);
  });

  beforeEach(() => {
    referenceTransport.mockResolvedValue(reply("B1"));
  });

  it("does not exist with STUDIO_BRAND_PROFILES off", async () => {
    delete process.env.STUDIO_BRAND_PROFILES;
    expect(
      (
        await postJson("/studio/direction/decompose-reference", {
          source: { kind: "text", text: "a soccer ad" },
        })
      ).status,
    ).toBe(404);
    expect(referenceTransport).not.toHaveBeenCalled();
  });

  it("a pasted brief comes back as a proposal in which every line is inferred, with the decomposition in references[0]", async () => {
    const { status, headers, json } = await postJson(
      "/studio/direction/decompose-reference",
      {
        source: {
          kind: "text",
          text: "a soccer ad with me in it — calm, clean, floodlit",
        },
        role: "style_reference",
      },
    );
    expect(status).toBe(200);
    const v = validateBriefProposal(json);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.proposal.sourceTool).toBe("decompose_reference");
    expect(v.proposal.flags.every((f) => f.basis === "inferred")).toBe(true);
    expect(unflaggedPaths(v.proposal)).toEqual([]);
    expect(v.proposal.brief.references[0].role).toBe("style_reference");
    expect(v.proposal.brief.creative_direction.style).toBe("sports_campaign");
    expect(headers.get("x-studio-model")).toBe("test-flash");
    expect(headers.get("x-studio-cost-usd")).not.toBeNull();
    expect(referenceTransport).toHaveBeenCalledTimes(1);
    expect(referenceTransport.mock.calls[0][0].image).toBeNull();
  });

  it("her photo is read as the image part; another athlete's photo is not found, and no call is made", async () => {
    const mine = await postJson("/studio/direction/decompose-reference", {
      source: { kind: "image", assetId: herPhoto },
    });
    expect(mine.status).toBe(200);
    expect(referenceTransport.mock.calls[0][0].image).toEqual({
      bytes: expect.any(Object),
      mimeType: "image/jpeg",
    });
    referenceTransport.mockClear();
    const theirs = await postJson("/studio/direction/decompose-reference", {
      source: { kind: "image", assetId: theirPhoto },
    });
    expect(theirs.status).toBe(404);
    expect(theirs.json).toEqual({ error: "No such photo" });
    expect(referenceTransport).not.toHaveBeenCalled();
  });

  it("a bad shape and an unknown field are 400s, before anything runs", async () => {
    expect(
      (
        await postJson("/studio/direction/decompose-reference", {
          source: { kind: "text", text: "" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postJson("/studio/direction/decompose-reference", {
          source: { kind: "text", text: "x" },
          athleteId: HER,
        })
      ).json,
    ).toMatchObject({ field: "athleteId" });
    expect(referenceTransport).not.toHaveBeenCalled();
  });

  const image = (
    bytes = Buffer.from("jpeg-bytes"),
    type = "image/jpeg",
    extra: Record<string, string> = {},
  ) =>
    new Response(bytes, {
      status: 200,
      headers: { "content-type": type, ...extra },
    });
  const referenceRows = () =>
    db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.athlete_id, HER),
          eq(mediaAssets.origin, "reference"),
        ),
      );

  /**
   * ⚠️ MUTATIONS: `fetch(url)` in place of safeFetch — the tripwire's "no direction module calls
   * fetch outside safeFetch" AND this test (the stand-in is never called) red; origin 'upload' on the
   * stored row — "never offered as her footage" reds on herPhoto and on searchMedia both.
   */
  it("a direct image link is fetched through safeFetch, stored as HERS with origin 'reference', read as the image part — and never offered as her footage", async () => {
    (safeFetch as jest.Mock).mockResolvedValueOnce(image());
    (saveBuffer as jest.Mock).mockImplementationOnce(
      async (buf: Buffer, basePath: string, ct: string) => ({
        gcs_path: `${basePath}.jpg`,
        content_type: ct,
        bytes: buf.byteLength,
      }),
    );
    const { status, headers, json } = await postJson(
      "/studio/direction/decompose-reference",
      { source: { kind: "url", url: "https://brand.example/look.jpg" } },
    );
    expect(status).toBe(200);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect((safeFetch as jest.Mock).mock.calls[0][0]).toBe(
      "https://brand.example/look.jpg",
    );
    expect((saveBuffer as jest.Mock).mock.calls[0][1]).toMatch(
      new RegExp(`^athletes/${HER}/references/`),
    );
    const id = headers.get("x-studio-reference-asset-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, id!));
    expect(row).toMatchObject({
      athlete_id: HER,
      origin: "reference",
      media_type: "IMAGE",
      status: "stored",
      content_type: "image/jpeg",
    });
    expect(referenceTransport.mock.calls[0][0].image).toEqual({
      bytes: expect.any(Object),
      mimeType: "image/jpeg",
    });
    const v = validateBriefProposal(json);
    expect(v.ok).toBe(true);
    expect(json.extras.notes.join(" ")).toMatch(/picture at her link/);
    // The marker every reader of her library honours (0062): the row exists and is not her footage.
    expect((await referenceRows()).map((r) => r.id)).toContain(id);
    const offered = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(herPhotoPredicate(HER));
    expect(offered.length).toBeGreaterThan(0); // her real photo is there …
    expect(offered.map((r) => r.id)).not.toContain(id); // … the reference is not
    const searched = await searchMedia(HER, {});
    expect(searched.map((r) => r.id)).not.toContain(id);
  });

  it("a page is a 415, an oversize image a 413, an unsafe link a 400 — nothing stored, no row written, no call made", async () => {
    const before = (await referenceRows()).length;
    (safeFetch as jest.Mock).mockResolvedValueOnce(
      new Response("<html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const page = await postJson("/studio/direction/decompose-reference", {
      source: { kind: "url", url: "https://brand.example/lookbook" },
    });
    expect(page.status).toBe(415);
    expect(page.json.error).toMatch(/direct image/);
    (safeFetch as jest.Mock).mockResolvedValueOnce(
      image(Buffer.alloc(16), "image/png", {
        "content-length": String(11 * 1024 * 1024),
      }),
    );
    expect(
      (
        await postJson("/studio/direction/decompose-reference", {
          source: { kind: "url", url: "https://brand.example/huge.png" },
        })
      ).status,
    ).toBe(413);
    (safeFetch as jest.Mock).mockRejectedValueOnce(
      new UnsafeUrlError("http://brand.example/look.jpg", "scheme" as never),
    );
    const unsafe = await postJson("/studio/direction/decompose-reference", {
      source: { kind: "url", url: "http://brand.example/look.jpg" },
    });
    expect(unsafe.status).toBe(400);
    expect(unsafe.json).toMatchObject({ field: "source.url" });
    expect(saveBuffer).not.toHaveBeenCalled();
    expect(referenceTransport).not.toHaveBeenCalled();
    expect((await referenceRows()).length).toBe(before);
  });

  it("a reply the engine refuses is a 502 that planned nothing", async () => {
    referenceTransport.mockResolvedValueOnce({
      text: "not the json",
      usage: null,
      model: "test-flash",
    });
    const r = await postJson("/studio/direction/decompose-reference", {
      source: { kind: "text", text: "x" },
    });
    expect(r.status).toBe(502);
  });
});

describe("POST /studio/direction/research-moment — a moment found live, never dated by the model", () => {
  const grounded = callStructured as jest.Mock;
  const ledger = jest.requireMock(
    "../../services/intelligence/research/ledger",
  ) as {
    reserveLlmCall: jest.Mock;
  };
  const answer = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      found: true,
      title: "Derby week: Crosstown United at home",
      summary:
        "The town's derby returns; last season's 2–1 is still argued about on the terraces.",
      angle: "the week before the derby from inside the squad",
      feeling: "charged, loyal, a little superstitious",
      line: "Derby week. You'll know when you see it.",
      feel: ["charged", "loyal", "superstitious"],
      // Two things the model was told not to send, sent anyway — and never read:
      date: "2026-10-04",
      sources: ["https://fake.example/the-model-made-this-up"],
      ...over,
    });
  // What callStructured hands back for one OpenAI web search: the answer, the pages the search saw (real
  // URLs) and the cost of the call (tokens + the web search fee, agent/models costOf).
  const found = (over: Record<string, unknown> = {}) => ({
    json: JSON.parse(answer(over)),
    text: answer(over),
    sources: [
      {
        url: "https://www.localpaper.example/crosstown-derby-preview",
        title: "Crosstown United v Home FC — derby preview",
      },
      { url: "https://league.example/fixtures" },
    ],
    queries: ["crosstown derby fixture"],
    status: "completed",
    responseId: null,
    durationMs: 1,
    usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 240, reasoningTokens: 0, webSearchCalls: 1 },
    cost: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 240, reasoningTokens: 0, webSearchCalls: 1, microUsd: 10_210 },
  });
  const ledgerRows = async () =>
    (await db.select({ day: researchBudgetDays.day }).from(researchBudgetDays))
      .length;
  const getJson = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeEach(() => {
    process.env.STUDIO_DIRECTION_MOMENTS = "true";
    grounded.mockResolvedValue(found());
  });
  afterEach(() => {
    delete process.env.STUDIO_DIRECTION_MOMENTS;
  });

  it("does not exist without its own flag, even with the profiles flag on — and no search runs", async () => {
    delete process.env.STUDIO_DIRECTION_MOMENTS;
    const r = await postJson("/studio/direction/research-moment", {
      ask: "our next derby",
    });
    expect(r.status).toBe(404);
    expect(grounded).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ MUTATIONS: read the model's `date` — "a date is hers or nobody's" (the 2026-10-04 assertion)
   * reds; cite the model's `sources` — the fake.example assertion reds; import + call reserveLlmCall
   * in moment.ts — "never touches the research ledger" reds here AND the tripwire reds.
   */
  it("one web search → a proposal: the moment as story, its feel as tone, a concept; every line inferred and cited from the pages the SEARCH saw; the model's date and sources never read; the research ledger never touched", async () => {
    const before = await ledgerRows();
    const { status, headers, json } = await postJson(
      "/studio/direction/research-moment",
      {
        ask: "our next derby at home",
      },
    );
    expect(status).toBe(200);
    const v = validateBriefProposal(json);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.proposal.sourceTool).toBe("research_moment");
    expect(v.proposal.brief.story).toBe("Derby week: Crosstown United at home");
    expect(v.proposal.brief.creative_direction.tone).toEqual([
      "charged",
      "loyal",
      "superstitious",
    ]);
    expect(v.proposal.extras.concept).toEqual({
      angle: "the week before the derby from inside the squad",
      feeling: "charged, loyal, a little superstitious",
      line: "Derby week. You'll know when you see it.",
    });
    expect(v.proposal.flags.every((f) => f.basis === "inferred")).toBe(true);
    expect(v.proposal.flags.find((f) => f.path === "story")?.because).toMatch(
      /localpaper\.example/,
    );
    expect(unflaggedPaths(v.proposal)).toEqual([]);
    // The pages the search saw are the citations — the model's claimed link is nowhere.
    expect(v.proposal.extras.moment?.sources).toEqual([
      {
        title: "Crosstown United v Home FC — derby preview",
        url: "https://www.localpaper.example/crosstown-derby-preview",
        domain: "localpaper.example",
      },
      {
        title: null,
        url: "https://league.example/fixtures",
        domain: "league.example",
      },
    ]);
    expect(v.proposal.extras.moment?.searchQueries).toEqual([
      "crosstown derby fixture",
    ]);
    expect(JSON.stringify(json)).not.toContain("fake.example");
    // A date is hers or nobody's: the model's is never read, and without hers there is no timing line.
    expect(JSON.stringify(json)).not.toContain("2026-10-04");
    expect(v.proposal.extras.constraints).toEqual([]);
    expect(v.proposal.extras.moment?.dateBasis).toBe("none");
    expect(v.proposal.extras.notes?.join(" ")).toMatch(/No date/);
    // The call: the ask fenced as data, the athlete's sport beside it, the tool's own instruction; ONE OpenAI
    // web search at low context.
    expect(grounded).toHaveBeenCalledTimes(1);
    const [req] = grounded.mock.calls[0] as [
      { input: string; skill: { instructions: string }; webSearch: unknown; model: { provider: string } },
    ];
    expect(req.input).toMatch(
      /<<<HER_ASK>>>\nour next derby at home\n<<<END_HER_ASK>>>/,
    );
    expect(req.skill.instructions).toMatch(/JSON object/);
    expect(req.webSearch).toEqual({ maxCalls: 1, contextSize: "low" });
    expect(req.model.provider).toBe("openai");
    // The cost line's numbers on the wire: the call's own cost, search fee included.
    expect(Number(headers.get("x-studio-cost-usd"))).toBe(0.01021);
    expect(headers.get("x-studio-model")).toBe(momentModel().model);
    // Never the research lane's ledger — no reservation, no row.
    expect(ledger.reserveLlmCall).not.toHaveBeenCalled();
    expect(await ledgerRows()).toBe(before);
  });

  it("a date SHE typed is the one literal line — a Timing constraint quoting her words — and the model's date is still never read", async () => {
    const { status, json } = await postJson(
      "/studio/direction/research-moment",
      {
        ask: "our next derby at home",
        date: "Saturday 4 Oct",
      },
    );
    expect(status).toBe(200);
    const v = validateBriefProposal(json);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.proposal.extras.constraints).toEqual(["Timing: Saturday 4 Oct"]);
    expect(
      v.proposal.flags.find((f) => f.path === "extras.constraints.0"),
    ).toEqual({
      path: "extras.constraints.0",
      basis: "literal",
      quote: "Saturday 4 Oct",
    });
    expect(v.proposal.extras.moment?.dateBasis).toBe("hers");
    expect(JSON.stringify(json)).not.toContain("2026-10-04");
    expect(unflaggedPaths(v.proposal)).toEqual([]);
  });

  it("a year or a date inside what the search wrote is stripped before it reaches a line, and named as removed", async () => {
    grounded.mockResolvedValueOnce(
      found({
        title: "2026 NWSL Championship",
        summary: "The final is on October 4th, 2026 at Audi Field.",
      }),
    );
    const { status, json } = await postJson(
      "/studio/direction/research-moment",
      {
        ask: "the next big final",
      },
    );
    expect(status).toBe(200);
    const v = validateBriefProposal(json);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.proposal.brief.story).toBe("NWSL Championship");
    expect(v.proposal.extras.moment?.summary).toBe(
      "The final is at Audi Field.",
    );
    expect(v.proposal.extras.moment?.timingRemoved).toEqual([
      "2026",
      "on October 4th, 2026",
    ]);
    expect(
      JSON.stringify({
        brief: v.proposal.brief,
        concept: v.proposal.extras.concept,
      }),
    ).not.toMatch(/\b(19|20)\d{2}\b|October/);
    expect(v.proposal.extras.notes?.join(" ")).toMatch(
      /removed \(2026, on October 4th, 2026\)/,
    );
  });

  it("nothing current is a 422, an unreadable answer a 502, a bad ask or an unknown field a 400 — the last two before any search", async () => {
    grounded.mockResolvedValueOnce(
      found({ found: false, title: undefined, summary: undefined }),
    );
    expect(
      (await postJson("/studio/direction/research-moment", { ask: "x" }))
        .status,
    ).toBe(422);
    grounded.mockRejectedValueOnce(
      new ModelCallError("research_moment: the model returned no valid JSON", {
        text: "I found many things! Here is prose.",
      }),
    );
    expect(
      (await postJson("/studio/direction/research-moment", { ask: "x" }))
        .status,
    ).toBe(502);
    grounded.mockClear();
    expect(
      (await postJson("/studio/direction/research-moment", { ask: "" })).status,
    ).toBe(400);
    expect(
      (
        await postJson("/studio/direction/research-moment", {
          ask: "x",
          athleteId: HER,
        })
      ).json,
    ).toMatchObject({ field: "athleteId" });
    expect(grounded).not.toHaveBeenCalled();
  });

  it("the trend door says, honestly, that it is not available — and carries nothing else; off with the profiles flag", async () => {
    const r = await getJson("/studio/direction/trend");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      available: false,
      reason: expect.stringMatching(/not wired|nothing is simulated/),
    });
    expect(Object.keys(r.json)).toEqual(["available", "reason"]);
    delete process.env.STUDIO_BRAND_PROFILES;
    expect((await getJson("/studio/direction/trend")).status).toBe(404);
  });

  // LAST: it fills the shared in-memory window for HER, and the window outlives this file's tests.
  it("over the shared per-athlete window the door is a 429 and no search runs (the limiter Mila shares)", async () => {
    for (let i = 0; i < MILA.WEB_SEARCH_MAX_PER_WINDOW; i++)
      webSearchLimiter.record(HER);
    const r = await postJson("/studio/direction/research-moment", {
      ask: "our next derby",
    });
    expect(r.status).toBe(429);
    expect(r.json.error).toMatch(/Nothing was spent/);
    expect(grounded).not.toHaveBeenCalled();
  });
});
