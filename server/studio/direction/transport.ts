/**
 * studio/direction/transport — a direction tool's ONE model call, behind a type any test can stand in for.
 *
 * The reference engine's shape (studio/reference/transport.ts), and the same proven wire: Gemini through
 * `genai()`, `responseMimeType: application/json`, temperature 0, the thinking config that follows the
 * model (config.ts `directionThinking`), and nothing else. The one addition is the DOCUMENT: a PDF rides
 * as an `inlineData` part BEFORE the instruction — the model reads the pages themselves (layout, a table,
 * text set as an image), which an extractor's text alone would lose. The instruction says the attached
 * document is data.
 *
 *   model        per tool (summarizeBriefModel(), …) — recorded on every answer beside the prompt version
 *   timeout      directionTimeoutMs() — 45s
 *
 * It THROWS on a failure (a timeout or an API error), and each tool turns every throw into a refusal. It
 * never retries: one document, one call. Nothing here plans, generates, stitches or quotes.
 */
import { genai } from "../../lib/models";
import { withTimeout } from "../../lib/withTimeout";
import { directionThinking, directionTimeoutMs } from "../config";

export interface DirectionDocument {
  bytes: Buffer;
  /** `application/pdf` today; the part is typed by what she uploaded. */
  mimeType: string;
}

export interface DirectionTransportRequest {
  model: string;
  instruction: string;
  /** The document the tool reads, or null for a words-only tool. */
  document: DirectionDocument | null;
  /**
   * 0 unless a tool says otherwise. Reading a document is reading; PROPOSING campaigns is the concept
   * step's kind of call and takes its temperature (config.ts PROPOSE_TEMPERATURE = 0.6), deliberately —
   * transport.test pins both, so a temperature is never ambient.
   */
  temperature?: number;
}

/** Tokens in and out, as the provider reported them — out includes thinking. Null when it reported none. */
export interface DirectionTransportUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface DirectionTransportReply {
  text: string;
  usage: DirectionTransportUsage | null;
  /** The model that answered. */
  model: string;
}

export type DirectionTransport = (
  req: DirectionTransportRequest,
) => Promise<DirectionTransportReply>;

/** EXACTLY what a tool sends, built in one place so a probe inspects the very object the product sends. */
export function directionRequest(req: DirectionTransportRequest) {
  const parts: (
    | { inlineData: { mimeType: string; data: string } }
    | { text: string }
  )[] = [];
  if (req.document)
    parts.push({
      inlineData: {
        mimeType: req.document.mimeType,
        data: req.document.bytes.toString("base64"),
      },
    });
  parts.push({ text: req.instruction });
  const thinking = directionThinking(req.model);
  return {
    model: req.model,
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      temperature: req.temperature ?? 0,
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  };
}

/** The product's transport: one Gemini call, bounded by the timeout. */
export const geminiDirectionTransport: DirectionTransport = async (req) => {
  const request = directionRequest(req);
  const res = await withTimeout(
    genai().models.generateContent({
      ...request,
      config: {
        ...request.config,
        // Frees the client when the timeout fires. The call still bills server-side; `withTimeout` is
        // what keeps her from waiting.
        abortSignal: AbortSignal.timeout(directionTimeoutMs()),
      },
    }),
    directionTimeoutMs(),
    "studio direction tool",
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
