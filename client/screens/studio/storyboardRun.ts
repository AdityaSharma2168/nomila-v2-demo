/**
 * storyboardRun — the requests a board makes, as pure functions.
 *
 * ─── WHY THIS IS NOT IN THE COMPONENT ───────────────────────────────────────────────────────────
 *
 * Building the request is where a board becomes money: which asset anchors a clip, which one it
 * arrives at, and therefore which model runs and what it costs. That decision is testable only if
 * it does not arrive through react-native — the same reason `storyboardLogic` and `stitchLogic` are
 * pure. The component does the fetching; everything it fetches is decided here.
 *
 * ⚠️ NOTHING HERE SPENDS ON ITS OWN. A preview is a check: it writes a row, quotes a figure, and calls
 * no provider. The one call that spends takes a `previewId` and nothing else — and `runBoardPieces`,
 * which decides the ORDER of spending, is handed that call rather than making it, so the order is
 * testable without a network.
 */
import type {
  GenerationPreview,
  PreviewRequest,
  StudioObjective,
  StudioReference,
} from "../../hooks/use-studio";
import {
  approvalBlock,
  boardGaps,
  boardQuote,
  isHeldRow,
  slotsAllowed,
  STALE_QUOTE_NOTE,
  type BoardLimits,
  type RowQuote,
  type ShotKind,
  type StoryboardRow,
} from "./storyboardLogic";

/**
 * The engine role a shot kind travels as.
 *
 * ⚠️ `shotTypeFor` READS THIS AND NOTHING ELSE. `person` means identity, which is Veo at $0.20/s;
 * anything else is b-roll, which is seedance at roughly a third of that.
 */
const ROLE_FOR: Record<
  Exclude<ShotKind, "still" | "clip">,
  "person" | "object"
> = {
  motion: "person",
  // A product is the object shot — the same role and the same route (seedance i2v) a photo-bearing
  // b-roll row travelled as before b-roll became words. Nothing on the wire changes; only the name.
  product: "object",
  broll: "object",
};

/** The role a row's photo travels under. A still has none: it is never a reference, because it is never a request. */
const roleFor = (row: StoryboardRow): "person" | "object" => {
  if (row.kind === "still" || row.kind === "clip")
    throw new Error("a still or a clip row is never a reference in a request");
  return ROLE_FOR[row.kind];
};

/** The clip a row becomes. */
export function clipRequestFor(
  row: StoryboardRow,
  objective: StudioObjective,
  /** The plan this Board came from, when the carrier is on (PR 14) — rides on every clip. */
  planId: string | null = null,
  /** The composer (PR 15.1, R-1): a photo-less row's composition and action ride too. */
  composer = false,
): PreviewRequest {
  // ⚠️ A STILL IS NEVER A REQUEST. It is held, not made: no preview, no quote, no admission, $0.
  // `boardRequests` never asks for one; a caller that does has a bug, and a thrown invariant is
  // better than a priced request for a photo nobody is animating.
  if (isHeldRow(row))
    throw new Error(
      "a still or a clip row generates nothing and has no request",
    );
  // ⚠️ NO REFERENCES AT ALL ON AN IMAGE-LESS ROW, which is what makes it text-to-video. The chain
  // tolerates an empty array end to end — measured: task video.generate, shotType broll, seedance,
  // 720x1280, no blocker — and it quotes the same as i2v b-roll, because seedance bills
  // `w x h x frames / 1024` and an input image is not a term in that.
  const references: StudioReference[] = row.assetId
    ? [{ assetId: row.assetId, role: roleFor(row) }]
    : [];
  return {
    intent: "video.generate",
    deliverable: "clip",
    objective,
    direction: row.prompt.trim(),
    references,
    ...shotFor(row, composer),
    // Only `true` travels, so a row with sound off sends the same body it always did.
    ...(row.audio ? { audio: true as const } : {}),
    // The plan's id, only when given: a Board without one sends the same body it always did (PR 14).
    // ⚠️ MUTATION (storyboardRun.test): drop it — "a brief do-not absent from the clip request" reds.
    ...(planId ? { planId } : {}),
  };
}

/**
 * The slots a row's clip travels with — or nothing at all.
 *
 * ⚠️ THIS OBJECT IS BUILT FIELD BY FIELD, WHICH IS HOW `kind` DIED HERE. A row field that is not
 * named in this function does not travel, and nothing errors: the clip simply ignores the chip. So
 * `shot` is named, and a test asserts it arrives.
 *
 * Filtered through `slotsAllowed` on the way out. `setShotSlot` already refuses a slot the row
 * cannot take, so this finds nothing in practice — it is the second lock, for a row built by a
 * caller that did not go through the setter. Without it a stale slot becomes a server blocker on a
 * board she cannot see the reason for.
 *
 * A BRIDGE never calls this: `bridgeRequestFor` builds its own request, and a transition refuses
 * every slot — its two frames are the whole instruction.
 *
 * ⚠️ THE COMPOSER FLAG IS PASSED, NEVER DEFAULTED (PR 15.1, R-1). This called `slotsAllowed(row)` for
 * all of PR 15, so the seed set composition and action on a photo-less row and this stripped them on
 * the way out — 15 of 48 capability members never reached a Board prompt, and no test crossed from
 * the seed to the request to see it. ⚠️ MUTATION (storyboardRun.test): drop `composer` here —
 * "slotsAllowed is called without the composer flag" reds by name.
 */
function shotFor(
  row: StoryboardRow,
  composer: boolean,
): Pick<PreviewRequest, "shot"> {
  const allowed = slotsAllowed(row, composer);
  const shot = Object.fromEntries(
    Object.entries(row.shot ?? {}).filter(
      ([slot, v]) => v !== undefined && (allowed as string[]).includes(slot),
    ),
  ) as NonNullable<PreviewRequest["shot"]>;
  return Object.keys(shot).length ? { shot } : {};
}

/**
 * The BRIDGE into a row — a clip that starts at the previous still and arrives at this one.
 *
 * ⚠️ STILL-TO-STILL, NOT CLIP-TO-CLIP, AND THE SEAM IS DELIBERATE. A bridge that began exactly where
 * clip N ENDED would need clip N's last frame, and nothing extracts one: `videoPoster` takes the
 * FIRST frame, and `video/frames.ts` samples a strip for QA. So the bridge starts from still N,
 * which is where clip N BEGAN — and the jump is therefore proportional to how far clip N travelled.
 *
 * Small for a `motion` row, which is the point of that kind. Potentially visible on a `broll` row.
 *
 * ⚠️ IF THAT JUMP IS VISIBLE, LAST-FRAME EXTRACTION IS THE FOLLOW-UP — with evidence behind it
 * rather than a guess, which is why it was deferred rather than built. Whoever picks up the
 * keyframes card will want this note: the extractor is the same piece of work both need.
 *
 * Returns null when there is nothing before this row to come from — position 0 can hold no bridge,
 * the same invariant `normalizeBoard` and `stitchLogic` both enforce.
 */
export function bridgeRequestFor(
  row: StoryboardRow,
  previous: StoryboardRow | undefined,
  objective: StudioObjective,
  planId: string | null = null,
): PreviewRequest | null {
  // ⚠️ A BRIDGE NEEDS SOMEWHERE TO START, and an image-less previous row has no frame to start from.
  // A bridge into this row would then be an ordinary t2v clip wearing a transition's name — the
  // exact mislabelling shotType.ts refused to ship a transition for. No frame, no bridge.
  if (!row.bridgeRequested || !previous?.assetId || !row.assetId) return null;
  // Belt and braces over `bridgeable`: a still or a clip has an asset, and still no bridge ever
  // touches one.
  if (isHeldRow(row) || isHeldRow(previous)) return null;
  return {
    intent: "video.generate",
    deliverable: "clip",
    objective,
    // No direction of her own. The transition template names no destination on purpose — the last
    // frame IS the destination — and a sentence borrowed from either neighbouring shot could
    // disagree with the frame it was handed, which is the failure prompts.ts opens with.
    direction: "",
    // The previous row's kind, not a hardcoded person. Routing-inert here — a last frame forces
    // `transition` whatever the references say — but the brief is the provenance record, and one
    // claiming a photograph of a ball is her likeness is false on the record even unread.
    references: [{ assetId: previous.assetId, role: roleFor(previous) }],
    // ⚠️ THE FIELD THAT MAKES IT A BRIDGE. The server resolves it under her athlete id and freezes
    // the row's path onto the brief, so the run cannot drift from the quote.
    lastFrameAssetId: row.assetId,
    // The plan's constraints bind a bridge too (PR 14); the server renders those alone on it.
    ...(planId ? { planId } : {}),
  };
}

/** Every request a board would make, in the order it would make them, paired with its row key. */
export function boardRequests(
  rows: StoryboardRow[],
  objective: StudioObjective,
  planId: string | null = null,
  /** STUDIO_COMPOSER, read by the caller (PR 15.1, R-2) — the Board and the Agent estimate alike. */
  composer = false,
): { key: string; kind: "bridge" | "clip"; request: PreviewRequest }[] {
  const out: {
    key: string;
    kind: "bridge" | "clip";
    request: PreviewRequest;
  }[] = [];
  rows.forEach((row, i) => {
    // A still or a clip asks for nothing — not a piece, and not a bridge into it. It takes its
    // place in the stitch (boardStitch) straight from the row, and everything downstream of here —
    // the quote, admission, the run — never hears of it. That is what makes it $0.
    if (isHeldRow(row)) return;
    // ⚠️ THE BRIDGE COMES FIRST, because it plays before the clip it arrives at. The order matters
    // for the run rather than the quote: a sequential execution that made the clip first would put
    // the pieces on the timeline out of order if it stopped halfway.
    const bridge = bridgeRequestFor(row, rows[i - 1], objective, planId);
    if (bridge) out.push({ key: row.key, kind: "bridge", request: bridge });
    out.push({
      key: row.key,
      kind: "clip",
      request: clipRequestFor(row, objective, planId, composer),
    });
  });
  return out;
}

/**
 * One piece's quote, from the server's own preview — THE ONE MAPPING.
 *
 * The Board's quote round and the Agent screen's estimate both go through here, so the two numbers
 * she sees are made the same way from the same answer.
 *
 * ⚠️ ONE FIGURE, AND expected === ceiling ON PURPOSE. The server returns a single `amountUsd`, and
 * deriving a second number here would mean a price table on this side — the one thing
 * storyboardLogic refuses to own. A missing cost and an explicit `unpriced` are the same answer, and
 * neither is $0.
 */
export const rowQuoteFrom = (key: string, p: GenerationPreview): RowQuote => ({
  key,
  ceilingUsd: p.cost?.amountUsd ?? 0,
  expectedUsd: p.cost?.amountUsd ?? 0,
  ...(p.unpriced || !p.cost ? { unpriced: true } : {}),
});

/**
 * The board's quote round — one preview per piece, in playing order, each mapped by `rowQuoteFrom` — lifted out of
 * StoryboardTab so the order and the stop are testable. Null when `live` says the board moved on mid-round; an error
 * stops the round, as it always did.
 *
 * PR 19 (ADI-R19-BOARD4): VIDEO OFF IS A SWITCHED-OFF FEATURE, NOT A SHOT PROBLEM. With `videoOff` (client
 * STUDIO_LIBRARY_FIELDS), the first answer that says so (`unavailable`, server/routes/studio.ts `withVideoAvailability`)
 * ends the round with its one sentence for the whole board — no shot is changed, nothing more is asked. Off, every
 * such answer is quoted as before and admission refuses it piece by piece. ⚠️ MUTATION M-videoOff: drop the arm —
 * "video off is one board-level message, and no shot changes" reds by name.
 */
export async function priceBoard(
  requests: readonly {
    key: string;
    kind: "bridge" | "clip";
    request: PreviewRequest;
  }[],
  preview: (request: PreviewRequest) => Promise<GenerationPreview>,
  opts: { videoOff: boolean; live?: () => boolean },
): Promise<
  | { off: string }
  | {
      off: null;
      clips: RowQuote[];
      bridges: RowQuote[];
      previews: Record<string, string>;
    }
  | null
> {
  const clips: RowQuote[] = [];
  const bridges: RowQuote[] = [];
  const previews: Record<string, string> = {};
  for (const r of requests) {
    const p = await preview(r.request);
    if (opts.live && !opts.live()) return null;
    if (opts.videoOff && p.unavailable) return { off: p.unavailable.reason };
    (r.kind === "bridge" ? bridges : clips).push(rowQuoteFrom(r.key, p));
    previews[`${r.key}:${r.kind}`] = p.previewId;
  }
  return { off: null, clips, bridges, previews };
}

/** One piece of a board as the run sees it: which row, which kind, and what she reads for it. */
export interface BoardPiece {
  key: string;
  kind: "bridge" | "clip";
  /** "Shot 2", "Bridge into shot 3" — never the row key, which is an asset id and a timestamp. */
  label: string;
}

/**
 * The two calls a run makes, handed in — so the order between them is testable without a network.
 *
 * `admit` RESOLVES when POST /studio/plan/admit says 200 and REJECTS with the server's own sentence
 * on a refusal. `generate` is POST /studio/generate for one approved preview: the one call that spends.
 */
export interface BoardRunIo {
  admit: (previewIds: string[]) => Promise<unknown>;
  generate: (previewId: string) => Promise<{ jobId: string }>;
  /** Each piece's outcome as it lands: "ok" with its job, or the sentence it failed with. */
  onPiece: (piece: BoardPiece, outcome: "ok" | string, jobId?: string) => void;
}

export type BoardRunResult = { ran: true } | { ran: false; refusal: string };

/**
 * ─── THE RUN: ADMITTED WHOLE, THEN SPENT ONE PIECE AT A TIME ────────────────────────────────────
 *
 * The board used to go straight into its loop: each piece through /studio/generate in turn, catching
 * per piece and carrying on. The caps are PER JOB, so every piece could be under the per-job cap and
 * the board could still cross the day ceiling partway down — she approved one board and was sold a
 * third of it, then a refusal, then more attempts behind it. That is the half-execution
 * POST /studio/plan/admit exists to prevent, and until now the Board never asked it.
 *
 * So the order is:
 *
 *   1. EVERY PIECE MUST HAVE BEEN QUOTED. One without a previewId refuses the whole board. It used to
 *      be SKIPPED — which ran a board that was not the one on her screen, minus a piece, at a price
 *      she was never shown.
 *   2. ADMISSION, ONCE, about all of them together. A refusal stops the board before anything spends,
 *      and her the server's own sentence — it names the ceiling and what is already spent.
 *   3. ONLY THEN the sequential loop, exactly as before. A piece that fails still does not stop the
 *      ones behind it: each is its own approved job, and abandoning the rest would throw away work
 *      already paid for.
 *
 * ⚠️ ADMISSION IS NOT A RESERVATION. Between 2 and the last spend, another tab can take money from the
 * same day; `/studio/generate` still checks every piece against its own caps. This narrows the window
 * from N spends wide to one decision wide. It does not close it.
 */
export async function runBoardPieces(
  pieces: BoardPiece[],
  previews: Record<string, string>,
  io: BoardRunIo,
): Promise<BoardRunResult> {
  if (pieces.length === 0) {
    return { ran: false, refusal: "There's nothing on the board to make yet." };
  }

  // 1. Every piece quoted, or nothing runs.
  const ids = pieces.map((p) => previews[`${p.key}:${p.kind}`]);
  if (ids.some((id) => !id)) {
    return {
      ran: false,
      refusal:
        "Some of this board hasn't been priced yet — give it a moment, then try again.",
    };
  }

  // 2. One admission for the whole board. ⚠️ THE RETURN IS THE POINT: a refused board spends nothing.
  try {
    await io.admit(ids);
  } catch (e) {
    return {
      ran: false,
      refusal:
        e instanceof Error ? e.message : "This board can't run right now.",
    };
  }

  // 3. Spend, one piece at a time, in playing order.
  for (const [i, piece] of pieces.entries()) {
    try {
      const run = await io.generate(ids[i]);
      io.onPiece(piece, "ok", run.jobId);
    } catch (e) {
      io.onPiece(piece, e instanceof Error ? e.message : "didn't run");
    }
  }
  return { ran: true };
}

/**
 * ─── ONE ROW: "REDO THIS SHOT" AND "MAKE JUST THIS ONE" ─────────────────────────────────────────
 *
 * The same machinery as the board, pointed at one row's pieces — its bridge (if it asked for one)
 * and its clip. Two labels, one code path:
 *
 *   1. PRICE, FRESH. A new preview per piece, every time. Never an id from an earlier quote: after a
 *      run that id is consumed (admission refuses it as "already been run"), and a preview can have
 *      been swept. Then admission is asked about just these, as the board's quote round asks about
 *      the board — so the day ceiling says no before she taps, in the server's words.
 *   2. RUN, THROUGH THE BOARD'S OWN ORDER. `runRowPieces` IS `runBoardPieces` on a shorter list:
 *      every piece quoted, one admission for them, then one spend at a time. One clip is still
 *      admitted — there is no bypass because it is one clip.
 *
 * The quote is stamped with the row's signature (`rowPiecesSignature`), and a quote made for another
 * version of the row cannot spend — `approvalBlock`, the board's own rule, applied to one row.
 */

/** One row's pieces out of the board's requests, in the board's order — bridge first, then clip. */
export const rowRequests = <T extends { key: string }>(
  requests: readonly T[],
  key: string,
): T[] => requests.filter((r) => r.key === key);

/**
 * quality-scrappy (ADI-QS-2): a row's requests with the output gate's fix on the ONE piece whose clip failed — the codes
 * `corrective` carries back to the preview door (routes/studio.ts), so the fresh quote she is shown is for the fixed
 * prompt. Nothing is spent here: the row's own button runs that quote on her tap, as any redo. No fix, the requests.
 */
export const withRowFix = <
  T extends { kind: "bridge" | "clip"; request: PreviewRequest },
>(
  requests: readonly T[],
  fix?: { kind: "bridge" | "clip"; corrective: string[] },
): T[] =>
  fix?.corrective.length
    ? requests.map((r) =>
        r.kind === fix.kind
          ? { ...r, request: { ...r.request, corrective: fix.corrective } }
          : r,
      )
    : [...requests];

/**
 * What one row would ASK FOR — its own requests, verbatim. The single-row twin of `boardSignature`:
 * it carries the objective (in every request) and, for a bridge, the row before it (the bridge
 * starts from that row's photo). So editing this row, the row before it, or the objective all change
 * it; editing any other row does not.
 */
export const rowPiecesSignature = (
  requests: readonly { key: string; kind: string; request: PreviewRequest }[],
  key: string,
): string =>
  JSON.stringify(rowRequests(requests, key).map((r) => [r.kind, r.request]));

/** One row's quote — the board's quote shape, for one row, stamped with what it was made for. */
export interface PiecesQuote {
  clips: RowQuote[];
  bridges: RowQuote[];
  /** `${key}:${kind}` → the previewId this quote wrote. What a run spends against. */
  previews: Record<string, string>;
  limits: BoardLimits | null;
  admissionRefusal: string | null;
  /** The `rowPiecesSignature` this quote was made for. */
  quotedFor: string;
}

/** Price one row's pieces fresh, then ask admission about them. Spends nothing. */
export async function quoteRowPieces(
  requests: readonly {
    key: string;
    kind: "bridge" | "clip";
    request: PreviewRequest;
  }[],
  quotedFor: string,
  io: {
    preview: (request: PreviewRequest) => Promise<GenerationPreview>;
    admit: (previewIds: string[]) => Promise<{ maxJobUsd: number }>;
  },
): Promise<PiecesQuote> {
  const clips: RowQuote[] = [];
  const bridges: RowQuote[] = [];
  const previews: Record<string, string> = {};
  for (const r of requests) {
    const p = await io.preview(r.request);
    (r.kind === "bridge" ? bridges : clips).push(rowQuoteFrom(r.key, p));
    previews[`${r.key}:${r.kind}`] = p.previewId;
  }
  let limits: BoardLimits | null = null;
  let admissionRefusal: string | null = null;
  try {
    const admission = await io.admit(
      requests.map((r) => previews[`${r.key}:${r.kind}`]),
    );
    limits = { maxJobUsd: admission.maxJobUsd };
  } catch (e) {
    admissionRefusal =
      e instanceof Error
        ? e.message
        : "Couldn't check this shot against today's limits.";
  }
  return { clips, bridges, previews, limits, admissionRefusal, quotedFor };
}

/** Run one row: THE BOARD'S ORDER, on its pieces — quoted, admitted together, then spent in turn. */
export const runRowPieces = (
  pieces: BoardPiece[],
  previews: Record<string, string>,
  io: BoardRunIo,
): Promise<BoardRunResult> => runBoardPieces(pieces, previews, io);

/** What one row's button says and does. */
export interface RowActionView {
  /** "Redo this shot", "Redo · $0.80", "Make just this one · $0.80", "Pricing…". */
  label: string;
  /** price: a tap quotes it fresh · run: a tap spends against the quote on the button · busy. */
  step: "price" | "run" | "busy";
  disabled: boolean;
  /** Why it cannot run — the board's own sentence for the same state — or null. */
  refusal: string | null;
  /** Its clip was made from an earlier version of this row. */
  stale: boolean;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * One row's action, or null when there is none to offer: while the whole board runs, and while this
 * row's own pieces are still being made (a redo then would pay for a second clip of a shot that has
 * not arrived yet).
 */
export function rowActionView(p: {
  row: StoryboardRow;
  /** The signature its clip was made for — undefined before it has been made. */
  madeFor: string | undefined;
  signature: string;
  run?: {
    busy: "pricing" | "running" | null;
    quote: PiecesQuote | null;
    error: string | null;
  };
  /** The board is running, or another row is — one spend at a time, as the board itself runs. */
  otherBusy: boolean;
  boardRunning: boolean;
  /** One of this row's pieces is still queued or being made. */
  working: boolean;
}): RowActionView | null {
  if (p.boardRunning || p.working) return null;
  // A still has nothing to make and nothing to redo — no button, ever. (`boardGaps` would pass it
  // and `boardQuote` would price it at $0.00, so without this it would offer "Make just this one
  // · $0.00" for a photo nobody animates.)
  if (isHeldRow(p.row)) return null;
  const made = p.madeFor !== undefined;
  const stale = made && p.madeFor !== p.signature;
  const base = made ? "Redo this shot" : "Make just this one";
  const short = made ? "Redo" : "Make just this one";
  const view = (
    v: Omit<RowActionView, "stale" | "refusal"> & { refusal?: string | null },
  ): RowActionView => ({ refusal: null, stale, ...v });

  if (p.run?.busy === "pricing")
    return view({ label: "Pricing…", step: "busy", disabled: true });
  if (p.run?.busy === "running")
    return view({ label: "Starting…", step: "busy", disabled: true });

  // An unfinished row is priced by nobody: a gap is something to fix, not a wall (boardGaps).
  const gaps = boardGaps([p.row]);
  if (gaps.length)
    return view({
      label: base,
      step: "price",
      disabled: true,
      refusal: gaps[0],
    });

  const q = p.run?.quote;
  if (q) {
    const priced = boardQuote(
      [p.row],
      q.clips,
      q.bridges,
      q.limits,
      q.admissionRefusal,
    );
    const block = approvalBlock([], priced.refusal, q.quotedFor, p.signature);
    if (block === null)
      return view({
        label: `${short} · ${usd(priced.ceilingUsd)}`,
        step: "run",
        disabled: p.otherBusy,
      });
    // A quote for another version of this row is not offered at all — a tap prices the row she has.
    if (block === STALE_QUOTE_NOTE)
      return view({ label: base, step: "price", disabled: p.otherBusy });
    return view({
      label: base,
      step: "price",
      disabled: p.otherBusy,
      refusal: block,
    });
  }
  return view({
    label: base,
    step: "price",
    disabled: p.otherBusy,
    refusal: p.run?.error ?? null,
  });
}
