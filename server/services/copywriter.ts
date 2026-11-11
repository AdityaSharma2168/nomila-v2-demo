/**
 * copywriter — the narrator's craft (narrator.ts CRAFT) on the copy an athlete publishes herself: a prepared post's hook
 * and caption, and a calendar moment's angle and hook. COPYWRITER_V1 only (narrator.ts copywriterEnabled).
 *
 * Same shape as the kit copy: Fable 5.1 writes 3 options per item from the same fenced athlete context
 * (buildContextBlock), a deterministic gate drops options that use never-content (policy.findNeverContent) or wording
 * she asked never to be used, and the Gemini editor RANKS what is left (never rewrites). The first-written copy is kept
 * as the original; nothing here ever blocks a kit or a scan — any failure returns null and the original stands.
 */
import { createLogger } from "../logger";
import { findNeverContent } from "../agent/policy";
import { getAthleteContext } from "./athleteContext";
import { loadCopyBrief } from "./copyContext";
import { CRAFT, buildContextBlock, editorJson, fableJson, usesAvoided, type NarratorContext } from "./narrator";

const logger = createLogger("copywriter");
const OPTIONS = 3;
const MAX = { hook: 160, caption: 2200, angle: 300 } as const;

export const CAPTION_SYSTEM = `You are a senior brand copywriter. You are rewriting prepared social post copy that the athlete will publish on their own account, and the angle and hook for calendar moments they may post about.

${CRAFT}

Return STRICT JSON only.`;

export interface PostCopyIn {
  format: string; platform: string; timing?: string | null;
  event?: { label: string; date: string } | null;
  hook: string; show: string; captionAngle: string; avoid: string;
  caption: string;
}
export interface MomentCopyIn { name: string; date: string; category: string; whyNow: string; angle: string; hook: string }
export interface PostCopy { hook: string; caption: string }
export interface MomentCopy { angle: string; hook: string }
export interface Polished<T> { picked: T; options: T[] }

/**
 * A prepared caption without production notes: the "Caption:" / "Caption draft:" text when there is one, else any quoted
 * on-image text ("Overlay:", "Text:" …), else the text as it is.
 */
export function captionOnly(text: string | null | undefined): string {
  const raw = String(text ?? "").trim();
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const quotes = (l: string) => [...l.matchAll(/[“"]([^”"]+)[”"]/g)].map((m) => m[1].trim());
  const draft = lines.filter((l) => /^caption( draft)?\s*:/i.test(l)).flatMap((l) => { const q = quotes(l); return q.length ? q : [l.replace(/^caption( draft)?\s*:\s*/i, "")]; });
  if (draft.length) return draft.join(" ");
  const onImage = lines.filter((l) => /^(overlay( draft)?|opening text|question sticker|on-screen text|text)\s*:/i.test(l)).flatMap(quotes);
  return onImage.length ? onImage.join(" ") : raw;
}

const f = (v: unknown, max = 240) => String(v ?? "").replace(/[\r\n<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The writer's request: the athlete context, then the posts to rewrite, then the moments. */
export function buildCopyPrompt(ctx: NarratorContext, posts: PostCopyIn[], moments: MomentCopyIn[]): string {
  const p = posts.map((x, i) => `- post ${i} (${f(x.format, 40)} on ${f(x.platform, 40)}${x.timing ? `, ${f(x.timing, 60)}` : ""})
    event: ${x.event ? `${f(x.event.label, 120)} on ${x.event.date}` : "none"}
    post idea: hook "${f(x.hook, 160)}"; show: ${f(x.show)}; caption angle: ${f(x.captionAngle)}; avoid: ${f(x.avoid) || "nothing listed"}
    current caption (rewrite it): ${f(captionOnly(x.caption), 900)}`).join("\n");
  const m = moments.map((x, i) => `- moment ${i}: "${f(x.name, 160)}" on ${x.date} (${f(x.category, 40)})
    why now: ${f(x.whyNow, 300)}
    current angle: ${f(x.angle, 300)}
    current hook: ${f(x.hook, 200)}`).join("\n");
  const shape = [
    posts.length ? `"posts": [ { "post": 0, "options": [ { "hook": ..., "caption": ... } x${OPTIONS} ] }, ... ]` : "",
    moments.length ? `"moments": [ { "moment": 0, "options": [ { "angle": ..., "hook": ... } x${OPTIONS} ] }, ... ]` : "",
  ].filter(Boolean).join(", ");
  return `${buildContextBlock(ctx)}
${posts.length ? `Rewrite each post's hook and caption (${OPTIONS} options each), keeping the post idea, format, what it shows, and everything in "avoid". Write only the hook and the caption text that will be posted.
${p}
` : ""}${moments.length ? `${posts.length ? "\nThen rewrite" : "Rewrite"} the angle and hook (${OPTIONS} options each) for each calendar moment:
${m}
` : ""}
Return: { ${shape} }`;
}

/** The editor's instruction for post copy and moment hooks — ranks only. */
export function buildCopyEditorPrompt(name: string, listing: string): string {
  return `You are the EDITOR of ${f(name, 80)}'s social posts. For each item below, choose the INDEX of the single BEST option — the most specific, scroll-stopping copy the athlete would be proud to post, in the athlete's own voice. Penalize generic lines that could be any athlete's, a borrowed register (luxury, glossy, hype) that is not the athlete's own, and anything that claims more than the post idea or the moment supports. You RANK only — do not rewrite.
Return STRICT JSON mapping every item to its chosen index: { "post 0": 1, "moment 0": 0, ... }

${listing}`;
}

/** The athlete as the kit copy sees her (the one athlete context: name, sport, team, pronouns, M.I.A. strengths, her
 *  confirmed voice) plus her current Brief. */
export async function loadCopyCtx(athleteId: string): Promise<NarratorContext> {
  const a = await getAthleteContext(athleteId);
  const voice = (a.asserted ?? []).find((x) => x.field === "brand_voice")?.raw as NarratorContext["voice"] | undefined;
  return {
    name: a.name, sport: a.sport ?? "", school: a.school ?? "", miaStrengths: a.mia?.strengths ?? [], gender: a.gender ?? undefined,
    storyArc: a.storyArc ?? "", signalHighlights: a.signalHighlights ?? [], brandFitTags: [], commercial: a.commercialState,
    ...(voice ? { voice } : {}),
    brief: await loadCopyBrief(athleteId).catch(() => null),
  };
}

type Item = { key: string; options: Array<Record<string, string>> };

/**
 * Write, gate and rank. Returns one entry per input (null where nothing clean came back), or null when the writer could
 * not run at all.
 */
export async function polishCopy(
  ctx: NarratorContext, posts: PostCopyIn[], moments: MomentCopyIn[], opts: { neverTerms?: readonly string[] } = {},
  deps: { write?: typeof fableJson; rank?: typeof editorJson } = {},
): Promise<{ posts: Array<Polished<PostCopy> | null>; moments: Array<Polished<MomentCopy> | null> } | null> {
  if (!posts.length && !moments.length) return { posts: [], moments: [] };
  const write = deps.write ?? fableJson;
  const rank = deps.rank ?? editorJson;
  const json = await write(CAPTION_SYSTEM, buildCopyPrompt(ctx, posts, moments));
  if (!json) return null;

  const clean = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");
  const ok = (texts: string[]) => texts.every(Boolean)
    && !findNeverContent(texts.join("\n"), opts.neverTerms ?? []).length && !usesAvoided(texts.join("\n"), ctx.voice?.avoid);
  const items: Item[] = [];
  posts.forEach((_, i) => {
    const got = (Array.isArray(json.posts) ? json.posts : []).find((x: any) => Number(x?.post) === i)?.options ?? [];
    const options = (Array.isArray(got) ? got : []).map((o: any) => ({ hook: clean(o?.hook, MAX.hook), caption: clean(o?.caption, MAX.caption) }))
      .filter((o: PostCopy) => ok([o.hook, o.caption]));
    items.push({ key: `post ${i}`, options });
  });
  moments.forEach((_, i) => {
    const got = (Array.isArray(json.moments) ? json.moments : []).find((x: any) => Number(x?.moment) === i)?.options ?? [];
    const options = (Array.isArray(got) ? got : []).map((o: any) => ({ angle: clean(o?.angle, MAX.angle), hook: clean(o?.hook, MAX.hook) }))
      .filter((o: MomentCopy) => ok([o.angle, o.hook]));
    items.push({ key: `moment ${i}`, options });
  });

  // The editor ranks only where there is a choice; a failed editor leaves the writer's first option as the pick.
  let picks: Record<string, number> = {};
  const choices = items.filter((it) => it.options.length > 1);
  if (choices.length) {
    const listing = choices.map((it) => `${it.key}:\n${it.options.map((o, j) => `  [${j}] ${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(" | ")}`).join("\n")}`).join("\n\n");
    picks = await rank(buildCopyEditorPrompt(ctx.name, listing)).catch((e: any) => {
      logger.warn({ error: String(e?.message ?? e).slice(0, 120) }, "copy editor failed — the writer's first option stands");
      return {};
    }) ?? {};
  }
  const pick = <T>(it: Item): Polished<T> | null => {
    if (!it.options.length) return null;
    const i = Math.max(0, Math.min(it.options.length - 1, Number(picks[it.key] ?? 0) || 0));
    return { picked: it.options[i] as unknown as T, options: it.options as unknown as T[] };
  };
  return {
    posts: items.filter((it) => it.key.startsWith("post ")).map((it) => pick<PostCopy>(it)),
    moments: items.filter((it) => it.key.startsWith("moment ")).map((it) => pick<MomentCopy>(it)),
  };
}

/** One post's hook and caption, polished; null on any failure (the kit keeps its own copy). */
export async function polishPostCopy(athleteId: string, post: PostCopyIn, opts: { neverTerms?: readonly string[] } = {}): Promise<Polished<PostCopy> | null> {
  try {
    return (await polishCopy(await loadCopyCtx(athleteId), [post], [], opts))?.posts[0] ?? null;
  } catch (e: any) {
    logger.warn({ athleteId, error: String(e?.message ?? e).slice(0, 160) }, "post copy not polished — the kit keeps its own copy");
    return null;
  }
}

/** A scan's moments' angles and hooks, polished in one call; null on any failure (the scan's own copy stands). */
export async function polishMomentCopy(athleteId: string, moments: MomentCopyIn[], opts: { neverTerms?: readonly string[] } = {}): Promise<Array<Polished<MomentCopy> | null> | null> {
  if (!moments.length) return [];
  try {
    return (await polishCopy(await loadCopyCtx(athleteId), [], moments, opts))?.moments ?? null;
  } catch (e: any) {
    logger.warn({ athleteId, error: String(e?.message ?? e).slice(0, 160) }, "moment copy not polished — the scan's own copy stands");
    return null;
  }
}
