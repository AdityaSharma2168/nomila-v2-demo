/**
 * gemini.ts — the one place Mila talks to the Gemini SDK.
 *
 * Client is constructed once at module scope (ADC auth, no API key — same
 * pattern as server/skills/researchBrand.ts). No loop logic lives here: one
 * function, one streaming call. The AbortSignal comes from the SSE stream so
 * a client disconnect cancels generation server-side.
 */

import { GoogleGenAI, type Content, type Tool } from "@google/genai";
import { MILA } from "./config";
import type { GeminiFunctionDeclaration } from "./registry";

const ai = new GoogleGenAI({
  vertexai: true,
  project: MILA.PROJECT,
  location: MILA.LOCATION,
});

export function streamMilaModel(
  contents: Content[],
  declarations: GeminiFunctionDeclaration[],
  signal: AbortSignal,
  systemInstruction: string,
) {
  return ai.models.generateContentStream({
    model: MILA.MODEL,
    contents,
    config: {
      systemInstruction,
      // Plain wire-shape functionDeclarations (the registry is deliberately SDK-free —
      // its "OBJECT"/"STRING" strings are the SDK `Type` enum's own runtime values,
      // nominally incompatible). The conversion to the SDK `Tool[]` type lives at this
      // boundary and nowhere else.
      tools: [{ functionDeclarations: declarations }] as unknown as Tool[],
      abortSignal: signal,
      // Cap the model's thinking budget. gemini-3.5-flash's default dynamic thinking
      // balloons on the FINAL answer (measured 1.8k–5.5k thinking tokens, most of a
      // turn's latency); a MODERATE cap trims that tail while leaving the sub-1000-
      // token tool-selection rounds untouched — so tool choice isn't starved (see
      // config.THINKING_BUDGET). -1 restores the uncapped default.
      thinkingConfig: { thinkingBudget: MILA.THINKING_BUDGET },
    },
  });
}

/**
 * One-shot rolling-summary generation — the Phase-2 memory summarizer: its own
 * one-shot call on the shared Vertex client, fired AFTER the answer has streamed, and it NEVER throws
 * (returns "" on any error) so a failed fold can't break a turn that already
 * completed. thinkingBudget 0 because this is a trivial "compress these turns"
 * call, not a reasoning task — thinking would only add latency/cost.
 *
 * Plain-text out (no responseMimeType): the summary is prose replayed as system-
 * prompt context, not a parsed structure. The caller wraps BOTH the turns handed
 * in AND the summary handed back in explicit data delimiters — the folded turns
 * include tool results derived from untrusted brand/email text, so the prompt
 * labels them as data, never instruction.
 */
export async function summarizeConversation(
  systemInstruction: string,
  input: string,
): Promise<string> {
  try {
    const res = await ai.models.generateContent({
      model: MILA.MODEL,
      contents: [{ role: "user", parts: [{ text: input }] }],
      config: {
        systemInstruction,
        temperature: 0.3,
        maxOutputTokens: 512,
        thinkingConfig: { thinkingBudget: 0 } as any,
      },
    });
    return res.text ?? "";
  } catch {
    return "";
  }
}
