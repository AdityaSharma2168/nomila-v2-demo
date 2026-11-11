/**
 * studio/agent/capabilityBlock — the block a planner reads: what this app can do with the athlete's own media, for
 * THIS post, generated from the library every time the planner runs (capability layer v3 §3, PR 1a).
 *
 * Never a hand-written list. One line per entry of studio/agent/capabilityEntries.ts that:
 *   - lists this surface,
 *   - is on here: its flag (and its flag for this surface) exactly "true", and its lane up (studio/capabilityRoutes),
 *   - and is relevant to this post: it fits the format, and no per-post fact it needs is known to be missing.
 *
 * Each line carries does, needs, settings, cost (free, or the registry's price now), likeness risk, use when (the
 * entry's whenItWorks), don't use when (its failureModes) and what was measured. Lines are grouped by job. Automatic
 * entries are STATED, never offered. Paid entries sit under "she decides". Entries on this surface that are off here,
 * and the capabilities the audit inventory marks as later (studio/mediaOperations.ts), are named ONCE at the end, so
 * no planner plans them and Mila never promises them. ⚠️ GUARD (capabilityBlock.test.ts): an entry that is off never
 * appears as an offered line.
 *
 * The block takes no position on the planner's output shape: the skill prompt that embeds it says what to write.
 * Engines are never named here (the routes table does that); gate codes the Board's planner knows are dropped on
 * every other surface.
 */
import { external } from "../../lib/externalContent";
import { studioGovernanceFlag } from "../studioFlag";
import type { PostFormat } from "../../../shared/postKit";
import { laneUp, routeFor, routeUp, type EntryRoute, type Lane } from "../capabilityRoutes";
import { laterCapabilities } from "../mediaOperations";
import {
  CAPABILITY_ENTRIES,
  ENTRY_GROUPS,
  type CapabilityEntry,
  type EntryGroup,
  type EntryParam,
  type EntryRefusal,
  type EntryRequirement,
  type Surface,
} from "./capabilityEntries";
import { costWords } from "./entryCost";

/** What the environment says is on. Tests pass their own; the default reads process.env. */
export interface CapabilityEnv {
  flagOn(name: string): boolean;
  laneUp(lane: Lane): boolean;
  /** Whether a route's engine runs here (a Remotion engine needs the motion renderer). Absent: the lane decides. */
  routeUp?(route: EntryRoute): boolean;
}

/**
 * The live environment. A capability flag is read strictly — exactly "true", never through the STUDIO_ALL_ON master:
 * a line the planner reads is a promise it acts on, so it turns on only in the PR that builds the capability.
 */
export const liveCapabilityEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): CapabilityEnv => ({
  flagOn: (name) => studioGovernanceFlag(env[name]),
  laneUp: (lane) => laneUp(lane, env),
  routeUp: (route) => routeUp(route, env),
});

export interface CapabilityBlockOptions {
  surface: Surface;
  /** The post's format, or null when it follows from the picks. */
  format: PostFormat | null;
  /** The post names a partner brand. */
  forBrand: boolean;
  /** The moment the post is timed for: its name, its date, and how many days from today it is (negative: passed). */
  moment: { name: string | null; date: string | null; daysAway: number | null } | null;
  /** What the candidates hold, when known: a fact that is not known never hides an entry. */
  candidates?: { photos: number; clips: number; maxFps: number | null } | null;
  /** A video post's length cap, in seconds. */
  maxSec?: number;
  env?: CapabilityEnv;
  /** Print the refusals section — only for a planner that gets a repair turn. */
  refusals?: boolean;
}

export const BLOCK_INTRO =
  'WHAT YOU CAN USE — the capability library for this post, generated from the app\'s own list. One line per thing this app can do with the athlete\'s own media: what it does, what it needs, its settings, what it costs, how likely it is to show someone who is not her ("likeness risk"), when to use it and when not to, and what was measured. Plan only with these lines; nothing else is possible here. A line\'s needs are real: use it only when the candidate or the post has what it needs. A $0 line that carries the moment beats anything fancier.';

const GROUP_HEADERS: Record<EntryGroup, string> = {
  shots: "SHOTS — each picture or clip in the post is one of these",
  photo_moves: "PHOTO MOVES — on a photo in a reel or story, choose one",
  clip_moves: "CLIP MOVES — on a clip, only when that clip has what the line needs",
  cards: "CARDS — at most one opener, and only when it makes the post clearly better",
  sound: "SOUND — one choice",
  looks: "LOOKS — one look for the whole post",
  finishing: "FINISHING",
  paid: "PAID",
};

export const AUTOMATIC_HEADER = "AUTOMATIC — the app does these on its own; do not ask for them";
export const PAID_HEADER = "PAID — SHE DECIDES (never in the preview; only ever a button she taps)";
export const OFF_HEADER = "NOT AVAILABLE HERE YET — do not plan, offer or promise";

/** Whether an entry exists on this surface in this environment: on the surface, its flags on, its lane up. */
export function entryAvailable(e: CapabilityEntry, surface: Surface, env: CapabilityEnv): boolean {
  if (!e.surfaces.includes(surface)) return false;
  if (e.flag && !env.flagOn(e.flag)) return false;
  const own = e.surfaceFlags[surface];
  if (own && !env.flagOn(own)) return false;
  const route = routeFor(e.id);
  if (route === null) return false;
  return env.routeUp ? env.routeUp(route) : env.laneUp(route.lane);
}

/** A per-post fact, or null when it is not known. */
function fact(req: EntryRequirement, o: CapabilityBlockOptions): boolean | null {
  const c = o.candidates ?? null;
  switch (req) {
    case "photo_candidate":
      return c ? c.photos > 0 : null;
    case "clip_candidate":
      return c ? c.clips > 0 : null;
    case "clip_fps_59":
      return c ? (c.clips > 0 && c.maxFps !== null ? c.maxFps >= 59 : c.clips > 0 ? null : false) : null;
    case "moment_ahead":
      return o.moment ? (o.moment.daysAway === null ? null : o.moment.daysAway > 0) : false;
  }
}

/** Whether an entry is worth showing for this post: it fits the format, and nothing it needs is known missing. */
function relevant(e: CapabilityEntry, o: CapabilityBlockOptions): boolean {
  if (o.format && e.formats && !e.formats.includes(o.format)) return false;
  return e.requires.every((r) => fact(r, o) !== false);
}

const isPaid = (e: CapabilityEntry) => e.group === "paid" || e.cost.kind === "registry";

/** The Board's planner knows the gate codes; every other planner reads plain words. */
function plain(text: string, surface: Surface): string {
  if (surface === "board") return text;
  return text
    .replace(/\s*\((?:[AS]\d[a-z]?|PR \d+[^)]*)\)/g, "")
    .replace(/\s+([.,;])/g, "$1")
    .trim();
}

function paramWords(name: string, p: EntryParam): string {
  switch (p.kind) {
    case "enum":
      return `${name} (one of ${p.values.join(", ")})`;
    case "text":
      return `${name} (text, ${p.max} characters or fewer)`;
    case "number":
      return `${name} (a number from ${p.min} to ${p.max})`;
    case "boolean":
      return `${name} (yes or no)`;
  }
}

/** One entry, one line, in the generated form. */
export function blockLine(e: CapabilityEntry, o: Pick<CapabilityBlockOptions, "surface" | "format">): string {
  const w = (t: string) => plain(t, o.surface);
  const params = Object.entries(e.params);
  return [
    `- ${e.id}`,
    `does: ${w(e.does)}`,
    `needs: ${w(e.needs)}`,
    ...(params.length ? [`settings: ${params.map(([n, p]) => paramWords(n, p)).join("; ")}`] : []),
    ...(o.format === null && e.formats ? [`formats: ${e.formats.join(", ")}`] : []),
    `cost: ${w(costWords(e))}`,
    `likeness risk: ${e.likenessRisk}`,
    `use when: ${w(e.whenItWorks)}`,
    ...(e.failureModes.length ? [`don't use when: ${e.failureModes.map(w).join(" ")}`] : []),
    `${e.reliability.measured ? "measured" : "NOT measured"}: ${w(e.reliability.summary)}`,
  ].join(" | ") + e.examples.map((x) => `\n  example: ${w(x)}`).join("");
}

function formatWords(o: CapabilityBlockOptions): string {
  const max = o.maxSec ?? 30;
  switch (o.format) {
    case "reel":
    case "story":
      return `${o.format}, 9:16, up to ${max} s, with sound`;
    case "carousel":
      return "carousel, 4:5, 2 or 3 pictures she swipes, no sound";
    case "feed":
      return "feed post, 4:5, one photo, no sound";
    case null:
      return "format not set yet: it follows from the picks (any clip makes a reel, two or more photos a carousel, one photo a feed post)";
  }
}

function momentWords(m: CapabilityBlockOptions["moment"]): string {
  if (!m || (!m.name && !m.date)) return "Moment: none.";
  // The name is outside text (a moments scan read it off the web): fenced as data, on one line, never quoted raw.
  const name = m.name ? external(m.name.replace(/\s+/g, " ").trim().slice(0, 120)) : "a dated moment";
  // Only a date that reads as one is printed; anything else is dropped rather than passed through.
  const date = m.date && /^\d{4}-\d{2}-\d{2}$/.test(m.date) ? m.date : null;
  if (!date) return `Moment: ${name}, no date.`;
  const d = m.daysAway;
  const when =
    d === null ? "" : d === 0 ? ", today" : d > 0 ? `, ${d} day${d === 1 ? "" : "s"} from today` : `, ${-d} day${d === -1 ? "" : "s"} ago`;
  return `Moment: ${name}, ${date}${when}.`;
}

/**
 * A refusal's words on this surface: its message, and its suggested entry only when that entry is available here —
 * a planner is never sent to a line it cannot use (refusal targets test).
 */
export function refusalWords(x: EntryRefusal, surface: Surface, env: CapabilityEnv): string {
  if (!x.orUse) return x.message;
  const target = CAPABILITY_ENTRIES.find((e) => e.id === x.orUse!.entry);
  if (!target || !entryAvailable(target, surface, env)) return x.message;
  return `${x.message.replace(/\.\s*$/, "")}, or use ${target.id} ${x.orUse.words}.`;
}

/** The header: the per-post facts every line's needs are read against. */
export function postHeader(o: CapabilityBlockOptions): string {
  const c = o.candidates;
  const cand = c
    ? ` Candidates: ${c.photos} photo${c.photos === 1 ? "" : "s"}, ${c.clips} clip${c.clips === 1 ? "" : "s"}${c.maxFps !== null && c.clips ? `, fastest clip ${c.maxFps} fps` : ""}.`
    : "";
  return `THIS POST: ${formatWords(o)}. ${momentWords(o.moment)} Names a partner: ${o.forBrand ? "yes" : "no"}.${cand}`;
}

/** The generated block (see the file header). */
export function renderCapabilityBlock(o: CapabilityBlockOptions): string {
  const env = o.env ?? liveCapabilityEnv();
  const onSurface = CAPABILITY_ENTRIES.filter((e) => e.surfaces.includes(o.surface));
  const available = onSurface.filter((e) => entryAvailable(e, o.surface, env));
  const off = onSurface.filter((e) => !entryAvailable(e, o.surface, env));
  const shown = available.filter((e) => relevant(e, o));
  // A paid entry is never stated as automatic, whatever its `auto` says (the schema refuses that pair too).
  const automatic = shown.filter((e) => e.auto && !isPaid(e));
  const paid = shown.filter((e) => isPaid(e));
  const offered = shown.filter((e) => !e.auto && !isPaid(e));

  const out: string[] = [BLOCK_INTRO, postHeader(o)];
  for (const g of ENTRY_GROUPS) {
    const lines = offered.filter((e) => e.group === g);
    if (!lines.length) continue;
    out.push(GROUP_HEADERS[g], ...lines.map((e) => blockLine(e, o)));
  }
  out.push(
    AUTOMATIC_HEADER,
    ...(automatic.length
      ? automatic.map((e) => `- ${e.id}: ${plain(e.does, o.surface)} Needs: ${plain(e.needs, o.surface)}`)
      : ["(none here)"]),
  );
  out.push(PAID_HEADER, ...(paid.length ? paid.map((e) => blockLine(e, o)) : ["(none offered here yet)"]));
  const offIds = off.map((e) => e.id);
  const later = laterCapabilities().filter((n) => !CAPABILITY_ENTRIES.some((e) => e.id === n && available.includes(e)));
  const notHere = [...offIds, ...later.filter((n) => !offIds.includes(n))];
  if (notHere.length) out.push(`${OFF_HEADER}: ${notHere.join(", ")}`);
  if (o.refusals) {
    const r = [...offered, ...paid].flatMap((e) =>
      e.refusals.map((x) => `  ${e.id} / ${x.code}: "${plain(refusalWords(x, o.surface, env), o.surface)}"`),
    );
    if (r.length)
      out.push(
        "IF A STEP IS REFUSED you get back its code and what to do instead:",
        ...r,
        "Fix the plan once using these; anything still refused is left out.",
      );
  }
  return out.join("\n");
}
