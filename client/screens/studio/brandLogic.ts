/**
 * brandLogic — the brands she can make a post for, taken from the deals she already has.
 *
 * ─── NO NEW ENDPOINT ───────────────────────────────────────────────────────────────────────────
 * `DealItem` already carries brandId, brandName and brandDomain, and brandId is exactly the type a
 * preview request wants. So the brand picker is real today without anything being built for it.
 *
 * The logo is NOT carried here: every brand surface in this app renders <BrandLogo brandName
 * brandDomain>, which resolves it and falls back to a monogram. Passing a url through would be a
 * second way of doing something the repo already does one way.
 *
 * ─── ONE ROW PER BRAND, NOT PER DEAL ───────────────────────────────────────────────────────────
 * A brand with four email threads is four deals — cross-thread grouping is a known gap on the
 * deals side — and showing gorjana four times would make the picker look broken. Collapsing by
 * brand id keeps this screen correct regardless of how that gets fixed.
 */
import {
  composeAskFromBrief,
  type BriefProposal,
  type ComposeObjective,
  type InferenceFlag,
} from "./directionLogic";
import type { DealItem } from "../../components/deals/DealCard";

export interface StudioBrand {
  brandId: number | null;
  name: string;
  /** Feeds BrandLogo, which does the resolving. */
  domain: string | null;
  /** How many deals collapsed into this row — the reason it is one row and not four. */
  dealCount: number;
}

/**
 * Which deals are worth offering as a brand to make something for.
 *
 * Written against the real DealStatus vocabulary — detected | pending | negotiating | accepted |
 * completed | rejected — rather than the words one might expect. There is no "declined" and no
 * "archived" status; being filed away is `threadStatus`, a different field entirely, and guarding
 * on statuses that cannot occur would have silently filtered nothing.
 *
 * `completed` stays IN: a finished deal is exactly when a recap gets made.
 */
function makeable(d: DealItem): boolean {
  if (d.status === "rejected") return false;
  if (d.threadStatus === "archived") return false;   // filed / set aside
  return true;
}

export function brandsFromDeals(deals: DealItem[]): StudioBrand[] {
  const byBrand = new Map<string, StudioBrand>();

  for (const d of deals) {
    if (!d.brandName) continue;
    if (!makeable(d)) continue;

    // Group on brandId where there is one; fall back to the name so a brand the resolver has not
    // matched still appears exactly once rather than once per thread.
    const key = d.brandId != null ? `id:${d.brandId}` : `name:${d.brandName.toLowerCase()}`;
    const existing = byBrand.get(key);

    if (existing) {
      existing.dealCount += 1;
      // A later row may carry the domain an earlier one lacked.
      existing.domain = existing.domain ?? d.brandDomain ?? null;
      continue;
    }

    byBrand.set(key, {
      brandId: d.brandId ?? null,
      name: d.brandName,
      domain: d.brandDomain ?? null,
      dealCount: 1,
    });
  }

  // Most deals first, then alphabetical — the brand she works with most is the one she is most
  // likely to be making something for.
  return [...byBrand.values()].sort(
    (a, b) => b.dealCount - a.dealCount || a.name.localeCompare(b.name),
  );
}

// ─── The brand post that plans onto the Board (PR 6, 6d) ────────────────────────────────────────

export type BrandFormat = "video" | "carousel";

/**
 * THE CHOOSER: Video and Carousel, and nothing else (PR 9, Lane 3b — Adi's product call). Story and Photo
 * are gone from the brand post; the "photo made on the next screen" path is dead in the brand flow.
 * ⚠️ MUTATION (brandPlan.test): add photo or story back — "brand-post chooser shows Story or Photo" reds by
 * name. Carousel keeps the old next-screen path until Lane 4's Carousel Create screen replaces it.
 */
export const BRAND_FORMATS: readonly { key: BrandFormat; label: string }[] = [
  { key: "video", label: "Video" },
  { key: "carousel", label: "Carousel" },
];

/**
 * The chooser's formats behind the flag (PR 10, R-1). The Carousel IS the ad flow, and the ad flow's
 * routes answer 404 with the server's STUDIO_IMAGE_EDIT_OPS off — so with the client flag off the chip
 * is not drawn at all: Video only. Nothing falls back to the dead next-screen path (carouselLogic.test's
 * fence). ⚠️ MUTATION (carouselLogic.test): return BRAND_FORMATS whatever the flag — "Carousel chip
 * renders with STUDIO_IMAGE_EDIT off" reds by name.
 */
export const brandFormatsFor = (
  imageEdit: boolean,
): readonly { key: BrandFormat; label: string }[] =>
  imageEdit ? BRAND_FORMATS : BRAND_FORMATS.filter((f) => f.key === "video");

/**
 * The one format the Board makes. A carousel is made on the old screen until Lane 4's Carousel Create
 * screen lands (PR 9) — the Board is a video editor.
 */
export const boardMakes = (f: BrandFormat): boolean => f === "video";

export interface BrandPlanInput {
  brand: Pick<StudioBrand, "name">;
  /** The open deliverable she picked, or null when she skipped. */
  deliverable: { id: string; campaign: string | null } | null;
  /** Her product photo, if she picked one — the plan's p1. */
  productPhotoId: string | null;
  /** The product in her words (decision 2). */
  productLine: string;
  /** Her own words for the post. */
  instructions: string;
  /** Her uploaded brief, when she uploaded one (studio-briefs/<her id>/…). */
  briefFilePath: string | null;
  /** A brief a direction tool read and she confirmed line by line (PR 7, Lane E), or null. */
  proposal: BriefProposal | null;
}

const cap = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

type ProductBlock = { ref: string | null; fidelity: string; line: string | null };
type OutputBlock = { type: string | null; aspect_ratio: string | null; platform: string | null };
/** The confirmed product, whole; the screen's photo only fills a confirmed product that names none (PR 10, R-3). */
const confirmedProduct = (
  confirmed: unknown,
  screen: ProductBlock | null,
): ProductBlock | null => {
  if (!confirmed || typeof confirmed !== "object") return screen;
  const c = confirmed as ProductBlock;
  return c.ref ? c : { ...c, ref: screen?.ref ?? null };
};
/** The confirmed output, field by field; the screen's value only where the brief said nothing (PR 10, R-3). */
const confirmedOutput = (confirmed: unknown, screen: OutputBlock): OutputBlock => {
  const c = (confirmed && typeof confirmed === "object" ? confirmed : {}) as Partial<OutputBlock>;
  return {
    type: c.type ?? screen.type,
    aspect_ratio: c.aspect_ratio ?? screen.aspect_ratio,
    platform: c.platform ?? screen.platform,
  };
};

/**
 * The CampaignBrief, assembled from what the screens collected — NO model call (PR 6, 6d). The shape
 * is server/studio/campaign/brief.ts `campaign-brief/1`, strict, and the server validates it; a test
 * holds this assembly to that schema. No athlete id, no deal id: the deal rides on the plan body
 * (decision 4), and the product photo is a handle, "product_1".
 */
export function brandCampaignBrief(i: BrandPlanInput): Record<string, unknown> {
  const line = cap(i.productLine, 120);
  const story = i.deliverable?.campaign ? cap(i.deliverable.campaign, 200) : "";
  const assembled = {
    schema: "campaign-brief/1" as const,
    objective: {
      type: "brand_campaign" as const,
      goal: "showcase-product" as const,
    },
    story: story || null,
    brand: {
      name: cap(i.brand.name, 80),
      brand_attributes: [] as string[],
      profile: null,
    },
    subject: { identity_priority: "high" as const, sport: null },
    product:
      i.productPhotoId || line
        ? {
            ref: i.productPhotoId ? "product_1" : null,
            fidelity: "high" as const,
            line: line || null,
          }
        : null,
    creative_direction: { tone: [] as string[], style: null, energy: null },
    references: [] as never[],
    output: {
      type: "video" as const,
      aspect_ratio: "9:16" as const,
      platform: null,
    },
  };
  if (!i.proposal) return assembled;
  // A brief she CONFIRMED line by line is the brief (PR 7, Lane E) — this screen's assembly only fills
  // what it has no line for: a story or brand the proposal left empty falls back to the deal's, her
  // picked photo fills a confirmed product that names no photo, and video/9:16 fills an output field the
  // brief left null (PR 10, R-3). ⚠️ MUTATION (brandPlan.test): return `assembled` — "a confirmed
  // proposal IS the brief the planner gets" reds.
  const b = i.proposal.brief as Record<string, unknown>;
  // The confirmed constraints ride INTO the campaign (decision 3's second half): a constraint the
  // planner never sees isn't one. ⚠️ MUTATION (brandPlan.test): leave them out — "constraints dropped at
  // the hop" reds by name.
  const constraints = i.proposal.extras.constraints;
  return {
    ...b,
    story: (typeof b.story === "string" && b.story.trim()) || assembled.story,
    brand: b.brand ?? assembled.brand,
    // THE CONFIRMED BRIEF WINS (PR 10, R-3 / AUDIT2 F23b): the product and the output block she confirmed
    // are the ones the planner reads; the screen's are fallbacks for what the brief has none of.
    // ⚠️ MUTATIONS (brandPlan.test): `assembled.product ?? b.product` — "confirmed product loses to the
    // screen's" reds by name; `assembled.output` — "confirmed output block reaches the planner as
    // video/9:16 after confirming image/4:5" reds by name.
    product: confirmedProduct(b.product, assembled.product),
    output: confirmedOutput(b.output, assembled.output),
    ...(constraints.length ? { constraints: constraints.slice(0, 6) } : {}),
  };
}

/**
 * The plan request the brand post sends: her words (or a plain line built from what she chose), a
 * brand objective — so the Board and the music are brand work, fail-closed — her product photo, the
 * assembled brief, and the deal and brief linkage for the plan row. ⚠️ MUTATION (brandLogic.test):
 * leave `campaign` out — "brief dropped between flow and planner" reds by name.
 */
/**
 * The plain line a brand plan asks with when she wrote no words of her own — built by code from what
 * she chose, never invented. Shared by the brand step and the agent door's re-plan (PR 6, 6d).
 */
export const brandFallbackLine = (brandName: string, productLine: string) => {
  const line = cap(productLine, 120);
  return `A video for ${cap(brandName, 80)}${line ? `, with ${line}` : ""}`;
};

export function brandPlanBody(i: BrandPlanInput): Record<string, unknown> {
  const words = cap(i.instructions, 2000);
  return {
    prompt: words || brandFallbackLine(i.brand.name, i.productLine),
    objective: "showcase-product",
    ...(i.productPhotoId ? { productAssetIds: [i.productPhotoId] } : {}),
    campaign: brandCampaignBrief(i),
    ...(i.deliverable ? { dealDeliverableId: i.deliverable.id } : {}),
    ...(i.briefFilePath ? { briefFilePath: i.briefFilePath } : {}),
  };
}

/**
 * THE HAND-OFF TO THE COMPOSE SCREEN (Adi's ruling, 23 Sep 2026 — supersedes 6d's terminate-in-Board
 * for the brief path): brief → confirm → concepts → the agent's compose screen, PRE-FILLED and editable
 * → her Plan-it tap → the planner → the Board. Two channels, never one: the VISIBLE fields (the
 * composed prompt, the feel, the purpose chip) she may edit, and the STRUCTURED payload (the confirmed
 * brief as the campaign, her concept, the brief file, the deal) that rides the plan
 * call regardless of what she edits. Populating one never drops the other.
 * ⚠️ MUTATION (brandPlan.test): leave `campaign` out of the hand-off — "brief dropped at compose hop"
 * reds by name.
 */
export interface BriefHandoff {
  brandName: string;
  prompt: string;
  aesthetic: string;
  objective: ComposeObjective;
  campaign: Record<string, unknown>;
  concept: { id: "A" | "B" | "C"; angle: string; feeling: string; line: string } | null;
  briefFilePath: string | null;
  dealDeliverableId: string | null;
  productIds: string[];
  /**
   * The confirm step's flags — which lines were literal and which inferred, with their quotes and
   * becauses (PR 13). They ride the plan call as `confirm` and land on the plan row; nothing consumes
   * them beyond display. ⚠️ MUTATION (brandPlan.test): leave them out — "confirm flags lost at save"
   * reds by name.
   */
  confirm: InferenceFlag[];
}

export function briefHandoff(
  i: BrandPlanInput,
  concept: BriefHandoff["concept"],
): BriefHandoff | null {
  if (!i.proposal) return null;
  const composed = composeAskFromBrief(i.proposal, i.brand.name);
  return {
    brandName: i.brand.name,
    prompt: composed.prompt,
    aesthetic: composed.aesthetic,
    objective: composed.objective ?? "showcase-product",
    campaign: brandCampaignBrief(i),
    concept,
    briefFilePath: i.briefFilePath,
    dealDeliverableId: i.deliverable?.id ?? null,
    productIds: i.productPhotoId ? [i.productPhotoId] : [],
    confirm: i.proposal.flags,
  };
}

/**
 * Where "Plan this one" goes: with a confirmed brief, to the compose screen — the planner runs only
 * on her tap there; without one, the manual path plans and lands on the Board as 6d built it.
 * ⚠️ MUTATION (brandPlan.test): "board" always — "planner runs without her tap on the brief path" reds.
 */
export const planStepAction = (i: BrandPlanInput): "compose" | "board" =>
  i.proposal ? "compose" : "board";


/** The campaign's lines as the ad op reads them: the product line, the story, the goal (PR 9, Lane 4). */
export function campaignLinesFor(i: BrandPlanInput): {
  product?: string;
  story?: string;
  goal?: string;
} {
  const brief = brandCampaignBrief(i) as {
    product?: { line?: string | null } | null;
    story?: string | null;
    objective?: { goal?: string };
  };
  return {
    ...(brief.product?.line ? { product: brief.product.line } : {}),
    ...(brief.story ? { story: brief.story } : {}),
    ...(brief.objective?.goal ? { goal: brief.objective.goal } : {}),
  };
}
