/**
 * Flow 2 — reference door → decompose → plan → clip. Does a reading dimension reach a compiled prompt,
 * and which? POST /studio/direction/decompose-reference on one of her own photos (the model mocked,
 * answering the census reading) → the proposal she confirms → the brief path of flow 1 (concepts,
 * hand-off, compose, plan, Board, preview, stitch).
 */
import { CENSUS_CAMPAIGN } from "../fixture";
import { post, seedAsset, type FlowCtx } from "./common";
import {
  composeAndPlan,
  PLANNER_ROUTES,
  readProposalFrom,
  type SeededLibrary,
} from "./brief";

/** What the reference engine answers: the census campaign's reading, and a commercial style. */
export const referenceReply = (): string =>
  JSON.stringify({
    schema: "reference-decomposition/1",
    reference_intent: CENSUS_CAMPAIGN.references[0].intent,
    commercial_style: ["documentary"],
  });

export async function runReferenceFlow(
  ctx: FlowCtx,
  lib: SeededLibrary,
): Promise<void> {
  ctx.model([
    {
      when: "You describe the LOOK of a creative reference",
      point: "direction_prompt",
      reply: referenceReply,
    },
    ...PLANNER_ROUTES,
  ]);
  // A reference she picked from her own library — no link fetched, nothing leaves the process.
  const ref = await seedAsset(ctx, {
    mediaType: "IMAGE",
    vision: {
      athlete_present: false,
      subject: "nobody",
      shot_type: "other",
      description: "a reference frame",
      brands_visible: [],
      setting: "a court",
      vibe: "calm",
      attire: "none",
    },
    embedding: [0, 0, 1],
  });
  const read = await post(ctx, "/studio/direction/decompose-reference", {
    source: { kind: "image", assetId: ref },
    role: "composition_reference",
  });
  const proposal = readProposalFrom(read, "decompose-reference");
  ctx.store.add("proposal", proposal);
  await composeAndPlan(ctx, lib, proposal);
}
