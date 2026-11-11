/**
 * decompose.test — decompose_reference: the engine's recorded output mapped onto a brief, every line
 * inferred; the engine itself untouched and reached through its own deps.
 *
 * The decompositions are PR 3's recorded live replies (studio/reference/fixtures), so the mapping is
 * tested against what the engine really answers. The wrapper is tested against in-memory Postgres, the
 * engine writes its analysis row as in production, and the model is a scripted transport.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  athletes,
  mediaAssets,
  studioReferenceAnalyses,
} from "../../../shared/schema";
import { db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { validateCampaignBrief } from "../campaign/brief";
import type { ReferenceTransport } from "../reference/transport";
import { unflaggedPaths, validateBriefProposal } from "./envelope";
import {
  decomposeToProposal,
  proposalFromDecomposition,
  readDecomposeInput,
  toneClauses,
} from "./decompose";

const HER = "33333333-1111-4444-8555-888888888888";
const SOMEONE_ELSE = "44444444-1111-4777-8666-999999999999";

interface RecordedCell {
  id: string;
  what: string;
  decomposition: Parameters<typeof proposalFromDecomposition>[0];
}
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
) as { cells: RecordedCell[] };
const cell = (id: string) => recorded.cells.find((c) => c.id === id)!;

/** A transport that answers one recorded decomposition as the model would, and records what it was handed. */
function transportOf(id: string) {
  const requests: { prompt: string; hasImage: boolean }[] = [];
  const transport: ReferenceTransport = async (req) => {
    requests.push({ prompt: req.prompt, hasImage: !!req.image });
    return {
      text: JSON.stringify(cell(id).decomposition),
      usage: { inputTokens: 1949, outputTokens: 512 },
      model: "test-flash",
    };
  };
  return { transport, requests };
}
const loadImage = async () => ({
  bytes: Buffer.from("jpeg"),
  mimeType: "image/jpeg",
});

let herPhoto: string;

beforeAll(async () => {
  await initTestDb();
  await db.insert(athletes).values([
    { id: HER, full_name: "Reference Athlete" },
    { id: SOMEONE_ELSE, full_name: "Another Athlete" },
  ] as never);
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: HER,
      platform: "upload",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${HER}/uploads/ref.jpg`,
      content_type: "image/jpeg",
      ingested_at: new Date(),
      metadata: {},
    } as never)
    .returning({ id: mediaAssets.id });
  herPhoto = row.id;
});
afterAll(closeTestDb);
beforeEach(() => {
  process.env.STUDIO_BRAND_PROFILES = "true";
});
afterEach(() => {
  delete process.env.STUDIO_BRAND_PROFILES;
});

describe("the mapping — a recorded decomposition onto a brief", () => {
  it("every recorded cell maps to a valid proposal in which EVERY line is inferred and the intent rides in references[0]", () => {
    expect(recorded.cells.length).toBeGreaterThanOrEqual(4);
    for (const c of recorded.cells) {
      const p = proposalFromDecomposition(c.decomposition, "style_reference", {
        kind: "image",
        droppedTags: 0,
      });
      const v = validateBriefProposal(p);
      expect({ id: c.id, ok: v.ok, issues: v.ok ? [] : v.issues }).toEqual({
        id: c.id,
        ok: true,
        issues: [],
      });
      if (!v.ok) continue;
      expect(v.proposal.sourceTool).toBe("decompose_reference");
      expect(unflaggedPaths(v.proposal)).toEqual([]);
      expect(v.proposal.flags.every((f) => f.basis === "inferred")).toBe(true);
      expect(v.proposal.brief.references).toEqual([
        {
          ref: "ref_1",
          role: "style_reference",
          intent: c.decomposition.reference_intent,
        },
      ]);
      expect(v.proposal.brief.creative_direction.style).toBe(
        c.decomposition.commercial_style[0] ?? null,
      );
      expect(v.proposal.brief.brand).toBeNull();
      expect(v.proposal.brief.product).toBeNull();
      expect(v.proposal.brief.story).toBeNull();
      expect(v.proposal.extras.notes?.[0]).toMatch(/inference by definition/);
      // The planner's own validator takes the brief as it is.
      expect(validateCampaignBrief(v.proposal.brief).ok).toBe(true);
    }
  });

  it("tone comes from the emotional tone's clauses, energy from the first motion tag, each with a because that names its dimension", () => {
    const d = cell("I1").decomposition;
    const p = proposalFromDecomposition(d, "composition_reference", {
      kind: "text",
      droppedTags: 2,
    });
    const v = validateBriefProposal(p);
    if (!v.ok) throw new Error(v.issues.join("\n"));
    const tone = v.proposal.flags.find(
      (f) => f.path === "creative_direction.tone",
    );
    expect(tone?.because).toMatch(/^from the reference's emotional tone: /);
    expect(v.proposal.brief.creative_direction.tone).toEqual(
      toneClauses(d.reference_intent.emotional_tone.summary),
    );
    expect(v.proposal.brief.references[0].role).toBe("composition_reference");
    expect(v.proposal.extras.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^The pasted text read on/),
        "2 off-list tags dropped.",
      ]),
    );
    expect(
      toneClauses("Calm, focused and unhurried; the whole frame breathes."),
    ).toEqual(["calm", "focused", "unhurried", "whole frame breathes"]);
  });
});

describe("decompose_reference — the wrapper, over the untouched engine", () => {
  it("a pasted brief: the engine reads it as text, writes its analysis row under her id, and the proposal comes back all inferred", async () => {
    const { transport, requests } = transportOf("I1");
    const r = await decomposeToProposal(
      HER,
      {
        source: {
          kind: "text",
          text: "a soccer ad with me in it, calm and clean",
        },
      },
      { transport },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(requests).toEqual([
      {
        prompt: expect.stringContaining("<<<REFERENCE_BRIEF>>>"),
        hasImage: false,
      },
    ]);
    expect(r.proposal.flags.every((f) => f.basis === "inferred")).toBe(true);
    expect(r.cost).toEqual({
      usd: expect.any(Number),
      basis: "estimated",
      inputTokens: 1949,
      outputTokens: 512,
    });
    const rows = await db.select().from(studioReferenceAnalyses);
    expect(
      rows.some((row) => row.id === r.analysisId && row.athlete_id === HER),
    ).toBe(true);
  });

  it("her image: loaded under her id, sent as the image part; another athlete's id is not found, and no call is made", async () => {
    const mine = transportOf("I1");
    const r = await decomposeToProposal(
      HER,
      { source: { kind: "image", assetId: herPhoto }, role: "style_reference" },
      { transport: mine.transport, loadImage },
    );
    expect(r.ok).toBe(true);
    expect(mine.requests).toEqual([
      { prompt: expect.any(String), hasImage: true },
    ]);
    const theirs = transportOf("I1");
    expect(
      await decomposeToProposal(
        SOMEONE_ELSE,
        { source: { kind: "image", assetId: herPhoto } },
        { transport: theirs.transport, loadImage },
      ),
    ).toEqual({
      ok: false,
      reason: "not_found",
      issues: undefined,
      cost: undefined,
      model: undefined,
    });
    expect(theirs.requests).toHaveLength(0);
  });

  it("a URL is fetched through the seam, stored as HER row with origin 'reference', then read as the image", async () => {
    const { transport, requests } = transportOf("I1");
    const saved: string[] = [];
    const r = await decomposeToProposal(
      HER,
      { source: { kind: "url", url: "https://brand.example/look.jpg" } },
      {
        transport,
        fetchUrl: async () =>
          new Response(Buffer.from("jpeg-bytes"), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          }),
        save: async (buf, basePath, ct) => {
          saved.push(basePath);
          return {
            gcs_path: `${basePath}.jpg`,
            content_type: ct,
            bytes: buf.byteLength,
          };
        },
        loadImage: async () => ({
          bytes: Buffer.from("jpeg-bytes"),
          mimeType: "image/jpeg",
        }),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(saved[0]).toMatch(new RegExp(`^athletes/${HER}/references/`));
    expect(r.storedAssetId).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, r.storedAssetId!));
    expect(row).toMatchObject({
      athlete_id: HER,
      origin: "reference",
      media_type: "IMAGE",
      status: "stored",
      content_type: "image/jpeg",
    });
    expect(
      (row.metadata as { reference?: { url?: string } }).reference?.url,
    ).toBe("https://brand.example/look.jpg");
    expect(requests).toHaveLength(1);
    expect(requests[0].hasImage).toBe(true);
    expect(r.proposal.flags.every((f) => f.basis === "inferred")).toBe(true);
    expect(r.proposal.extras.notes?.join(" ")).toMatch(/picture at her link/);
  });

  it("a page, an oversize image and an unsafe link are refused by name before anything is stored or read", async () => {
    const { transport, requests } = transportOf("I1");
    const save = jest.fn();
    const page = await decomposeToProposal(
      HER,
      { source: { kind: "url", url: "https://brand.example/lookbook" } },
      {
        transport,
        save,
        fetchUrl: async () =>
          new Response("<html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      },
    );
    expect(page).toMatchObject({ ok: false, reason: "not_an_image" });
    const big = await decomposeToProposal(
      HER,
      { source: { kind: "url", url: "https://brand.example/huge.png" } },
      {
        transport,
        save,
        fetchUrl: async () =>
          new Response(Buffer.alloc(8), {
            status: 200,
            headers: {
              "content-type": "image/png",
              "content-length": String(11 * 1024 * 1024),
            },
          }),
      },
    );
    expect(big).toMatchObject({ ok: false, reason: "too_large" });
    const { UnsafeUrlError } = await import("../../lib/safeFetch");
    const unsafe = await decomposeToProposal(
      HER,
      { source: { kind: "url", url: "http://brand.example/look.jpg" } },
      {
        transport,
        save,
        fetchUrl: async () => {
          throw new UnsafeUrlError("http://brand.example/look.jpg", "scheme");
        },
      },
    );
    expect(unsafe).toMatchObject({ ok: false, reason: "url_refused" });
    expect(save).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("reads the input strictly, and the flag off is the engine's own refusal", async () => {
    expect(
      readDecomposeInput({ source: { kind: "text", text: "x".repeat(2001) } }),
    ).toMatchObject({ ok: false });
    expect(
      readDecomposeInput({ source: { kind: "image", assetId: "nope" } }),
    ).toMatchObject({ ok: false });
    expect(
      readDecomposeInput({
        source: { kind: "text", text: "ok" },
        role: "mood",
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.stringMatching(/^role: one of/)],
    });
    expect(
      readDecomposeInput({ source: { kind: "text", text: "ok" } }),
    ).toEqual({
      ok: true,
      value: { source: { kind: "text", text: "ok" }, role: "style_reference" },
    });
    delete process.env.STUDIO_BRAND_PROFILES;
    const { transport, requests } = transportOf("I1");
    expect(
      await decomposeToProposal(
        HER,
        { source: { kind: "text", text: "ok" } },
        { transport },
      ),
    ).toMatchObject({ ok: false, reason: "disabled" });
    expect(requests).toHaveLength(0);
  });
});
