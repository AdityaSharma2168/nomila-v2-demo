/**
 * models.ts — single source of truth for Gemini model ids + the Vertex client.
 *
 * Why this exists: model ids and the Vertex `location` were previously hardcoded
 * across ~6 files. Two problems that caused:
 *   1. Current-gen Gemini (3.x) resolves ONLY in the `global` Vertex location — a
 *      naive model-id swap that leaves `location: "us-central1"` 404s. Verified
 *      against this project.
 *   2. Gemini 2.5 retires 2026-10-16, so the whole fleet has to move — and it will
 *      have to move again at the next retirement. One file makes that a one-line change.
 *
 * Every value is env-overridable so a bad model rollout is a config flip (Cloud Run
 * env), not a redeploy — and any single model can be rolled back independently.
 *
 * Kimi model ids are centralized here too (see KIMI below). What is NOT here is the
 * Kimi *client strategy* — whether the workhorse runs on Vertex MaaS (GCP credits) or
 * the Moonshot API — that routing stays in `lib/kimi.ts` and is a separate, deferred
 * decision. Claude models live with their callers (narrator).
 */
import { GoogleGenAI } from "@google/genai";
import { startObservation } from "@langfuse/tracing";
import { tracingEnabled } from "./tracing";

const PROJECT = process.env.GCP_PROJECT_ID ?? "gamechanger-pocket-agent";
// 3.x Gemini is served from the `global` location, not us-central1.
const LOCATION = process.env.VERTEX_LOCATION ?? "global";

let _genai: GoogleGenAI | null = null;
/**
 * Shared Vertex GoogleGenAI client — lazy singleton, `global` location, ADC auth.
 *
 * Traced when LANGFUSE_TRACING is on. Every Gemini caller in the codebase goes through this
 * function — ten files, including dealDetector's classify, which runs on every inbound
 * message — so wrapping here covers all of them without touching a single call site. Same
 * reasoning that put the concurrency gate at the primitive.
 *
 * Explicit spans rather than an off-the-shelf instrumentor, deliberately: there is no
 * first-party JS instrumentor for `@google/genai`, and the nearest third-party one
 * (`@traceloop/instrumentation-vertexai`) targets `@google-cloud/vertexai`, a different
 * package. Hand-rolling the span is also what lets the model id, prompt and completion land
 * in the shape Langfuse reads as a generation rather than an anonymous span.
 */
export function genai(): GoogleGenAI {
  if (!_genai) {
    _genai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });
  }
  return tracingEnabled() ? tracedGenai(_genai) : _genai;
}

/**
 * A Proxy over the client that wraps `models.generateContent` in a Langfuse generation.
 *
 * A Proxy rather than a rewritten client because the SDK surface is large and moves; this
 * intercepts the one method we call and forwards everything else untouched, so a future
 * caller reaching for `generateContentStream` or `embedContent` still works — just
 * untraced until someone adds it here.
 *
 * Cached per client so repeated `genai()` calls do not build a new Proxy each time.
 */
let _tracedGenai: GoogleGenAI | null = null;
function tracedGenai(client: GoogleGenAI): GoogleGenAI {
  if (_tracedGenai) return _tracedGenai;

  const tracedModels = new Proxy(client.models, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "generateContent" || typeof value !== "function") return value;

      return async (params: any) => {
        const generation = startObservation(
          "gemini.generateContent",
          {
            model: params?.model,
            input: params?.contents,
            modelParameters: {
              temperature:       params?.config?.temperature ?? null,
              responseMimeType:  params?.config?.responseMimeType ?? null,
              // The system prompt is the thing we most want to see when an output is wrong,
              // and it is the thing the prompt registry (step 1.4) will start versioning.
              systemInstruction: params?.config?.systemInstruction ?? null,
            },
          },
          { asType: "generation" },
        );
        try {
          const res = await value.call(target, params);
          generation.update({
            output: res?.text ?? null,
            usageDetails: {
              input:  res?.usageMetadata?.promptTokenCount ?? 0,
              output: res?.usageMetadata?.candidatesTokenCount ?? 0,
              total:  res?.usageMetadata?.totalTokenCount ?? 0,
            },
          }).end();
          return res;
        } catch (err: any) {
          // Record the failure and rethrow unchanged. A 429 here is exactly the event this
          // instrumentation exists to make visible — it is what silently turned real deals
          // into NOISE and put ±2–3% of error on the classifier eval.
          generation.update({ output: { error: err?.message?.slice(0, 500) }, level: "ERROR" }).end();
          throw err;
        }
      };
    },
  });

  _tracedGenai = new Proxy(client, {
    get(target, prop, receiver) {
      return prop === "models" ? tracedModels : Reflect.get(target, prop, receiver);
    },
  }) as GoogleGenAI;
  return _tracedGenai;
}

/**
 * Gemini model ids by role. Defaults are the current generation verified available
 * on this Vertex project (global): flash / flash-lite / pro-preview. Override any of
 * them via env without a deploy.
 */
export const GEMINI = {
  flash:     process.env.GEMINI_FLASH_MODEL      ?? "gemini-3.5-flash",
  flashLite: process.env.GEMINI_FLASH_LITE_MODEL ?? "gemini-3.5-flash-lite",
  pro:       process.env.GEMINI_PRO_MODEL        ?? "gemini-3.1-pro-preview",
} as const;

/**
 * Kimi model ids. `vertexModel` is the workhorse (classify/summarize/score/draft/chat),
 * `moonshotModel` is used by kimiSearch's web-search. Values are unchanged from before —
 * only their DEFINITION moved here so the whole fleet's models live in one file. Which
 * client each runs on (Vertex vs Moonshot) is decided in lib/kimi.ts, not here.
 */
export const KIMI = {
  vertexModel:   process.env.KIMI_VERTEX_MODEL ?? "moonshotai/kimi-k2-thinking-maas",
  moonshotModel: process.env.KIMI_MODEL        ?? "kimi-k2.6",
} as const;
