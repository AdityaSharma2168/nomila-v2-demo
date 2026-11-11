/**
 * Flow 4 — ask-for-ideas → concepts → pick → plan. AgentScreen's own door with no brief: `agentRequest`
 * → POST /studio/agent/plan with `stage: "concepts"` → her pick (the SECOND concept, so a concept that
 * is not the first is proven to travel) → the plan with the concept → Board, preview, stitch.
 * Replicated from AgentScreen.tsx:265-345.
 */
import { agentRequest } from "../../../../../../client/screens/studio/agentLogic";
import type { PickedVideo } from "../../../../../../client/screens/studio/storyboardLogic";
import { CENSUS_ASK } from "../fixture";
import { post, type FlowCtx } from "./common";
import { planAndBoard, PLANNER_ROUTES, type SeededLibrary } from "./brief";

export async function runIdeasFlow(
  ctx: FlowCtx,
  lib: SeededLibrary,
): Promise<void> {
  ctx.model(PLANNER_ROUTES);
  const req = agentRequest({
    prompt: CENSUS_ASK.prompt,
    objective: CENSUS_ASK.objective,
    aesthetic: CENSUS_ASK.aesthetic,
    picked: [lib.her, lib.held],
    products: [lib.product],
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
    throw new Error(`census flow 4: the request refused: ${req.gap}`);
  const ideas = await post(ctx, "/studio/agent/plan", {
    ...req.body,
    stage: "concepts",
  });
  if (ideas.status !== 200)
    throw new Error(
      `census flow 4: concepts ${ideas.status} ${JSON.stringify(ideas.json)}`,
    );
  const concepts = (ideas.json?.concepts ?? []) as { id: string }[];
  const pick = concepts[1];
  if (!pick)
    throw new Error("census flow 4: fewer than two concepts came back");
  const body = { ...req.body, concept: pick };
  ctx.store.add("plan_request", body);
  await planAndBoard(ctx, body, CENSUS_ASK.objective, null);
}
