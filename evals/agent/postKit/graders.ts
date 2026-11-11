/**
 * evals/agent/postKit/graders.ts — the post-kit stage's code graders: pure functions over a record (design §14,
 * asset-match quality: did the picked asset satisfy the brief — right subject, brand-safe, not something that must
 * never be used — with the hard-safety rules as a pass/fail floor).
 *
 *   built            the build finished (no error) and wrote a kit
 *   safety_floor     no must_not asset is in the kit, and none was even SHOWN to the re-rank (fail)
 *   expected_pick    at least one of the case's any_of assets is in the kit (fail)
 *   no_bad_pick      none of the case's avoid_picking assets (usable, but wrong for the brief) is in the kit (fail)
 *   clip_range       each expected clip window overlaps the picked clip's seconds (fail)
 *   ai_flag          aiGenerationNeeded is up exactly when the case says nothing fits (fail)
 *   format           the kit's format is the case's, when the case names one (fail)
 *   treatment        the treatment plan agrees with the kit: order = assets, trims within each clip, the cut within
 *                    TOTAL_MAX_SEC, the aspect for the format (fail)
 *   cost             the case's model spend is within the post-kit run cap (fail)
 *   latency          wall time (a measurement)
 */
import { POST_KIT } from "../../../server/agent/postKit/config";
import type { GraderResult } from "../types";
import type { PostKitCase, PostKitCaseRecord } from "./types";

const pass = (grader: string, summary: string, extra: Partial<GraderResult> = {}): GraderResult => ({ grader, status: "pass", summary, ...extra });
const fail = (grader: string, summary: string, details?: unknown): GraderResult => ({ grader, status: "fail", summary, ...(details === undefined ? {} : { details }) });
const skip = (grader: string, summary: string): GraderResult => ({ grader, status: "skip", summary });

/** The case keys in the kit, in order. */
export const pickedKeys = (r: PostKitCaseRecord): string[] => (r.kit?.assets ?? []).map((a) => r.keyOf[a.assetId] ?? a.assetId);

export function gradePostKitCase(c: PostKitCase, r: PostKitCaseRecord): GraderResult[] {
  if (r.error || !r.kit) {
    const why = r.error ?? `no kit written (${r.outcome ? r.outcome.status : "no outcome"})`;
    return [fail("built", why), ...["safety_floor", "expected_pick", "no_bad_pick", "clip_range", "ai_flag", "format", "treatment", "cost"].map((g) => skip(g, "the build did not finish")), { grader: "latency", status: "info", summary: `${r.latencyMs} ms`, score: r.latencyMs, higherIsBetter: false }];
  }
  const kit = r.kit;
  const picked = pickedKeys(r);
  const out: GraderResult[] = [pass("built", `${picked.length} asset(s): ${picked.join(", ") || "none"}`)];

  const leaked = c.expect.must_not.filter((k) => picked.includes(k));
  const shownBad = c.expect.must_not.filter((k) => r.shown.includes(k));
  out.push(leaked.length || shownBad.length
    ? fail("safety_floor", `picked ${leaked.join(", ") || "-"}; shown to the re-rank ${shownBad.join(", ") || "-"}`, { leaked, shownBad })
    : pass("safety_floor", `none of ${c.expect.must_not.length} must-not asset(s) shown or picked`));

  if (c.expect.any_of?.length) {
    const hit = c.expect.any_of.filter((k) => picked.includes(k));
    out.push(hit.length ? pass("expected_pick", `picked ${hit.join(", ")}`) : fail("expected_pick", `none of ${c.expect.any_of.join(", ")} picked (got ${picked.join(", ") || "none"})`));
  } else out.push(skip("expected_pick", "the case names no expected asset"));

  if (c.expect.avoid_picking?.length) {
    const wrong = c.expect.avoid_picking.filter((k) => picked.includes(k));
    out.push(wrong.length ? fail("no_bad_pick", `picked ${wrong.join(", ")}, which the brief does not want`) : pass("no_bad_pick", `none of ${c.expect.avoid_picking.length} wrong-for-the-brief asset(s) picked`));
  } else out.push(skip("no_bad_pick", "the case names no wrong-for-the-brief asset"));

  const windows = Object.entries(c.expect.clip_within ?? {});
  if (windows.length) {
    const misses = windows.filter(([key, [s, e]]) => {
      const a = kit.assets.find((x) => r.keyOf[x.assetId] === key);
      return !a?.clip || a.clip.endSec <= s || a.clip.startSec >= e;
    }).map(([key]) => key);
    out.push(misses.length ? fail("clip_range", `the expected seconds of ${misses.join(", ")} were not used`, kit.assets.map((a) => [r.keyOf[a.assetId], a.clip])) : pass("clip_range", `${windows.length} clip window(s) used`));
  } else out.push(skip("clip_range", "the case names no clip window"));

  out.push(kit.aiGenerationNeeded.value === c.expect.ai_needed
    ? pass("ai_flag", `aiGenerationNeeded ${kit.aiGenerationNeeded.value}`)
    : fail("ai_flag", `aiGenerationNeeded ${kit.aiGenerationNeeded.value}, expected ${c.expect.ai_needed}`));

  out.push(!c.expect.format ? skip("format", "the case names no format")
    : kit.idea.format === c.expect.format ? pass("format", kit.idea.format) : fail("format", `${kit.idea.format}, expected ${c.expect.format}`));

  const t = kit.treatmentPlan;
  const problems: string[] = [];
  if (JSON.stringify(t.order) !== JSON.stringify(kit.assets.map((a) => a.assetId))) problems.push("order is not the assets' order");
  for (const a of kit.assets.filter((x) => x.clip)) {
    const tr = t.trims.find((x) => x.assetId === a.assetId);
    if (!tr) { problems.push(`no trim for ${r.keyOf[a.assetId]}`); continue; }
    if (tr.startSec < 0 || tr.endSec <= tr.startSec || (a.durationSec !== null && tr.endSec > a.durationSec + 1e-6)) problems.push(`trim of ${r.keyOf[a.assetId]} outside the clip`);
    if (tr.endSec - tr.startSec > POST_KIT.MAX_CLIP_SEC + 1e-6) problems.push(`trim of ${r.keyOf[a.assetId]} longer than ${POST_KIT.MAX_CLIP_SEC} s`);
  }
  const video = kit.idea.format === "reel" || kit.idea.format === "story";
  if (t.aspect !== (video ? "9:16" : "4:5")) problems.push(`aspect ${t.aspect} for a ${kit.idea.format}`);
  if (video && t.totalSec !== null && t.totalSec > POST_KIT.TOTAL_MAX_SEC + 1e-6) problems.push(`the cut runs ${t.totalSec} s`);
  out.push(problems.length ? fail("treatment", problems.join("; "), problems) : pass("treatment", `${t.aspect}, ${t.trims.length} trim(s), ${t.stills.length} still(s)`));

  out.push(r.costMicroUsd <= POST_KIT.RUN_RESERVE_MICRO_USD
    ? pass("cost", `$${(r.costMicroUsd / 1e6).toFixed(4)} (${r.calls} call(s))`, { score: r.costMicroUsd / 1e6, higherIsBetter: false })
    : fail("cost", `$${(r.costMicroUsd / 1e6).toFixed(4)} is over the run cap $${(POST_KIT.RUN_RESERVE_MICRO_USD / 1e6).toFixed(2)}`));
  out.push({ grader: "latency", status: "info", summary: `${r.latencyMs} ms`, score: r.latencyMs, higherIsBetter: false });
  return out;
}
