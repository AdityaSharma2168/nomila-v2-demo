/**
 * Flow 6 — MakeIt / Create Anything: her sentence → POST /studio/classify → `previewRequestFor` (the
 * hook's own composition, client/lib/studio-contract.ts:993) → POST /studio/preview → POST
 * /studio/generate → the router (REAL) → the provider adapter (stood in, recording what it was sent)
 * → the cost line (the router's own JSONL) → the join row (qa/join.ts `joinRow`). Twice: a new picture
 * of her (image.generate, her photo as "You"), and an edit of her photograph (image.edit).
 */
import { readFileSync } from "node:fs";
import {
  previewRequestFor,
  type Attachment,
} from "../../../../../../client/lib/studio-contract";
import type { StudioClassification } from "../../../../../../client/hooks/use-studio";
import { joinRow } from "../../../../qa/join";
import { post, type FlowCtx } from "./common";
import type { SeededLibrary } from "./brief";

export const MAKEIT_GENERATE = "ZQ150 me sprinting along a beach at sunset";
export const MAKEIT_EDIT = "make my jersey teal";

async function makeOne(
  ctx: FlowCtx,
  sentence: string,
  attachments: Attachment[],
  frameAssetId: string | null,
): Promise<void> {
  const cls = await post(ctx, "/studio/classify", {
    direction: sentence,
    hasSourcePhoto: frameAssetId !== null,
  });
  if (cls.status !== 200)
    throw new Error(
      `census flow 6: classify ${cls.status} ${JSON.stringify(cls.json)}`,
    );
  ctx.store.add("plan_request", { classify: cls.json });
  const { request } = previewRequestFor({
    format: "photo",
    classification: cls.json as unknown as StudioClassification,
    direction: sentence,
    attachments,
    frameAssetId,
    interpreter: true,
  });
  ctx.store.add("clip_requests", request);
  const quoted = await post(ctx, "/studio/preview", request);
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
    return;
  }
  if (json.brief?.job) ctx.store.add("brief_jobs", json.brief.job);
  if (json.plan?.inputs?.prompt)
    ctx.store.add("compiled_prompts", json.plan.inputs.prompt, false);
  for (const b of ctx.spies.briefInputs()) ctx.store.add("brief_inputs", b);

  const made = await post(ctx, "/studio/generate", {
    previewId: json.previewId,
  });
  if (made.status !== 200) {
    ctx.store.add(
      "adapter_inputs",
      `REFUSED ${made.status} ${JSON.stringify(made.json)}`,
      false,
    );
    return;
  }
  const jobId = (made.json as { jobId?: string } | null)?.jobId;
  if (jobId) {
    const logPath = process.env.STUDIO_COST_LOG as string;
    ctx.store.add(
      "join_row",
      await joinRow(ctx.athleteId, { jobId }, { logPath }),
    );
  }
}

export async function runMakeItFlow(
  ctx: FlowCtx,
  lib: SeededLibrary,
): Promise<void> {
  ctx.model([]);
  const you: Attachment = {
    id: "you",
    role: "source-frame",
    name: "You",
    uri: null,
    assetId: lib.her,
    mediaType: "IMAGE",
  };
  await makeOne(ctx, MAKEIT_GENERATE, [you], null);
  await makeOne(ctx, MAKEIT_EDIT, [you], lib.her);
}

/** Every line the router wrote to the cost log this run — the census's cost_lines point. */
export function costLines(path: string): unknown[] {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}
