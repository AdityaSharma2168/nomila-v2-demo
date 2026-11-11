/**
 * frameText — does the FRAME a card shows carry burned-in text (a repost's caption, a meme overlay, a screenshot)?
 *
 * The library's tags describe the whole post, and the tagger often doesn't mention an overlay on the thumbnail a card
 * actually shows (a 19 Oct proof tile carried "I told him I graduated at 19" in white over her photo). So the proof
 * card asks once per frame: one small Gemini Flash call on the thumbnail (the same cheap tier the tagger uses, about a
 * tenth of a cent), cached on the media row (metadata.frame_text) so it is never asked again. A frame whose check fails
 * is treated as having text — the proof card shows fewer tiles rather than a doubtful one.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { mediaAssets } from "../../shared/schema";
import { genai, GEMINI } from "../lib/models";
import { readObject } from "../lib/mediaStore";
import { mimeFor } from "../lib/visionTag";
import { createLogger } from "../logger";

const logger = createLogger("frame-text");
const ai = genai();

/** Prompt Register §49. */
export const FRAME_TEXT_PROMPT = `Look at this single image. Is there text burned into the image itself — a caption, subtitle, meme text, a quote, a username, a screenshot of an app, a watermark? Ignore text that is part of the real scene: writing on clothing or kit, banners, scoreboards, signs, logos on products. Return STRICT JSON: {"burned_in_text": true|false}`;

/** The cached answer on a media row's metadata, if any. */
export function cachedFrameText(metadata: unknown, gcsPath: string): boolean | null {
  const f = (metadata as any)?.frame_text;
  return f && f.path === gcsPath && typeof f.burned_in_text === "boolean" ? f.burned_in_text : null;
}

/** Ask (or read the cache): true = the frame carries burned-in text. Never throws. */
export async function frameHasText(id: string, gcsPath: string): Promise<boolean> {
  const row = { id };
  try {
    const [m] = await db.select({ metadata: mediaAssets.metadata }).from(mediaAssets).where(eq(mediaAssets.id, id)).limit(1);
    const cached = cachedFrameText(m?.metadata, gcsPath);
    if (cached != null) return cached;
    const obj = await readObject(gcsPath, 8_000_000);
    if (!obj) return true;
    const res = await ai.models.generateContent({
      model: GEMINI.flash,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: obj.contentType || mimeFor(gcsPath), data: obj.buf.toString("base64") } }, { text: FRAME_TEXT_PROMPT }] }],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const v = JSON.parse((res.text ?? "").trim())?.burned_in_text;
    if (typeof v !== "boolean") return true;
    await db.update(mediaAssets)
      .set({ metadata: sql`coalesce(${mediaAssets.metadata}, '{}'::jsonb) || ${JSON.stringify({ frame_text: { path: gcsPath, burned_in_text: v, at: new Date().toISOString() } })}::jsonb` })
      .where(eq(mediaAssets.id, row.id));
    return v;
  } catch (e: any) {
    logger.warn({ id: row.id, error: e?.message?.slice(0, 120) }, "frame text check failed — treated as text");
    return true;
  }
}
