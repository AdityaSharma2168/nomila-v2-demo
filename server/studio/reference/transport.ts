/**
 * studio/reference/transport — the reference engine's ONE model call, behind a type any test can stand in for.
 *
 * The same shape as the interpreter's (studio/interpret/transport.ts), and the same wire, because that wire is
 * proven on this project: Gemini through `genai()`, `responseMimeType: application/json`, temperature 0,
 * `{ thinkingBudget: 0 }`, and nothing else. The one difference is that the image is optional: a pasted brief is
 * text only.
 *
 *   model        referenceModel() — pinned to gemini-3.5-flash, its own setting (config.ts)
 *   timeout      referenceTimeoutMs() — 30s
 *
 * It THROWS on a failure (a timeout or an API error), and decompose.ts turns every throw into a refusal. It
 * never retries: one reference, one call.
 */
import { genai } from "../../lib/models";
import { withTimeout } from "../../lib/withTimeout";
import {
  referenceModel,
  referenceThinking,
  referenceTimeoutMs,
} from "../config";

export interface ReferenceTransportRequest {
  prompt: string;
  /** Her image, upright and probe-sized (studio/autoMask.ts `probeBytesFor`). Null for a pasted brief. */
  image: { bytes: Buffer; mimeType: string } | null;
}

/** Tokens in and out, as the provider reported them — out includes thinking. Null when it reported none. */
export interface ReferenceTransportUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ReferenceTransportReply {
  text: string;
  usage: ReferenceTransportUsage | null;
  /** The model that answered — recorded on the analysis row beside the prompt version. */
  model: string;
}

export type ReferenceTransport = (
  req: ReferenceTransportRequest,
) => Promise<ReferenceTransportReply>;

/** EXACTLY what the engine sends, built in one place so a probe inspects the very object the product sends. */
export function referenceRequest(req: ReferenceTransportRequest) {
  const parts: (
    | { inlineData: { mimeType: string; data: string } }
    | { text: string }
  )[] = [];
  if (req.image)
    parts.push({
      inlineData: {
        mimeType: req.image.mimeType,
        data: req.image.bytes.toString("base64"),
      },
    });
  parts.push({ text: req.prompt });
  return {
    model: referenceModel(),
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      temperature: 0,
      thinkingConfig: referenceThinking(),
    },
  };
}

/** The product's transport: one Gemini call, bounded by the timeout. */
export const geminiReferenceTransport: ReferenceTransport = async (req) => {
  const request = referenceRequest(req);
  const res = await withTimeout(
    genai().models.generateContent({
      ...request,
      config: {
        ...request.config,
        // Frees the client when the timeout fires. The call still bills server-side; `withTimeout` is what
        // keeps her from waiting.
        abortSignal: AbortSignal.timeout(referenceTimeoutMs()),
      },
    }),
    referenceTimeoutMs(),
    "studio reference decomposition",
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
