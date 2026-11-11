/**
 * routes/milaVoiceSettings.ts — "Mila's voice and language" in Me (mounted under /api/v1/me, requireAuth).
 * services/milaVoice/settings.ts does the work; services/milaVoice/catalogue.ts is the list of choices.
 *
 *   GET /mila/voice-language   → { voice, conversationLanguage, postLanguages, options }
 *   PUT /mila/voice-language   { voice?: <id> | null, conversationLanguage?: "auto" | "<BCP-47>", postLanguages?: [...] }
 *                              → the same shape, saved; 400 { error, code, field } when a value is not in the catalogue
 *
 * `options` is what the Me screen lists: every catalogue voice (id, Google's male/female label, our short description,
 * sampleUrl: null until the samples are approved), the default voice id, the supported languages and the post-language
 * cap. Provider voice names are never sent to the app.
 *
 * Tenancy: the athlete is always req.athleteId; a body never picks an athlete.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { AUTO_LANGUAGE, DEFAULT_VOICE_ID, MAX_POST_LANGUAGES, SUPPORTED_LANGUAGES, VOICE_CATALOGUE } from "../services/milaVoice/catalogue";
import { readMilaVoiceSettings, writeMilaVoiceSettings, type MilaVoiceSettings } from "../services/milaVoice/settings";

const logger = createLogger("routes/milaVoiceSettings");
const router = Router();

export const MILA_VOICE_OPTIONS = {
  voices: VOICE_CATALOGUE.map((v) => ({ id: v.id, gender: v.gender, description: v.description, sampleUrl: null as string | null })),
  defaultVoice: DEFAULT_VOICE_ID,
  languages: SUPPORTED_LANGUAGES.map((l) => ({ code: l.code, name: l.name, nativeName: l.nativeName })),
  autoLanguage: AUTO_LANGUAGE,
  maxPostLanguages: MAX_POST_LANGUAGES,
};

const view = (s: MilaVoiceSettings) => ({ ...s, options: MILA_VOICE_OPTIONS });

const ERROR_TEXT = {
  unknown_voice: "That voice is not one of Mila's voices.",
  unsupported_language: "That language is not supported yet.",
  too_many_languages: `Pick at most ${MAX_POST_LANGUAGES} languages to post in.`,
  invalid: "postLanguages must be a list of language codes.",
} as const;

router.get("/mila/voice-language", requireAuth, async (req: Request, res: Response) => {
  try { res.json(view(await readMilaVoiceSettings(req.athleteId!))); } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "mila voice settings read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/mila/voice-language", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    const r = await writeMilaVoiceSettings(req.athleteId!, body);
    if (!r.ok) { res.status(400).json({ error: ERROR_TEXT[r.error.code], code: r.error.code, field: r.error.field }); return; }
    res.json(view(r.settings));
  } catch (err: any) {
    logger.error({ athleteId: req.athleteId, error: String(err?.message ?? err).slice(0, 200) }, "mila voice settings write failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
