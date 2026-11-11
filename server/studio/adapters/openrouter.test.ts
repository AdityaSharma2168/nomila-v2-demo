/**
 * openrouter.test.ts — the VIDEO wire body, with `fetch` stubbed so nothing here can reach
 * OpenRouter or spend a cent.
 *
 * ─── WHAT THIS PINS, AND WHY IT COULD NOT BE CAUGHT ANY OTHER WAY ──────────────────────────────
 *
 * Image-to-video on this provider was never wired: every reference went into `input_references`,
 * OpenRouter's STYLE/content field, rather than `frame_images`, its image-to-video field. Both are
 * valid keys, the request is accepted either way, and a clip comes back either way — it is simply a
 * clip of someone else, because a style hint does not pin a first frame. There is no error to
 * observe and no log line that differs. The wire body is the only place the difference exists,
 * which is why these assertions read it directly.
 *
 * The property, stated once: THE FIRST REFERENCE BY SLOT ORDER IS THE FIRST FRAME, on this provider
 * exactly as on Vertex (`vertex.ts` reads `refParts[0]` into `instances[0].image`). Everything else
 * below is that one sentence, checked from a different side.
 *
 * ⚠️ NOTHING HERE ENABLES VIDEO. These call the ROUTER directly, which is the same door the probes
 * use. (Since video V3 the product path queues a clip rather than refusing it, but it is still gated
 * by `studioEnabled`, and nothing in this file touches that.)
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generate } from "../router";
import type { ImageRef } from "../types";

const ORIGINAL_ENV = { ...process.env };
const OR = { provider: "openrouter" as const, model: "bytedance/seedance-2.0" };

let fetchMock: jest.Mock;
let logDir: string;

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
});

/** The bytes a stubbed clip download returns. Content, so a byte assertion is possible. */
const CLIP_BYTES = Buffer.from("fake-mp4-bytes");

/** A successful clip download — the THIRD call the video path now makes. */
const clipDownload = () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () =>
    CLIP_BYTES.buffer.slice(
      CLIP_BYTES.byteOffset,
      CLIP_BYTES.byteOffset + CLIP_BYTES.byteLength,
    ),
  headers: new Map(),
  json: async () => ({}),
  text: async () => "",
});

/**
 * Submit → one poll that is already complete → the authenticated download of the finished clip.
 *
 * ⚠️ THE THIRD CALL IS THE POINT. The adapter used to hand the url on undownloaded, and the url it
 * handed on is an AUTHENTICATED endpoint, so the caller's bare fetch got 401 and the billed clip was
 * lost. The download lives in the adapter because that is where the credential is known.
 */
function queueVideo(download: unknown = clipDownload()) {
  fetchMock.mockResolvedValueOnce(
    json({ id: "vid_1", status: "pending" }) as any,
  );
  fetchMock.mockResolvedValueOnce(
    json({
      status: "completed",
      unsigned_urls: ["https://openrouter.ai/api/v1/videos/vid_1/content"],
      usage: { cost: 1.23 },
    }) as any,
  );
  fetchMock.mockResolvedValueOnce(download as any);
}

const bodyOf = (call: number) =>
  JSON.parse((fetchMock.mock.calls[call][1] as any).body);

const bytesRef = (slot: ImageRef["slot"], tag: string): ImageRef => ({
  kind: "bytes",
  bytes: Buffer.from(tag),
  mimeType: "image/jpeg",
  slot,
});

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "studio-openrouter-"));
  process.env = {
    ...ORIGINAL_ENV,
    OPENROUTER_API_KEY: "test-key",
    // The poll loop sleeps before its first GET; 1ms keeps the suite honest and instant.
    STUDIO_VIDEO_POLL_MS: "1",
    STUDIO_COST_LOG: join(logDir, "log.jsonl"),
  };
  fetchMock = jest.fn();
  global.fetch = fetchMock as any;
});

afterEach(() => rmSync(logDir, { recursive: true, force: true }));
afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("video wire body — the identity anchor reaches the image-to-video field", () => {
  it("sends the only reference as frame_images/first_frame, NOT as input_references", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "she walks toward camera",
        durationSeconds: 6,
        width: 720,
        height: 1280,
        references: [bytesRef("frame", "her")],
      },
      OR,
    );

    const body = bodyOf(0);
    expect(body.frame_images).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,aGVy" },
        frame_type: "first_frame",
      },
    ]);
    // THE REGRESSION ITSELF. With the anchor in this field the request is reference-to-video and the
    // returned clip is of whoever the model felt like drawing.
    expect(body).not.toHaveProperty("input_references");
  });

  it("anchors on the SLOT order, not on the order the caller stacked the array", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "x",
        durationSeconds: 6,
        width: 720,
        height: 1280,
        // Deliberately backwards: a style board first, her frame last.
        references: [bytesRef("style", "board"), bytesRef("frame", "her")],
      },
      OR,
    );

    const body = bodyOf(0);
    // SLOT_ORDER puts `frame` ahead of `style` (studio/refOrder.ts), so her frame anchors the clip
    // even though it arrived second — the same rule vertex.ts applies to refParts[0].
    expect(body.frame_images[0].image_url.url).toBe(
      "data:image/jpeg;base64,aGVy",
    );
    expect(body.input_references).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,Ym9hcmQ=" },
      },
    ]);
  });

  it("keeps the extra references as style refs rather than dropping or re-framing them", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "x",
        durationSeconds: 6,
        width: 720,
        height: 1280,
        references: [
          bytesRef("frame", "a"),
          bytesRef("character", "b"),
          bytesRef("object", "c"),
        ],
      },
      OR,
    );

    const body = bodyOf(0);
    // Exactly ONE first frame. A second `frame_type: "first_frame"` entry is not a richer anchor,
    // it is an ambiguous one — and Vertex would have dropped refs 2 and 3 entirely, so this is the
    // side that can carry MORE, never differently.
    expect(body.frame_images).toHaveLength(1);
    expect(body.input_references).toHaveLength(2);
    expect(body.frame_images[0].frame_type).toBe("first_frame");
  });

  it("sends the last frame as a SECOND frame_images entry, first then last", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "she turns away and comes back",
        durationSeconds: 6,
        width: 720,
        height: 1280,
        references: [bytesRef("frame", "start")],
        lastFrame: bytesRef("frame", "end"),
      },
      OR,
    );

    // Both entries, in timeline order, each carrying its own frame_type. The ORDER is asserted
    // because the two entries are distinguished by a field, not by position — an implementation
    // that emitted them backwards would still satisfy a set comparison and would still be wrong to
    // read in a log.
    expect(bodyOf(0).frame_images).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,c3RhcnQ=" },
        frame_type: "first_frame",
      },
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,ZW5k" },
        frame_type: "last_frame",
      },
    ]);
  });

  it("does not take the last frame out of references — extra refs stay style refs", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "x",
        durationSeconds: 6,
        width: 720,
        height: 1280,
        references: [bytesRef("frame", "a"), bytesRef("character", "b")],
        lastFrame: bytesRef("frame", "z"),
      },
      OR,
    );

    const body = bodyOf(0);
    // THE CONFUSION THIS RULES OUT: "last" meaning the last element of `references`. Ref `b` is a
    // style reference and must stay one; the closing frame is the one the caller named.
    expect(body.frame_images.map((f: any) => f.frame_type)).toEqual([
      "first_frame",
      "last_frame",
    ]);
    expect(body.frame_images[1].image_url.url).toBe(
      "data:image/jpeg;base64,eg==",
    );
    expect(body.input_references).toHaveLength(1);
    expect(body.input_references[0].image_url.url).toBe(
      "data:image/jpeg;base64,Yg==",
    );
  });

  it("a last frame with no references is a lone last_frame, not a first_frame", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "arrive here",
        durationSeconds: 6,
        width: 720,
        height: 1280,
        lastFrame: bytesRef("frame", "end"),
      },
      OR,
    );

    // The API takes either member of `supported_frame_images` on its own. Promoting a lone last
    // frame to first_frame would silently generate the clip backwards.
    expect(bodyOf(0).frame_images).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,ZW5k" },
        frame_type: "last_frame",
      },
    ]);
  });

  it("sends neither field for a text-to-video call — no empty arrays on the wire", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "an empty stadium at dusk",
        durationSeconds: 6,
        width: 720,
        height: 1280,
      },
      OR,
    );

    const body = bodyOf(0);
    expect(body).not.toHaveProperty("frame_images");
    expect(body).not.toHaveProperty("input_references");
    expect(body.prompt).toBe("an empty stadium at dusk");
  });

  it("still carries duration and size, which are what the per-token quote is derived from", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "x",
        durationSeconds: 8,
        width: 720,
        height: 1280,
        aspectRatio: "9:16",
        references: [bytesRef("frame", "her")],
      },
      OR,
    );

    expect(bodyOf(0)).toMatchObject({
      duration: 8,
      size: "720x1280",
      aspect_ratio: "9:16",
    });
  });

  it("a url reference travels as its url, not re-encoded", async () => {
    queueVideo();
    await generate(
      "video.generate",
      {
        prompt: "x",
        durationSeconds: 6,
        width: 720,
        height: 1280,
        references: [
          {
            kind: "url",
            url: "https://signed.example/frame.jpg",
            slot: "frame",
          },
        ],
      },
      OR,
    );

    expect(bodyOf(0).frame_images[0].image_url.url).toBe(
      "https://signed.example/frame.jpg",
    );
  });
});

/**
 * ─── THE 401 THAT LOST SEVEN PAID CLIPS ────────────────────────────────────────────────────────
 *
 * OpenRouter returns finished videos in a field called `unsigned_urls`, which reads as "no
 * credential needed". It is not: those urls are `/api/v1/videos/{id}/content`, ordinary
 * authenticated API endpoints. The adapter used to hand one on undownloaded, and the caller
 * (`storeAsset` → `rehostFromUrl`) fetches a url with no headers — so every clip 401'd after being
 * generated and billed. V2 lost all seven of its Seedance clips exactly that way.
 *
 * The credential is known in ONE place, the adapter, so the download lives here. `lib/mediaStore.ts`
 * is shared code and is deliberately untouched.
 */
describe("the finished clip is downloaded here, because this is where the credential is", () => {
  it("sends the bearer when it downloads the finished clip", async () => {
    queueVideo();
    const res = await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      OR,
    );

    // Call 0 submit, call 1 poll, CALL 2 the download. Its absence is the bug.
    const [url, init] = fetchMock.mock.calls[2] as [string, any];
    expect(url).toBe("https://openrouter.ai/api/v1/videos/vid_1/content");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(res.assets[0].bytes).toEqual(CLIP_BYTES);
  });

  it("keeps the url alongside the bytes, so a lost clip is still recoverable from the cost log", async () => {
    queueVideo();
    const res = await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      OR,
    );

    // `storeAsset` prefers bytes, so `rehostFromUrl` is never reached and shared code stays
    // untouched — but the url is what `costLog` records as `outputRef`, and it is the only handle
    // anyone has on a clip that was billed and then failed to store. Dropping it would trade one
    // recovery path for another instead of adding one.
    expect(res.assets[0].url).toBe(
      "https://openrouter.ai/api/v1/videos/vid_1/content",
    );
    expect(res.assets[0].bytes).toBeDefined();
  });

  it("NEVER sends our bearer to a host that is not OpenRouter", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "vid_1", status: "pending" }));
    fetchMock.mockResolvedValueOnce(
      json({
        status: "completed",
        // A provider could hand back a signed CDN url on someone else's host. Our API key must not
        // follow it there.
        unsigned_urls: ["https://cdn.elsewhere.test/clip.mp4"],
        usage: { cost: 1.23 },
      }),
    );
    fetchMock.mockResolvedValueOnce(clipDownload() as any);

    await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      OR,
    );

    const [url, init] = fetchMock.mock.calls[2] as [string, any];
    expect(url).toBe("https://cdn.elsewhere.test/clip.mp4");
    expect(init?.headers?.Authorization).toBeUndefined();
  });

  it("a failed download does NOT throw away the record of having paid", async () => {
    // THE V2 LESSON, as a test. The clip is billed at completion, so a throw AFTER completion loses
    // the clip AND the cost line (`router.ts` logs spend only on success). The download therefore
    // degrades to url-only rather than throwing: the spend is recorded, the url is recorded, and
    // the job fails downstream with the money on the record.
    queueVideo({ ok: false, status: 401, text: async () => "unauthorized" });

    const res = await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      OR,
    );

    expect(res.assets[0].bytes).toBeUndefined();
    expect(res.assets[0].url).toBe(
      "https://openrouter.ai/api/v1/videos/vid_1/content",
    );
    expect(res.cost).toMatchObject({ amountUsd: 1.23, basis: "reported" });
  });
});

/**
 * ─── AUDIO OFF, AND WHY THE CALLER CANNOT TURN IT BACK ON ──────────────────────────────────────
 *
 * OpenRouter's video guide: `generate_audio` "defaults to true for models that support audio
 * output". kling-v3.0-std advertises audio and quotes 0.126/s for it against 0.084/s without, while
 * `config.ts` prices it flat 0.084 — so an UNSET flag bought the dearer arm and the quote
 * under-quoted by 50%, which is the one direction the pre-generation check exists to prevent.
 *
 * MEASURED 2026-09-19 (docs/probes/kling-moderation.md §5): four cells sent `generate_audio: false`
 * and all four invoiced $0.5040 = 6s x $0.084 — the audio-off arm exactly. The flag is honoured, so
 * sending it makes the existing flat price TRUE rather than optimistic. No price table is edited.
 */
describe("generate_audio is forced off, so the flat per-second price is the real one", () => {
  it("forces generate_audio off, so the flat $0.084 quote is the real price", async () => {
    queueVideo();
    await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      { ...OR, model: "kwaivgi/kling-v3.0-std" },
    );

    expect(bodyOf(0).generate_audio).toBe(false);
  });

  it("a caller cannot buy the expensive audio arm through providerParams", async () => {
    queueVideo();
    await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      {
        ...OR,
        model: "kwaivgi/kling-v3.0-std",
        providerParams: { generate_audio: true },
      },
    );

    // ⚠️ A DELIBERATE EXCEPTION to "providerParams ride through untouched, and win". Everywhere else
    // that rule is right; here it would let a caller flip the wire to the 0.126/s arm while pricing
    // still quoted 0.084/s, silently rebuilding the under-quote this exists to remove. Audio and its
    // price are ONE decision, so turning audio on must be a code change that also moves the price.
    expect(bodyOf(0).generate_audio).toBe(false);
  });
});

/**
 * ─── THE ONE CARVE-OUT: SEEDANCE MAY ASK, BECAUSE ITS AUDIO IS FREE ────────────────────────────
 *
 * Seedance is priced `per_video_token` (config.ts) and its published `video_tokens_without_audio`
 * equals `video_tokens`, so there is no audio arm to buy — `wantsAudio` in studio/pricing is reached
 * only inside `case "per_second"`, which Seedance never enters. Turning it on therefore cannot move
 * a Seedance quote, which is what makes it safe here and unsafe on Kling.
 *
 * ⚠️ THE GATE IS THE MODEL, NOT THE KEY. The third case is the one that matters: the SAME
 * `providerParams` that opens seedance leaves Kling forced off. A caller cannot talk its way onto
 * the 0.126/s arm, because there is no value it can send that the model check does not outrank.
 */
describe("seedance may ask for sound; the model decides, not the caller", () => {
  const withAudio = { providerParams: { parameters: { generateAudio: true } } };

  it("honours an explicit ask on seedance", async () => {
    queueVideo();
    await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      { ...OR, ...withAudio },
    );

    expect(bodyOf(0).generate_audio).toBe(true);
  });

  it("stays off on seedance when nothing asked — silence is still the default", async () => {
    queueVideo();
    await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      { ...OR },
    );

    expect(bodyOf(0).generate_audio).toBe(false);
  });

  // MUTATION: drop the `SEEDANCE_AUDIO_MODELS` check from `seedanceAudio`. This reds, and it is the
  // under-quote guard — the identical request, one model over.
  it("and the very same ask does NOT open Kling", async () => {
    queueVideo();
    await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      { ...OR, model: "kwaivgi/kling-v3.0-std", ...withAudio },
    );

    expect(bodyOf(0).generate_audio).toBe(false);
  });
});

/**
 * The download is an external call like any other on this adapter, so it carries the same
 * AbortSignal — bounded by `withTimeout`, and cancelled when the caller cancels.
 *
 * ⚠️ NOT a `Promise.race`. A race satisfies the timeout and leaves the loser running: the fetch goes
 * on streaming a clip nobody is waiting for and holds its buffer until the process exits. On Cloud
 * Run that memory is not free.
 */
describe("the clip download is cancellable, like every other call here", () => {
  it("passes an AbortSignal to the download, so a client disconnect stops it", async () => {
    queueVideo();
    await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      OR,
    );

    const [, init] = fetchMock.mock.calls[2] as [string, any];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it("the caller's cancel reaches the download's own signal, mid-flight", async () => {
    const ctrl = new AbortController();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ id: "vid_1", status: "pending" }));
    fetchMock.mockResolvedValueOnce(
      json({
        status: "completed",
        unsigned_urls: ["https://openrouter.ai/api/v1/videos/vid_1/content"],
        usage: { cost: 1.23 },
      }),
    );

    // ⚠️ THE ASSERTION IS ON THE SIGNAL THE DOWNLOAD WAS HANDED, not on the degraded result. An
    // earlier version of this test checked only that bytes came back undefined — which is ALSO what
    // happens with no signal at all, because `init.signal.addEventListener` then throws and the
    // catch degrades. It passed under its own mutation. This captures the signal and asserts the
    // caller's abort propagated INTO it, which is false the moment the signal stops being passed.
    let seen: AbortSignal | null = null;
    fetchMock.mockImplementationOnce(
      (_u: string, init: any) =>
        new Promise((_res, rej) => {
          seen = init.signal;
          init.signal.addEventListener("abort", () =>
            rej(new Error("aborted")),
          );
          ctrl.abort();
        }),
    );

    const res = await generate(
      "video.generate",
      { prompt: "x", durationSeconds: 6, width: 720, height: 1280 },
      { ...OR, signal: ctrl.signal },
    );

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(true);
    // Degraded, not thrown — the clip was billed at completion and the spend must stay on record.
    expect(res.assets[0].bytes).toBeUndefined();
    expect(res.assets[0].url).toBe(
      "https://openrouter.ai/api/v1/videos/vid_1/content",
    );
  });
});

describe("Seedance's refusal is a REFUSAL, not an error — and it is never retried", () => {
  /**
   * ⚠️ THE REAL STRING, FROM THE PROBE THAT MEASURED IT.
   *
   * BytePlus answered real-person image-to-video with this 6 times out of 6 — a stated policy, not
   * a blip (docs/probes/kling-moderation.md §1). It came through this door as `provider_error`,
   * which is the same code a 503 gets, so nothing downstream could tell "this route will never
   * make that" from "try again in a minute".
   */
  const SEEDANCE_REFUSAL =
    "InputImageSensitiveContentDetected.PrivacyInformation: the input image contains sensitive content";

  function queueFailedVideo(error: unknown) {
    fetchMock.mockResolvedValueOnce(
      json({ id: "vid_1", status: "pending" }) as any,
    );
    fetchMock.mockResolvedValueOnce(json({ status: "failed", error }) as any);
  }

  async function refusal() {
    try {
      await generate(
        "video.generate",
        {
          prompt: "she walks toward camera",
          durationSeconds: 6,
          width: 720,
          height: 1280,
        },
        OR,
      );
    } catch (err) {
      return err as { code: string; message: string };
    }
    throw new Error("expected the poll to throw, and it returned a clip");
  }

  it("reads the stated input-policy refusal as content_blocked", async () => {
    queueFailedVideo(SEEDANCE_REFUSAL);
    const err = await refusal();
    expect(err.code).toBe("content_blocked");
    // The provider's own words still travel, so an operator sees the cause and not just a code.
    expect(err.message).toContain("InputImageSensitiveContentDetected");
  });

  it("leaves an ordinary failure as provider_error, so nothing else changed", async () => {
    queueFailedVideo("upstream timed out");
    expect((await refusal()).code).toBe("provider_error");
  });

  it("survives a provider that sends an OBJECT where the string was expected", async () => {
    // The classifier is handed JSON rather than "[object Object]", so a nested code is still found.
    queueFailedVideo({
      code: "InputImageSensitiveContentDetected.PrivacyInformation",
    });
    expect((await refusal()).code).toBe("content_blocked");
  });

  it("does not throw on a failure with no error field at all", async () => {
    queueFailedVideo(undefined);
    expect((await refusal()).code).toBe("provider_error");
  });
});
