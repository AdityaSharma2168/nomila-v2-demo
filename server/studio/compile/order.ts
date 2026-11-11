/**
 * studio/compile/order — the order one call's clauses are compiled in.
 *
 * Applied where the intent is FROZEN (studio/nativeIntent.ts, `freezeEditIntent`), so the stored
 * `changes` are already in this order: the compile (assemble.ts) re-orders nothing, and a brief
 * frozen at the quote and replayed at the spend compiles in the order she was quoted.
 */
import type { NativeChange } from "../nativeEdit";

/** Where a scene-wide change sits in the compiled call: after every change to a thing. */
const SCENE_RANK: Partial<Record<NativeChange["op"], number>> = {
  CHANGE_BACKGROUND: 1,
  DISPLAY_TEXT: 2,
  GLOBAL_STYLE: 3,
  // PR 19: the ad's brand logo, last — after the headline it must not cover, and after a look, so a look never
  // re-grades the brand's own colours. Every sentence without one compiles exactly as it did.
  BRAND_MARK: 4,
};

/**
 * The changes in the order they are COMPILED: every change to a thing first, in step order, then the
 * background, then a headline, then a look — composition's decision 5, scoped by 5a.
 *
 * A headline after the background (PR T): its banner goes "across the top of the background", so it is
 * written onto the scene the background clause has just made. Before the look, so a look of hers grades
 * the banner with everything else. Every sentence with no headline compiles in exactly the order it did.
 *
 * ─── WHY THE BACKGROUND GOES LAST ───────────────────────────────────────────────────────────────
 *
 * Sweep #3 read "background usually wins" off Part B. The addendum re-attributed every Part B drop to
 * the classifier, so there is no model-tier evidence either way yet — but a background is the one
 * change that restates the whole scene, and put first it is the clause every later one has to
 * survive. Last, it cannot eat the others positionally. A look goes after it: it grades the frame
 * the background has just changed.
 *
 * ⚠️ THE CHANGES ONLY, NEVER `steps` (5a). `orderSteps` is the masked path's data-loss rule and the
 * spend-time re-check (`intentsAgree`) compares steps, so steps keep their run order and only the
 * compiled clauses move. A stable sort: every sentence with no scene-wide change beside another
 * change — every sentence before composition — compiles in exactly the order it did.
 */
export function sceneLast(changes: NativeChange[]): NativeChange[] {
  return [...changes].sort(
    (a, b) => (SCENE_RANK[a.op] ?? 0) - (SCENE_RANK[b.op] ?? 0),
  );
}
