/**
 * studio/agent/plans — a plan is a stored, versioned object (PR 6, 6a3; migrations/0061_studio_plans.sql).
 *
 * The route writes one row per plan it answers; a regenerate writes a CHILD (version + 1,
 * parent_plan_id); rows are never edited. The Board seeds from a stored id, and re-opening one renders
 * the STORED object — no planner call, no search, no spend.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────
 *
 * Every query filters by the athlete the ROUTE resolved (`req.athleteId`), never by an id a client
 * sent alone: a plan id that is not hers reads as missing. The parent FK is composite, so even a bug
 * here cannot file a child under another athlete's plan. ⚠️ MUTATION:
 * drop the athlete filter in `readPlan` — "cross-athlete plan read" reds by name (studio.agent.test).
 *
 * ─── NO SIGNED URL IS STORED ────────────────────────────────────────────────────────────────────
 *
 * A cast item carries signed thumb and video urls that expire. They are stripped before the write and
 * re-signed on read from HER rows (`loadCastable`, athlete-scoped): a photo she has since deleted
 * comes back with no thumbnail rather than a url to bytes that are gone.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
  dealDeliverables,
  deals,
  studioPlans,
  type StudioPlan,
} from "../../../shared/schema";
import { beatPosterUrl } from "./beatPoster";
import { asPick, loadCastable, type CastItem } from "./cast";
import type { PlanLook, PlanMusic } from "./types";

/** What the route answered, as it is stored: every signed url nulled. */
export interface StoredPlanBody {
  items: CastItem[];
  castCount: number;
  picksWithoutHer: string[];
  gaps: string[];
  look: PlanLook | null;
  music: PlanMusic | null;
}

export interface SavePlanInput {
  plan: StoredPlanBody;
  brief?: unknown;
  briefFilePath?: string | null;
  concept?: unknown;
  dealDeliverableId?: string | null;
  /** A regenerate: the plan this one comes from. Must be hers. */
  parentPlanId?: string | null;
  /** What it was planned FROM (PR 13, 0066) — written once, here. Her words, as the route validated them. */
  prompt?: string | null;
  /** Her feel line, or null when she gave none. */
  aesthetic?: string | null;
  /** The purpose the plan was made for. */
  objective?: string | null;
  /** The confirm step's flags (studio/direction/envelope.ts InferenceFlag[]), or null without a brief. */
  confirm?: unknown;
  /** Provenance, not authorization (0072): the creative intent this plan interprets, or null. */
  creativeIntentId?: string | null;
}

type Client = Pick<typeof db, "select" | "insert">;

/** A cast item with its signed urls taken out — the stored form. */
const unsigned = (item: CastItem): CastItem =>
  item.assetId === null ? item : { ...item, thumbUrl: null, videoUrl: null };

/** Her plan by id, or null — never another athlete's. */
export async function readPlan(
  athleteId: string,
  id: string,
  client: Client = db,
): Promise<StudioPlan | null> {
  const [row] = await client
    .select()
    .from(studioPlans)
    .where(and(eq(studioPlans.id, id), eq(studioPlans.athlete_id, athleteId)))
    .limit(1);
  return row ?? null;
}

export class ParentPlanNotFound extends Error {
  constructor() {
    super("That plan is not one of hers");
  }
}

/**
 * Writes one row: version 1, or — with a parent — the parent's version + 1. A parent that is not
 * hers throws `ParentPlanNotFound` (the route checks it BEFORE the planner runs, so this is the second
 * line, and the FK the third).
 */
export async function savePlan(
  athleteId: string,
  input: SavePlanInput,
  client: Client = db,
): Promise<{ id: string; version: number }> {
  let version = 1;
  if (input.parentPlanId) {
    const parent = await readPlan(athleteId, input.parentPlanId, client);
    if (!parent) throw new ParentPlanNotFound();
    version = parent.version + 1;
  }
  const [row] = await client
    .insert(studioPlans)
    .values({
      athlete_id: athleteId,
      parent_plan_id: input.parentPlanId ?? null,
      version,
      brief: input.brief ?? null,
      brief_file_path: input.briefFilePath ?? null,
      concept: input.concept ?? null,
      plan: { ...input.plan, items: input.plan.items.map(unsigned) },
      deal_deliverable_id: input.dealDeliverableId ?? null,
      prompt: input.prompt ?? null,
      aesthetic: input.aesthetic ?? null,
      objective: input.objective ?? null,
      confirm: input.confirm ?? null,
      creative_intent_id: input.creativeIntentId ?? null,
    })
    .returning({ id: studioPlans.id, version: studioPlans.version });
  return row;
}

/**
 * A stored plan's items with fresh urls, from her own rows: a trimmed clip's beat frame (cached, so
 * no re-grab), else the row's poster; the clip's mp4. An asset no longer castable for her keeps its
 * place with no url. No model, no search.
 *
 * AND A LATER READ (PR 9.5, F22 B3 — a MERGE, not a re-plan): a clip item whose asset has beats NOW
 * carries `beats: N` in the answer, so the screen can say "Cut it · N beats" and offer the re-plan
 * (her Plan-it tap, the parentPlanId path). The stored row is never rewritten; when no asset has
 * beats the answer is byte-for-byte what it was (P2). ⚠️ MUTATION (studio.agent.test): drop the
 * merge — "saved plan ignores a later read" reds by name.
 */
export async function resignItems(
  athleteId: string,
  items: readonly CastItem[],
  poster: typeof beatPosterUrl = beatPosterUrl,
): Promise<CastItem[]> {
  const ids = items.flatMap((i) => (i.assetId ? [i.assetId] : []));
  const rows = await loadCastable(athleteId, ids);
  return Promise.all(
    items.map(async (item) => {
      if (item.assetId === null) return item;
      const row = rows.get(item.assetId);
      if (!row) return { ...item, thumbUrl: null, videoUrl: null };
      const pick = await asPick(row);
      const beatFrame =
        item.trim && pick.videoPath
          ? await poster({
              athleteId,
              assetId: item.assetId,
              videoPath: pick.videoPath,
              window: item.trim,
            })
          : null;
      const fresh = item.mediaType === "clip" ? row.beats.length : 0;
      return {
        ...item,
        thumbUrl: beatFrame ?? pick.thumbUrl,
        videoUrl: item.mediaType === "clip" ? (pick.videoUrl ?? null) : null,
        ...(fresh > 0 && fresh !== item.beats ? { beats: fresh } : {}),
      };
    }),
  );
}

/**
 * Whether a deal deliverable is HERS (PR 6, 6d) — the plan row may name it. A deliverable has no athlete
 * id of its own; its deal does, so the join is the tenancy boundary (studio/dealDeliverables.ts reads
 * them the same way). Read-only. ⚠️ MUTATION (studio.agent.test): drop the athlete predicate — "another
 * athlete's deliverable is refused, before any model call" reds by name.
 */
export async function ownsDeliverable(
  athleteId: string,
  deliverableId: string,
  client: Client = db,
): Promise<boolean> {
  const [row] = await client
    .select({ id: dealDeliverables.id })
    .from(dealDeliverables)
    .innerJoin(deals, eq(dealDeliverables.deal_id, deals.id))
    .where(
      and(
        eq(dealDeliverables.id, deliverableId),
        eq(deals.athlete_id, athleteId),
      ),
    )
    .limit(1);
  return !!row;
}

/** Where her uploaded briefs live: one prefix per athlete, one object per upload (decision 5). */
export const briefPrefix = (athleteId: string) => `studio-briefs/${athleteId}/`;

/** A brief path she may attach to a plan: under HER prefix, a server-minted id, a .pdf. */
export const isHerBriefPath = (
  athleteId: string,
  path: unknown,
): path is string =>
  typeof path === "string" &&
  path.startsWith(briefPrefix(athleteId)) &&
  /^[0-9a-f-]{36}\.pdf$/i.test(path.slice(briefPrefix(athleteId).length));
