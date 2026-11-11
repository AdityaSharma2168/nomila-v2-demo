/**
 * Flow 5 — carousel: brief lines → recommend → typed op → quote → compiled sentence; and every manual op
 * through the single-edit door, one run to the billable door so the ad's CAMPAIGN block is seen as sent.
 *
 * The carousel as BrandPlanStep hands it over (BrandPlanStep.tsx:285-297: `campaignLinesFor`,
 * `briefLinesFrom(brandCampaignBrief(input))`) and CarouselCreateScreen runs it (:133-163, :211-226:
 * one recommend pass per photo, `recs[0]` as the cleanup, `batchBody` with a null headline). The manual
 * ops are the EditSheet's door, POST /studio/edits/quote. Model mocked: the recommend pass only.
 */
import {
  campaignLinesFor,
  brandCampaignBrief,
  type BrandPlanInput,
} from "../../../../../../client/screens/studio/brandLogic";
import { briefLinesFrom } from "../../../../../../client/screens/studio/editPopoverLogic";
import {
  addRef,
  batchBody,
  setVariations,
  MAX_INITIAL_CANDIDATES,
} from "../../../../../../client/screens/studio/carouselLogic";
import type { BriefProposal } from "../../../../../../client/screens/studio/directionLogic";
import { OP_PARAMS } from "../fixture";
import { editTick } from "../../../../edit/batch";
import { post, type FlowCtx } from "./common";
import type { SeededLibrary } from "./brief";

/** The recommend pass's answer: one cleanup, its `because` copied verbatim from a line it was shown. */
const recommendReply = (prompt: string): string => {
  const because =
    prompt
      .split("\n")
      .find((l) => /^\d+\. /.test(l))
      ?.replace(/^\d+\. /, "") ?? "";
  return JSON.stringify({
    recs: [
      {
        op: "recolour",
        params: OP_PARAMS.recolour,
        because,
        what: "ZQ134 a bright bib shows",
      },
    ],
  });
};

export async function runCarouselFlow(
  ctx: FlowCtx,
  lib: SeededLibrary,
  proposal: BriefProposal,
): Promise<void> {
  ctx.model([
    {
      when: "You are checking ONE photograph against a brand campaign",
      point: "recommend_prompt",
      reply: recommendReply,
    },
  ]);
  // The brand the brief named — BrandPlanStep passes `brand.name` (BrandPlanStep.tsx:286).
  const brandName = String(
    (proposal.brief as { brand?: { name?: unknown } }).brand?.name ?? "",
  );
  const input: BrandPlanInput = {
    brand: { name: brandName },
    deliverable: null,
    productPhotoId: lib.product,
    productLine: "",
    instructions: "",
    briefFilePath: null,
    proposal,
  };
  const campaign = campaignLinesFor(input);
  const briefLines = briefLinesFrom(brandCampaignBrief(input));

  // ── CarouselCreateScreen: the recommend pass on her photo, recs[0] as the cleanup ─────────────────
  const rec = await post(ctx, "/studio/edits/recommend", {
    assetId: lib.her,
    briefLines,
    brand: OP_PARAMS.ad.brand,
  });
  if (rec.status !== 200)
    throw new Error(
      `census flow 5: recommend ${rec.status} ${JSON.stringify(rec.json)}`,
    );
  const recs = (rec.json?.recs ?? []) as unknown[];
  const added = addRef([], { assetId: lib.her, thumbUrl: null });
  if (!added.ok)
    throw new Error(`census flow 5: addRef refused: ${added.reason}`);
  const three = setVariations(added.refs, lib.her, MAX_INITIAL_CANDIDATES);
  const refs = (three.ok ? three.refs : added.refs).map((r) => ({
    ...r,
    cleanup: (recs[0] ?? null) as never,
  }));
  const body = batchBody(
    refs,
    OP_PARAMS.ad.brand,
    campaign,
    briefLines,
    null,
    OP_PARAMS.ad.setting,
  );
  ctx.store.add("plan_request", { carouselBatch: body });
  const quote = await post(ctx, "/studio/edits/batch/quote", body);
  ctx.store.add(
    "op_quote",
    quote.status === 200
      ? quote.json
      : `REFUSED ${quote.status} ${JSON.stringify(quote.json)}`,
  );
  // Her tap: the batch runs. The route kicks the tick in the background; the census drives the same tick
  // itself until nothing is left to claim, so every ad the batch made is seen at the adapter.
  const batchId = (quote.json as { batchId?: string } | null)?.batchId;
  if (quote.status === 200 && batchId) {
    const run = await post(ctx, `/studio/edits/batch/${batchId}/run`, {});
    if (run.status !== 200)
      ctx.store.add(
        "adapter_inputs",
        `REFUSED batch run ${run.status} ${JSON.stringify(run.json)}`,
        false,
      );
    for (let i = 0; i < 12; i++) await editTick();
  }

  // ── The EditSheet's door: every manual op, and the ad whole ───────────────────────────────────────
  const singles: { op: string; params: Record<string, unknown> }[] = [
    { op: "recolour", params: OP_PARAMS.recolour },
    { op: "garment", params: OP_PARAMS.garment },
    { op: "garment", params: OP_PARAMS.garmentDesign },
    {
      op: "product",
      params: { ...OP_PARAMS.productPlace, productAssetId: lib.product },
    },
    { op: "product", params: OP_PARAMS.productAdd },
    { op: "product", params: OP_PARAMS.productRemove },
    { op: "background_clean", params: OP_PARAMS.backgroundClean },
    { op: "ad", params: OP_PARAMS.ad },
  ];
  for (const s of singles) {
    const q = await post(ctx, "/studio/edits/quote", {
      sourceAssetId: lib.her,
      op: s.op,
      params: s.params,
    });
    ctx.store.add(
      "op_quote",
      q.status === 200
        ? q.json?.quote
        : `REFUSED ${q.status} ${s.op} ${JSON.stringify(q.json)}`,
    );
    // The ad is run once, so its CAMPAIGN block is read where it is sent (the billable door, mocked).
    if (s.op === "ad" && q.status === 200) {
      const id = (q.json?.edit as { id?: string } | undefined)?.id;
      if (id) {
        const run = await post(ctx, `/studio/edits/${id}/run`, {});
        if (run.status !== 200)
          ctx.store.add(
            "adapter_inputs",
            `REFUSED ${run.status} ${JSON.stringify(run.json)}`,
            false,
          );
      }
    }
  }
}
