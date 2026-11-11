/**
 * COPYWRITER_V1 (dev only until the owner says): Fable 5.1 alone, 3 options per slot, the current Brief as context, and
 * the same craft on post copy and moment hooks (copywriter.ts). Off: the pooled Gemini + Kimi + Fable 5 kit copy, 2
 * options per model, the legacy context, and no copy pass on posts or moments — exactly as before. Read per call so the
 * flag stays live. Its own module so agent code can read it without loading the model clients.
 */
export function copywriterEnabled(): boolean {
  return process.env.COPYWRITER_V1?.trim().toLowerCase() === "true";
}
