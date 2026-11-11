/**
 * studio/compile/fence — brand research and brief lines, fenced as data (PR 18; PR 16 K1/K2; ADI-24SEP R1).
 *
 * The pattern is Mila's `get_brand` (server/mila/tools/getBrand.ts:41-47), verbatim: `<external_content>` around
 * the text and nothing else. ADI-24SEP R1: the content is left UNSANITISED on purpose (the model reads the
 * brand's own voice, not a paraphrase), and FENCED so it reads as data, never as instruction. No trimming, no
 * dropped field, no paraphrase. The one change: a copy of the fence's own tag inside the text (`</external_content>`
 * and its variants) is replaced with "[removed delimiter]" (lib/externalContent), so text cannot end the fence early
 * and put instructions outside it. This closes what ledger §7 had stated rather than fixed.
 *
 * BEHIND STUDIO_STYLE_SPEC (brief R-12): off, `fenced` is the identity function and every prompt is byte-for-byte
 * today's. The invariant compile/styleFlag.test.ts holds (ADI-GO18 G6): with the flag ON and no style reference,
 * `unfence(prompt)` is the flag-off prompt exactly, so a fence can only ever ADD its two markers (for any text that
 * does not itself carry the delimiter; text that does has it neutralised, which is the point).
 */
import { styleSpecEnabled } from "../config";
import { EXTERNAL_CLOSE, EXTERNAL_OPEN, neutralizeDelimiter } from "../../lib/externalContent";

// Re-exported for templates.ts and the studio tests only; the guard (lib/externalContent.test.ts) fails any other
// non-test importer, so nobody else can put these markers around text that skipped neutralizeDelimiter.
export { EXTERNAL_CLOSE, EXTERNAL_OPEN };

/** One field, fenced when the flag is on; the field itself, byte for byte, when it is off. */
export function fenced(text: string): string {
  return styleSpecEnabled() ? `${EXTERNAL_OPEN}${neutralizeDelimiter(text)}${EXTERNAL_CLOSE}` : text;
}

/** The fences taken out, and nothing else. Exported for the invariant's test and for recommend's grounding. */
export function unfence(text: string): string {
  return text.split(EXTERNAL_OPEN).join("").split(EXTERNAL_CLOSE).join("");
}
