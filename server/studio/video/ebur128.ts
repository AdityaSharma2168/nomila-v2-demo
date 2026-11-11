/**
 * ebur128 — the one spelling of ffmpeg's loudness meter that Studio uses, so it works on EVERY ffmpeg it runs on.
 *
 * ⚠️ PROD RUNS FFMPEG 5.1 (Debian bookworm's apt package, Dockerfile), CI's Ubuntu runner 6.x. `framelog=quiet` only
 * arrived in ffmpeg 6.0 (libavfilter/f_ebur128.c: release/5.1's "level" constants are `info` and `verbose`; 6.0 adds
 * `quiet`). On 5.1 the filter refuses to initialise ("Unable to parse option value \"quiet\""), the whole pass fails,
 * and the callers fell back to null in silence: the bed went unlevelled and a clip's loudness came out empty.
 *
 * `framelog=verbose` is in both: the per-frame "t: … M: … S: … I: …" lines go to AV_LOG_VERBOSE, which ffmpeg's
 * default `-loglevel info` does not print, while the closing summary ("Summary: … Integrated loudness: … I: … LUFS")
 * is logged at AV_LOG_INFO on 5.1 and 6.x alike. So stderr carries exactly what `framelog=quiet` left on 6.x, and the
 * parsers read the same integrated figure, in the same LUFS.
 */

/** The filter, summary only. `peak` adds the true-peak summary ("True peak: … Peak: … dBFS"). */
export function ebur128Filter(opts: { peak?: boolean } = {}): string {
  return `ebur128=${opts.peak ? "peak=true:" : ""}framelog=verbose`;
}

/**
 * Filter options Studio must never send, because prod's ffmpeg 5.1 rejects them. ebur128.test.ts holds every filter
 * string the server builds against this list; add to it when a newer option is found to be missing on 5.1.
 */
export const FFMPEG_51_UNSUPPORTED: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /framelog=quiet/, why: "ebur128's framelog=quiet arrived in ffmpeg 6.0; use framelog=verbose (ebur128Filter)" },
];

/** The last `n` characters of a tool's stderr, for a warning log. */
export function stderrTail(stderr: unknown, n = 600): string {
  const s = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  return s.length > n ? s.slice(-n) : s;
}
