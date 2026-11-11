/**
 * studio/qa/vision — one structured vision ask, and the rules every QA check makes it under.
 *
 * Q.2, Q.3 and Q.4 are all "look at these images and answer in JSON". This is that call, once, so
 * the timeout, the probe scaling, the JSON discipline and the untrusted-output handling are decided
 * in one place rather than three times with three sets of bugs.
 *
 * ─── ⚠️  THE OUTPUT OF THIS FUNCTION IS DATA. IT IS NEVER AN INSTRUCTION. ───────────────────────
 *
 * A QA verdict is derived from pictures, and one of those pictures is a model's own output. A model
 * that can be steered into writing text into an image can, in principle, write text into an image
 * that reads as an instruction to the model inspecting it. `server/CLAUDE.md`'s rule — "a tool
 * result must never be able to instruct the model to take an action" — applies with the arrow
 * pointing the other way here, and it is the reason every prompt in this module:
 *
 *   * asks for a CLOSED schema with named fields, never free-form advice or a recommendation;
 *   * says explicitly that text visible inside the images is CONTENT TO BE REPORTED, never a
 *     direction to follow;
 *   * is parsed into a typed shape where unknown fields are dropped, so a field the model invented
 *     cannot reach a caller.
 *
 * Nothing here can take an action in any case — the whole stage is observation-only — but the
 * discipline belongs at the boundary rather than in an argument about what is currently reachable.
 *
 * ─── WHY EVERY ASK IS ITS OWN CALL ─────────────────────────────────────────────────────────────
 *
 * The four checks could ride in one prompt with one JSON answer, and at flash prices the saving is
 * a fraction of a cent against a $0.1344 generation. It is not worth it. A single prompt doing four
 * jobs dilutes each of them, and — the part that actually decides it — ONE malformed response or
 * one refusal takes out all four checks at once, so the verdict record cannot say which check ran
 * and which did not. Separate calls fail independently, and a check that fails is recorded as
 * `null` rather than as a pass.
 */
import sharp from "sharp";

import { genai, GEMINI } from "../../lib/models";
import { withTimeout } from "../../lib/withTimeout";
import { createLogger } from "../../logger";

const logger = createLogger("studio/qa/vision");

/**
 * How far down the long edge an image is scaled before it is sent.
 *
 * `autoMask.PROBE_LONG_EDGE_PX` is 1024 and its docstring already warns that small-object detection
 * "falls off with resolution". QA's hardest subject is smaller than autoMask's: the Stanford tree on
 * afc78262's shorts is ~20x25px in a 1008px frame, and on a 4000x6000 source the same mark is ~8px
 * at a 1024 probe. So the default here is higher, and the mark check additionally re-asks on a
 * native-resolution crop rather than trusting one whole-frame look. See qa/marks.ts.
 */
export const QA_PROBE_LONG_EDGE_PX = Number(
  process.env.STUDIO_QA_PROBE_LONG_EDGE_PX ?? 1536,
);

/** One vision round trip. Slower than autoMask's 20s because two images ride in most of these. */
const QA_VISION_TIMEOUT_MS = Number(
  process.env.STUDIO_QA_VISION_TIMEOUT_MS ?? 45_000,
);

/** Gemini's normalized coordinate range for box_2d — 0-1000 on both axes, and Y IS FIRST. */
export const BOX_SCALE = 1000;

export interface VisionImage {
  bytes: Buffer;
  mimeType: string;
  /** How the prompt refers to it — "SOURCE", "OUTPUT". Position alone is too easy to transpose. */
  role: string;
}

export interface VisionAsk<T> {
  /** For logs and the cost record. */
  name: string;
  /** The asset the call is about, when there is one — for its log lines only. */
  assetId?: string;
  images: VisionImage[];
  prompt: string;
  /** Narrows the model's JSON to a typed shape. Returns null if the answer is unusable. */
  parse: (raw: unknown) => T | null;
  /** Flash unless a check earns otherwise. Nothing here has. */
  model?: string;
}

export interface VisionResult<T> {
  value: T | null;
  /** Null when the call or the parse failed — never silently a pass. */
  error: string | null;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/**
 * Materialize EXIF rotation, and report the dimensions THAT buffer actually has.
 *
 * ─── ⚠️  WHY THIS EXISTS AT ALL: sharp's .rotate() IS LAZY ─────────────────────────────────────
 *
 * `sharp(bytes).rotate()` does not rotate anything when you call it — it schedules the rotation for
 * the eventual output. So `.metadata()` on that pipeline still reports the STORED dimensions, and a
 * box computed against those numbers is then applied to a buffer with the rotated ones.
 *
 * Measured on this corpus, not theorised: four of the nine identity references are EXIF orientation
 * 8, stored 6000x4000 and displayed 4000x6000. The first version of `cropRect` measured 6000 wide
 * and extracted from a 4000-wide upright image, and sharp answered `extract_area: bad extract area`.
 * It failed loudly, which was luck — a box that merely lands ROTATED relative to the picture, as it
 * would on a squarer frame, extracts happily and returns the wrong part of the image, and nothing
 * downstream can tell. That is the identical failure `studio/imageSize.ts`'s ONE SPACE note,
 * `studio/orient.ts` and `orientPath.test.ts` all exist to prevent, and which the repo records
 * having already paid for once: "every 24MP upload measured landscape when it displays portrait,
 * and the guard that should have caught it agreed with the bug instead."
 *
 * So the rotation is FORCED THROUGH A BUFFER here, once, and every dimension in this module is read
 * from the result. Nothing in qa/ may call `.metadata()` on a lazily-rotated pipeline.
 */
export async function upright(
  bytes: Buffer,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const out = await sharp(bytes).rotate().toBuffer();
  const meta = await sharp(out).metadata();
  return { bytes: out, width: meta.width ?? 0, height: meta.height ?? 0 };
}

/**
 * Scale an image down for a probe, preserving aspect. Returns UPRIGHT bytes and upright dimensions,
 * so a box found in the result is a box in display space — which is the space `cropRect` extracts in.
 */
export async function probeScale(
  bytes: Buffer,
  longEdge = QA_PROBE_LONG_EDGE_PX,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const up = await upright(bytes);
  const scale = Math.min(1, longEdge / Math.max(up.width, up.height));
  if (scale >= 1) {
    const jpeg = await sharp(up.bytes).jpeg({ quality: 92 }).toBuffer();
    return { bytes: jpeg, width: up.width, height: up.height };
  }
  const w = Math.round(up.width * scale);
  const h = Math.round(up.height * scale);
  const out = await sharp(up.bytes)
    .resize(w, h, { fit: "inside" })
    .jpeg({ quality: 92 })
    .toBuffer();
  const m = await sharp(out).metadata();
  return { bytes: out, width: m.width ?? w, height: m.height ?? h };
}

/**
 * The delimiter every image-derived instruction is wrapped in before it reaches a prompt.
 *
 * Her sentence rides into Q.4's prompt so the check can ask whether it happened. That sentence is
 * user input, and on the inbound path it can be brand-authored — so it is fenced and labelled, per
 * the server convention for untrusted content, rather than concatenated into the instructions.
 */
export function asData(label: string, text: string, maxChars = 400): string {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, maxChars);
  return `<${label}>\n${clean}\n</${label}>`;
}

/** Pull the first JSON object or array out of a response that may be fenced or prose-wrapped. */
function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through to the fenced/embedded forms below */
  }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* keep going */
    }
  }
  const start = t.search(/[[{]/);
  if (start >= 0) {
    for (let end = t.length; end > start; end--) {
      const slice = t.slice(start, end);
      if (!/[\]}]$/.test(slice)) continue;
      try {
        return JSON.parse(slice);
      } catch {
        /* keep shrinking */
      }
    }
  }
  return null;
}

/**
 * Run one ask. NEVER THROWS — a QA failure must not become a generation failure, and this is the
 * same inversion `studio/segment.ts` argues for: the generation is already paid for by the time
 * anything here runs, so letting a sub-cent inspection call fail it gets the arithmetic backwards.
 * A failed check is recorded as an error and a null value, which the verdict reports as `unknown`.
 */
export async function askVision<T>(
  ask: VisionAsk<T>,
): Promise<VisionResult<T>> {
  const started = Date.now();
  try {
    const res = await withTimeout(
      genai().models.generateContent({
        model: ask.model ?? GEMINI.flash,
        contents: [
          {
            role: "user",
            parts: [
              ...ask.images.map((i) => ({
                inlineData: {
                  mimeType: i.mimeType,
                  data: i.bytes.toString("base64"),
                },
              })),
              { text: ask.prompt },
            ],
          },
        ],
        // Perception, not reasoning — the same argument autoMask makes for temperature 0. A QA
        // verdict that moves between runs on the same pair is not a measurement.
        config: { responseMimeType: "application/json", temperature: 0 },
      }),
      QA_VISION_TIMEOUT_MS,
      `qa vision ${ask.name}`,
    );

    const raw = extractJson(res.text ?? "");
    const value = raw === null ? null : ask.parse(raw);
    const um = (res as { usageMetadata?: Record<string, number> })
      .usageMetadata;
    const usage = um
      ? {
          inputTokens: um.promptTokenCount ?? 0,
          outputTokens:
            (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
        }
      : null;

    if (value === null)
      logger.warn(
        { ask: ask.name, assetId: ask.assetId, chars: (res.text ?? "").length },
        "qa vision answer did not parse",
      );

    return {
      value,
      error: value === null ? "unparseable answer" : null,
      latencyMs: Date.now() - started,
      usage,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { ask: ask.name, assetId: ask.assetId, error: message.slice(0, 160) },
      "qa vision call failed",
    );
    return {
      value: null,
      error: message.slice(0, 160),
      latencyMs: Date.now() - started,
      usage: null,
    };
  }
}

/**
 * `[ymin, xmin, ymax, xmax]` in 0-1000 → a fractional rect.
 *
 * ⚠️ Y IS FIRST. This is autoMask's documented trap, restated because getting it wrong here is just
 * as invisible: a transposed box lands rotated relative to the picture and every downstream crop is
 * of the wrong thing, with nothing to notice. `qa/vision.test.ts` exercises it on a NON-SQUARE box
 * on a NON-SQUARE frame, because a square fixture passes a transposed implementation silently.
 */
export function boxToRect(
  box: unknown,
): { left: number; top: number; width: number; height: number } | null {
  // Gemini wraps the quad in an extra array often enough to matter — a face ask on q1-d answered
  // `"box_2d": [[97, 431, 224, 576]]` while the same ask on the next image answered it flat. Both
  // are the same box; rejecting one of them loses a real detection to a formatting coin-flip.
  let b: unknown = box;
  while (Array.isArray(b) && b.length === 1 && Array.isArray(b[0])) b = b[0];

  if (!Array.isArray(b) || b.length !== 4) return null;
  const n = b.map((v) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(BOX_SCALE, Math.max(0, v))
      : NaN,
  );
  const [ymin, xmin, ymax, xmax] = n;
  if (n.some(Number.isNaN)) return null;
  if (xmax <= xmin || ymax <= ymin) return null;
  return {
    left: xmin / BOX_SCALE,
    top: ymin / BOX_SCALE,
    width: (xmax - xmin) / BOX_SCALE,
    height: (ymax - ymin) / BOX_SCALE,
  };
}

/**
 * Gemini's detection answers come back in one of two shapes and the choice is not stable:
 * a bare array `[{box_2d, label}, …]` — its documented convention, and what `studio/autoMask.ts`
 * parses — or the object wrapper a prompt asked for. Accept both, and accept `label` as a synonym
 * for whatever key the prompt named, because the model reliably prefers `label`.
 */
export function detectionList(
  raw: unknown,
  wrapperKey: string,
): Record<string, unknown>[] | null {
  const o = raw as Record<string, unknown> | null;
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(o?.[wrapperKey])
      ? (o![wrapperKey] as unknown[])
      : null;
  if (!arr) return null;
  return arr.filter(
    (x): x is Record<string, unknown> => typeof x === "object" && x !== null,
  );
}

/**
 * Crop a fractional rect out of an image, with margin. Measures and extracts in UPRIGHT space.
 *
 * The rect is clamped to the image and the extract is never allowed to be empty. A fractional box
 * from a model can be inverted, zero-width, or slightly outside [0,1] — none of which should throw
 * inside an observation-only stage, and all of which sharp turns into the same opaque
 * `bad extract area`.
 *
 * Margin is a fraction of the BOX's own size, not the frame's, so it scales with the subject: a
 * face box tight to the jaw throws away hairline and ears, and those carry identity.
 */
export async function cropRect(
  bytes: Buffer,
  rect: { left: number; top: number; width: number; height: number },
  marginFrac = 0,
): Promise<Buffer> {
  const up = await upright(bytes);
  const W = up.width;
  const H = up.height;
  if (W <= 0 || H <= 0) throw new Error("cropRect: image has no dimensions");

  const mx = rect.width * marginFrac;
  const my = rect.height * marginFrac;
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));

  const left = clamp(Math.round((rect.left - mx) * W), 0, W - 1);
  const top = clamp(Math.round((rect.top - my) * H), 0, H - 1);
  const right = clamp(
    Math.round((rect.left + rect.width + mx) * W),
    left + 1,
    W,
  );
  const bottom = clamp(
    Math.round((rect.top + rect.height + my) * H),
    top + 1,
    H,
  );

  return sharp(up.bytes)
    .extract({ left, top, width: right - left, height: bottom - top })
    .png()
    .toBuffer();
}
