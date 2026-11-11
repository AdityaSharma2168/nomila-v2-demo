/**
 * Flow 3 — moment door → concept → compose → plan, as BrandPostScreen wires it (BrandPostScreen.tsx:236-
 * 266): POST /studio/direction/research-moment (the grounded search mocked: the model's answer and the
 * provider's own citations) → she confirms the moment, which WAITS → "Ideas": POST
 * /studio/direction/propose-campaign with the moment stacked as prior context (`toPriorContext`, her
 * confirm tap) → she picks a proposal → the brief path, the proposal's concept riding the plan unchanged
 * (BrandPlanStep.tsx:94-104).
 */
import { toPriorContext } from "../../../../../../client/screens/studio/directionLogic";
import { post, type FlowCtx } from "./common";
import {
  composeAndPlan,
  PLANNER_ROUTES,
  readProposalFrom,
  type SeededLibrary,
} from "./brief";

export const momentReply = () => ({
  text: JSON.stringify({
    found: true,
    title: "ZQ080 the league final",
    summary: "ZQ081 the season's last match, on court this weekend",
    angle: "ZQ082 the last whistle",
    feeling: "ZQ083 electric",
    line: "ZQ084 I have waited all season for this one",
    feel: ["ZQ085 electric", "tense"],
  }),
  grounding: [
    {
      uri: "https://example.org/zq086-final",
      title: "ZQ087 league final preview",
      domain: "example.org",
    },
  ],
});

/** propose_campaign's answer: two proposals, each a concept and a few lines. */
export const proposeReply = (): string =>
  JSON.stringify({
    proposals: [
      {
        concept: {
          angle: "ZQ090 the final, from the bench",
          feeling: "ZQ091 taut",
          line: "ZQ092 the minutes before she goes on",
        },
        lines: [
          {
            path: "creative_direction.tone",
            value: ["ZQ093 taut", "ZQ094 bright"],
            because: "ZQ095 the moment reads tense",
          },
          {
            path: "story",
            value: "ZQ096 the walk onto court for the final",
            because: "ZQ097 the moment she confirmed",
          },
        ],
      },
      {
        concept: {
          angle: "ZQ098 the whole season",
          feeling: "proud",
          line: "ZQ099 every match that led here",
        },
        lines: [],
      },
    ],
    notes: [],
  });

export async function runMomentFlow(
  ctx: FlowCtx,
  lib: SeededLibrary,
): Promise<void> {
  ctx.model([
    {
      when: "You help an athlete creator find ONE moment",
      point: "direction_prompt",
      reply: momentReply,
    },
    {
      when: "You are a creative director for an athlete",
      point: "direction_prompt",
      reply: proposeReply,
    },
    ...PLANNER_ROUTES,
  ]);
  const brand = "Qorvane ZQ002";
  const read = await post(ctx, "/studio/direction/research-moment", {
    ask: "ZQ088 something for the final",
    brand,
  });
  const moment = readProposalFrom(read, "research-moment");
  ctx.store.add("proposal", moment);
  // Her confirm tap: the moment waits, and stacks into the ideas call.
  const proposed = await post(ctx, "/studio/direction/propose-campaign", {
    objective: "showcase-product",
    brand,
    priorContext: toPriorContext(moment, { confirmed: true }),
  });
  if (proposed.status !== 200)
    throw new Error(
      `census flow 3: propose ${proposed.status} ${JSON.stringify(proposed.json)}`,
    );
  const first = ((proposed.json?.proposals ?? []) as unknown[])[0];
  const proposal = readProposalFrom(
    { status: 200, json: { proposal: first } },
    "propose-campaign",
  );
  ctx.store.add("proposal", proposal);
  await composeAndPlan(ctx, lib, proposal);
}
