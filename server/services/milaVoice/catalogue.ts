/**
 * services/milaVoice/catalogue.ts — the voices the athlete can pick for Mila, and the languages Mila talks and posts in
 * (owner decisions 10 Nov 2026: Mila is gender-neutral, but the athlete picks the voice; talking follows the athlete
 * unless they fix a language; a separate "post in" list for captions, stored now and used later; English and Spanish
 * first).
 *
 * Server-side and code-owned on purpose: the setting stores a catalogue `id`, never a provider voice name, so a voice can
 * be renamed, re-mapped or retired here without touching a row. The voice worker (nomila-co/mila-voice) receives the
 * RESOLVED provider names in the dispatch metadata (server/voice/webTokenRoute.ts) and checks them against its own list
 * of the providers' voices, so a stale or unknown name falls back to its default rather than failing the call.
 *
 * ── Sources (read 10 Nov 2026) ───────────────────────────────────────────────────────────────────────────────────────
 * Gemini Live voices — the 30 prebuilt voices and their one-word character, "Voice is configured in the voice_name field
 *   for all models" (gemini-3.8-live and gemini-live-2.5-flash-native-audio):
 *   https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice#voices-supported
 *   That page gives no gender. The male/female label is Google's own, from the same voices' Chirp 3 HD table:
 *   https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
 * Grok voices — xAI's voice table (name + description), shared by Text to Speech and Speech to Speech ("all of them can
 *   speak every supported language"): https://docs.x.ai/developers/model-capabilities/audio/text-to-speech#voices
 *   xAI gives no gender, so `grokVoice` is the closest by CHARACTER (xAI's description against Google's), not by gender:
 *   hear both before approving a mapping (scripts/voice-samples.ts).
 *
 * `gender` is what Google says, shown in Me as a plain label next to our short description ("warm, calm"); it describes
 * the voice, not Mila. Nothing here names an athlete, sport, school or brand.
 */

export type VoiceGender = "male" | "female";

export interface CatalogueVoice {
  /** Stored in the setting and sent by the app. Stable; lower case. */
  id: string;
  /** The Gemini Live prebuilt voice name (speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName). */
  geminiVoice: string;
  /** Google's one-word character for the voice (Live API voices list). */
  googleCharacter: string;
  /** Google's gender label for the voice (Chirp 3 HD table). */
  gender: VoiceGender;
  /** Our short description, shown in Me. */
  description: string;
  /** The closest Grok voice by character (the Grok fallback model). */
  grokVoice: string;
  /** xAI's own description of that Grok voice. */
  grokCharacter: string;
}

export const VOICE_CATALOGUE: readonly CatalogueVoice[] = [
  { id: "puck",         geminiVoice: "Puck",         googleCharacter: "Upbeat",      gender: "male",   description: "upbeat, lively",      grokVoice: "iris",    grokCharacter: "Friendly, upbeat, and naturally charming" },
  { id: "sulafat",      geminiVoice: "Sulafat",      googleCharacter: "Warm",        gender: "female", description: "warm, calm",          grokVoice: "ara",     grokCharacter: "Warm and friendly" },
  { id: "achird",       geminiVoice: "Achird",       googleCharacter: "Friendly",    gender: "male",   description: "friendly, easy-going", grokVoice: "ursa",    grokCharacter: "Friendly, warm, and steadfast" },
  { id: "vindemiatrix", geminiVoice: "Vindemiatrix", googleCharacter: "Gentle",      gender: "female", description: "gentle, soft-spoken", grokVoice: "luna",    grokCharacter: "Gentle, patient, and deeply nurturing" },
  { id: "charon",       geminiVoice: "Charon",       googleCharacter: "Informative", gender: "male",   description: "clear, steady",       grokVoice: "rex",     grokCharacter: "Confident and clear" },
  { id: "kore",         geminiVoice: "Kore",         googleCharacter: "Firm",        gender: "female", description: "confident, direct",   grokVoice: "celeste", grokCharacter: "Compassionate, confident, and reassuring" },
] as const;

/**
 * The voice Mila uses when the athlete has not picked one: Puck, what every call has used so far. A null setting sends
 * no voice at all, so the worker keeps its own defaults (Puck on Gemini, carina on Grok) and nothing changes for an
 * athlete who never opens the setting.
 */
export const DEFAULT_VOICE_ID = "puck";

export function voiceById(id: unknown): CatalogueVoice | null {
  return typeof id === "string" ? VOICE_CATALOGUE.find((v) => v.id === id.trim().toLowerCase()) ?? null : null;
}

// ─── Languages ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SupportedLanguage {
  /** BCP-47 primary language tag, as stored. */
  code: string;
  /** The language's name in English, and in itself (for the picker). */
  name: string;
  nativeName: string;
}

/** The languages Mila talks and posts in. Add a row here to support one more (the worker resolves names itself). */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "es", name: "Spanish", nativeName: "Español" },
] as const;

/** "auto": talk in whatever language the athlete uses. */
export const AUTO_LANGUAGE = "auto";

/** Bilingual captions at most (decision b): two "post in" languages. */
export const MAX_POST_LANGUAGES = 2;

export function languageByCode(code: unknown): SupportedLanguage | null {
  return typeof code === "string" ? SUPPORTED_LANGUAGES.find((l) => l.code === code.trim().toLowerCase()) ?? null : null;
}
