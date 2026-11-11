/**
 * services/milaVoice/settings.ts — the athlete's "Mila's voice and language" setting (table mila_voice_settings, 0152).
 *
 *   readMilaVoiceSettings(athleteId)          the setting; the defaults when they never set one
 *   writeMilaVoiceSettings(athleteId, patch)  validate every given field against the catalogue, then save the whole set
 *   voiceDispatchFields(settings)             what the voice token route adds to the worker's dispatch metadata
 *   conversationLanguageOf(settings)          the fixed conversation language for the chat CONTEXT line, or null (auto)
 *
 * Contract (GET/PUT /api/v1/me/mila/voice-language):
 *   { voice: <catalogue id> | null, conversationLanguage: "auto" | "<BCP-47>", postLanguages: ["<BCP-47>", …] }
 * A PUT may send any subset; an unknown voice, an unsupported language or too many post languages is refused whole
 * (nothing saved) with a code saying which field. A stored value the catalogue no longer has reads as the default, so a
 * retired voice or language never reaches the worker or the prompt.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { milaVoiceSettings } from "../../../shared/schema";
import { AUTO_LANGUAGE, MAX_POST_LANGUAGES, languageByCode, voiceById, type SupportedLanguage } from "./catalogue";

export interface MilaVoiceSettings {
  voice: string | null;
  conversationLanguage: string;
  postLanguages: string[];
}

const defaults = (): MilaVoiceSettings => ({ voice: null, conversationLanguage: AUTO_LANGUAGE, postLanguages: [] });

/** A stored row as the API answers it: anything the catalogue no longer knows reads as its default. */
function clean(row: { voice: string | null; conversation_language: string; post_languages: string[] | null }): MilaVoiceSettings {
  return {
    voice: voiceById(row.voice)?.id ?? null,
    conversationLanguage: languageByCode(row.conversation_language)?.code ?? AUTO_LANGUAGE,
    postLanguages: [...new Set((row.post_languages ?? []).map((c) => languageByCode(c)?.code).filter((c): c is string => !!c))].slice(0, MAX_POST_LANGUAGES),
  };
}

export async function readMilaVoiceSettings(athleteId: string): Promise<MilaVoiceSettings> {
  const [r] = await db.select().from(milaVoiceSettings).where(eq(milaVoiceSettings.athlete_id, athleteId)).limit(1);
  return r ? clean(r) : defaults();
}

export type SettingsError = { field: "voice" | "conversationLanguage" | "postLanguages"; code: "unknown_voice" | "unsupported_language" | "too_many_languages" | "invalid" };

/** Validate a patch against the current setting. Absent field = keep; voice null = back to the default. */
export function applyPatch(cur: MilaVoiceSettings, patch: Record<string, unknown>): { ok: true; next: MilaVoiceSettings } | { ok: false; error: SettingsError } {
  const next = { ...cur, postLanguages: [...cur.postLanguages] };
  if ("voice" in patch) {
    if (patch.voice === null) next.voice = null;
    else {
      const v = voiceById(patch.voice);
      if (!v) return { ok: false, error: { field: "voice", code: "unknown_voice" } };
      next.voice = v.id;
    }
  }
  if ("conversationLanguage" in patch) {
    const raw = patch.conversationLanguage;
    if (typeof raw === "string" && raw.trim().toLowerCase() === AUTO_LANGUAGE) next.conversationLanguage = AUTO_LANGUAGE;
    else {
      const l = languageByCode(raw);
      if (!l) return { ok: false, error: { field: "conversationLanguage", code: "unsupported_language" } };
      next.conversationLanguage = l.code;
    }
  }
  if ("postLanguages" in patch) {
    const raw = patch.postLanguages;
    if (!Array.isArray(raw)) return { ok: false, error: { field: "postLanguages", code: "invalid" } };
    const codes: string[] = [];
    for (const c of raw) {
      const l = languageByCode(c);
      if (!l) return { ok: false, error: { field: "postLanguages", code: "unsupported_language" } };
      if (!codes.includes(l.code)) codes.push(l.code);
    }
    if (codes.length > MAX_POST_LANGUAGES) return { ok: false, error: { field: "postLanguages", code: "too_many_languages" } };
    next.postLanguages = codes;
  }
  return { ok: true, next };
}

export async function writeMilaVoiceSettings(athleteId: string, patch: Record<string, unknown>): Promise<{ ok: true; settings: MilaVoiceSettings } | { ok: false; error: SettingsError }> {
  const r = applyPatch(await readMilaVoiceSettings(athleteId), patch);
  if (!r.ok) return r;
  // Only the columns this patch named: two PUTs racing on different fields (voice from one screen, languages from
  // another) must not undo each other with the stale values each read. A new row takes the defaults for the rest.
  const row: Partial<typeof milaVoiceSettings.$inferInsert> = { updated_at: new Date() };
  if ("voice" in patch) row.voice = r.next.voice;
  if ("conversationLanguage" in patch) row.conversation_language = r.next.conversationLanguage;
  if ("postLanguages" in patch) row.post_languages = r.next.postLanguages;
  await db.insert(milaVoiceSettings).values({ athlete_id: athleteId, ...row }).onConflictDoUpdate({ target: milaVoiceSettings.athlete_id, set: row });
  return { ok: true, settings: await readMilaVoiceSettings(athleteId) };
}

/**
 * The dispatch metadata's voice and language fields (server/voice/webTokenRoute.ts → mila-voice src/jobMetadata.ts).
 * Only what the athlete set: no voice key for the default voice and no language key for "auto", so a session for an
 * athlete who never opened the setting is dispatched exactly as before. Provider names, resolved here, so the worker
 * never needs this catalogue.
 */
export function voiceDispatchFields(s: MilaVoiceSettings): { voice?: string; grokVoice?: string; conversationLanguage?: string } {
  const v = voiceById(s.voice);
  const lang = conversationLanguageOf(s);
  return {
    ...(v ? { voice: v.geminiVoice, grokVoice: v.grokVoice } : {}),
    ...(lang ? { conversationLanguage: lang.code } : {}),
  };
}

/** The language the athlete fixed for talking with Mila, or null when Mila follows them ("auto"). */
export function conversationLanguageOf(s: MilaVoiceSettings | null | undefined): SupportedLanguage | null {
  if (!s || s.conversationLanguage === AUTO_LANGUAGE) return null;
  return languageByCode(s.conversationLanguage);
}
