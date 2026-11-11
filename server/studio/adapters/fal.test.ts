/**
 * fal.test.ts — the segmentation adapter, with `fetch` stubbed so nothing here reaches fal or
 * spends a cent.
 *
 * The assertions that matter are not "it parses the response". They are:
 *
 *  1. A SIGNED URL CANNOT REACH FAL. This is the privacy decision the header of fal.ts explains,
 *     and it is enforced by a type plus a throw rather than by everyone remembering. The test that
 *     proves it is the one that passes a url reference and expects a refusal — if that ever starts
 *     passing, an athlete's photograph has become a fetchable third-party link.
 *  2. AN EMPTY MASK IS NOT AN ERROR. A vocabulary miss returns zero assets and the caller falls back
 *     to the rectangle. Throwing there would turn the designed fallback into a lost, already-billed
 *     crop.
 *  3. THE CALL IS COUNTED. It spends, so it goes through the router's cost log like everything else.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generate } from "../router";
import { readLog } from "../costLog";
import { dataUriFor, masksFrom } from "./fal";
import { GenerationError } from "../types";

const ORIGINAL_ENV = { ...process.env };
const MODEL = "fal-ai/sam-3/image";
const FAL = { provider: "fal" as const, model: MODEL };
const MASK_B64 = Buffer.from("fake-mask-png").toString("base64");

let fetchMock: jest.Mock;
let logDir: string;
let logFile: string;

const bytesRef = () => ({ kind: "bytes" as const, bytes: Buffer.from("crop-pixels"), mimeType: "image/png" });
const bodyOf = (call: number) => JSON.parse((fetchMock.mock.calls[call][1] as any).body);

function queue(...bodies: unknown[]) {
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body, text: async () => "" } as any);
  }
}

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "studio-fal-"));
  logFile = join(logDir, "log.jsonl");
  process.env = {
    ...ORIGINAL_ENV,
    FAL_KEY: "test-key",
    STUDIO_COST_LOG: logFile,
    STUDIO_PRICE_JSON: JSON.stringify({ [MODEL]: { unit: "per_image", usd: 0.005 } }),
  };
  fetchMock = jest.fn();
  global.fetch = fetchMock as any;
});

afterEach(() => rmSync(logDir, { recursive: true, force: true }));
afterAll(() => { process.env = ORIGINAL_ENV; });

describe("the image goes as bytes, and a url cannot be made to work", () => {
  it("refuses a url reference outright rather than fetching and inlining it", () => {
    // The whole privacy argument in one assertion. A future caller holding the signed frame url it
    // is sitting next to cannot pass it here "just this once".
    expect(() => dataUriFor([{ kind: "url", url: "https://storage.googleapis.com/signed?token=secret" }]))
      .toThrow(/never a url/);
  });

  it("names the reason, so nobody reads it as a capability gap to fill in later", () => {
    try {
      dataUriFor([{ kind: "url", url: "https://example.com/x.png" }]);
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(GenerationError);
      expect((err as GenerationError).code).toBe("invalid_input");
      expect((err as GenerationError).message).toMatch(/photograph/);
    }
  });

  it("sends the crop as a data URI carrying the reference's own mime type", async () => {
    queue({ masks: [{ url: `data:image/png;base64,${MASK_B64}` }] });
    await generate("image.segment", { prompt: "jersey", references: [bytesRef()] }, FAL);

    const body = bodyOf(0);
    expect(body.image_url).toBe(`data:image/png;base64,${Buffer.from("crop-pixels").toString("base64")}`);
    // No signed url, no https reference to anything of hers, anywhere in the request.
    expect(JSON.stringify(body)).not.toMatch(/storage\.googleapis/);
  });

  it("asks for the mask and not a cut-out of her photograph", async () => {
    queue({ masks: [{ url: `data:image/png;base64,${MASK_B64}` }] });
    await generate("image.segment", { prompt: "socks", references: [bytesRef()] }, FAL);
    expect(bodyOf(0).apply_mask).toBe(false);
    expect(bodyOf(0).prompt).toBe("socks");
  });

  it("goes to the synchronous host, not the queue", async () => {
    queue({ masks: [{ url: `data:image/png;base64,${MASK_B64}` }] });
    await generate("image.segment", { prompt: "jersey", references: [bytesRef()] }, FAL);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://fal.run/${MODEL}`);
  });
});

describe("an empty mask list is an answer, not a failure", () => {
  it("returns zero assets rather than throwing when the noun found nothing", async () => {
    // The vocabulary miss: "jersey" on a crop top. The caller reads this as "no mask" and
    // composites the rectangle.
    queue({ masks: [] });
    const result = await generate("image.segment", { prompt: "jersey", references: [bytesRef()] }, FAL);
    expect(result.assets).toHaveLength(0);
  });

  it("does the same for a payload carrying no masks field at all", async () => {
    queue({});
    const result = await generate("image.segment", { prompt: "jersey", references: [bytesRef()] }, FAL);
    expect(result.assets).toHaveLength(0);
  });

  it("still throws on a provider error, which is a different thing entirely", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "upstream boom" } as any);
    await expect(
      generate("image.segment", { prompt: "jersey", references: [bytesRef()] }, FAL),
    ).rejects.toThrow(/fal segmentation failed \(500\)/);
  });
});

describe("masksFrom reads the shapes fal actually uses, and guesses at none", () => {
  const noFetch = (async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;

  it("reads an inline data uri", async () => {
    const out = (await masksFrom({ masks: [{ url: `data:image/png;base64,${MASK_B64}` }] }, noFetch, undefined))[0];
    expect(out?.toString()).toBe("fake-mask-png");
  });

  it("reads a bare base64 content field", async () => {
    const out = (await masksFrom({ masks: [{ content: MASK_B64 }] }, noFetch, undefined))[0];
    expect(out?.toString()).toBe("fake-mask-png");
  });

  it("fetches a hosted mask url — which carries none of her pixels, only fal's own output", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Buffer.from("fetched-mask"),
    });
    const out = (await masksFrom({ masks: [{ url: "https://fal.media/m.png" }] }, fetchImpl as any, undefined))[0];
    expect(out?.toString()).toBe("fetched-mask");
  });

  it("returns null on a shape it does not recognise rather than inventing one", async () => {
    expect(await masksFrom({ masks: [{ somethingElse: 1 }] }, noFetch, undefined)).toEqual([]);
    expect(await masksFrom({ masks: [] }, noFetch, undefined)).toEqual([]);
    expect(await masksFrom(null, noFetch, undefined)).toEqual([]);
  });
});

describe("the call is counted, because it spends", () => {
  it("writes one cost-log line at the flat per-call price", async () => {
    queue({ masks: [{ url: `data:image/png;base64,${MASK_B64}` }] });
    await generate("image.segment", { prompt: "jersey", references: [bytesRef()] }, FAL);

    const lines = await readLog(logFile);
    const seg = lines.filter((l: any) => l.task === "image.segment");
    expect(seg).toHaveLength(1);
    expect(seg[0].cost).toBeCloseTo(0.005, 6);
    expect(seg[0].provider).toBe("fal");
  });
});

describe("the adapter claims only what it serves", () => {
  it("refuses to be routed a generation", async () => {
    await expect(
      generate("image.generate", { prompt: "x" }, { provider: "fal", model: MODEL }),
    ).rejects.toThrow(/does not support image\.generate/);
  });

  it("refuses a segment call with no image at the router door", async () => {
    await expect(generate("image.segment", { prompt: "jersey" }, FAL)).rejects.toThrow(/requires the image/);
  });

  it("refuses without a key rather than calling unauthenticated", async () => {
    delete process.env.FAL_KEY;
    await expect(
      generate("image.segment", { prompt: "jersey", references: [bytesRef()] }, FAL),
    ).rejects.toThrow(/FAL_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("masksFrom keeps EVERY mask — the adapter reports, it does not choose", () => {
  const noFetch = (async () => { throw new Error("should not fetch"); }) as unknown as typeof fetch;

  it("returns all of them, in order", async () => {
    const two = await masksFrom(
      { masks: [{ content: MASK_B64 }, { url: `data:image/png;base64,${MASK_B64}` }] },
      noFetch,
      undefined,
    );
    expect(two).toHaveLength(2);
    expect(two[0].equals(two[1])).toBe(true);
  });

  it("skips an unreadable entry without losing the readable ones after it", async () => {
    // Keeping masks[0] used to make this unobservable: a junk first entry meant "no mask at all".
    const out = await masksFrom({ masks: [{ somethingElse: 1 }, { content: MASK_B64 }] }, noFetch, undefined);
    expect(out).toHaveLength(1);
  });
});
