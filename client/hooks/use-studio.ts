/**
 * use-studio — the Studio Content Engine's client data layer.
 *
 * Two calls, both server-backed, both athlete-scoped by the TOKEN and nothing else. Note what is
 * absent from every request shape below: an athlete id. The server reads it from the authenticated
 * request, so there is nothing here to send and nothing to accidentally send wrong.
 *
 * THE 404 IS NOT AN ERROR. The server gates this surface on STUDIO_ENABLED (a runtime env var) and
 * the client gates it on EXPO_PUBLIC_STUDIO_ENABLED (a BUILD-time one). They are set independently,
 * so a client built with the flag on can meet a server with it off and get a 404 from a route it
 * believes exists. That is "not released here", not a failure — it renders as the empty/unavailable
 * state, never as a red error.
 */
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { STUDIO_IDENTITY_PACK } from "../lib/flags";
import { previewBody, type PackPolicy } from "../lib/identityPack";
import { useIdentityProfile } from "./use-identity-pack";
import { Platform } from "react-native";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";

// ─── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/**
 * The three arms of the intent picker.
 *
 * Mirrors `GenerationTask` in server/studio/types.ts. Duplicated on purpose: there is no shared
 * studio type module and adding one to shared/ is out of lane. The server does not trust this union
 * anyway — it re-validates every value against its own allowlist, so a drift here is a 400, not a
 * bad generation.
 */
export type StudioIntent = "image.generate" | "image.edit" | "video.generate";

/** The FORMAT. A parameter of the job, never a branch in the UI. */
export type StudioDeliverable =
  | "post"
  | "story"
  | "reel"
  | "carousel"
  | "ad"
  | "clip";

export type StudioObjective =
  | "announce"
  | "showcase-product"
  | "grow-following"
  | "concept"
  | "recap"
  | "thank-partner";

/**
 * What an uploaded reference is FOR. Mirrors `ReferenceRole` in server/studio/brief.ts, duplicated
 * for the same reason every other union here is: there is no shared studio type module and adding
 * one to shared/ is out of lane. The server re-validates against its own allowlist, so a drift here
 * is a 400 rather than a bad generation.
 *
 *   person   — her. Contributes the face and build to render.
 *   product  — the thing being shown. Contributes the object.
 *   object   — a thing to place IN the frame. Same slot as product, different manifest line.
 *
 * A third value, `influence` (a look reference), was removed: it promised the athlete "we'll take
 * the look — never the people", and on the model we route to that was not true. Style direction now
 * goes in the brief text instead, where nothing claims a guarantee.
 *
 * THERE IS NO DEFAULT AND MUST NOT BE ONE. The role decides what the model is told to take from a
 * photo, and picking one on her behalf is a decision she never made.
 *
 *   style_reference — PR 18, behind EXPO_PUBLIC_STUDIO_STYLE_SPEC: one of her ALREADY-READ references. Its
 *   reading shapes the look; its pixels are never sent (the server never plans it). Not `influence` back:
 *   what leaked was a look IMAGE in a slot, and this sends none.
 */
export type StudioReferenceRole =
  | "person"
  | "product"
  | "object"
  | "style_reference";

/**
 * One reference on the way to the server: an ASSET ID and a tag, never a path.
 *
 * The server re-reads the asset under the authenticated athlete and takes the storage path from
 * that row, so there is deliberately nothing here that could point a generation at a photo that is
 * not hers.
 */
export interface StudioReference {
  assetId: string;
  role: StudioReferenceRole;
  /** Her own words for what this is. Rides into the prompt verbatim; the server trims and caps it. */
  label?: string;
}

/**
 * Which formats each intent can produce. Must agree with the server's taskForPair() — which in turn
 * mirrors the engine's own fork — or the pill the athlete taps produces a 400.
 *
 * Motion is video-only; an edit is stills-only, because the pixel-faithful edit path has no motion
 * equivalent and silently re-rendering a clip is the failure the fork exists to prevent.
 */
export const DELIVERABLES_FOR: Record<StudioIntent, StudioDeliverable[]> = {
  "image.generate": ["post", "story", "ad", "carousel"],
  "image.edit": ["post", "story", "ad", "carousel"],
  "video.generate": ["reel", "clip"],
};

// ─── Shapes (mirrors of the server's) ───────────────────────────────────────────────────────────

export interface StudioContentItem {
  assetId: string;
  mediaType: string;
  url: string | null;
  thumbUrl: string | null;
  caption: string | null;
  approvalStatus: string | null;
  published: {
    platform: string;
    permalink: string | null;
    postedAt: string | null;
  } | null;
  createdAt: string | null;
  /**
   * Who it was made for. Read off the job's frozen brief server-side (studio/content.ts), never
   * guessed from a caption — null means no brand was named, which is a personal piece.
   */
  brandId: number | null;
  brandName: string | null;
}

export interface BriefGap {
  field: string;
  note: string;
  severity: "blocking" | "degraded";
}

export interface GenerationPreview {
  /**
   * The id of the SERVER'S stored record of this check — the row that later authorizes the spend.
   * It is the only thing /studio/generate is sent, and there is deliberately no cost field to go
   * with it: the ceiling is read off that row, not off anything this client says.
   */
  previewId: string;
  status: "ready" | "blocked";
  plan: {
    task: string;
    provider: string;
    model: string;
    inputs: {
      prompt: string;
      references: number;
      n: number;
      durationSeconds?: number;
    };
  } | null;
  references: { role: string; ref: string; label: string; slot: string }[];
  cost: {
    amountUsd: number;
    currency: string;
    basis: "estimated";
    unpriced?: boolean;
    detail?: string;
  } | null;
  unpriced: boolean;
  blockers: BriefGap[];
  warnings: BriefGap[];
  verdict: { canGenerate: boolean; headline: string; reason: string | null };
  /** Set when the block is a capability we are missing, not a gap in her material. */
  unavailable: { reason: string } | null;
  /**
   * The region the SERVER derived from her sentence, when she drew no box — fractions of the source
   * frame, the same wire format MaskEditor emits.
   *
   * Present only on an edit whose mask was auto-derived. Absent when she drew the box herself
   * (there is nothing to tell her that she does not already know) and on every generate.
   *
   * It is here so the mask editor can be SEEDED with it: she sees what will change before she
   * approves the spend, and can correct it. Correcting it sends `regions` explicitly on the next
   * check, which is what tells the server not to derive one.
   */
  derivedRegions?: StudioRegion[];
  /**
   * "Here's what we'll do" — present only on a preview the interpreter proposed (server/routes/studio.ts,
   * InterpretationCard). Each line is the FROZEN intent's own words, tagged by where it came from, so what
   * she reads is what will run. Absent on every other preview, and on every server without the interpreter.
   */
  interpretation?: { lines: InterpretationLine[] };
  /**
   * The same card on a preview the RULES read, when her keep froze beside their steps (A3b, "make it warmer,
   * dont change anything about me"): every line hers, and nothing to refuse — nothing was interpreted.
   * Absent on every other preview, and on every server without A3b.
   */
  card?: { lines: InterpretationLine[] };
  /**
   * The interpreter read her words as a new picture of her, not an edit of this photo (the new-image exit,
   * interpret/5). Present only then, on a BLOCKED preview — never on a decline or any other ask — so a screen
   * can tell the two apart without reading copy. Absent on every server without the exit.
   */
  newImage?: true;
  /**
   * The brief the preview froze — the server returns the whole of it (server/studio/preview.ts, `brief`). Mirrored
   * for ONE read: the steps of the edit intent it froze, so the composer's send can tell an interpreted ADD from
   * any other proposal (catch-all through the interpreter, D5). Absent `editIntent` on every generate, and on an
   * edit that froze none.
   *
   * And its changes' adds (C3): whether the add froze a photo of hers as its thing — the Object photo, or her one
   * Product photo — or invents it. The server decides; the send reads the answer rather than guessing it from the tray.
   */
  brief?: {
    job: {
      editIntent?: {
        steps: StudioEditStep[];
        changes?: { add?: { objectAssetId: string | null } | null }[];
      };
    };
  };
}

/** Where a line on the card came from: her words, our suggestion, or the ad's brand (plan v2 §2). */
export type InterpretationSource = "yours" | "suggested" | "brand";

/** One line of "Here's what we'll do" — a change, or a condition on the whole edit. */
export interface InterpretationLine {
  kind: "change" | "constraint";
  text: string;
  /** Null on a line nothing tagged. */
  source: InterpretationSource | null;
}

/**
 * A region to change, as FRACTIONS of the source image (0..1) — deliberately not pixels.
 *
 * The photo she marks up on screen is a scaled-down stand-in for a 4000x6000-class original, so a
 * pixel measured on the client means nothing to the server. A fraction is scale-invariant: it
 * survives device pixel ratio, `contain` letterboxing and the gap between the preview and the real
 * frame, so there is no scale factor for the two sides to disagree about. The server multiplies
 * these by dimensions it reads out of the object's own bytes (server/studio/geometry.ts) — the
 * `media_assets.width/height` columns are NULL for ingested media and client-asserted for uploads,
 * so neither side trusts them.
 *
 * `label` rides into the edit prompt verbatim, which is why an empty one is refused server-side.
 */
export interface StudioRegion {
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The structured shot slots — a HAND MIRROR of server/studio/types.ts `ShotSpec`, like every other
 * studio type in this file, and for the same stated reason (no shared module yet).
 *
 * Drift is a 400, not a bad generation: the server validates every slot NAME and VALUE against its
 * own closed sets and refuses what it does not know, so a value added here and not there cannot
 * produce a clip that silently ignored a chip.
 */
export {
  SHOT_SLOT_VALUES,
  LEGACY_SHOT_SLOT_VALUES,
} from "../lib/shotSlotValues";
import { SHOT_SLOT_VALUES } from "../lib/shotSlotValues";

export type StudioShotSlot = keyof typeof SHOT_SLOT_VALUES;
export type StudioShotSpec = {
  [K in StudioShotSlot]?: (typeof SHOT_SLOT_VALUES)[K][number];
};

export interface PreviewRequest {
  intent: StudioIntent;
  deliverable: StudioDeliverable;
  objective: StudioObjective;
  direction?: string;
  brandId?: number | null;
  sourceAssetId?: string;
  /** Edit only. Up to 3; the server re-checks the count, the bounds and the labels. */
  regions?: StudioRegion[];
  durationSeconds?: number;
  /**
   * Sound on this clip — video only, and a PRICE: it doubles Veo's per-second rate, so it belongs to
   * the quote rather than to playback. Absent is off. See `TargetPreviewRequest.audio`.
   */
  audio?: boolean;
  /**
   * The tagged references this is built from. Legal on BOTH intents and they mean different things:
   * on a generate they are the whole anchor, on an edit they are what to change the base toward.
   *
   * The server caps the count per model and refuses an untagged one — there is no default role.
   */
  references?: StudioReference[];
  /**
   * The frame a CLIP must arrive at — an ASSET ID, never a path.
   *
   * The server re-reads it under HER athlete id (`readOwnedImage`, the same predicate
   * `sourceAssetId` gets) and freezes the ROW's path onto the brief, so the job that runs is the
   * job that was quoted. Video only; an image preview ignores it.
   *
   * Sending one is what makes the clip a TRANSITION — it routes to Kling and takes the
   * first-and-last template. See server/studio/brief.ts JobLastFrame.
   */
  lastFrameAssetId?: string;
  /**
   * The stored plan this clip belongs to (PR 14, behind STUDIO_BRIEF_CARRIER) — an ID, never a brief.
   * The server reads the row under HER athlete id and freezes the brief's feel, constraints and concept
   * onto the clip; a plan that is not hers is a 404. Sent by a planned Board only.
   */
  planId?: string;
  /**
   * What she SET about a clip — framing, camera movement, lighting, setting. Video only. The server
   * freezes it on the brief, so the prompt she is quoted is the prompt that runs. A clip that starts
   * from a photo takes `movement` alone; a bridge takes none. See `StudioShotSpec`.
   */
  shot?: StudioShotSpec;
  /**
   * quality-scrappy piece 5: the gate's reason CODES for her previous output, on a re-quote — never text. The server
   * compiles each into the target's own fix; with its STUDIO_OUTPUT_GATE off it drops them. Absent on every first check.
   */
  corrective?: string[];
}

// ─── The routing answer ─────────────────────────────────────────────────────────────────────────

/**
 * Where an edit is actually performed, mirroring `EditPath` in server/studio/classify.ts.
 *
 * `ASK` is not a path. It is the classifier declining to route, and it is the only answer that
 * carries a `reason` — see `StudioClassification.reason`.
 */
export type StudioEditPath =
  | "FULL_IMAGE"
  | "MASKED"
  | "BACKGROUND"
  | "GENERATE"
  | "ASK";

/** One thing being done to the frame, mirroring `EditStep`. */
export interface StudioEditStep {
  op: string;
  targets: string[];
  value: string | null;
  scope: "REGION" | "SUBJECT_INVERSE" | "GLOBAL";
  /** "object" when what it becomes is the thing in her attached Object photo (replace with reference). */
  reference?: "object";
}

/**
 * What `POST /studio/classify` answers — a hand-mirror of `ClassifyResponse` (server/routes/studio).
 *
 * ⚠️ `reason` IS THE FIELD THIS SHAPE EXISTS TO CARRY. `person_target` and `fast_path_declined` are
 * both ASK and want DIFFERENT UI — one is "we won't do that to a picture of you", the other is
 * "which of these did you mean". The classifier already did the work of telling them apart, so
 * flattening them into a generic decline anywhere between the route and the screen throws that work
 * away. It travels as an opaque string on purpose: a client-side union would have to be widened in
 * lockstep with the server every time a reason is added, and the failure mode of forgetting is a
 * type error on a value the screen could have rendered.
 */
export interface StudioClassification {
  /** The first step's operation. Null on ASK, which has no steps. */
  op: string | null;
  /** The first step's targets. Empty on ASK, and on a whole-frame step that names no region. */
  targets: string[];
  initialPath: StudioEditPath;
  steps: StudioEditStep[];
  /** Why it declined. Absent on a routed answer. */
  reason?: string;
  /**
   * May the preview interpret this ask (the interpreter)? The server's own deterministic answer — an ask
   * a paraphrase might answer, its flags on, a photo to edit. Absent from a server that predates it, which
   * reads as no: the ask stays an ask.
   */
  interpretable?: boolean;
  /**
   * The `vague` ask's op chips (PR 19, R-6): sentences the rules read on their own, for her to tap into her draft.
   * Absent on every other answer, and from a server with STUDIO_IMAGE_OPS off.
   */
  suggestions?: string[];
}

/**
 * Why Create anything asked, when the answer is not the plan's routing decision — a hand-mirror of
 * `ClassifyPurpose` (server/studio/classify.ts). `draft` while she types, `shape` at send (auto-mark,
 * 2026-09-16). Neither changes the answer; they keep partial and unshown sentences out of the
 * classifier's fall-through log (draft: not logged; shape: tagged).
 */
export type ClassifyPurpose = "draft" | "shape";

/** The body `POST /studio/classify` is sent, in one place for the query and the one-shot below. */
function classifyBody(
  text: string,
  hasSourcePhoto: boolean,
  objectPhotos: number,
  purpose: ClassifyPurpose | undefined,
  stylePhotos = 0,
) {
  return {
    direction: text,
    hasSourcePhoto,
    objectPhotos,
    // PR 19 (B): only when she attached one, so every other body is byte-for-byte what it was.
    ...(stylePhotos > 0 ? { stylePhotos } : {}),
    ...(purpose ? { purpose } : {}),
  };
}

/**
 * Her sentence → the routing answer. A QUERY rather than a mutation: it is a pure function of
 * (direction, hasSourcePhoto, objectPhotos) on the server, so it caches and de-duplicates like any
 * other read, and re-checking a brief she has not changed costs nothing.
 *
 * `objectPhotos` is how many Object photos go with the job (`objectPhotosIn`): "change my earrings to
 * these gold hoops" routes with one and asks without, so attaching one re-asks — it is in the key.
 *
 * `enabled` is the caller's, not this hook's — it stays off entirely when the cutover flag is off,
 * so the flag-off path never makes the call at all.
 *
 * `purpose` (auto-mark): only Create anything's composer passes one — `draft`, for the badge while she
 * types. It is in the key, so a draft answer is never the cache hit the PLAN reads: the plan's own call
 * goes out untagged and is logged as it always was. A draft query keeps its previous answer while the
 * next one is in flight, so the badge does not blink off between two words.
 */
export function useStudioClassify(
  direction: string | null | undefined,
  hasSourcePhoto: boolean,
  enabled: boolean,
  objectPhotos = 0,
  purpose?: ClassifyPurpose,
  /** PR 19 (B): how many Style references go with the job. In the key, as objectPhotos is. */
  stylePhotos = 0,
) {
  const text = direction?.trim() ?? "";
  return useQuery<StudioClassification>({
    queryKey: [
      "studio",
      "classify",
      text,
      hasSourcePhoto,
      objectPhotos,
      ...(purpose ? [purpose] : []),
      ...(stylePhotos > 0 ? [`styles:${stylePhotos}`] : []),
    ],
    enabled: enabled && text.length > 0,
    // The answer cannot change for the same sentence and tray — the classifier is deterministic and
    // reads no row — so a refetch would only ever re-confirm it.
    staleTime: Infinity,
    ...(purpose === "draft" ? { placeholderData: keepPreviousData } : {}),
    queryFn: () =>
      studioPost<StudioClassification>(
        "/api/v1/me/studio/classify",
        classifyBody(text, hasSourcePhoto, objectPhotos, purpose, stylePhotos),
      ),
  });
}

/**
 * ONE classify call, now, never from a cache — the send's re-ask (auto-mark, 2026-09-16).
 *
 * The badge she saw was read off a draft answer, which can be for words she has since changed, or still in
 * flight. What is SENT is decided on the exact sentence sent, so send asks again rather than trusting it.
 */
export function classifyNow(
  direction: string,
  hasSourcePhoto: boolean,
  objectPhotos: number,
  purpose: ClassifyPurpose,
  /** PR 19 (B): her Style references, counted as the server's `attachedIn` counts them. */
  stylePhotos = 0,
): Promise<StudioClassification> {
  return studioPost<StudioClassification>(
    "/api/v1/me/studio/classify",
    classifyBody(
      direction.trim(),
      hasSourcePhoto,
      objectPhotos,
      purpose,
      stylePhotos,
    ),
  );
}

// ─── The content strip ──────────────────────────────────────────────────────────────────────────

/** Distinguishes "the server has this switched off" from "she has made nothing yet". */
export type StudioContentState = "loading" | "ready" | "unavailable" | "error";

export function useStudioContent(enabled: boolean) {
  const query = useQuery<{ items: StudioContentItem[] } | "unavailable">({
    queryKey: ["studio", "content"],
    enabled,
    queryFn: async () => {
      const res = await fetch(
        new URL("/api/v1/me/studio/content", getApiUrl()).toString(),
        {
          headers: await getAuthHeaders(),
        },
      );
      // See the module header: a 404 means the surface is not released on this server.
      if (res.status === 404) return "unavailable" as const;
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return (await res.json()) as { items: StudioContentItem[] };
    },
  });

  const data = query.data;
  const unavailable = data === "unavailable";
  const state: StudioContentState = query.isLoading
    ? "loading"
    : unavailable
      ? "unavailable"
      : query.isError
        ? "error"
        : "ready";

  return {
    items: data && data !== "unavailable" ? data.items : [],
    state,
    refetch: query.refetch,
  };
}

// ─── What she owes ──────────────────────────────────────────────────────────────────────────────

/**
 * One outstanding commitment, as the server sends it. Mirrors OutstandingDeliverable in
 * server/studio/dealDeliverables.ts.
 *
 * `dueOn` is a DATE STRING — "2026-10-12" — and not an instant. It must reach nowLogic's localDay()
 * without passing through `new Date()`, or it lands a day early for every athlete west of
 * Greenwich; see the note on that function.
 */
export interface StudioDeliverableItem {
  id: string;
  dealId: string;
  brandId: number | null;
  brandName: string;
  campaign: string;
  format: string;
  dueOn: string | null;
  optional: boolean;
  delivered: number;
  total: number;
}

/**
 * OUTSTANDING work only. Fulfilled, waived, cancelled and superseded obligations are filtered
 * server-side, as are deals she rejected — see the header on server/studio/dealDeliverables.ts.
 * A deal-history view needs a different read and must not be built on this one.
 *
 * `brandId` narrows to one brand and is part of the query key, so the Now feed (all brands) and the
 * brand-post picker (one brand) do not share a cache entry and overwrite each other's answer.
 */
export function useStudioDeliverables(
  enabled: boolean,
  brandId?: number | null,
) {
  const query = useQuery<{ items: StudioDeliverableItem[] } | "unavailable">({
    queryKey: ["studio", "deliverables", brandId ?? null],
    enabled,
    queryFn: async () => {
      const url = new URL("/api/v1/me/studio/deliverables", getApiUrl());
      if (brandId != null) url.searchParams.set("brandId", String(brandId));
      const res = await fetch(url.toString(), {
        headers: await getAuthHeaders(),
      });
      if (res.status === 404) return "unavailable" as const;
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return (await res.json()) as { items: StudioDeliverableItem[] };
    },
  });

  const data = query.data;
  const unavailable = data === "unavailable";
  const state: StudioContentState = query.isLoading
    ? "loading"
    : unavailable
      ? "unavailable"
      : query.isError
        ? "error"
        : "ready";

  return { items: data && data !== "unavailable" ? data.items : [], state };
}

// ─── The pre-generation check ───────────────────────────────────────────────────────────────────

/**
 * Compose → pre-check. Costs nothing and runs nothing: the server's preview makes no model call.
 * Deliberately a MUTATION rather than a query — it runs when she asks for it, not on every keystroke.
 */
export function usePreviewGeneration() {
  // ─── THE PACK'S ONE HOOK (PR 17, R-3) ────────────────────────────────────────────────────────
  //
  // Both reference flows — Campaign's picker and Create anything's tray — post through here, so this
  // is the single place a likeness generation is topped up from her pack. `previewBody` is pure and
  // is the thing the tests hold; with EXPO_PUBLIC_STUDIO_IDENTITY_PACK off the profile query never
  // fires and the body is the variables minus `packPolicy` — byte-for-byte the request sent before.
  const profile = useIdentityProfile();
  return useMutation<
    GenerationPreview,
    Error,
    PreviewRequest & { packPolicy?: PackPolicy }
  >({
    mutationFn: (vars) =>
      previewNow(
        previewBody(vars, profile.data?.profile ?? null, STUDIO_IDENTITY_PACK),
      ),
  });
}

/**
 * ONE preview check, now — the hook's call, and the composer's send-time check (catch-all through the interpreter,
 * 2026-09-16), which sends the request the hook would and hands its answer to the sheet. `signal` lets that
 * check give up on a slow answer; the hook passes none, exactly as before.
 */
export async function previewNow(
  body: PreviewRequest,
  signal?: AbortSignal,
): Promise<GenerationPreview> {
  const res = await fetch(
    new URL("/api/v1/me/studio/preview", getApiUrl()).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `Couldn't check this (${res.status})`);
  }
  return (await res.json()) as GenerationPreview;
}

/**
 * What POST /studio/plan/admit answers when a plan — a board — may be put in front of her whole.
 *
 * The caps ride along so a surface renders the ceiling it is measured against rather than carrying
 * its own copy of the number. They arrive only on a 200.
 */
export interface PlanAdmission {
  ok: true;
  itemCount: number;
  totalUsd: number;
  spentTodayUsd: number;
  maxJobUsd: number;
  maxDayUsd: number;
}

/**
 * ADMIT A WHOLE PLAN, OR BE TOLD WHY NOT. Spends nothing and consumes nothing — a read and an answer.
 *
 * Resolves on a 200. REJECTS on anything else with the server's own sentence, which is written for
 * her: it names the item by position, the ceiling, and what is already spent today.
 *
 * ⚠️ ADMISSION, NOT A RESERVATION. A 200 is not a promise the plan completes — another tab can spend
 * from the same day in between. `/studio/generate` still checks every piece on its own.
 */
export async function admitPlan(
  previewIds: string[],
  signal?: AbortSignal,
): Promise<PlanAdmission> {
  const res = await fetch(
    new URL("/api/v1/me/studio/plan/admit", getApiUrl()).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify({ previewIds }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ?? `Couldn't check this board (${res.status})`,
    );
  }
  return (await res.json()) as PlanAdmission;
}

// ─── The Agent ──────────────────────────────────────────────────────────────────────────────────

/** A planned item's kind (server/studio/agent/types.ts V1_PLAN_ITEM_KINDS). `image` since C1b: a held photo, $0. `clip` since C2: one of her own videos, $0. */
export type AgentItemKind = "i2v" | "broll" | "image" | "product" | "clip";

/**
 * One item of POST /studio/agent/plan's answer. Three states (server/studio/agent/cast.ts `CastItem`):
 *
 *   assetId set                 made from that photo of hers
 *   assetId null, uncast null   b-roll, made from its direction alone — on the Board, not left out
 *   assetId null, uncast set    left out, and `uncast` is the line she reads where it was
 */
export interface AgentPlanItem {
  kind: AgentItemKind;
  /** Why this is in the plan, in a line she reads. */
  beat: string;
  /** The sentence the item is generated from — it becomes the Board row's prompt. */
  direction: string;
  assetId: string | null;
  thumbUrl: string | null;
  /**
   * The vision tagger's fact about the photo it was cast to — null when nothing is cast, or when the
   * photo carries no such tag. For a product it is what decides the engine (agentLogic `seedRowsFrom`).
   */
  athletePresent: boolean | null;
  /** The planner recommends sound here. Seeds the Board row's sound on; she can turn it off there. */
  sound: boolean;
  /**
   * "This photo shows Nike." — the photo shows a sportswear brand her sentence did not name. A fact
   * for her to judge; the item is still in the plan. Null when there is nothing to say.
   */
  brandFlag: string | null;
  /**
   * The planned photo could not be used, so this is the closest match from her library — and the
   * direction was written about the planned one, so she should check it. Null when it is the photo
   * the planner chose.
   */
  swapped: string | null;
  /**
   * The direction was written about a photo that showed other people and that photo was swapped or
   * dropped, so it now describes the photo used (or reads as its beat). A line for the card, like
   * `swapped`; null otherwise; absent from an older server.
   */
  rewritten?: string | null;
  /**
   * The planner asked for an i2v, but her sentence asked for her own footage, so the photo is held
   * with a slow push-in instead of animated (PR 4 A1b). A line for the card; null otherwise; absent
   * from an older server.
   */
  demoted?: string | null;
  uncast: string | null;
  /** What the cast row IS — a photograph or one of her clips. Null when nothing is cast. Absent from an older server: read as a photo. */
  mediaType?: "photo" | "clip" | null;
  /** A clip item's window — the beat it is cut to — or null for the whole clip. Null on a photo. */
  trim?: { startSec: number; endSec: number } | null;
  /**
   * How many beats the clip has NOW (PR 9.5, B3) — merged onto a stored plan's item by the server
   * when a read landed after the plan was made. Absent when the asset has no beats, and from an older
   * server. A whole-clip item with beats is one she can plan again to cut into.
   */
  beats?: number | null;
  /** A clip's measured length, or null. Null on a photo. */
  durationSeconds?: number | null;
  /** A clip's mp4, signed, so the Board row can play its window. Null on a photo; absent from an older server. */
  videoUrl?: string | null;
  /**
   * Where the cast row came from — her camera, made here, synced from her accounts, stitched here
   * (server/studio/agent/provenance.ts). Said on the plan card, so a made-here still animated as
   * her is visible as what it is. Null when nothing is cast; absent from an older server.
   */
  provenance?: "camera" | "made-here" | "synced" | "stitched-here" | null;
  /** The cast row's platform — "instagram" makes a synced card FROM YOUR INSTAGRAM (PR 4 B2b). Absent from an older server. */
  platform?: string | null;
  /**
   * A CLIP's stored AI edit — the tagger's own note when it said the clip wants a crop or an
   * enhance (server/studio/agent/cast.ts `editNoteOf`). Shown as a chip on the clip card; nothing
   * is called to get it. Null on a photo, on a clip with no edit; absent from an older server.
   */
  editNote?: string | null;
  /**
   * An `image` item's move over its hold — "dolly" a slow push-in (PR 6; "pan" before it), "zoom",
   * "sweep" or "punch" toward a point (PR 6, 6a2) — $0, nothing generated, labelled apart from an
   * i2v's "slight movement" (C3, D2). Null or absent holds it dead still; null on every other kind.
   */
  motion?: "dolly" | "zoom" | "sweep" | "punch" | null;
  /** Where a zoom, sweep or punch heads — fractions of the upright photo — or null for the framing prior. Absent from an older server. */
  focus?: { x: number; y: number } | null;
  /**
   * Why the planner chose it: the capability-library entry (server/studio/agent/capabilityEntries),
   * why it fits the moment, and the entry it beat. Null when the planner named none the library
   * holds; absent from an older server (PR 6, 6a2).
   */
  reason?: AgentReason | null;
  /**
   * The Board slots the planner's capability asks fill (server/studio/agent/capabilities.ts
   * `toShotSpec`). The seed keeps only the slots the row may carry (`slotsAllowed`). Absent when none.
   */
  shot?: StudioShotSpec;
}

/** One idea from the concept step (server/studio/agent/types.ts `PlanConcept`, PR 6, 6c). */
export interface AgentConcept {
  id: "A" | "B" | "C";
  angle: string;
  feeling: string;
  line: string;
}

/** A choice's reason, against the capability library (server/studio/agent/types.ts `ItemReason`). */
export interface AgentReason {
  entry: string;
  fits: string;
  over: string | null;
}

export interface AgentPlanAnswer {
  items: AgentPlanItem[];
  castCount: number;
  /** One grade over every held photo, and why — or null; absent from an older server (PR 6, 6a2). */
  look?: { value: string; reason: AgentReason | null } | null;
  /** One track or bed, whether cuts land on its beat, and why — or null; absent from an older server. */
  music?: { name: string; onBeat: boolean; reason: AgentReason | null } | null;
  /** What the planner could not cover from her library — lines she reads (PR 6, 6a3). */
  gaps?: string[];
  /** The stored plan's id — null when it could not be saved; absent from an older server (PR 6, 6a3). */
  planId?: string | null;
  /** 1, or its parent's + 1 for a regenerate. */
  version?: number | null;
  /** The plan this one was regenerated from, or null. */
  parentPlanId?: string | null;
  /** The concept this plan's coverage serves (PR 6, 6c), or null. */
  concept?: AgentConcept | null;
  /** The deal deliverable this plan is for (PR 6, 6d), or null. */
  dealDeliverableId?: string | null;
  /** The CampaignBrief it was planned from — answered by GET /studio/agent/plans/:id (PR 6, 6d), or null. */
  brief?: Record<string, unknown> | null;
  /**
   * What it was planned FROM (PR 13, 0066), answered by the GET: her words, her feel, the purpose,
   * the confirm step's flags. Each null on a plan saved before 0066, and absent from an older server —
   * either way the screen inherits as it did before (agentLogic `inheritFromStoredPlan`).
   */
  prompt?: string | null;
  aesthetic?: string | null;
  objective?: string | null;
  confirm?: unknown;
  /**
   * Her picks the tagger did not see her in. No shot can be made from one now (i2v needs her in the
   * frame, b-roll is made from words), so when one is left out the screen can say why — see
   * agentLogic `picksLeftOut`. Absent from an older server: read as none.
   */
  picksWithoutHer?: string[];
}

/**
 * PLAN, OR BE TOLD WHY NOT. POST /studio/agent/plan: one model call and a few searches, and it writes
 * no preview and spends nothing — the plan is priced on the Agent screen by the Board's own code and
 * only ever spent from the Board.
 *
 * REJECTS with the server's own sentence on anything but a 200 — every refusal it gives ends in
 * "Nothing was spent", because none of them could have.
 */
export async function planWithAgent(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentPlanAnswer> {
  const res = await fetch(
    new URL("/api/v1/me/studio/agent/plan", getApiUrl()).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ?? `Couldn't plan that (${res.status}). Nothing was spent.`,
    );
  }
  return (await res.json()) as AgentPlanAnswer;
}

/**
 * CONCEPT BEFORE COVERAGE (PR 6, 6c). The same route with `stage: "concepts"`: two or three ideas from
 * her ask — one model call, none of her library, nothing planned or stored. She picks one; the plan
 * call carries it as `concept`.
 */
export async function conceptsWithAgent(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentConcept[]> {
  const res = await fetch(
    new URL("/api/v1/me/studio/agent/plan", getApiUrl()).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify({ ...body, stage: "concepts" }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ??
        `Couldn't find an idea in that (${res.status}). Nothing was spent.`,
    );
  }
  return ((await res.json()) as { concepts: AgentConcept[] }).concepts;
}

/** A brief PDF she picked: its uri, its size when the picker knows it, and on web the File itself. */
export interface PickedBrief {
  uri: string;
  size: number | null;
  file?: Blob;
}

/**
 * THE PICKER ALONE (PR 7, Lane E): the direction engine's upload door takes the file to the raw
 * application/pdf route, which stores and reads it in one round trip and needs no signer — the signed
 * door below cannot mint on a laptop (ADC has no `client_email` to sign with). Null when she backs out.
 */
export async function pickBriefPdf(): Promise<PickedBrief | null> {
  const DocumentPicker = await import("expo-document-picker");
  const r = await DocumentPicker.getDocumentAsync({
    type: "application/pdf",
    copyToCacheDirectory: true,
  });
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0];
  return {
    uri: a.uri,
    size: typeof a.size === "number" ? a.size : null,
    file: (a as { file?: Blob }).file,
  };
}

/**
 * UPLOAD A BRAND BRIEF (PR 6, 6d; decision 5) — the contract upload's pattern: the server mints a path
 * under studio-briefs/<her id>/ and a signed write url, and the PDF goes straight to storage. Nothing
 * reads it yet; its path rides on the plan for PR 7. Null when she backs out of the picker.
 */
export async function uploadBrief(): Promise<string | null> {
  const a = await pickBriefPdf();
  if (!a) return null;
  const mint = await mintBriefUpload(a.size);
  if (mint === "signing_unavailable")
    throw new Error("Couldn't start the upload (501).");
  await putPickedBrief(a, mint.uploadUrl);
  return mint.briefFilePath;
}

/**
 * THE MINT ALONE (PR 7, Lane E): a path under her prefix and a signed write url — or the server's word
 * that THIS runtime cannot sign (`501 signing_unavailable`: ADC without a `client_email`, a laptop),
 * which the direction engine's door answers by taking the raw application/pdf route instead. Cloud Run
 * signs, so deployed dev and prod exercise the signed path; a laptop exercises the fallback.
 */
export async function mintBriefUpload(
  size: number | null,
): Promise<
  { briefFilePath: string; uploadUrl: string } | "signing_unavailable"
> {
  const res = await fetch(
    new URL("/api/v1/me/studio/briefs/upload-url", getApiUrl()).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify({
        contentType: "application/pdf",
        bytes: size ?? undefined,
      }),
    },
  );
  if (res.status === 501) return "signing_unavailable";
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ?? `Couldn't start the upload (${res.status}).`,
    );
  }
  return (await res.json()) as { briefFilePath: string; uploadUrl: string };
}

/** The PUT to a signed url: the File on web, a streamed uri on device. */
export async function putPickedBrief(
  a: PickedBrief,
  uploadUrl: string,
): Promise<void> {
  if (Platform.OS === "web") {
    const body = a.file ?? (await (await fetch(a.uri)).blob());
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body,
    });
    if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  } else {
    const FileSystem = await import("expo-file-system/legacy");
    const put = await FileSystem.uploadAsync(uploadUrl, a.uri, {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": "application/pdf" },
    });
    if (put.status < 200 || put.status >= 300)
      throw new Error(`Upload failed (${put.status})`);
  }
}

/**
 * RE-OPEN A STORED PLAN (PR 6, 6a3). GET /studio/agent/plans/:id — the object the planner answered,
 * with fresh urls. No planner call, no search, nothing spent. A plan that is not hers is a 404.
 */
export async function openStoredPlan(
  planId: string,
  signal?: AbortSignal,
): Promise<AgentPlanAnswer> {
  const res = await fetch(
    new URL(
      `/api/v1/me/studio/agent/plans/${encodeURIComponent(planId)}`,
      getApiUrl(),
    ).toString(),
    { headers: await getAuthHeaders(), ...(signal ? { signal } : {}) },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      detail?.error ?? `Couldn't open that plan (${res.status}).`,
    );
  }
  return (await res.json()) as AgentPlanAnswer;
}

/** A plan refusal the screen can read by FIELD, not only by sentence — the replan route's own 400s. */
export class AgentPlanRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field: string | null,
  ) {
    super(message);
    this.name = "AgentPlanRefusal";
  }
}

/**
 * RE-PLAN A STORED PLAN FROM WHAT IT REMEMBERS (PR 13). POST /studio/agent/plans/:id/replan: the
 * child of that plan, planned from the row's own words, feel, purpose, brief and concept — anything in
 * `body` overrides the stored value. Rejects with an `AgentPlanRefusal` carrying the server's `field`,
 * so a pre-0066 row's "say it again" 400 can be told from every other refusal and the screen can fall
 * back to the posted re-plan (agentLogic `regeneratePlan`).
 */
export async function replanStoredPlan(
  planId: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentPlanAnswer> {
  const res = await fetch(
    new URL(
      `/api/v1/me/studio/agent/plans/${encodeURIComponent(planId)}/replan`,
      getApiUrl(),
    ).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await getAuthHeaders()),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new AgentPlanRefusal(
      detail?.error ?? `Couldn't plan that (${res.status}). Nothing was spent.`,
      res.status,
      typeof detail?.field === "string" ? detail.field : null,
    );
  }
  return (await res.json()) as AgentPlanAnswer;
}

// ─── Generation ─────────────────────────────────────────────────────────────────────────────────

/**
 * WHAT THIS CLIENT DOES NOT SEND, AND WHY.
 *
 * There is no cost, ceiling or "I approved it" field anywhere below. Generation is authorized by
 * the server's own record of the check she was shown, looked up by `previewId`; a figure sent from
 * here would be read by nothing. That is deliberate — a client able to name its own ceiling could
 * authorize a spend the athlete never saw, and the dangerous direction is an INFLATED number, not a
 * low one. Do not add a cost field to this request to "keep the server in sync".
 */
export type ClearanceStatus = "draft" | "approved" | "rejected";

/**
 * quality-scrappy piece 5 (server STUDIO_OUTPUT_GATE, opt-in): an output the gate held back — still being checked, or
 * failed, with one plain sentence per reason and the CODES a re-quote sends back as `corrective`. Absent: it passed,
 * or the gate is off — the wire it was.
 */
export type OutputGate =
  | { pending: true }
  | { failed: true; headline: string; lines: string[]; corrective: string[] };

export interface GeneratedAsset {
  assetId: string;
  mediaType: string;
  url: string | null;
  approvalStatus: string | null;
  /** What the clearance machine will actually accept next. Render buttons from THIS, never guess. */
  allowedNext: ClearanceStatus[];
  gate?: OutputGate;
}

export interface GenerationRun {
  jobId: string;
  /**
   * "already_running" ⇒ an identical tap already bought this; same job, one charge.
   *
   * ⚠️ "queued" WAS MISSING AND THE SERVER HAS ALWAYS SENT IT. A video generate does not run inline —
   * `/studio/generate` opens the job, answers `queued`, and the runner works it on its own tick. The
   * type admitted only the two inline outcomes, so every caller that branched on `status` was
   * branching on a union that could not describe a clip.
   */
  status: "queued" | "succeeded" | "already_running";
  assets: GeneratedAsset[];
}

/** Thrown when the server has the capability switched off (video today) rather than refusing HER. */
export class StudioUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioUnavailable";
  }
}

async function studioPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(path, getApiUrl()).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getAuthHeaders()),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message = detail?.error ?? `Something went wrong (${res.status})`;
    if (res.status === 503 && detail?.unavailable)
      throw new StudioUnavailable(message);
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/**
 * Run it. The one call that spends money — and note the request shape: a previewId, nothing else.
 *
 * Safe to fire twice. The server claims the approval atomically, so a double tap returns the SAME
 * jobId and bills once; this hook does not need to debounce for correctness (the button is disabled
 * while pending for the athlete's benefit, not the ledger's).
 */
export function useGenerate() {
  const qc = useQueryClient();
  return useMutation<GenerationRun, Error, { previewId: string }>({
    mutationFn: ({ previewId }) =>
      studioPost<GenerationRun>("/api/v1/me/studio/generate", { previewId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["studio", "content"] });
    },
  });
}

/**
 * Clearance. Approve, reject, or reopen one asset.
 *
 * "reject" is the §11 single gesture: the server removes the asset from every deck holding it and
 * THEN withdraws clearance, so this is one call and one confirmation. The athlete is never asked to
 * go and clear a deck first — if the server has to refuse, the message it returns is already a
 * sentence written for her.
 */
export interface ClearanceResult {
  assetId: string;
  approvalStatus: ClearanceStatus;
  allowedNext: ClearanceStatus[];
  removedFromDecks?: number;
  message?: string;
}

/**
 * "Not what I meant" — she refuses the interpreter's reading of her words (the interpreter, I.6). The
 * server records it on that preview and blocks it, so it can never be spent; her words go back to the
 * composer, where she left them. Sent the previewId and nothing else.
 */
export function useRejectInterpretation() {
  return useMutation<
    { previewId: string; rejected: true },
    Error,
    { previewId: string }
  >({
    mutationFn: ({ previewId }) =>
      studioPost(
        `/api/v1/me/studio/previews/${previewId}/interpretation/reject`,
      ),
  });
}

export function useClearance() {
  const qc = useQueryClient();
  return useMutation<
    ClearanceResult,
    Error,
    { assetId: string; action: "approve" | "reject" | "reopen" }
  >({
    mutationFn: ({ assetId, action }) =>
      studioPost<ClearanceResult>(
        `/api/v1/me/studio/assets/${assetId}/${action}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["studio", "content"] });
    },
  });
}
