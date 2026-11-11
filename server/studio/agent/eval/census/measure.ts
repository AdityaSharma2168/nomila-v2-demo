/**
 * studio/agent/eval/census/measure — where each row's value went (PR 16, R-3).
 *
 * A row's TOKENS are the nonces its value carries (ZQ###), plus any asset or plan id — read from the
 * fixture for the sources the fixture sets, and from the captured objects at the row's own point for
 * every derived source (a CastItem's `beat`, a Board row's `prompt`, …). Its REACH is every point
 * DOWNSTREAM of its origin whose text carries one of those tokens. A row whose reach touches a
 * consuming point (census/capture.ts `CONSUMING`) is CONSUMED by measurement; one whose tokens stop
 * short of every consuming point is not. Values with no token — a boolean, a number, a bare enum —
 * are measured by MEMBER words (census/fixture.ts) or not at all: those rows carry a cited check.
 */
import { CONSUMING, POINTS, type CaptureStore, type Point } from "./capture";
import { MEMBERS, TOKEN } from "./fixture";
import type { CensusRow, SourceName } from "./rows";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Where each source's values are READ from: the fixture (the census set them) or a captured point
 * (the pipeline made them), with the path prefix inside that point's objects.
 */
export const ORIGIN: Record<
  SourceName,
  { point: Point | "fixture" | "unit" | "none"; prefix?: string }
> = {
  campaignBrief: { point: "fixture" },
  readingDimension: { point: "fixture" },
  assetTags: { point: "fixture" },
  opParams: { point: "fixture" },
  studioPlans: { point: "plan_row" },
  briefProposal: { point: "proposal" },
  libraryEntry: { point: "library" },
  castItem: { point: "cast_items" },
  shotSpec: { point: "cast_items", prefix: "shot" },
  boardRow: { point: "board_rows" },
  clipRequest: { point: "clip_requests" },
  briefInput: { point: "brief_inputs" },
  briefJob: { point: "brief_jobs" },
  jobCampaign: { point: "brief_jobs", prefix: "campaign" },
  costLine: { point: "cost_lines" },
  // Measured elsewhere: the 48 members at unit level (census/capabilities.test.ts, R-7).
  capability: { point: "unit" },
  // The QA verdict is written only with STUDIO_CREATIVE_QA and a vision call; no flow drives it.
  qaVerdict: { point: "none" },
  // The brief's two halves (image-parity, R-12 (b)): the flows capture `brief.job` only, so these rows are
  // held by static and cite verdicts (census/verdicts.ts), never by a flow.
  athleteHalf: { point: "none" },
  brandHalf: { point: "none" },
};

/** The values at a row path (`a.b[].c`) inside one object — arrays flattened. */
export function valuesAt(obj: unknown, path: string): unknown[] {
  let cur: unknown[] = [obj];
  for (const raw of path.split(".")) {
    const arr = raw.endsWith("[]");
    const key = arr ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const c of cur) {
      if (!c || typeof c !== "object") continue;
      const v = (c as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (arr) {
        if (Array.isArray(v)) next.push(...v);
      } else next.push(v);
    }
    cur = next;
  }
  return cur;
}

/** How many times `needle` occurs in `hay`. */
const count = (hay: string, needle: string): number =>
  hay.split(needle).length - 1;

/** The tokens a value carries: its nonces and its ids. */
export function tokensOf(v: unknown): string[] {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return [
    ...new Set([
      ...(s.match(TOKEN) ?? []).map((t) => t.toUpperCase()),
      ...(s.match(UUID) ?? []).map((u) => u.toLowerCase()),
    ]),
  ];
}

export interface Measured {
  row: string;
  /** How it was measured: by its tokens, by member words, or not at all. */
  mode: "token" | "member" | "none";
  tokens: string[];
  /** Downstream points its tokens (or member words) reached, in pipeline order. */
  reach: Point[];
  consumed: boolean;
  /** The last point it was seen at — what a failure names. Null when it was never seen downstream. */
  lastSeen: Point | null;
  /** The furthest CONSUMING point it reached — what a verdict's `at` is held to. Null when none. */
  furthest: Point | null;
}

/** Everything a run can say about every row, from what it captured. */
export function measure(
  store: CaptureStore,
  rows: readonly CensusRow[],
  fixture: ReadonlyMap<string, string[]>,
  /** Ids that are everywhere by construction (her athlete id) and so say nothing about a field. */
  noise: readonly string[] = [],
): Map<string, Measured> {
  const quiet = new Set(noise.map((n) => n.toLowerCase()));
  const lower = new Map<Point, string>(
    POINTS.map((p) => [p, store.text(p).toLowerCase()]),
  );
  const out = new Map<string, Measured>();
  for (const r of rows) {
    const origin = ORIGIN[r.source];
    const member = MEMBERS.find((m) => m.row === r.id);
    let tokens: string[] = [];
    if (origin.point === "fixture") tokens = fixture.get(r.id) ?? [];
    else if (origin.point !== "unit" && origin.point !== "none") {
      const path = origin.prefix ? `${origin.prefix}.${r.path}` : r.path;
      // A DERIVED row is traced only by tokens EXCLUSIVE to it within its own captured object: a token the
      // same object also carries in another field (a confirm flag's `because` quoting the reading that
      // became the tone) says nothing about THIS field, and is dropped as ambiguous.
      tokens = store.objects(origin.point).flatMap((o) => {
        const here = valuesAt(o, path);
        const inField = JSON.stringify(here).toLowerCase();
        const inObject = JSON.stringify(o).toLowerCase();
        return here
          .flatMap(tokensOf)
          .filter(
            (t) =>
              count(inObject, t.toLowerCase()) ===
              count(inField, t.toLowerCase()),
          );
      });
    }
    tokens = [...new Set(tokens)].filter((t) => !quiet.has(t.toLowerCase()));
    const from =
      origin.point === "fixture" ||
      origin.point === "unit" ||
      origin.point === "none"
        ? -1
        : POINTS.indexOf(origin.point);
    const downstream = POINTS.filter((_, i) => i > from);
    const needles = tokens.length ? tokens : member ? [member.words] : [];
    const reach = needles.length
      ? downstream.filter((p) =>
          needles.some((n) => lower.get(p)!.includes(n.toLowerCase())),
        )
      : [];
    out.set(r.id, {
      row: r.id,
      mode: tokens.length ? "token" : member ? "member" : "none",
      tokens: needles,
      reach,
      consumed: reach.some((p) => CONSUMING.has(p)),
      lastSeen: reach.length ? reach[reach.length - 1] : null,
      furthest: [...reach].reverse().find((p) => CONSUMING.has(p)) ?? null,
    });
  }
  return out;
}
