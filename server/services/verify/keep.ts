/**
 * verify/keep.ts — a rendered file that failed check-before-deliver is KEPT for debugging, never deleted with the
 * workspace: its bytes are copied to athletes/<athlete>/studio/needs-a-look/<job>/<i>.<ext> in the media bucket.
 *
 * No media_assets row is written, so nothing in her library, the Made shelf or a post ever shows it; it is reached only
 * by the path the needs-a-look log line names. It lives under her own prefix, so account deletion purges it with the
 * rest of her storage (lib/athleteDataManifest ATHLETE_STORAGE). Best effort: a copy that fails is logged, and the
 * delivery point's failure path goes on regardless.
 */
import { stat } from "fs/promises";
import { uploadLocalFile } from "../../lib/mediaStore";
import { createLogger } from "../../logger";

const logger = createLogger("verify/keep");

/** A file over this is not copied (the check may have failed it for its size). */
const KEEP_MAX_BYTES = 200 * 1024 * 1024;

export const needsALookPrefix = (athleteId: string, jobId: string) => `athletes/${athleteId}/studio/needs-a-look/${jobId}/`;

export interface KeepFile { path: string; contentType: string; kind: "video" | "image" }

/** Copy each file; the stored paths, in order (a file that was not copied is left out). Never throws. */
export async function keepForReview(
  athleteId: string, jobId: string, files: readonly KeepFile[],
  upload: (local: string, gcs: string, contentType: string) => Promise<void> = uploadLocalFile,
): Promise<string[]> {
  const kept: string[] = [];
  for (const [i, f] of files.entries()) {
    const dest = `${needsALookPrefix(athleteId, jobId)}${i}.${f.kind === "video" ? "mp4" : "jpg"}`;
    try {
      const size = (await stat(f.path)).size;
      if (size <= 0 || size > KEEP_MAX_BYTES) continue;
      await upload(f.path, dest, f.contentType);
      kept.push(dest);
    } catch (err) {
      logger.warn({ jobId, index: i, error: String((err as Error)?.message ?? err).slice(0, 160) }, "a file that needs a look could not be kept");
    }
  }
  return kept;
}
