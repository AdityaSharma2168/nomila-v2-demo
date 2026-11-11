/**
 * Flow 8 — identity pack → chooser → the references actually attached. Her pack is a stored row (the
 * calibration that measures it is not this flow); GET /studio/identity/profile reads it (behind
 * STUDIO_IDENTITY_PACK: the off-run gets a 404 and no pack); the client's chooser tops her request up
 * (client/lib/identityPack.ts `previewBody`, exactly as `usePreviewGeneration` calls it); the preview
 * and the generate run; the adapter records which images it was handed, in which slot.
 */
import { identityProfiles } from "../../../../../../shared/schema";
import {
  previewBody,
  type IdentityProfileWire,
} from "../../../../../../client/lib/identityPack";
import { previewRequestFor } from "../../../../../../client/lib/studio-contract";
import type { StudioClassification } from "../../../../../../client/hooks/use-studio";
import { get, post, seedAsset, type FlowCtx } from "./common";
import { VISION_HER } from "../fixture";
import { PACK_MIN } from "../../../../identity/types";
import type { SeededLibrary } from "./brief";

export const IDENTITY_SENTENCE = "ZQ185 me warming up on the track at dusk";

export async function runIdentityFlow(
  ctx: FlowCtx,
  lib: SeededLibrary,
): Promise<{ pack: string[] }> {
  ctx.model([]);
  // A COMPLETE pack: PACK_MIN photos of her (identity/types.ts) — an incomplete pack is never used, by design.
  const face = await seedAsset(ctx, {
    mediaType: "IMAGE",
    vision: {
      ...VISION_HER,
      shot_type: "portrait",
      description: "ZQ186 her face, close",
    },
  });
  const body = await seedAsset(ctx, {
    mediaType: "IMAGE",
    vision: {
      ...VISION_HER,
      shot_type: "action",
      description: "ZQ187 her full stride",
    },
  });
  const more: string[] = [];
  for (let i = 0; i < PACK_MIN - 3; i++)
    more.push(
      await seedAsset(ctx, {
        mediaType: "IMAGE",
        vision: { ...VISION_HER, description: `her, frame ${i}` },
      }),
    );
  const pack = [face, body, lib.her, ...more];
  const entry = (
    assetId: string,
    faceSizeFrac: number,
    prominence: number,
    shotType: string,
  ) => ({
    assetId,
    faceSizeFrac,
    prominence,
    faceVisibility: "clear",
    shotType,
  });
  await ctx.db
    .insert(identityProfiles)
    .values({
      athlete_id: ctx.athleteId,
      pack: [
        entry(face, 0.4, 0.9, "portrait"),
        entry(body, 0.1, 0.8, "action"),
        entry(lib.her, 0.2, 0.7, "lifestyle"),
        ...more.map((id, i) => entry(id, 0.05 + i * 0.001, 0.5, "lifestyle")),
      ],
    } as typeof identityProfiles.$inferInsert)
    .onConflictDoNothing();
  const prof = await get(ctx, "/studio/identity/profile");
  // { profile, quote } — the hook reads `.profile` (client/hooks/use-identity-pack.ts:77).
  const profile =
    prof.status === 200
      ? ((prof.json?.profile ?? null) as IdentityProfileWire | null)
      : null;
  ctx.store.add("plan_request", {
    identityProfile: {
      status: prof.status,
      packSize: profile?.pack?.length ?? 0,
    },
  });

  const cls = await post(ctx, "/studio/classify", {
    direction: IDENTITY_SENTENCE,
    hasSourcePhoto: false,
  });
  const { request } = previewRequestFor({
    format: "photo",
    classification: cls.json as unknown as StudioClassification,
    direction: IDENTITY_SENTENCE,
    attachments: [],
    frameAssetId: null,
    interpreter: true,
  });
  const sent = previewBody(request, profile, ctx.flagsOn);
  ctx.store.add("clip_requests", sent);
  const quoted = await post(ctx, "/studio/preview", sent);
  const json = quoted.json as {
    previewId?: string;
    brief?: { job?: unknown };
    plan?: { inputs?: { prompt?: string } };
  } | null;
  if (quoted.status !== 200 || !json?.previewId) {
    ctx.store.add(
      "compiled_prompts",
      `REFUSED ${quoted.status} ${JSON.stringify(quoted.json)}`,
      false,
    );
    return { pack };
  }
  if (json.brief?.job) ctx.store.add("brief_jobs", json.brief.job);
  if (json.plan?.inputs?.prompt)
    ctx.store.add("compiled_prompts", json.plan.inputs.prompt, false);
  for (const b of ctx.spies.briefInputs()) ctx.store.add("brief_inputs", b);
  await post(ctx, "/studio/generate", { previewId: json.previewId });
  return { pack };
}
