/**
 * Flow 7 — clip read → beats → a plan that cuts into the clip. POST /studio/media/:id/read on a clip no
 * tagger has seen (behind STUDIO_CLIP_READ, a roadmap gate: the off-run gets a 404, and the plan that
 * follows has no beats to cut to) → the video tagger (the model mocked, answering two beats) → the
 * planner cutting a window inside beat 1 → the cast trim → the Board → the stitch.
 */
import { eq } from "drizzle-orm";
import { mediaAssets } from "../../../../../../shared/schema";
import { agentRequest } from "../../../../../../client/screens/studio/agentLogic";
import type { PickedVideo } from "../../../../../../client/screens/studio/storyboardLogic";
import { post, refFor, seedAsset, type FlowCtx } from "./common";
import { conceptsReply, planAndBoard, type SeededLibrary } from "./brief";

/** What the video tagger answers for the unread clip: the whole clip, and two beats. */
export const clipTagReply = (): string =>
  JSON.stringify({
    subject: "the_athlete",
    athlete_prominence: 0.8,
    shot_type: "action",
    description: "ZQ170 she drills a pass against the wall",
    brands_visible: [],
    aesthetic_quality: 0.75,
    brand_safe: true,
    content_flags: {
      hateful: false,
      sexual: false,
      violence_or_weapons: false,
      drugs_or_alcohol: false,
      self_harm: false,
      obscene_gesture: false,
    },
    setting: "ZQ171 a gym wall",
    attire: "ZQ172 a training top",
    vibe: "ZQ173 focused",
    hero_suitability: 0.7,
    disposition: "as_is",
    edit_note: "ZQ174 none",
    reason: "ZQ175 a clean repeated drill",
    beats: [
      {
        start_s: 0,
        end_s: 4,
        description: "ZQ176 she sets her feet",
        camera: "static wide",
        motion: "she steps in",
        shot_type: "action",
        subject: "the_athlete",
        athlete_prominence: 0.7,
        aesthetic_quality: 0.7,
        hero_suitability: 0.6,
        setting: "ZQ177 the wall",
        attire: "ZQ172 a training top",
        vibe: "ZQ178 calm",
        brands_visible: [],
      },
      {
        start_s: 4,
        end_s: 9,
        description: "ZQ179 she fires three passes",
        camera: "handheld close-up",
        motion: "the ball rebounds",
        shot_type: "action",
        subject: "the_athlete",
        athlete_prominence: 0.9,
        aesthetic_quality: 0.8,
        hero_suitability: 0.8,
        setting: "ZQ177 the wall",
        attire: "ZQ172 a training top",
        vibe: "ZQ180 sharp",
        brands_visible: [],
      },
    ],
  });

export async function runClipReadFlow(
  ctx: FlowCtx,
  lib: SeededLibrary,
): Promise<void> {
  const unread = await seedAsset(ctx, {
    mediaType: "VIDEO",
    vision: null,
    durationSeconds: 9,
    embedding: [0.85, 0.15, 0],
  });
  const planReply = (prompt: string) => {
    let clip: string | null = null;
    try {
      clip = refFor(prompt, "ZQ170");
    } catch {
      clip = null; // the clip was never read: nothing to cut into
    }
    const her = refFor(prompt, "ZQ101");
    return JSON.stringify({
      items: [
        {
          kind: "i2v",
          ref: her,
          beat: "ZQ190 her before the drill",
          direction: "ZQ191 she breathes and looks up",
          reason: { entry: "i2v", fits: "ZQ192 opens on her" },
        },
        ...(clip
          ? [
              {
                kind: "clip",
                ref: clip,
                segment: 1,
                window: { startSec: 5, endSec: 7.5 },
                beat: "ZQ193 the passes",
                direction: "ZQ194 cut to the second and third pass",
                reason: {
                  entry: "clip.camera",
                  fits: "ZQ195 her drill, cut tight",
                },
              },
            ]
          : [
              {
                kind: "broll",
                beat: "ZQ196 the wall",
                direction: "ZQ197 an empty gym wall",
                reason: { entry: "broll", fits: "ZQ198 no clip to cut" },
              },
            ]),
      ],
      gaps: [],
    });
  };
  ctx.model([
    {
      when: "Watch THIS video in full, with its sound",
      point: "direction_prompt",
      reply: clipTagReply,
    },
    {
      when: 'Return STRICT JSON: { "concepts"',
      point: "concepts_prompt",
      reply: conceptsReply,
    },
    { when: "HER LIBRARY", point: "planner_prompt", reply: planReply },
  ]);
  const read = await post(ctx, `/studio/media/${unread}/read`, {});
  ctx.store.add("plan_request", {
    clipRead: { status: read.status, answer: read.json },
  });
  // The read finishes in the background past a grace window (clipRead.ts): wait for its row, bounded.
  let beats = 0;
  if (read.status === 200) {
    for (let i = 0; i < 60 && beats === 0; i++) {
      const [row] = await ctx.db
        .select({ m: mediaAssets.metadata })
        .from(mediaAssets)
        .where(eq(mediaAssets.id, unread));
      beats = (
        (row?.m as { vision?: { beats?: unknown[] } } | null)?.vision?.beats ??
        []
      ).length;
      if (beats === 0) await new Promise((r) => setTimeout(r, 50));
    }
  }
  const req = agentRequest({
    prompt: "ZQ199 cut my drill into a short",
    objective: "grow-following",
    aesthetic: "",
    picked: [lib.her],
    products: [],
    videos: [
      {
        assetId: unread,
        posterUrl: null,
        beats,
        cut: beats > 0,
      } satisfies PickedVideo,
    ],
  });
  if ("gap" in req)
    throw new Error(`census flow 7: the request refused: ${req.gap}`);
  ctx.store.add("plan_request", req.body);
  await planAndBoard(ctx, req.body, "grow-following", null);
}
