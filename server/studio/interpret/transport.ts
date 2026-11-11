/**
 * studio/interpret/transport — the interpreter's ONE model call, behind a type any test can stand in for
 * (the interpreter, I.3; plan v1 §2 "Model and config", §7 "Testing interpreter cells deterministically").
 *
 * A transport is `(prompt, image) → reply text + usage`. The product's is Gemini through `genai()` — the
 * same client detection and QA already use (studio/autoMask.ts, studio/qa/vision.ts), so there is no new
 * vendor, credential or dependency. Every test injects its own: recorded replies (fixtures/), or
 * hand-written adversarial ones. CI never calls a model.
 *
 *   model        interpreterModel() — pinned to gemini-3.5-flash, its own setting (config.ts)
 *   temperature  0 — a reading that moves between runs on the same words is not a reading
 *   output       responseMimeType application/json — detection's and QA's own pair, and nothing more
 *   thinking     { thinkingBudget: 0 } — the shape Mila sends this model on Vertex (config.ts)
 *   timeout      interpreterTimeoutMs() — 15s, and then she gets her ask
 *
 * ─── NO SCHEMA ON THE WIRE (interpret/2) ─────────────────────────────────────────────────────────────
 *
 * interpret/1 sent `responseJsonSchema` — the reply's shape with enums, maxItems and fifteen optional slot
 * fields — and a `thinkingLevel`. R1's first call came back 400 INVALID_ARGUMENT from Vertex, with a
 * thinking budget as well (2026-09-14). Diffed field by field against the calls that work daily on this
 * project — detection and QA send `{responseMimeType: "application/json", temperature: 0}` and nothing
 * else — interpret/1 differed in exactly those two fields, and the schema was the one present in both
 * failing runs. So the wire is now detection's own pair plus Mila's thinking shape.
 *
 * NOTHING IS LOST BY IT. The schema was never the guard: the strict read (reply.ts) and the checks
 * (core.ts) already refuse everything it would have — an unknown kind, an off-menu look, brand, item or
 * preposition, "brand" as a source, a malformed or wrapped reply — and each refusal is her ask. The
 * prompt still lists every closed vocabulary the checks read (prompt.ts).
 *
 * It THROWS on a failure — a timeout, an API error — and the caller (interpret.ts) turns every throw into
 * her ask. It never retries: one call per memo key (A8).
 */
import { genai } from "../../lib/models";
import { withTimeout } from "../../lib/withTimeout";
import {
  interpreterModel,
  interpreterThinking,
  interpreterTimeoutMs,
} from "../config";

export interface TransportRequest {
  prompt: string;
  /** The frame, upright and probe-sized (studio/autoMask.ts, `probeBytesFor`). */
  image: { bytes: Buffer; mimeType: string };
}

/** Tokens in and out, as the provider reported them — out includes thinking. Null when it reported none. */
export interface TransportUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TransportReply {
  text: string;
  usage: TransportUsage | null;
  /** The model that answered — recorded on the preview row beside the prompt version. */
  model: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportReply>;

/**
 * EXACTLY what the interpreter sends Vertex — the model, the contents and the generation config — built in
 * one place, so R1's preflight (server/scripts/studioInterpreterRecord.ts) diffs and bisects the very
 * object the product sends rather than a copy of it. The abort signal is added by the transport: it is a
 * client-side control, not a field on the wire.
 */
export function interpreterRequest(req: TransportRequest) {
  return {
    model: interpreterModel(),
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: req.image.mimeType,
              data: req.image.bytes.toString("base64"),
            },
          },
          { text: req.prompt },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0,
      thinkingConfig: interpreterThinking(),
    },
  };
}

/** The product's transport: one Gemini call, bounded by the timeout. See the module header. */
export const geminiTransport: Transport = async (req) => {
  const request = interpreterRequest(req);
  const res = await withTimeout(
    genai().models.generateContent({
      ...request,
      config: {
        ...request.config,
        // Frees the client when the timeout fires. The SDK says it cancels nothing server-side — the call
        // still bills — so `withTimeout` below stays the guarantee that she is not kept waiting.
        abortSignal: AbortSignal.timeout(interpreterTimeoutMs()),
      },
    }),
    interpreterTimeoutMs(),
    "studio interpreter",
  );
  const um = (res as { usageMetadata?: Record<string, number> }).usageMetadata;
  return {
    text: res.text ?? "",
    usage: um
      ? {
          inputTokens: um.promptTokenCount ?? 0,
          outputTokens:
            (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0),
        }
      : null,
    model: request.model,
  };
};
