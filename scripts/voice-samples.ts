/**
 * voice-samples.ts — one ~5-second sample per catalogue voice (server/services/milaVoice/catalogue.ts), the SAME line in
 * every voice, for the owner to approve before the Me voice picker ships its play buttons. NOT RUN YET (no spend
 * approved): without --confirm it only prints the plan and the estimated cost.
 *
 *   npx tsx scripts/voice-samples.ts                    the plan and estimate, no calls
 *   npx tsx scripts/voice-samples.ts --confirm          Gemini samples (Vertex AI, ADC; GOOGLE_CLOUD_PROJECT)
 *   npx tsx scripts/voice-samples.ts --confirm --grok   also the mapped Grok voice of each (XAI_API_KEY)
 *
 * Output: media/voice-samples/<id>.<lang>.gemini.wav (+ .grok.mp3), local files only; nothing is uploaded or written to
 * the database. Uploading the approved ones and filling `sampleUrl` is a later, separate change.
 *
 * Gemini: the Live voices are Google's 30 prebuilt voices, the same names Gemini's speech generation (TTS) serves, so a
 * TTS call with speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName gives the voice's sound without opening a Live
 * session. It is the voice, not a Live call: hear the chosen one on a real call before it is final. Model:
 * VOICE_SAMPLE_TTS_MODEL, default gemini-2.5-flash-tts (check it is served in the project's region before running).
 * Grok: POST https://api.x.ai/v1/tts { text, voice_id, language } (docs.x.ai › Voice › Text to Speech).
 *
 * Cost (estimate, list prices as read 10 Nov 2026 — re-check before running):
 *   Gemini 2.5 Flash TTS: $0.50 / 1M text-input tokens, $10 / 1M audio-output tokens; audio is 25 tokens a second, so a
 *   5-second sample is ~125 output tokens ≈ $0.0013. 6 voices × 2 languages = 12 samples ≈ $0.02.
 *   Grok TTS: billed per character; 12 samples × ~90 characters ≈ 1,100 characters — cents at most (xAI's per-character
 *   price was not on the docs page read; check console.x.ai pricing before running with --grok).
 * Nothing here names an athlete, sport, school or brand.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VOICE_CATALOGUE } from "../server/services/milaVoice/catalogue";

/** The one line every voice says (≈ 5 seconds spoken), per supported language. */
export const SAMPLE_LINES: Record<string, string> = {
  en: "Hi, I'm Mila. I read every offer with you, and I'll tell you straight what I'd do.",
  es: "Hola, soy Mila. Leo cada oferta contigo y te digo claro lo que yo haría.",
};

/** xAI TTS wants a regional variant for Spanish (bare "es" is not in its list); English is "en". */
const GROK_TTS_LANGUAGE: Record<string, string> = { en: "en", es: "es-MX" };

const OUT_DIR = join(process.cwd(), "media", "voice-samples");
const TTS_MODEL = process.env.VOICE_SAMPLE_TTS_MODEL?.trim() || "gemini-2.5-flash-tts";
const GEMINI_SAMPLE_USD = 0.0013;

/** 16-bit mono PCM at 24 kHz (Gemini TTS output) in a WAV container. */
function wav(pcm: Buffer, rate = 24_000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function geminiSample(voiceName: string, text: string): Promise<Buffer> {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ vertexai: true, project: process.env.GOOGLE_CLOUD_PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1" });
  const res = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [{ role: "user", parts: [{ text: `Say warmly and naturally: ${text}` }] }],
    config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
  });
  const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!data) throw new Error(`no audio for ${voiceName}`);
  return wav(Buffer.from(data, "base64"));
}

async function grokSample(voiceId: string, text: string, language: string): Promise<Buffer> {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY is not set");
  const res = await fetch("https://api.x.ai/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice_id: voiceId, language }),
  });
  if (!res.ok) throw new Error(`xAI TTS ${res.status} for ${voiceId}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const confirm = process.argv.includes("--confirm");
  const grok = process.argv.includes("--grok");
  const jobs = VOICE_CATALOGUE.flatMap((v) => Object.entries(SAMPLE_LINES).map(([lang, text]) => ({ v, lang, text })));
  console.log(`${jobs.length} Gemini samples (${TTS_MODEL})${grok ? ` + ${jobs.length} Grok samples` : ""}, ≈ $${(jobs.length * GEMINI_SAMPLE_USD).toFixed(3)} Gemini`);
  for (const j of jobs) console.log(`  ${j.v.id} (${j.v.geminiVoice} / grok ${j.v.grokVoice}) ${j.lang}: "${j.text}"`);
  if (!confirm) { console.log("Plan only. Re-run with --confirm to generate (spends)."); return; }
  mkdirSync(OUT_DIR, { recursive: true });
  for (const j of jobs) {
    writeFileSync(join(OUT_DIR, `${j.v.id}.${j.lang}.gemini.wav`), await geminiSample(j.v.geminiVoice, j.text));
    if (grok) writeFileSync(join(OUT_DIR, `${j.v.id}.${j.lang}.grok.mp3`), await grokSample(j.v.grokVoice, j.text, GROK_TTS_LANGUAGE[j.lang] ?? "auto"));
    console.log(`  wrote ${j.v.id}.${j.lang}`);
  }
}

if (require.main === module) main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
