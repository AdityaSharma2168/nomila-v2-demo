/**
 * Flow 1 — brand brief → confirm → plan → Board → clip request → compiled prompt → stitch spec.
 *
 * The brief path exactly as the screens run it (docs/probes/flow-eval.md C4): her uploaded brief read
 * by POST /studio/direction/summarize-brief (the model mocked, answering the census campaign's lines)
 * → the proposal she confirms → BrandPlanStep: concepts through the plan route's concept stage on
 * `brandPlanBody`, her pick, `briefHandoff` → AgentScreen: the composed ask, `agentRequest` +
 * `briefBody` + the concept → POST /studio/agent/plan → the cast → the Board (`seedRowsFrom`,
 * `buildSeed`, `planSeedExtras`) → `boardRequests` → POST /studio/preview per request → `boardStitch`
 * → `parseStitchSpec`. Client steps replicated from BrandPlanStep.tsx:133-175, AgentScreen.tsx:258-345
 * and :425-446, StoryboardTab.tsx:882-900 — the pure functions those screens call, called the same way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  athletesCurrent,
  mediaAssets,
  studioPlans,
} from "../../../../../../shared/schema";
import {
  agentRequest,
  briefBody,
  buildSeed,
  planSeedExtras,
  seedRowsFrom,
} from "../../../../../../client/screens/studio/agentLogic";
import {
  brandPlanBody,
  briefHandoff,
  type BrandPlanInput,
} from "../../../../../../client/screens/studio/brandLogic";
import {
  readProposal,
  type BriefProposal,
} from "../../../../../../client/screens/studio/directionLogic";
import { boardRequests } from "../../../../../../client/screens/studio/storyboardRun";
import {
  boardStitch,
  type StitchPiece,
} from "../../../../../../client/screens/studio/boardStitch";
import type { VideoEntryView } from "../../../../../../client/screens/studio/videoEntryLogic";
import type { PickedVideo } from "../../../../../../client/screens/studio/storyboardLogic";
import type { AgentPlanAnswer } from "../../../../../../client/hooks/use-studio";
import { parseStitchSpec, isRefusal } from "../../../../video/spec";
import { aspectFor } from "../../../../compile/aspect";
import type { CreativeBrief } from "../../../../brief";
import {
  CENSUS_CAMPAIGN,
  CENSUS_CONCEPT,
  PLAN_CAPS,
  VISION_CLIP,
  VISION_HELD,
  VISION_HER,
  VISION_PRODUCT,
} from "../fixture";
import {
  get,
  post,
  refFor,
  seedAsset,
  type FlowCtx,
  type ModelRoute,
} from "./common";

/** The brief file's id — a fixed UUID, so the census can trace where its path goes. */
export const BRIEF_FILE_ID = "0e0e0e0e-4c4c-4a4a-8b8b-000000000048";

/** A real PDF the summarize route can read (the direction suite's own fixture). */
export const FULL_PDF = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "direction",
    "fixtures",
    "briefs",
    "full.pdf",
  ),
);

export interface SeededLibrary {
  her: string;
  held: string;
  product: string;
  clip: string;
}

/** Her library: a photo of her, a second for the held still, her product, her clip with two beats. */
export async function seedLibrary(ctx: FlowCtx): Promise<SeededLibrary> {
  await ctx.db
    .insert(athletesCurrent)
    .values({
      athlete_id: ctx.athleteId,
      story_arc: "A synthetic arc for the census.",
    } as typeof athletesCurrent.$inferInsert)
    .onConflictDoNothing();
  return {
    her: await seedAsset(ctx, { mediaType: "IMAGE", vision: VISION_HER }),
    held: await seedAsset(ctx, {
      mediaType: "IMAGE",
      vision: VISION_HELD,
      embedding: [0.9, 0.1, 0],
    }),
    product: await seedAsset(ctx, {
      mediaType: "IMAGE",
      vision: VISION_PRODUCT,
      embedding: [0, 1, 0],
    }),
    clip: await seedAsset(ctx, {
      mediaType: "VIDEO",
      vision: VISION_CLIP,
      durationSeconds: 6,
      embedding: [0.8, 0.2, 0],
    }),
  };
}

// ─── The model's answers (fixture, not fields) ───────────────────────────────────────────────────

/** summarize_brief's answer: every line it may fill, from the census campaign, each inferred with a because. */
export function summarizeReply(): string {
  const c = CENSUS_CAMPAIGN;
  const line = (path: string, value: unknown, n: number) => ({
    path,
    value,
    basis: "inferred",
    because: `ZQ${String(50 + n).padStart(3, "0")} the brief implies it`,
  });
  return JSON.stringify({
    lines: [
      line("brand.name", c.brand.name, 0),
      line("brand.brand_attributes", c.brand.brand_attributes, 1),
      line("story", c.story, 2),
      line("subject.sport", c.subject.sport, 3),
      line("subject.identity_priority", c.subject.identity_priority, 4),
      line("product.line", c.product.line, 5),
      line("product.fidelity", c.product.fidelity, 6),
      line("creative_direction.tone", c.creative_direction.tone, 7),
      line("creative_direction.style", c.creative_direction.style, 8),
      line("creative_direction.energy", c.creative_direction.energy, 9),
      line("objective.type", c.objective.type, 10),
      line("objective.goal", c.objective.goal, 11),
      line("output.type", c.output.type, 12),
      line("output.aspect_ratio", c.output.aspect_ratio, 13),
      line("output.platform", c.output.platform, 14),
      line("constraints", c.constraints, 15),
    ],
    notes: ["ZQ066 read the whole brief"],
  });
}

/** The concept step's answer: three angles; the census picks A. */
export function conceptsReply(): string {
  return JSON.stringify({
    concepts: [
      {
        angle: CENSUS_CONCEPT.angle,
        feeling: CENSUS_CONCEPT.feeling,
        line: CENSUS_CONCEPT.line,
      },
      {
        angle: "ZQ070 the record, replayed",
        feeling: "ZQ071 proud",
        line: "ZQ072 the record run from the stands",
      },
      {
        angle: "ZQ073 thank you, in pictures",
        feeling: "ZQ074 warm",
        line: "ZQ075 every frame says thanks",
      },
    ],
  });
}

/** The planner's answer, written against the refs the prompt actually showed. */
export function planReply(prompt: string): string {
  const her = refFor(prompt, "ZQ101");
  const held = refFor(prompt, "ZQ108");
  const clip = refFor(prompt, "ZQ118");
  return JSON.stringify({
    items: [
      {
        kind: "i2v",
        ref: her,
        beat: "ZQ201 open on her",
        direction: "ZQ202 she looks up from her laces and smiles",
        searchQuery: "ZQ213 her on the court",
        sound: true,
        capabilities: {
          camera: "close_up",
          movement: "push_in",
          lighting: "golden_hour",
          composition: "centered",
          motion: "turning",
        },
        reason: {
          entry: "i2v",
          fits: "ZQ203 her face carries the thanks",
          over: "broll",
        },
      },
      {
        kind: "image",
        ref: held,
        beat: "ZQ204 a held breath",
        direction: "ZQ205 hold on the stretch",
        motion: "dolly",
        focus: { x: 0.4, y: 0.6 },
        reason: {
          entry: "image.motion.dolly",
          fits: "ZQ214 a still beat before the run",
        },
      },
      {
        kind: "clip",
        ref: clip,
        segment: 1,
        beat: "ZQ206 the turn",
        direction: "ZQ207 cut in on the turn to camera",
        sound: true,
        reason: {
          entry: "clip.camera",
          fits: "ZQ215 her own footage of the turn",
        },
      },
      {
        kind: "broll",
        beat: "ZQ208 the empty court",
        direction: "ZQ209 empty court lines at dawn",
        sound: true,
        capabilities: PLAN_CAPS,
        reason: {
          entry: "broll",
          fits: "ZQ216 the place before anyone arrives",
        },
      },
      {
        kind: "product",
        beat: "ZQ210 the spikes",
        direction: "ZQ211 the spikes turn slowly on the bench",
        capabilities: { movement: "orbit", lighting: "soft_light" },
        reason: {
          entry: "product",
          fits: "ZQ217 the product line, shown as it is",
        },
      },
    ],
    gaps: ["ZQ212 a caption to tag the partner"],
    look: {
      value: "warm",
      reason: { entry: "look", fits: "ZQ218 the dawn light" },
    },
    music: {
      name: "walking-around",
      onBeat: true,
      reason: { entry: "music.track", fits: "ZQ219 a warm walk" },
    },
  });
}

/** The routes every planning flow shares: the concept step and the planner. */
export const PLANNER_ROUTES: readonly ModelRoute[] = [
  {
    when: 'Return STRICT JSON: { "concepts"',
    point: "concepts_prompt",
    reply: conceptsReply,
  },
  { when: "HER LIBRARY", point: "planner_prompt", reply: planReply },
];

// ─── The flow ────────────────────────────────────────────────────────────────────────────────────

export async function runBrandBriefFlow(
  ctx: FlowCtx,
  lib: SeededLibrary,
): Promise<BriefProposal> {
  ctx.model([
    {
      when: "You read a brand's campaign brief",
      point: "direction_prompt",
      reply: summarizeReply,
    },
    ...PLANNER_ROUTES,
  ]);
  const briefFilePath = `studio-briefs/${ctx.athleteId}/${BRIEF_FILE_ID}.pdf`;
  const read = await post(ctx, "/studio/direction/summarize-brief", {
    briefFilePath,
  });
  const proposal = readProposalFrom(read, "summarize-brief");
  ctx.store.add("proposal", proposal);
  await composeAndPlan(ctx, lib, proposal, { briefFilePath });
  return proposal;
}

/** The proposal a direction route answered, read the way the client reads it — or the flow fails by name. */
export function readProposalFrom(
  r: { status: number; json: Record<string, unknown> | null },
  door: string,
): BriefProposal {
  if (r.status !== 200 || !r.json)
    throw new Error(`census: ${door} ${r.status} ${JSON.stringify(r.json)}`);
  const p = readProposal(r.json.proposal ?? r.json);
  if (!p)
    throw new Error(
      `census: ${door} answered no proposal the client can read: ${JSON.stringify(r.json).slice(0, 400)}`,
    );
  return p;
}

/**
 * BrandPlanStep → AgentScreen: the concept stage on the brand plan body, her pick (A), the hand-off,
 * the composed ask, the plan. Then the Board and everything after it.
 */
export async function composeAndPlan(
  ctx: FlowCtx,
  lib: SeededLibrary,
  proposal: BriefProposal,
  o: { briefFilePath?: string | null } = {},
): Promise<AgentPlanAnswer> {
  const input: BrandPlanInput = {
    brand: {
      name: String(
        (proposal.brief as { brand?: { name?: unknown } }).brand?.name ??
          "Qorvane ZQ002",
      ),
    },
    deliverable: null,
    productPhotoId: lib.product,
    productLine: "",
    instructions: "",
    briefFilePath: o.briefFilePath ?? null,
    proposal,
  };
  // ── BrandPlanStep: a confirmed proposal's own concept IS the idea, and the concept call is skipped
  // (BrandPlanStep.tsx:94-104); without one, onIdeas asks on the brand plan body and she picks A ──────
  let pick: NonNullable<Parameters<typeof briefHandoff>[1]> | null = null;
  if (proposal.extras.concept) pick = { id: "A", ...proposal.extras.concept };
  else {
    const ideas = await post(ctx, "/studio/agent/plan", {
      ...brandPlanBody(input),
      stage: "concepts",
    });
    if (ideas.status !== 200)
      throw new Error(
        `census: concepts ${ideas.status} ${JSON.stringify(ideas.json)}`,
      );
    const concepts = (ideas.json?.concepts ?? []) as NonNullable<
      Parameters<typeof briefHandoff>[1]
    >[];
    pick = concepts[0] ?? null;
  }
  // ── BrandPlanStep.onPlan: the compose path's hand-off ───────────────────────────────────────────
  const handoff = briefHandoff(input, pick);
  if (!handoff)
    throw new Error("census: briefHandoff answered null with a proposal");
  // ── AgentScreen: the fields pre-filled from the hand-off; her picks; the carried payload ─────────
  const req = agentRequest({
    prompt: handoff.prompt,
    objective: handoff.objective,
    aesthetic: handoff.aesthetic,
    picked: [lib.her, lib.held],
    products: handoff.productIds,
    videos: [
      {
        assetId: lib.clip,
        posterUrl: null,
        beats: 2,
        cut: true,
      } satisfies PickedVideo,
    ],
  });
  if ("gap" in req)
    throw new Error(`census: the compose screen refused: ${req.gap}`);
  const body = {
    ...req.body,
    ...briefBody(handoff, handoff.productIds.length),
    ...(handoff.concept ? { concept: handoff.concept } : {}),
  };
  ctx.store.add("plan_request", body);
  return planAndBoard(ctx, body, handoff.objective, handoff.campaign);
}

/** POST the plan, capture everything it made, then the Board and beyond. */
export async function planAndBoard(
  ctx: FlowCtx,
  body: Record<string, unknown>,
  objective: string,
  campaign: unknown,
): Promise<AgentPlanAnswer> {
  const planned = await post(ctx, "/studio/agent/plan", body);
  if (planned.status !== 200 || !planned.json)
    throw new Error(
      `census: plan ${planned.status} ${JSON.stringify(planned.json)}`,
    );
  const answer = planned.json as unknown as AgentPlanAnswer;
  for (const lib of ctx.spies.library()) ctx.store.add("library", lib);
  for (const item of answer.items) ctx.store.add("cast_items", item);
  if (answer.planId) {
    const [row] = await ctx.db
      .select()
      .from(studioPlans)
      .where(eq(studioPlans.id, answer.planId));
    ctx.store.add("plan_row", row);
  }
  await boardAndBeyond(ctx, answer, objective, campaign);
  return answer;
}

/**
 * The Board a plan seeds, its requests priced through the real preview route, and the stitch it would
 * send. Shared by every flow that ends in a Board.
 */
export async function boardAndBeyond(
  ctx: FlowCtx,
  answer: AgentPlanAnswer,
  objective: string,
  campaign: unknown,
): Promise<void> {
  const composer = ctx.flagsOn;
  const carrier = ctx.flagsOn;
  const opts = await get(ctx, "/studio/stitch/options");
  const limits = (opts.json?.limits ?? null) as {
    maxClips: number;
    minStillSec: number;
    maxStillSec: number;
    defaultStillSec: number;
  } | null;
  const nonce = `census${Math.random().toString(36).slice(2, 8)}`;
  const seed = buildSeed(
    nonce,
    objective as Parameters<typeof buildSeed>[1],
    seedRowsFrom(
      answer.items,
      nonce,
      limits?.defaultStillSec ?? null,
      composer,
    ),
    [],
    answer.planId ?? null,
    planSeedExtras(answer, false, composer ? campaign : null),
  );
  for (const r of seed.rows) ctx.store.add("board_rows", r);

  // PR 15.1's fourth argument: the composer, read by the caller (StoryboardTab / the Agent estimate).
  const requests = boardRequests(
    seed.rows,
    seed.objective,
    carrier ? (seed.planId ?? null) : null,
    composer,
  );
  for (const r of requests) ctx.store.add("clip_requests", r.request);

  const views: Record<string, VideoEntryView> = {};
  for (const r of requests) {
    const quoted = await post(ctx, "/studio/preview", r.request);
    // The preview route answers the brief it froze, whole (routes/studio.ts), and the plan it priced.
    const json = quoted.json as {
      brief?: CreativeBrief;
      plan?: { inputs?: { prompt?: string } };
    } | null;
    if (quoted.status !== 200) {
      ctx.store.add(
        "compiled_prompts",
        `REFUSED ${quoted.status} ${r.key} ${JSON.stringify(quoted.json)}`,
        false,
      );
      continue;
    }
    if (json?.brief?.job) ctx.store.add("brief_jobs", json.brief.job);
    if (json?.plan?.inputs?.prompt)
      ctx.store.add("compiled_prompts", json.plan.inputs.prompt, false);
    if (ctx.fidelity && json?.plan?.inputs?.prompt)
      ctx.fidelity.push({
        kind: "video",
        aspectRatio: json.brief ? (aspectFor(json.brief) ?? null) : null,
        text: json.plan.inputs.prompt,
      });
    // The piece as if it had been made: a generated clip of hers, so the stitch has a source.
    const made = await madeClip(ctx);
    views[`${r.key}:${r.kind}`] = {
      phase: "ready",
      label: "Ready",
      working: false,
      clips: [
        {
          assetId: made,
          mediaType: "VIDEO",
          uri: null,
          removed: false,
          editable: false,
          rejected: false,
        },
      ],
    };
  }
  for (const b of ctx.spies.briefInputs()) ctx.store.add("brief_inputs", b);

  const pieces: StitchPiece[] = requests.map((r, i) => ({
    key: r.key,
    kind: r.kind,
    label: `Shot ${i + 1}`,
  }));
  const stitch = boardStitch(
    seed.rows,
    pieces,
    views,
    seed.passthrough,
    limits?.maxClips ?? null,
    seed.music
      ? { bed: seed.music.bed, grid: null, onBeat: seed.music.onBeat }
      : null,
    limits
      ? { minStillSec: limits.minStillSec, maxStillSec: limits.maxStillSec }
      : null,
    seed.look ?? null,
    // As StoryboardTab.tsx:904-906 passes it after PR 15.1: the rhythm, and the plan id on the record.
    composer
      ? { rhythm: seed.rhythm ?? null, planId: seed.planId ?? null }
      : null,
  );
  ctx.store.add("stitch_body", {
    body: stitch.body,
    joins: stitch.joins,
    refusal: stitch.refusal,
  });
  if (stitch.body) {
    const spec = parseStitchSpec(stitch.body);
    if (isRefusal(spec)) ctx.store.add("stitch_spec", { refusal: spec });
    else {
      // What ffmpeg is built from, and the composer's record beside it — measured apart (PR 15.1).
      const { composer: record, ...built } = spec;
      ctx.store.add("stitch_spec", built);
      if (record) ctx.store.add("stitch_record", record);
    }
  }
}

async function madeClip(ctx: FlowCtx): Promise<string> {
  const [row] = await ctx.db
    .insert(mediaAssets)
    .values({
      athlete_id: ctx.athleteId,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      gcs_path: `athletes/${ctx.athleteId}/studio/census-made-${Math.random().toString(36).slice(2)}.mp4`,
      content_type: "video/mp4",
      duration_seconds: 4,
      ingested_at: new Date(),
      metadata: {},
    } as typeof mediaAssets.$inferInsert)
    .returning({ id: mediaAssets.id });
  return row.id;
}
