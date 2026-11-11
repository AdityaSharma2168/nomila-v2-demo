/**
 * agentLogic — the Agent screen's rules, as arithmetic and nothing else.
 *
 * Pure for the reason storyboardLogic and stitchLogic are: jest's roots take client/ only for suites
 * with no renderer, so a rule that decides what she is shown, priced or handed to the Board is only
 * testable if it never arrives through react-native.
 *
 * ─── ⚠️  ONE COPY OF THE ROWS ───────────────────────────────────────────────────────────────────
 *
 * The Agent screen prices a plan through the BOARD's own code (storyboardRun `boardRequests` →
 * `previewNow`), and the Board seeds from the same rows. `seedRowsFrom` is the only place a plan
 * becomes rows, so the estimate she sees here and the quote the Board makes are built by one piece
 * of code from one set of rows. A second mapping — one for the estimate, one for the seed — would be
 * two things that could disagree about what she is buying.
 */
import type {
  AgentItemKind,
  AgentPlanAnswer,
  AgentPlanItem,
  AgentReason,
  StudioObjective,
} from "../../hooks/use-studio";
import { takesFocus } from "./stitchLogic";
import { brandFallbackLine } from "./brandLogic";
import {
  asIsVideos,
  cutVideos,
  droppedSlotReason,
  heldClipRow,
  heldPhotoRow,
  slotsAllowed,
  type BoardSeed,
  type DroppedSlot,
  type PickedVideo,
  type StoryboardRow,
} from "./storyboardLogic";
import { rhythmFrom } from "./rhythmLogic";

/** What a plan is FOR — the server's closed list, in her words. The first is the default. */
export const OBJECTIVE_CHOICES: { value: StudioObjective; label: string }[] = [
  { value: "grow-following", label: "Grow my following" },
  { value: "showcase-product", label: "Show off a product" },
  { value: "announce", label: "Announce something" },
  { value: "recap", label: "Recap a moment" },
  { value: "thank-partner", label: "Thank a partner" },
  { value: "concept", label: "Try out an idea" },
];

/**
 * The server's own bounds (routes/studio.ts POST /studio/agent/plan), mirrored so the screen can say
 * so before she sends. The server refuses past them regardless — these are the convenience.
 */
export const MAX_PROMPT = 2000;
export const MAX_AESTHETIC = 200;
export const MAX_PICKED = 12;
/** server/studio/agent/types.ts `MAX_PLAN_PRODUCTS`. */
export const MAX_PRODUCTS = 5;

/** What she has set on the screen. */
export interface AgentForm {
  prompt: string;
  objective: StudioObjective;
  aesthetic: string;
  /** Photos she picked, in the order she picked them. */
  picked: string[];
  /** Her products, in the order she picked them — the order the plan's product items take them. */
  products: string[];
  /**
   * Her videos. The ones with beats she left on CUT travel to the planner AFTER her photos, in
   * `assetIds` — the same door, the same cap (`MAX_PICKED` is shared). The rest never leave the
   * screen: they are the Board's passthrough (`buildSeed`).
   */
  videos?: PickedVideo[];
}

/**
 * The request body — or the one line that says what is missing.
 *
 * Optional fields travel only when set: an empty aesthetic is no aesthetic, and a body carrying
 * `assetIds: []` would be a different request from one that picked nothing only in its shape.
 */
export function agentRequest(
  form: AgentForm,
): { body: Record<string, unknown> } | { gap: string } {
  const prompt = form.prompt.trim();
  if (!prompt) return { gap: "Say what you want made." };
  if (prompt.length > MAX_PROMPT)
    return { gap: `That's a lot — keep it under ${MAX_PROMPT} characters.` };
  const aesthetic = form.aesthetic.trim();
  if (aesthetic.length > MAX_AESTHETIC)
    return {
      gap: `Keep how it should feel to a line — under ${MAX_AESTHETIC} characters.`,
    };
  const cut = cutVideos(form.videos ?? []).map((v) => v.assetId);
  const assetIds = [...form.picked, ...cut];
  if (assetIds.length > MAX_PICKED)
    return {
      gap: cut.length
        ? `Pick up to ${MAX_PICKED} photos and videos to cut, together.`
        : `Pick up to ${MAX_PICKED} photos.`,
    };
  if (form.products.length > MAX_PRODUCTS)
    return { gap: `Pick up to ${MAX_PRODUCTS} products.` };
  return {
    body: {
      prompt,
      objective: form.objective,
      ...(aesthetic ? { aesthetic } : {}),
      ...(assetIds.length ? { assetIds } : {}),
      ...(form.products.length ? { productAssetIds: form.products } : {}),
    },
  };
}

/**
 * Where a cast row came from, in the words of the plan card's label line — "FILMED BY YOU" on her
 * own upload, "MADE HERE" on a generated one. Empty when the server did not say (an older server,
 * or nothing cast). Provenance on the card is what makes a made-here still animated as her
 * visible as what it is (22 Sep 2026's lookalike).
 */
export const PROVENANCE_WORDS: Record<
  NonNullable<AgentPlanItem["provenance"]>,
  string
> = {
  camera: "FILMED BY YOU",
  "made-here": "MADE HERE",
  synced: "FROM YOUR ACCOUNTS",
  "stitched-here": "STITCHED HERE",
};
/** A synced row off Instagram — the server's "from: her instagram" (PR 4 B2b). */
export const INSTAGRAM_WORDS = "FROM YOUR INSTAGRAM";
export const provenanceWords = (
  item: Pick<AgentPlanItem, "provenance" | "assetId" | "platform">,
): string =>
  !item.assetId || !item.provenance
    ? ""
    : // A reel she posted names the account (PR 4 B2b); any other synced row keeps the generic words.
      item.provenance === "synced" && item.platform === "instagram"
      ? INSTAGRAM_WORDS
      : PROVENANCE_WORDS[item.provenance];

/**
 * The AI-edit chip on a clip card (C3, D1): the tagger's stored edit note, or null when the card
 * shows none. Only a CAST clip row can carry one — the note describes footage, and a photo or a
 * left-out item has none — and an empty or whitespace note is no chip. Nothing is called: the note
 * was written when the clip was read (server/studio/agent/cast.ts `editNoteOf`).
 */
export const editChip = (
  item: Pick<AgentPlanItem, "kind" | "assetId" | "editNote">,
): string | null => {
  if (item.kind !== "clip" || !item.assetId) return null;
  const note = item.editNote?.trim();
  return note ? note : null;
};

/** What the chip is called before it is opened. */
export const EDIT_CHIP_LABEL = "AI EDIT";

/**
 * How long a pushed-in photo is held when the plan seeds it (D2). Longer than a dead still's
 * default (the server's 2 s): a push-in needs room to be seen. Inside the server's 1–8 s bounds
 * (spec.ts MIN_STILL_SEC / MAX_STILL_SEC); she changes it on the Board like any hold.
 */
export const PAN_HOLD_SEC = 4;

/** The plan card's words for an image item's push-in — kept apart from an i2v's "Slight movement". */
export const PAN_LABEL = "SLOW PUSH-IN";

/** The plan card's words for each move a held photo can make (the Board's chips, in capitals). */
export const MOTION_CARD_LABEL: Record<
  NonNullable<AgentPlanItem["motion"]>,
  string
> = {
  dolly: PAN_LABEL,
  zoom: "ZOOM IN",
  sweep: "PAN ACROSS",
  punch: "PUNCH-IN",
};

/**
 * The capability-library entries in her words (server/studio/agent/capabilityEntries.ts ids). An id
 * this list does not know is shown as it is — the server only sends ids its library holds.
 */
export const ENTRY_WORDS: Readonly<Record<string, string>> = {
  "clip.camera": "your camera clip",
  "clip.her_instagram": "your Instagram clip",
  "clip.made_here": "a clip made here",
  "image.held": "a held photo",
  "image.motion.dolly": "a slow push-in",
  "image.motion.zoom": "a zoom in",
  "image.motion.sweep": "a pan across",
  "image.motion.punch": "a punch-in",
  i2v: "your photo brought to life",
  broll: "a scene made from words",
  product: "your product",
  "music.track": "a licensed track",
  "music.bed": "a music bed",
  look: "a look",
};

/** The "why" line on a plan card: why it fits, what it is, and what it beat — or null (PR 6, 6a2). */
export function reasonWords(
  reason: AgentReason | null | undefined,
): string | null {
  if (!reason) return null;
  const what = ENTRY_WORDS[reason.entry] ?? reason.entry;
  const over = reason.over
    ? `, over ${ENTRY_WORDS[reason.over] ?? reason.over}`
    : "";
  // The model ends its line with a stop more often than not; one stop, at the very end.
  const fits = reason.fits.replace(/[.\s]+$/, "");
  return fits
    ? `${fits} — ${what}${over}.`
    : `${what[0].toUpperCase()}${what.slice(1)}${over}.`;
}

/** What each planned kind is called on her screen — the Board's own words where it has them. */
export const KIND_LABEL: Record<AgentItemKind, string> = {
  i2v: "Slight movement",
  broll: "B-roll",
  image: "Held photo",
  product: "Your product",
  clip: "Your clip",
};

/**
 * The Board rows a plan becomes — THE ONE MAPPING (see the header).
 *
 *   i2v      → a `motion` row, `hasPerson: true`
 *   broll    → a `broll` row, `hasPerson: false`
 *   product  → a `product` row, `hasPerson: false` — its own kind since 22 Sep 2026 (found on device:
 *              seeded as "B-roll" with a photo attached, a contradiction once b-roll meant words).
 *              The same request it always made — role `object`, seedance image-to-video — under
 *              its own name on the Board.
 *              ⚠️ UNLESS THE TAGGER SAYS SHE IS IN IT (`athletePresent === true` — her hand round the
 *              bottle): then it is an identity frame, and arrives as `motion` with `hasPerson: true`.
 *              As b-roll it would go to seedance, which refuses real people 6 of 6. Only `true`
 *              moves it: an untagged product stays b-roll, as every product did before.
 *
 * ⚠️ `hasPerson` HERE IS EVIDENCE, NOT A GUESS. The Board defaults it false because its tray tags
 * nothing. These rows were cast by the server only because their vision tag said she IS (i2v) or is
 * NOT (b-roll) in them — so `true` on an i2v row is a fact, and it greys B-roll on that row, which is
 * exactly the refusal seedance would otherwise give 6 times of 6.
 *
 * Sound the planner recommended arrives ON (`audio: true`) — the Board's own field, in its quote key
 * and priced by the server: double on a shot of her, free on b-roll. She turns it off on the Board.
 * Only `true` travels, exactly as the Board sends it, so a silent item seeds the row it always did.
 *
 * B-ROLL IS MADE FROM WORDS (21 Sep 2026): the server casts no photo for it and it is not left out —
 * it arrives as `{ assetId: null, thumbUrl: null }`, and becomes a photo-less b-roll row, the one the
 * Board's "Add a shot without a photo" already makes. Its direction is the row's sentence, and the
 * Board makes it text-to-video.
 *
 * An item that could not be made — left out, with a line — is NOT a row: it stays on the Agent screen
 * as its line, and the Board gets only what can be made.
 *
 * A HELD PHOTO (C1b): an `image` item becomes a `still` row — the photo the caster cast, held for
 * `stillSec`, the server's default hold (`/studio/stitch/options` `defaultStillSec`, which the
 * screen already reads for `maxClips`). $0: no request, no quote, no admission — the Board and the
 * estimate skip it and price only the shots. Its direction is not a prompt (nothing is directed),
 * so it does not ride the row; its beat and line stay on the Agent screen. With `stillSec` null —
 * the options not read yet — it is NOT a row: the Board cannot hold a still without a hold, and
 * the screen waits for the options before seeding rather than inventing a number.
 *
 * HER OWN CLIP (C2 Half B): a `clip` item becomes a `clip` row — the clip the caster cast, cut to
 * the beat the planner named (`trim`) or whole, its sound kept when the planner said so. $0 like a
 * held photo: no request, no quote, no admission. It needs no hold from the options, so it seeds at
 * once.
 *
 * THE PLANNER'S SLOTS (C2 Half B): the server maps the item's capability asks onto Board slots
 * (`shot`); only the slots this row may carry are kept — a photo row takes movement only, a
 * photo-less b-roll row all four — so the row can never hold a slot the server would refuse.
 * A HELD row goes through the same path (PR 15.1, R-3): it keeps nothing, and with the composer on
 * every slot the planner set is named on it as `nothing-filmed` instead of vanishing.
 *
 * Keys are `agent:<nonce>:<index>` — unique per plan, stable for its life, never the asset id (one
 * photograph may appear twice on a board).
 */
export function seedRowsFrom(
  items: AgentPlanItem[],
  nonce: string,
  /** The server's default hold for a held photo, or null while the options have not been read. */
  stillSec: number | null,
  /** The composer (PR 15): six slots on a photo-less row, and a dropped slot named on the row. */
  composer = false,
): StoryboardRow[] {
  // Every row carries its reason in her words (PR 6, 6d) — display only, behind the row's WHY chip.
  return items.flatMap((item, i): StoryboardRow[] => {
    const why = reasonWords(item.reason);
    return rowsOf(item, i, nonce, stillSec, composer).map((r) =>
      why ? { ...r, why } : r,
    );
  });
}

/**
 * The planner's direction on a HELD row, as data (PR 14, R-5). A held photo or clip used to drop it here —
 * the row's `prompt` is "" because nothing is generated — and the stitch (PR 15) had nothing to read.
 * ⚠️ MUTATION (agentLogic.test): return the row alone — "direction dropped on an image row" reds by name.
 */
const withDirection = (
  row: StoryboardRow,
  item: Pick<AgentPlanItem, "direction">,
): StoryboardRow =>
  item.direction.trim() ? { ...row, direction: item.direction.trim() } : row;

/** One plan item's rows — THE ONE MAPPING, per item (see seedRowsFrom). */
function rowsOf(
  item: AgentPlanItem,
  i: number,
  nonce: string,
  stillSec: number | null,
  composer: boolean,
): StoryboardRow[] {
  // Left out — the screen shows its line; the Board never sees it.
  if (item.uncast) return [];
  if (item.kind === "clip") {
    if (!item.assetId) return [];
    // Through the slot path like every row (PR 15.1, R-3): a held clip films nothing, so it keeps no
    // slot — and with the composer on, each one the planner set is recorded as `nothing-filmed`.
    // ⚠️ MUTATION (agentLogic.test): return the row without `withPlannedShot` — "a held row drops a
    // capability with no reason" reds by name.
    return [
      withPlannedShot(
        withDirection(
          heldClipRow(
            `agent:${nonce}:${i}`,
            item.assetId,
            item.thumbUrl,
            item.trim ?? null,
            item.durationSeconds ?? null,
            item.sound,
            item.videoUrl ?? null,
          ),
          item,
        ),
        item.shot,
        composer,
      ),
    ];
  }
  if (item.kind === "image") {
    if (!item.assetId || stillSec === null) return [];
    // A pushed-in photo holds longer than a dead still — a 2 s push-in reads as a flinch.
    // PAN_HOLD_SEC sits inside the server's 1–8 s bounds; she changes it on the Board.
    // Any move — a push-in, or one heading for a point — holds as long as the push-in does.
    const motion = item.motion ?? null;
    const row = withDirection(
      heldPhotoRow(
        `agent:${nonce}:${i}`,
        item.assetId,
        item.thumbUrl,
        motion ? PAN_HOLD_SEC : stillSec,
        motion,
      ),
      item,
    );
    // The point it heads for, only beside a move that takes one (the server refuses it elsewhere).
    // Then the slot path, as a held clip takes it (PR 15.1, R-3).
    return [
      withPlannedShot(
        item.focus && takesFocus(motion)
          ? { ...row, stillFocus: item.focus }
          : row,
        item.shot,
        composer,
      ),
    ];
  }
  if (!item.assetId) {
    // Made from words. Only b-roll can be — anything else without a photo has nothing to move.
    if (item.kind !== "broll") return [];
    return [
      withPlannedShot(
        {
          key: `agent:${nonce}:${i}`,
          assetId: null,
          thumbUrl: null,
          prompt: item.direction,
          kind: "broll",
          hasPerson: false,
          ...(item.sound ? { audio: true as const } : {}),
        },
        item.shot,
        composer,
      ),
    ];
  }
  const person =
    item.kind === "i2v" ||
    (item.kind === "product" && item.athletePresent === true);
  return [
    withPlannedShot(
      {
        key: `agent:${nonce}:${i}`,
        assetId: item.assetId,
        thumbUrl: item.thumbUrl,
        prompt: item.direction,
        kind: person ? "motion" : "product",
        hasPerson: person,
        ...(item.sound ? { audio: true as const } : {}),
      },
      item.shot,
      composer,
    ),
  ];
}

/**
 * The row with the planner's slots — only those it may carry; none when none survive. With the
 * composer on (PR 15, R-2) what does NOT survive is written on the row by name with its reason
 * (`droppedSlots`), never dropped in silence. ⚠️ MUTATION (agentLogic.test): skip the dropped list —
 * "a photo row silently drops framing" reds by name.
 */
function withPlannedShot(
  row: StoryboardRow,
  shot: AgentPlanItem["shot"],
  composer = false,
): StoryboardRow {
  if (!shot) return row;
  const allowed = slotsAllowed(row, composer) as string[];
  const set = Object.entries(shot).filter(([, v]) => v !== undefined);
  const kept = Object.fromEntries(
    set.filter(([slot]) => allowed.includes(slot)),
  ) as NonNullable<StoryboardRow["shot"]>;
  const dropped: DroppedSlot[] = composer
    ? set.flatMap(([slot, v]) => {
        if (allowed.includes(slot)) return [];
        const reason = droppedSlotReason(row, slot as DroppedSlot["slot"]);
        return reason
          ? [{ slot: slot as DroppedSlot["slot"], value: String(v), reason }]
          : [];
      })
    : [];
  if (!Object.keys(kept).length && !dropped.length) return row;
  return {
    ...row,
    ...(Object.keys(kept).length ? { shot: kept } : {}),
    ...(dropped.length ? { droppedSlots: dropped } : {}),
  };
}

/**
 * The line she reads when the plan left some of her products out — or null when every one is in.
 *
 * The planner decides how many product items a plan has, and may use fewer than she picked. The
 * plan she approves must say so rather than let a product vanish between her pick and the Board.
 */
export function productsLeftOut(
  products: string[],
  items: AgentPlanItem[],
): string | null {
  const used = new Set(
    items.filter((i) => i.kind === "product").map((i) => i.assetId),
  );
  const out = products.filter((id) => !used.has(id)).length;
  if (out === 0) return null;
  if (out < products.length)
    return `${out} of the ${products.length} products you picked ${out === 1 ? "isn't" : "aren't"} in this plan.`;
  return `This plan doesn't show ${products.length === 1 ? "your product" : "any of your products"} — plan it again, or say in your words that it should.`;
}

/**
 * The line she reads when the plan left out photos she picked — or null when every one is in.
 *
 * The planner names which photo each item is made from, and uses her picks where they fit; one it
 * did not use is named here rather than vanishing between her pick and the Board.
 *
 * ─── A PICK WITHOUT HER GETS ITS OWN SENTENCE, AND AN ACTION ───────────────────────────────────
 *
 * Since b-roll went to words, a photo she is not in (a soccer ball, a bottle) can be NO shot of its
 * own: i2v needs her in the frame, and only the products tray is ever a product. So a left-out pick
 * like that was not overlooked — it cannot be placed — and "the plan didn't find a place for it"
 * would send her looking for a reason that does not exist. `withoutHer` is the server's list of those
 * picks (POST /studio/agent/plan `picksWithoutHer`); they get the true reason and the one thing she
 * can do about it. Any other left-out pick keeps the sentence it always had.
 */
export function picksLeftOut(
  picked: string[],
  items: AgentPlanItem[],
  withoutHer: readonly string[] = [],
): string | null {
  const used = new Set(items.map((i) => i.assetId));
  const out = picked.filter((id) => !used.has(id));
  if (out.length === 0) return null;
  const noHer = out.filter((id) => withoutHer.includes(id)).length;
  const other = out.length - noHer;
  const one = noHer === 1;
  const lines: string[] = [];
  if (noHer > 0) {
    lines.push(
      `${noHer} of the photos you picked ${one ? "doesn't" : "don't"} have you in ${one ? "it" : "them"}. ` +
        `B-roll is made from words now, so ${one ? "it" : "they"} can't be a shot of ${one ? "its" : "their"} own — ` +
        `the plan may still borrow from ${one ? "it" : "them"} for a scene. ` +
        `To show ${one ? "it exactly as it is" : "them exactly as they are"}, add ${one ? "it" : "them"} under Your products.`,
    );
  }
  if (other > 0) {
    lines.push(
      `${other} of the ${picked.length} photos or videos you picked ${other === 1 ? "isn't" : "aren't"} in this plan — the plan didn't find a place for ${other === 1 ? "it" : "them"}.`,
    );
  }
  return lines.join(" ");
}

/**
 * Why a plan holding a held photo cannot be seeded YET — or null. The Board needs the hold, and the
 * hold is the server's (`defaultStillSec`); until the options arrive there is no row to seed.
 */
export const holdRefusal = (
  items: readonly Pick<AgentPlanItem, "kind" | "assetId">[],
  stillSec: number | null,
): string | null =>
  stillSec === null && items.some((it) => it.kind === "image" && it.assetId)
    ? "One moment — checking how long a photo can be held."
    : null;

/**
 * Why this plan cannot go on the Board as it stands — or null.
 *
 * A stitch joins at most `maxClips` clips (server/studio/video/materialize.ts, served by
 * /studio/stitch/options — never hardcoded here). A seeded board carries no bridges, so its clips
 * are its rows plus the videos she added. `maxClips` null means the limit has not been read yet, and
 * the Board checks again at its stitch button, where pieces may also have failed.
 */
export function clipCapRefusal(
  rows: number,
  passthrough: number,
  maxClips: number | null,
): string | null {
  if (maxClips === null) return null;
  const total = rows + passthrough;
  return total > maxClips
    ? `A video can join up to ${maxClips} clips — this plan makes ${total}. Remove ${total - maxClips === 1 ? "a video" : `${total - maxClips} videos`} to fit.`
    : null;
}

/**
 * The seed the Board is handed. Only her AS-IS videos are passthrough: a video she left on CUT is
 * already in `rows`, as the clip items the plan made of its beats.
 */
export const buildSeed = (
  nonce: string,
  objective: StudioObjective,
  rows: StoryboardRow[],
  videos: readonly PickedVideo[],
  /** The stored plan the rows came from (PR 6, 6a3), or null when it was not saved. */
  planId: string | null = null,
  /** The plan-level choices and the deal linkage (PR 6, 6d) — see `planSeedExtras`. */
  extras: Pick<BoardSeed, "look" | "music" | "dealLinked"> = {},
): BoardSeed => ({
  nonce,
  objective,
  rows,
  passthrough: asIsVideos(videos),
  planId,
  ...extras,
});

/**
 * A board RE-OPENED from a stored plan (PR 6, 6d): the stored object's items through THE ONE MAPPING,
 * under the seed's own nonce — so the rows are the ones the plan first seeded, key for key — with its
 * look, music and deal linkage. No planner call anywhere on this path.
 */
export const seedFromStoredPlan = (
  seed: Pick<BoardSeed, "nonce" | "objective">,
  answer: AgentPlanAnswer,
  stillSec: number | null,
  /** The composer (PR 15): named dropped slots on the rows, and the stored brief's rhythm on the seed. */
  composer = false,
): BoardSeed =>
  buildSeed(
    seed.nonce,
    seed.objective,
    seedRowsFrom(answer.items, seed.nonce, stillSec, composer),
    [],
    answer.planId ?? null,
    planSeedExtras(
      answer,
      !!answer.dealDeliverableId,
      composer ? (answer.brief ?? null) : null,
    ),
  );

/**
 * THE AGENT DOOR ON A PLANNED BOARD (PR 6, 6d fix). The manual Board's "or let the agent build this for
 * you" used to open a BLANK ask: from a board the brand flow seeded, that dropped the brand objective,
 * the brief, the product and the deal — and the re-plan came back as own-content work, the music guard's
 * forBrand false. Now the door carries the board's stored plan id; the Agent screen opens that plan
 * (GET, no planner) and inherits from it through this one helper:
 *
 *   parentPlanId   the stored plan — the re-plan is its CHILD (version + 1)
 *   campaign       the brief it was planned from; the concept step rebuilds from it
 *   dealDeliverableId, productIds (the plan's product items, in order — "product_1" is the first)
 *   prompt         HER OWN WORDS, from the row (PR 13, 0066); on a row saved before 0066 the brand
 *                  fallback line — the brief is then the only signal; she can type over either
 *   aesthetic      her feel line from the row, or "" when none was stored
 *   objective      the stored purpose; on a pre-0066 row, the brand objective when there is a brief
 *                  (brand work, fail-closed); else unchanged
 *
 * ⚠️ MUTATION (brandPlan.test): drop the campaign or the deal in `inheritedBody` — "brand context
 * dropped at the agent door" reds by name. Force BRAND_BOARD_OBJECTIVE over a stored objective, or
 * the fallback line over stored words — "a regenerate re-plans from the fallback line" reds by name.
 */
export interface InheritedPlan {
  parentPlanId: string;
  prompt: string;
  aesthetic: string;
  objective: StudioObjective | null;
  productIds: string[];
  campaign: Record<string, unknown> | null;
  dealDeliverableId: string | null;
}

export function inheritFromStoredPlan(
  answer: AgentPlanAnswer,
): InheritedPlan | null {
  if (!answer.planId) return null;
  const campaign =
    answer.brief && typeof answer.brief === "object" ? answer.brief : null;
  const brand = campaign?.brand as { name?: unknown } | null | undefined;
  const product = campaign?.product as { line?: unknown } | null | undefined;
  const productIds = [
    ...new Set(
      answer.items.flatMap((i) =>
        i.kind === "product" && i.assetId ? [i.assetId] : [],
      ),
    ),
  ];
  // What the row remembers (PR 13) — null or absent on a pre-0066 row, or from an older server.
  const storedPrompt =
    typeof answer.prompt === "string" && answer.prompt.trim()
      ? answer.prompt
      : null;
  const storedObjective = OBJECTIVE_CHOICES.find(
    (o) => o.value === answer.objective,
  )?.value;
  return {
    parentPlanId: answer.planId,
    prompt:
      storedPrompt ??
      (campaign && typeof brand?.name === "string"
        ? brandFallbackLine(
            brand.name,
            typeof product?.line === "string" ? product.line : "",
          )
        : ""),
    aesthetic: typeof answer.aesthetic === "string" ? answer.aesthetic : "",
    objective: storedObjective ?? (campaign ? BRAND_BOARD_OBJECTIVE : null),
    productIds,
    campaign,
    dealDeliverableId: answer.dealDeliverableId ?? null,
  };
}

/**
 * What an inherited plan adds to the Agent's request: the brief and the deal. If she has since removed
 * every product photo, the brief's photo handle is dropped too (its line stays) — the route refuses a
 * handle naming a photo she did not pick.
 */
export function inheritedBody(
  inh: InheritedPlan | null,
  productCount: number,
): Record<string, unknown> {
  if (!inh) return {};
  let campaign = inh.campaign;
  const product = campaign?.product as
    | { ref?: unknown; line?: unknown }
    | null
    | undefined;
  if (campaign && product && product.ref && productCount < 1)
    campaign = {
      ...campaign,
      product: product.line ? { ...product, ref: null } : null,
    };
  return {
    ...(campaign ? { campaign } : {}),
    ...(inh.dealDeliverableId
      ? { dealDeliverableId: inh.dealDeliverableId }
      : {}),
  };
}

/**
 * What a confirmed brief's hand-off adds to the Agent's request (PR 7, Lane E): the brief as the
 * campaign — its photo handle dropped if she has since removed every product photo, as an inherited
 * plan's is — the brief file, the deal. The visible fields are hers to edit; this rides regardless.
 * ⚠️ MUTATION (brandPlan.test): return {} — "the structured brief rides the plan call whatever she
 * edits on the compose screen" reds by name.
 */
export function briefBody(
  h: {
    campaign: Record<string, unknown>;
    briefFilePath: string | null;
    dealDeliverableId: string | null;
    /** The confirm step's flags (PR 13) — posted as `confirm`, stored on the plan row. */
    confirm?: readonly unknown[];
  } | null,
  productCount: number,
): Record<string, unknown> {
  if (!h) return {};
  let campaign = h.campaign;
  const product = campaign.product as
    | { ref?: unknown; line?: unknown }
    | null
    | undefined;
  if (product && product.ref && productCount < 1)
    campaign = {
      ...campaign,
      product: product.line ? { ...product, ref: null } : null,
    };
  return {
    campaign,
    ...(h.briefFilePath ? { briefFilePath: h.briefFilePath } : {}),
    ...(h.dealDeliverableId ? { dealDeliverableId: h.dealDeliverableId } : {}),
    ...(h.confirm?.length ? { confirm: h.confirm } : {}),
  };
}

/**
 * A REGENERATE GOES THROUGH THE REPLAN ROUTE (PR 13, R-3): the stored plan's child, planned from what
 * the row remembers with her current fields posted over it. A row saved before 0066 remembers no words
 * and no purpose, and the route says so — a 400 naming `prompt` or `objective`, nothing called. THAT
 * refusal, and only that one, falls back to the re-plan the screen made before the route existed: the
 * same body, POSTed to the plan route with `parentPlanId`. Every other refusal is hers to read.
 * ⚠️ MUTATION (brandPlan.test): rethrow the old-row refusal, or fall back on every refusal — "old-row
 * replan dead-ends the client" reds by name.
 */
export const isOldRowReplanRefusal = (e: unknown): boolean =>
  e instanceof Error &&
  (e as { status?: unknown }).status === 400 &&
  ((e as { field?: unknown }).field === "prompt" ||
    (e as { field?: unknown }).field === "objective");

export async function regeneratePlan<T>(
  api: {
    replan: (parentPlanId: string, body: Record<string, unknown>) => Promise<T>;
    plan: (body: Record<string, unknown>) => Promise<T>;
  },
  parentPlanId: string,
  body: Record<string, unknown>,
): Promise<T> {
  try {
    return await api.replan(parentPlanId, body);
  } catch (e) {
    if (!isOldRowReplanRefusal(e)) throw e;
    return api.plan({ ...body, parentPlanId });
  }
}

/**
 * THE BRAND POST'S BOARD (PR 6, 6d): the plan's rows, under a BRAND objective — so every request the
 * Board makes is brand work — with the plan's id, look, music and deal linkage. The music it suggests is
 * decided by the server off the stored plan's brief and deal (PR 10, R-2: studio/music/suggest.ts
 * `brandWorkFor`), the plan id on this seed being what it reads.
 *
 * ⚠️ THE COMPOSER IS READ, NOT INFERRED (PR 15.1, R-2). It was `campaign !== null` — so a brand plan
 * with no proposal brief seeded as if the flag were off. The flag now comes in by name, and it gates
 * the rhythm here too, so a campaign handed in with the flag off can never produce one.
 * ⚠️ MUTATION (brandPlan.test): back to `campaign !== null` — "the composer flag is inferred from
 * campaign rather than read" reds by name.
 */
export const BRAND_BOARD_OBJECTIVE: StudioObjective = "showcase-product";
export const brandBoardSeed = (
  answer: AgentPlanAnswer,
  nonce: string,
  stillSec: number | null,
  dealLinked: boolean,
  /** The composer (PR 15): the confirmed brief she planned from, for its readings' rhythm — null when off. */
  campaign: unknown = null,
  /** STUDIO_COMPOSER, read by the caller (PR 15.1, R-2). */
  composer = false,
): BoardSeed =>
  buildSeed(
    nonce,
    BRAND_BOARD_OBJECTIVE,
    seedRowsFrom(answer.items, nonce, stillSec, composer),
    [],
    answer.planId ?? null,
    planSeedExtras(answer, dealLinked, composer ? campaign : null),
  );

/**
 * What a plan hands the Board besides its rows (PR 6, 6d): its look, its track or bed with On the beat,
 * and whether the board is for a deal. Absent choices stay absent, so the Board's own defaults — and
 * its fail-closed suggestion — stand.
 */
export const planSeedExtras = (
  answer: Pick<AgentPlanAnswer, "look" | "music">,
  dealLinked = false,
  /**
   * The campaign the plan was made from (PR 15, D-2) — the confirmed brief on a fresh plan, the stored
   * plan's `brief` on a re-opened one — read for its reference readings' rhythm (rhythmLogic). Null
   * with the composer off, and the seed carries no rhythm.
   */
  campaign: unknown = null,
): Pick<BoardSeed, "look" | "music" | "dealLinked" | "rhythm"> => {
  const rhythm = campaign === null ? null : rhythmFrom(campaign);
  return {
    ...(answer.look ? { look: answer.look.value } : {}),
    ...(answer.music
      ? { music: { bed: answer.music.name, onBeat: answer.music.onBeat } }
      : {}),
    ...(dealLinked ? { dealLinked: true } : {}),
    ...(rhythm ? { rhythm } : {}),
  };
};
