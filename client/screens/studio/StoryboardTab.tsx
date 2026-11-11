/**
 * StoryboardTab — a board of stills, on the way to being clips.
 *
 * ─── WHAT IT IS ─────────────────────────────────────────────────────────────────────────────────
 *
 * She picks photographs, writes a line for each, and says what KIND of shot each one is. Every row
 * becomes one generated clip; the clips land in the pool the Video tab already reads, and the
 * timeline takes over from there.
 *
 * ─── ⚠️  THE ONE BUTTON HERE THAT SPENDS ────────────────────────────────────────────────────────
 *
 * It was dead for a commit, on purpose, until the quote panel had been read on a device — and that
 * hold earned its keep: the panel was showing "$0.00" beside real shots while the refusal underneath
 * said the price was unknown, and B-roll was greyed on every row including a photograph of a ball.
 * Both are fixed; neither was visible to a green test suite.
 *
 * Now it runs. ADMITTED WHOLE FIRST — one POST /studio/plan/admit about every piece, so a board that
 * would cross the day ceiling is refused before its first piece rather than partway down — and then
 * sequentially, one piece at a time, each through the ordinary preview → approval → job path,
 * because a board is N jobs and the caps are PER JOB. A piece that fails once admitted does not stop
 * the ones behind it — each is separately approved, and abandoning the rest would throw away work
 * already paid for. The order lives in `runBoardPieces` (storyboardRun.ts), where it is tested.
 *
 * ⚠️ IT CAN ONLY SPEND AGAINST A previewId IT WAS GIVEN. A piece with no quote refuses the WHOLE
 * board — it used to be skipped, which ran a board that was not the one on her screen, minus a
 * piece, at a price she was never shown.
 *
 * ─── IT OWNS NO ARITHMETIC AND NO TRANSITIONS ──────────────────────────────────────────────────
 *
 * The rules and the money are `storyboardLogic` — pure, testable without a renderer, and holding no
 * price table of its own. Cut / Fade / Bridge already exist per join on the timeline (card 2), so
 * this surface only records which joins she has ASKED to be bridged.
 *
 * DESIGN.md: pills at least 120px; cards at radius `lg`; no blur; Feather icons; reanimated only.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";

import { StudioMediaPicker } from "../../components/studio/StudioMediaPicker";
import { MOUNT_ORIGINS } from "./mediaPickerLogic";
import {
  admitPlan,
  openStoredPlan,
  previewNow,
  useGenerate,
  type AgentPlanAnswer,
  type StudioShotSlot,
  type StudioObjective,
  type StudioShotSpec,
} from "../../hooks/use-studio";
import {
  boardRequests,
  priceBoard,
  quoteRowPieces,
  withRowFix,
  rowActionView,
  rowPiecesSignature,
  rowRequests,
  runBoardPieces,
  runRowPieces,
  type BoardPiece,
  type PiecesQuote,
  type RowActionView,
} from "./storyboardRun";
import { boardStitch, madeAssetId } from "./boardStitch";
import { takesFocus, type StillMotionName } from "./stitchLogic";
import { OBJECTIVE_CHOICES, seedFromStoredPlan } from "./agentLogic";
import { WhyChip } from "../../components/studio/WhyChip";
import {
  useMusicSuggestion,
  useQueueStitch,
  useStitchOptions,
} from "../../hooks/use-studio-stitch";
import { effectiveBed, feelFromRows, type MusicPick } from "./musicLogic";
import { MusicSuggestion } from "../../components/studio/MusicSuggestion";
import { ratioForTarget } from "../../components/studio/playerBox";
import { useRunWatch } from "../../hooks/use-studio-sessions";
import { videoEntryFromJob, type VideoEntryView } from "./videoEntryLogic";
import { VideoEntry } from "../../components/studio/VideoEntry";
import { BoardClipPlayer } from "../../components/studio/BoardClipPlayer";
import { StillFocusPicker } from "../../components/studio/StillFocusPicker";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import {
  approvalBlock,
  BACK_TO_PLAN_NOTE,
  backToPlan,
  boardSignature,
  normalizeBoard,
  seedDecision,
  seededMusic,
  STALE_QUOTE_NOTE,
  boardGaps,
  boardProgress,
  boardQuote,
  boardWorkSignature,
  brollRefusal,
  productRefusal,
  cutAllowed,
  heldPhotoRow,
  isStillRow,
  isClipRow,
  isHeldRow,
  clearClipTrim,
  clipPlays,
  clipRefusal,
  motionRefusal,
  setCut,
  setStillSec,
  setStillMotion,
  setStillFocus,
  stillRefusal,
  MAX_ROWS,
  moveRow,
  removeRow,
  SLOT_LABELS,
  audioNote,
  setAudio,
  setBridge,
  bridgeable,
  setKind,
  setPrompt,
  setShotSlot,
  slotValueLabel,
  seededRhythm,
  shotSlotValues,
  slotsAllowed,
  slotsNote,
  type BoardLimits,
  type BoardQuote,
  type BoardSeed,
  type PassthroughClip,
  type RowQuote,
  type ShotKind,
  type StoryboardRow,
} from "./storyboardLogic";
import {
  STUDIO_BRIEF_CARRIER,
  STUDIO_COMPOSER,
  STUDIO_LIBRARY_FIELDS,
} from "../../lib/flags";

/**
 * What a board is FOR, as the engine's vocabulary.
 *
 * Fixed rather than picked: a board is her own work, not a deliverable owed to a partner. When it
 * needs to be a brand piece, the objective and the brandId travel together and both belong on the
 * request — which is a bigger change than a constant.
 */
const DEFAULT_OBJECTIVE: StudioObjective = "grow-following";

/** How long she stops typing before the board is re-quoted. */
const QUOTE_DEBOUNCE_MS = 600;

/** No stitch asked for yet. */
const NO_STITCH = {
  id: null as string | null,
  view: null as VideoEntryView | null,
  error: null as string | null,
  sending: false,
};

/** What each objective is called on the surface — the Agent screen's own words. */
const objectiveLabel = (o: StudioObjective): string =>
  OBJECTIVE_CHOICES.find((c) => c.value === o)?.label ?? o;

/** No quotes, no previews and no ceiling — the board before anything has been asked. */
const EMPTY_QUOTES = {
  clips: [] as RowQuote[],
  bridges: [] as RowQuote[],
  previews: {} as Record<string, string>,
  error: null as string | null,
  limits: null as BoardLimits | null,
  admissionRefusal: null as string | null,
  /** The `rowSignature` these quotes were made for — null before anything has been quoted. */
  quotedFor: null as string | null,
};

/** The holds offered on a still — the Video tab's chips, trimmed to the server's bounds plus what is set now. */
const HOLD_CHOICES = [1, 2, 3, 5, 8];

/**
 * How a held photo can move — the server's motions (studio/video/stillMotion.ts), in her words. "dolly"
 * on the wire is D2's slow push-in ("pan" until PR 6); "sweep" is the pan across a wide shot.
 */
const MOTION_CHOICES: readonly (readonly [StillMotionName | null, string])[] = [
  [null, "Still"],
  ["dolly", "Push-in"],
  ["zoom", "Zoom in"],
  ["sweep", "Pan"],
  ["punch", "Punch"],
];
/** The server's looks (studio/video/still.ts STILL_LOOKS), in her words; null is "as they are". */
const LOOK_CHOICES: readonly (readonly [string | null, string])[] = [
  [null, "As they are"],
  ["natural", "Natural"],
  ["warm", "Warm"],
  ["cool", "Cool"],
  ["teal-orange", "Teal & orange"],
  ["muted", "Muted"],
  ["mono", "Black & white"],
];
const MOTION_HEAD: Record<StillMotionName, string> = {
  dolly: "SLOW PUSH-IN",
  zoom: "ZOOM",
  sweep: "PAN",
  punch: "PUNCH-IN",
};
const MOTION_HINT: Record<StillMotionName | "none", string> = {
  none: "Shown exactly as it is. Nothing is made, so it costs nothing.",
  dolly:
    "A slow push-in over the photo — still your photo, nothing is made, so it costs nothing.",
  zoom: "Closes in over the hold — on the upper middle, or where you tap. Still your photo; it costs nothing.",
  sweep:
    "Pans across the photo toward the side that matters. Still your photo — it costs nothing.",
  punch:
    "A snap zoom in the first fifth of a second, then it holds. Still your photo — it costs nothing.",
};
const holdChoices = (
  current: number | undefined,
  limits: { minStillSec: number; maxStillSec: number } | null,
): number[] =>
  [
    ...new Set([
      ...(limits
        ? HOLD_CHOICES.filter(
            (s) => s >= limits.minStillSec && s <= limits.maxStillSec,
          )
        : HOLD_CHOICES),
      ...(current !== undefined ? [current] : []),
    ]),
  ].sort((a, b) => a - b);

const KINDS: { value: ShotKind; label: string; hint: string }[] = [
  { value: "motion", label: "Slight movement", hint: "You, moving a little" },
  {
    value: "product",
    label: "Your product",
    hint: "This photo brought to life — a product or an object, nobody in it",
  },
  {
    value: "broll",
    label: "B-roll",
    hint: "A scene with nobody in it, made from your words — no photo",
  },
];

const money = (n: number) => `$${n.toFixed(2)}`;

export function StoryboardTab({
  onOpenDetail,
  onOpenAgent,
  seed,
  onSeedHandled,
  onFineTune,
  onBackToPlan,
}: {
  onOpenDetail?: (assetId: string) => void;
  /**
   * Pop back to the Agent screen underneath, its plan as she left it. Passed only when the screen
   * directly beneath is the Agent's; drawn only on a board seeded here (storyboardLogic `backToPlan`).
   */
  onBackToPlan?: () => void;
  /** The Agent's door. Absent — and nothing drawn — unless the build has the client flag on. */
  /** The Agent's door — with the stored plan this board came from, when it came from one (PR 6, 6d). */
  onOpenAgent?: (from: { fromPlanId: string | null }) => void;
  /** A board the Agent screen handed over, in route params. Applied once, by its nonce. */
  seed?: BoardSeed | null;
  /** Called once a seed has been taken off the route, so it is never applied twice. */
  onSeedHandled?: () => void;
  /**
   * Open the stitched video on the Video tab's timeline — with, when the composer is on (PR 15, R-5),
   * the Board's own words and purpose, so the caption editor there can suggest a line from them.
   */
  onFineTune?: (
    assetId: string,
    captions?: { feel: string[]; objective: string },
  ) => void;
}) {
  const [rows, setRows] = useState<StoryboardRow[]>([]);
  /**
   * What a tap on a photo adds: a SHOT of it (animated, priced) or the photo HELD as it is ($0).
   * A mode rather than two strips — the picker is one tile, and the choice is about what she wants
   * the photo to do, not where it comes from.
   */
  const [pickMode, setPickMode] = useState<"shot" | "hold">("shot");
  /**
   * What the board is FOR. Fixed for a board she builds by hand; a seeded board carries the one she
   * chose on the Agent screen. It is in every request, and so in the quote key (`boardSignature`).
   */
  const [objective, setObjective] =
    useState<StudioObjective>(DEFAULT_OBJECTIVE);
  /** Her own videos from an Agent plan — joined at the END when she stitches, never quoted. */
  const [passthrough, setPassthrough] = useState<PassthroughClip[]>([]);
  /**
   * The music under the Board's stitch — a curated bed by name, or none — and whether the edit is
   * cut on its beat (A2). Board-local, like the rows: it travels only in the stitch body.
   */
  /** One look over every photo in the stitch (A3) — a name from LOOK_CHOICES, or null for as-is. */
  const [look, setLook] = useState<string | null>(null);
  // `touched` (PR 8): until she taps a Music chip the server's suggested track is preselected;
  // after it, her pick stands and the suggestion never re-asserts (musicLogic).
  const [music, setMusic] = useState<MusicPick>({
    bed: null,
    onBeat: true,
    touched: false,
  });
  /**
   * The reference reading's rhythm the seed carried (PR 15, D-2; rhythmLogic), or null — one input to
   * the composer's join rule, after her Cut, the beat type and the music's beat. Board-local, like the
   * music; it travels only into the stitch body's joins.
   */
  const [rhythm, setRhythm] = useState<
    import("./rhythmLogic").RhythmReading | null
  >(null);
  /**
   * The stored plan this board was seeded from (PR 6, 6d), or null for a hand-built one — what the
   * agent door hands on, so a brand board's brief, deal, product and objective survive a re-plan.
   */
  const [boardPlanId, setBoardPlanId] = useState<string | null>(null);
  // An emptied board is a fresh one: nothing carries over from a plan that is no longer on it.
  useEffect(() => {
    if (rows.length === 0) {
      setObjective(DEFAULT_OBJECTIVE);
      setPassthrough([]);
      setBoardPlanId(null);
    }
  }, [rows.length]);

  const gaps = boardGaps(rows);

  /**
   * ─── THE QUOTE: ONE SERVER PREVIEW PER PIECE ($0) ─────────────────────────────────────────────
   *
   * A preview writes a row, quotes a figure and calls no provider. It is the ONLY honest source of
   * a price — `storyboardLogic` owns no table precisely so this is the only place a number can come
   * from — and `previewId` is what step B later spends against, so quoting and running are the same
   * two-step the rest of the product uses rather than a board-shaped shortcut.
   *
   * ⚠️ RE-QUOTED WHENEVER THE BOARD CHANGES WHAT IT WOULD ASK FOR, and never otherwise. The
   * signature below is the request list, so retyping a prompt re-quotes (her words reach the model
   * and can change nothing about the price, but they DO change the job, and a previewId that
   * authorises a different sentence is the drift bug again) while a pure re-render does not.
   */
  const [quotes, setQuotes] = useState<{
    clips: RowQuote[];
    bridges: RowQuote[];
    previews: Record<string, string>;
    error: string | null;
    /** The ceiling admission returned for THESE previews — null until it has answered. */
    limits: BoardLimits | null;
    /** Admission's own sentence when it said no, or null. */
    admissionRefusal: string | null;
    /**
     * The board these quotes were MADE for, as its `rowSignature`. Compared with the board's
     * signature NOW before anything may spend — see `approvalBlock`.
     */
    quotedFor: string | null;
  }>(EMPTY_QUOTES);

  // What the board would ask for, recomputed each render — a map over at most MAX_ROWS rows, and
  // cheaper than the bookkeeping to memoise it. The ref is what the effect and the run button read,
  // so neither needs it in a dependency array.
  // The plan's id rides on every request when the carrier is on (PR 14) — and in the quote key below.
  const carrierPlanId = STUDIO_BRIEF_CARRIER ? boardPlanId : null;
  // The composer (PR 15.1, R-1): composition and action ride a photo-less row's request.
  const requests = boardRequests(
    rows,
    objective,
    carrierPlanId,
    STUDIO_COMPOSER,
  );
  const requestsRef = useRef(requests);
  requestsRef.current = requests;

  // The fields that change what the board would ASK FOR. A re-render touching none of them must not
  // re-quote; a prompt edit must, because a previewId authorising a different sentence is the same
  // drift the brief field was added to close.
  // In storyboardLogic, where a test can hold it: a field that travels in the request and is
  // missing from this signature means she spends against a stale preview. It was, once. The
  // OBJECTIVE is in every request too, so it is in the key — see `boardSignature`.
  const quoteKey = boardSignature(rows, objective, carrierPlanId);

  useEffect(() => {
    // THE STAMP: the board this round is quoting. Captured now, written with the quotes it produces,
    // so a quote can never be mistaken for one of a board she has since edited.
    const quotedFor = quoteKey;
    // Nothing to price, and nothing to un-price: an empty board is genuinely free.
    if (!requestsRef.current.length || gaps.length > 0) {
      setQuotes({ ...EMPTY_QUOTES, quotedFor });
      return;
    }
    let live = true;
    // ⚠️ DEBOUNCED, AND NOT AS A NICETY. `rowSignature` includes her prompt, so without this every
    // keystroke fires one preview PER PIECE — a board of eight is eight writes and eight quotes per
    // character. Free in money and indefensible in load.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // One preview per piece, in order (storyboardRun `priceBoard`). The one mapping from a preview to a quote —
          // shared with the Agent screen's estimate. (The probes' audio-arm over-quote came from a STUDIO_PRICE_JSON
          // override in the probe, not production pricing, so there is no honest second figure and the panel shows
          // one.) PR 19 (ADI-R19-BOARD4, STUDIO_LIBRARY_FIELDS): video off is one board-level line; no shot changes.
          const priced = await priceBoard(requestsRef.current, previewNow, {
            videoOff: STUDIO_LIBRARY_FIELDS,
            live: () => live,
          });
          if (!priced || !live) return;
          if (priced.off !== null) {
            setQuotes({ ...EMPTY_QUOTES, quotedFor, error: priced.off });
            return;
          }
          const { clips, bridges, previews } = priced;

          // ─── THE CEILING, FROM THE SERVER — ASKED ABOUT THE BOARD JUST QUOTED ──────────────────
          //
          // Admission is a read: it consumes nothing and spends nothing. Asked here it does two jobs
          // the placeholder could not: it hands back the REAL `maxJobUsd` the panel measures the
          // board against, and it says no — in the server's words — to a board the day ceiling
          // would stop, before she taps anything. The run asks again at tap time (runBoardPieces),
          // because a quote-time yes is not a reservation.
          let limits: BoardLimits | null = null;
          let admissionRefusal: string | null = null;
          try {
            const admission = await admitPlan(
              requestsRef.current.map((r) => previews[`${r.key}:${r.kind}`]),
            );
            limits = { maxJobUsd: admission.maxJobUsd };
          } catch (e) {
            admissionRefusal =
              e instanceof Error
                ? e.message
                : "Couldn't check this board against today's limits.";
          }
          if (live)
            setQuotes({
              clips,
              bridges,
              previews,
              error: null,
              limits,
              admissionRefusal,
              quotedFor,
            });
        } catch (e) {
          if (live)
            setQuotes({
              ...EMPTY_QUOTES,
              quotedFor,
              error:
                e instanceof Error ? e.message : "Couldn't price this board.",
            });
        }
      })();
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [quoteKey, gaps.length]);

  const quote: BoardQuote = boardQuote(
    rows,
    quotes.clips,
    quotes.bridges,
    quotes.limits,
    quotes.admissionRefusal,
  );
  // A board with no rows is priced and genuinely free; one with rows and no quotes is not free, it
  // is unknown. The panel must tell those apart — see `BoardQuote.priced`.
  const showMoney = quote.priced && rows.length > 0;

  // ⚠️ THE QUOTE MUST BE FOR THIS BOARD. Between an edit and the re-quote landing, the stored
  // previewIds authorise the board she HAD; the button stays dead through that window. See
  // `approvalBlock`.
  const block = approvalBlock(gaps, quote.refusal, quotes.quotedFor, quoteKey);

  /**
   * ─── STEP B: THE RUN. THE ONE THING HERE THAT SPENDS. ────────────────────────────────────────
   *
   * Sequential, deliberately. A board is N jobs and the caps are per job, so firing them together
   * would race the rolling day total and let a board slip past a ceiling that each piece
   * individually respects. Sequential also means the pieces arrive on the timeline in playing
   * order, and `boardRequests` emits a bridge before the clip it arrives at for the same reason.
   *
   * ⚠️ A FAILED PIECE DOES NOT EAT THE ONES BEHIND IT. Each is its own approved job; one refusal is
   * that piece's, and the rest still run. Stopping the whole board on the first error would throw
   * away work she has already paid for.
   */
  const gen = useGenerate();
  const [runState, setRunState] = useState<{
    running: boolean;
    done: Record<string, "ok" | string>;
    /** Why the whole board was stopped before anything spent — admission's sentence, or null. */
    refusal: string | null;
  }>({ running: false, done: {}, refusal: null });

  /**
   * ─── #3 + #4: WHERE EACH PIECE HAS GOT TO, AND THE CLIP WHEN IT ARRIVES ──────────────────────
   *
   * A video generate does not run inline: `/studio/generate` opens a job, answers `queued`, and the
   * runner works it on its own tick. So the board keeps the jobId per piece and watches it — the
   * SAME machinery the Video tab uses (`useRunWatch` + `videoEntryFromJob`), which is why neither
   * gains a renderer here. She made these clips on this surface; they arrive on it.
   *
   * ⚠️ WATCHING DRIVES NO EXECUTION. `GET /studio/jobs/:jobId` is reconnect-and-refresh; the runner
   * advances the queue on its own. Polling cannot start, resume or re-bill a job.
   */
  /**
   * ─── ONE ROW AT A TIME: "REDO THIS SHOT" / "MAKE JUST THIS ONE" ───────────────────────────────
   *
   * `rowRuns` is each row's own price-then-run state (storyboardRun `rowActionView` decides the
   * button). `madeFor` is the `rowPiecesSignature` each row's clip was MADE for — written when a run
   * that included the row actually ran — so an edit after a run marks that row's clip stale and arms
   * its redo, rather than leaving an old clip that looks current.
   */
  const [rowRuns, setRowRuns] = useState<
    Record<
      string,
      {
        busy: "pricing" | "running" | null;
        quote: PiecesQuote | null;
        error: string | null;
      }
    >
  >({});
  const [madeFor, setMadeFor] = useState<Record<string, string>>({});
  const rowBusy = Object.values(rowRuns).some((r) => r.busy !== null);
  const canApprove = block === null && !rowBusy;

  const [jobs, setJobs] = useState<{ key: string; jobId: string }[]>([]);
  const [views, setViews] = useState<Record<string, VideoEntryView>>({});

  const watches = useMemo(
    () =>
      jobs.map((j) => ({ key: j.key, jobId: j.jobId, kind: "video" as const })),
    [jobs],
  );
  const putView = useCallback(
    (key: string, view: VideoEntryView) =>
      setViews((v) => ({ ...v, [key]: view })),
    [],
  );
  useRunWatch(
    watches,
    (key, outcome, read) =>
      putView(key, videoEntryFromJob(read ?? "error", outcome)),
    (key, _phase, read) => putView(key, videoEntryFromJob(read, "continue")),
  );

  // Declared after the watch, because it reads what the watch writes.
  const progress = boardProgress(Object.values(views).map((v) => v.phase));

  /**
   * The ORDER — every piece quoted, one admission for the whole board, then the sequential loop — is
   * `runBoardPieces` (storyboardRun.ts), pure and tested there. This only turns its events into
   * state. Until it existed the board went straight into the loop and never asked admission at all,
   * so a board could cross the day ceiling partway down, a third of it bought.
   */
  // Every piece the board asks for, in playing order, with what she reads for it — the run spends
  // them and the stitch joins them, in this one order.
  const pieces = requests.map((r) => {
    // ⚠️ A DISPLAY LABEL, BUILT HERE. The row key is `${assetId}:${Date.now()}` — internally fine,
    // and on screen it rendered as a uuid and a millisecond timestamp. What she needs is which
    // shot, and whether it is the shot or the bridge into it.
    const shot = rows.findIndex((row) => row.key === r.key) + 1;
    return {
      key: r.key,
      kind: r.kind,
      label: r.kind === "bridge" ? `Bridge into shot ${shot}` : `Shot ${shot}`,
    };
  });

  /** One piece's outcome, as it lands — the board's run and a single row's run write it the same way. */
  const onPiece = (
    piece: BoardPiece,
    outcome: "ok" | string,
    jobId?: string,
  ) => {
    setRunState((st) => ({
      ...st,
      done: { ...st.done, [piece.label]: outcome },
    }));
    if (!jobId) return;
    // A clip is QUEUED, not made — the runner works it on its own tick. Watch it from here so she
    // never has to paste a job id or go looking in MediaDetail for something she made here. A redo's
    // job REPLACES the piece's old one (`runRow` drops it first), so the new clip is the one shown.
    const watchKey = `${piece.key}:${piece.kind}`;
    setJobs((js) =>
      js.some((j) => j.jobId === jobId)
        ? js
        : [...js, { key: watchKey, jobId }],
    );
    putView(watchKey, videoEntryFromJob("error", "continue"));
  };

  /** Every row's signature NOW — what a run that includes the row makes its clip FOR. */
  const signatureOf = (key: string) => rowPiecesSignature(requests, key);

  const runBoard = async () => {
    if (!canApprove || runState.running) return;
    const madeAs = Object.fromEntries(
      rows.map((r) => [r.key, signatureOf(r.key)]),
    );
    setRunState({ running: true, done: {}, refusal: null });
    setStitch(NO_STITCH);
    const result = await runBoardPieces(pieces, quotes.previews, {
      admit: admitPlan,
      generate: (previewId) => gen.mutateAsync({ previewId }),
      onPiece,
    });
    if (result.ran) {
      setMadeFor(madeAs);
      setRowRuns({});
    }
    setRunState((st) => ({
      ...st,
      running: false,
      refusal: result.ran ? null : result.refusal,
    }));
  };

  /**
   * One row, priced FRESH — a new preview per piece, never the board's old ids (after a run they are
   * consumed) — and then asked about by admission, as the board's quote is. Spends nothing.
   */
  const priceRow = async (
    key: string,
    /** quality-scrappy (ADI-QS-2): the gate's fix for the piece it failed — a re-quote WITH it, from the notice. */
    fix?: { kind: "bridge" | "clip"; corrective: string[] },
  ) => {
    const signature = signatureOf(key);
    setRowRuns((rr) => ({
      ...rr,
      [key]: { busy: "pricing", quote: null, error: null },
    }));
    try {
      const quote = await quoteRowPieces(
        withRowFix(rowRequests(requestsRef.current, key), fix),
        signature,
        {
          preview: (request) => previewNow(request),
          admit: admitPlan,
        },
      );
      setRowRuns((rr) => ({
        ...rr,
        [key]: { busy: null, quote, error: null },
      }));
    } catch (e) {
      setRowRuns((rr) => ({
        ...rr,
        [key]: {
          busy: null,
          quote: null,
          error: e instanceof Error ? e.message : "Couldn't price this shot.",
        },
      }));
    }
  };

  /**
   * One row, run through the BOARD'S order (`runRowPieces` is `runBoardPieces`): its quoted pieces,
   * admitted together, then spent in turn. Only against the quote on its button, and only while that
   * quote is for the row on screen — `rowActionView` offers `run` for nothing else, and this checks
   * again at the tap rather than trusting the render it came from.
   */
  const runRow = async (key: string) => {
    const quote = rowRuns[key]?.quote;
    const row = rows.find((r) => r.key === key);
    if (!quote || !row || runState.running || rowBusy) return;
    const view = rowActionView({
      row,
      madeFor: madeFor[key],
      signature: signatureOf(key),
      run: rowRuns[key],
      otherBusy: false,
      boardRunning: false,
      working: false,
    });
    if (view?.step !== "run") return;

    setRowRuns((rr) => ({
      ...rr,
      [key]: { busy: "running", quote, error: null },
    }));
    // Its old result is the one being replaced: stop watching it and take it off the row, and any
    // stitch of the board is no longer of this board.
    setJobs((js) => js.filter((j) => !j.key.startsWith(`${key}:`)));
    setViews((v) =>
      Object.fromEntries(
        Object.entries(v).filter(([k]) => !k.startsWith(`${key}:`)),
      ),
    );
    setStitch(NO_STITCH);
    const result = await runRowPieces(
      pieces.filter((p) => p.key === key),
      quote.previews,
      {
        admit: admitPlan,
        generate: (previewId) => gen.mutateAsync({ previewId }),
        onPiece,
      },
    );
    if (result.ran) setMadeFor((m) => ({ ...m, [key]: quote.quotedFor }));
    setRowRuns((rr) => ({
      ...rr,
      [key]: {
        busy: null,
        quote: null,
        error: result.ran ? null : result.refusal,
      },
    }));
  };

  /** Each row's button — storyboardRun `rowActionView`, where it is tested. */
  const actionFor = (row: StoryboardRow): RowActionView | null =>
    rowActionView({
      row,
      madeFor: madeFor[row.key],
      signature: signatureOf(row.key),
      run: rowRuns[row.key],
      otherBusy:
        runState.running || (rowBusy && rowRuns[row.key]?.busy == null),
      boardRunning: runState.running,
      working:
        views[`${row.key}:clip`]?.working === true ||
        views[`${row.key}:bridge`]?.working === true,
    });

  /**
   * ─── A PLAN FROM THE AGENT ─────────────────────────────────────────────────────────────────────
   *
   * Taken off the route ONCE, by nonce, and held here as pending — so a re-render, or coming back to
   * this tab, never applies the same plan twice. What happens to it is `seedDecision`: applied to an
   * empty board, asked about over her work, and held while a run is in progress (replacing a board
   * mid-run would strand the pieces it is still spending on).
   */
  const handledSeeds = useRef<Set<string>>(new Set());
  /** The board a seed made, as its signature — null until a seed has been applied here. */
  const [seededAs, setSeededAs] = useState<string | null>(null);
  const [confirmBack, setConfirmBack] = useState(false);
  const [pendingSeed, setPendingSeed] = useState<BoardSeed | null>(null);
  /**
   * A STORED PLAN, RE-OPENED (PR 6, 6d): a seed with a plan id and no rows is opened from the server —
   * the stored object, no planner — and becomes a seed once the default hold is known (below), so its
   * held photos seed exactly as they did the first time.
   */
  const [reopened, setReopened] = useState<{
    seed: BoardSeed;
    answer: AgentPlanAnswer;
  } | null>(null);
  const [reopenError, setReopenError] = useState<string | null>(null);
  useEffect(() => {
    if (!seed || handledSeeds.current.has(seed.nonce)) return;
    handledSeeds.current.add(seed.nonce);
    onSeedHandled?.();
    if (seed.rows.length === 0 && seed.planId) {
      setReopenError(null);
      openStoredPlan(seed.planId).then(
        (answer) => setReopened({ seed, answer }),
        (e) =>
          setReopenError(
            e instanceof Error ? e.message : "Couldn't open that plan.",
          ),
      );
      return;
    }
    setPendingSeed(seed);
    // Re-running is harmless by construction: a seed already handled returns at the first line, so
    // a new `onSeedHandled` identity on every render changes nothing.
  }, [seed, onSeedHandled]);

  const seedAction = pendingSeed
    ? seedDecision(rows.length, runState.running || rowBusy)
    : null;

  // ── "‹ Back to the plan" — storyboardLogic `backToPlan` decides; a pop ends this board ─────────
  // ⚠️ THE WORK KEY, NOT THE QUOTE KEY. A still's hold and a Cut beside it are edits she would mind
  // losing, and neither re-quotes the board — so `boardWorkSignature`, which holds both, is what
  // "as the plan left it" is measured against. (storyboardLogic explains why the two keys stay two.)
  const back = backToPlan({
    available: !!onBackToPlan && seededAs !== null,
    running: runState.running || rowBusy,
    holdsWork:
      boardWorkSignature(rows, objective) !== seededAs || jobs.length > 0,
  });

  const applySeed = useCallback((s: BoardSeed) => {
    // A new board: its rows, its objective, her videos — and nothing of the last board's run.
    setRows(normalizeBoard(s.rows));
    setObjective(s.objective);
    setPassthrough(s.passthrough);
    // The plan's look and music (PR 6, 6d) — or the Board's defaults, never the last board's pick.
    setLook(s.look ?? null);
    setMusic(seededMusic(s));
    setRhythm(seededRhythm(s));
    setBoardPlanId(s.planId ?? null);
    setJobs([]);
    setViews({});
    setRowRuns({});
    setMadeFor({});
    setRunState({ running: false, done: {}, refusal: null });
    setStitch(NO_STITCH);
    setPendingSeed(null);
    // What "as the plan left it" means for Back to the plan: this board, before any edit.
    setSeededAs(boardWorkSignature(normalizeBoard(s.rows), s.objective));
    setConfirmBack(false);
  }, []);

  useEffect(() => {
    if (pendingSeed && seedAction === "apply") applySeed(pendingSeed);
  }, [pendingSeed, seedAction, applySeed]);

  /**
   * ─── THE STITCH: WHAT WAS MADE, JOINED, ONCE THE RUN HAS SETTLED ─────────────────────────────
   *
   * Built from the Board's OWN pieces and views — never the Video tab's list — in playing order,
   * with her videos at the end. `boardStitch` decides the joins (the promised crossfades) and what
   * she is told before tapping; stitching spends nothing.
   */
  const [stitch, setStitch] = useState(NO_STITCH);
  const queueStitch = useQueueStitch();
  // ⚠️ "ANYTHING TO STITCH", NOT "A CLIP WAS MADE". A still is a piece that always exists, so a
  // board of only stills can stitch with no run at all, and a mixed board stitches once its run has
  // settled and something — a clip, or a still — is there to join.
  const stillCount = rows.filter(isStillRow).length;
  // A clip of hers is a piece that always exists too (C2 Half B).
  const heldCount = rows.filter(isHeldRow).length;
  const canStitch =
    (progress.settled || pieces.length === 0) &&
    (progress.hasClips || heldCount > 0);
  // Read while there is anything to stitch, and while a still is on the board or about to be: the
  // hold chips clamp to the server's bounds and a new still takes the server's default hold.
  const stitchOptions = useStitchOptions(
    canStitch || stillCount > 0 || pickMode === "hold",
  );
  const stitchLimits =
    stitchOptions.data && stitchOptions.data !== "unavailable"
      ? stitchOptions.data.limits
      : null;
  const maxClips = stitchLimits?.maxClips ?? null;
  // A re-opened plan becomes a seed once the default hold is known (see `reopened`).
  useEffect(() => {
    if (!reopened || !stitchLimits) return;
    setPendingSeed(
      seedFromStoredPlan(
        reopened.seed,
        reopened.answer,
        stitchLimits.defaultStillSec,
        STUDIO_COMPOSER,
      ),
    );
    setReopened(null);
  }, [reopened, stitchLimits]);
  const bedChoices =
    stitchOptions.data && stitchOptions.data !== "unavailable"
      ? stitchOptions.data.beds
      : [];
  const musicReady =
    stitchOptions.data && stitchOptions.data !== "unavailable"
      ? stitchOptions.data.ready
      : false;
  // The Suggested track (PR 8): read from her row sentences, decided brand-or-not by the server — off the
  // stored plan's brief and deal when this board came from one (PR 10, R-2), the chip only otherwise.
  const suggestion = useMusicSuggestion(
    feelFromRows(rows),
    objective,
    musicReady && bedChoices.length > 0,
    boardPlanId,
  );
  const suggested = musicReady ? (suggestion.data ?? null) : null;
  const bedName = effectiveBed(
    music,
    suggested?.name ?? null,
    bedChoices.map((b) => b.name),
    musicReady,
  );
  const chosenBed = bedName
    ? (bedChoices.find((b) => b.name === bedName) ?? null)
    : null;
  const stitchPlan = canStitch
    ? boardStitch(
        rows,
        pieces,
        views,
        passthrough,
        maxClips,
        chosenBed && musicReady
          ? {
              bed: chosenBed.name,
              grid: chosenBed.beat ?? null,
              onBeat: music.onBeat,
            }
          : null,
        stitchLimits,
        look,
        // The composer (PR 15, R-1): joins by rule, with reasons. Null keeps today's joins exactly.
        // The plan id rides the record so the server can join a dropped slot to its item (PR 15.1).
        STUDIO_COMPOSER ? { rhythm, planId: boardPlanId } : null,
      )
    : null;

  const stitchWatches = useMemo(
    () =>
      stitch.id && stitch.view?.working !== false
        ? [{ key: stitch.id, jobId: stitch.id, kind: "stitch" as const }]
        : [],
    [stitch.id, stitch.view],
  );
  useRunWatch(
    stitchWatches,
    (_key, outcome, read) =>
      setStitch((st) => ({
        ...st,
        view: videoEntryFromJob(read ?? "error", outcome),
      })),
    (_key, _phase, read) =>
      setStitch((st) => ({ ...st, view: videoEntryFromJob(read, "continue") })),
  );
  /** The stitched video, once it is ready — what "Fine-tune in Video" opens. */
  const stitchedId = madeAssetId(stitch.view);

  const onStitch = async () => {
    if (!stitchPlan?.body || stitch.sending) return;
    setStitch({ ...NO_STITCH, sending: true });
    try {
      const out = await queueStitch.mutateAsync(stitchPlan.body);
      // THE DEV LOG (PR 15, D-4): every join's reason and every slot a row dropped, once per stitch,
      // behind the flag and only in development. A convenience since PR 15.1, not the mechanism: the
      // same record rides the body (`composer`) and is stored on the stitch's spec.
      if (__DEV__ && STUDIO_COMPOSER)
        console.log(
          "[composer] stitch",
          JSON.stringify({
            stitchId: out.stitchId,
            onBeat: music.onBeat,
            bed: bedName,
            rhythm,
            joins: stitchPlan.joins,
            droppedSlots: rows.flatMap((r) =>
              r.droppedSlots ? [{ row: r.key, dropped: r.droppedSlots }] : [],
            ),
          }),
        );
      setStitch({
        id: out.stitchId,
        // Working until the first tick says otherwise — nothing has been learned yet.
        view: videoEntryFromJob("error", "continue"),
        error: null,
        sending: false,
      });
    } catch (e) {
      setStitch({
        ...NO_STITCH,
        error: e instanceof Error ? e.message : "Couldn't start the stitch.",
      });
    }
  };

  /**
   * A shot with no photograph — text-to-video. Locked to b-roll, because "slight movement" is a beat
   * performed BY a subject in a frame she supplied and there is no frame.
   */
  const addTextShot = () =>
    setRows((l) =>
      l.length >= MAX_ROWS
        ? l
        : [
            ...l,
            {
              key: `text:${Date.now()}`,
              assetId: null,
              thumbUrl: null,
              prompt: "",
              kind: "broll" as ShotKind,
              hasPerson: false,
            },
          ],
    );

  const addPhotoShot = (assetId: string, thumbUrl: string | null) =>
    setRows((l) =>
      l.length >= MAX_ROWS
        ? l
        : [
            ...l,
            {
              key: `${assetId}:${Date.now()}`,
              assetId,
              thumbUrl,
              prompt: "",
              // The safe default. `motion` is allowed on every still; `broll` is not, and defaulting
              // to a kind that half her library cannot hold would mean rows arriving already refused.
              kind: "motion" as ShotKind,
              // ─── ⚠️  FALSE MEANS "NOT KNOWN TO CARRY HER", NOT "KNOWN TO BE EMPTY" ────────────
              //
              // This defaulted TRUE, on the argument that assuming she is in her own photograph is
              // the safe direction. On a device that argument collapsed: the tray tags nothing, so
              // EVERY row got the guard, B-roll was greyed on all of them including a photograph of
              // a football, and the picker she asked for could not be used at all.
              //
              // A feature that cannot be reached is worse than a refusal that can. Picking B-roll is
              // HER assertion that nobody is in the shot — she is the one who can see it — and a
              // mis-picked row costs $0: seedance refuses at submit, which bills nothing. So the
              // guard now fires on EVIDENCE rather than on the absence of it, and today there is no
              // evidence, so it stays quiet. The mechanism is correct for the day the tray tags.
              hasPerson: false,
            },
          ],
    );

  /**
   * The photo HELD, as it is — a still row (C1b). $0: no request, no quote, no admission. It takes
   * the server's default hold; until the options have arrived there is no default to take, so the
   * tap waits for them (the strip says so) rather than inventing a number.
   */
  const addHeldPhoto = (assetId: string, thumbUrl: string | null) => {
    if (!stitchLimits) return;
    const hold = stitchLimits.defaultStillSec;
    setRows((l) =>
      l.length >= MAX_ROWS
        ? l
        : [
            ...l,
            heldPhotoRow(`${assetId}:${Date.now()}`, assetId, thumbUrl, hold),
          ],
    );
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.head}>
        {back !== "hidden" ? (
          <Pressable
            style={styles.backLink}
            onPress={() =>
              back === "go" ? onBackToPlan?.() : setConfirmBack(true)
            }
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back to the plan"
          >
            <Feather
              name="chevron-left"
              size={14}
              color={Colors.light.primary}
            />
            <Text style={styles.backLinkTxt}>Back to the plan</Text>
          </Pressable>
        ) : null}
        {back === "confirm" && confirmBack ? (
          <View style={styles.banner}>
            <Text style={styles.bannerTxt}>{BACK_TO_PLAN_NOTE}</Text>
            <View style={styles.bannerActions}>
              <Pressable
                style={[styles.bannerBtn, styles.bannerBtnOn]}
                onPress={() => {
                  setConfirmBack(false);
                  onBackToPlan?.();
                }}
                accessibilityRole="button"
                accessibilityLabel="Go back to the plan"
              >
                <Text style={[styles.bannerBtnTxt, styles.bannerBtnTxtOn]}>
                  Go back
                </Text>
              </Pressable>
              <Pressable
                style={styles.bannerBtn}
                onPress={() => setConfirmBack(false)}
                accessibilityRole="button"
                accessibilityLabel="Stay on this board"
              >
                <Text style={styles.bannerBtnTxt}>Stay</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <Text style={styles.title}>Storyboard</Text>
        <Text style={styles.sub}>
          Photos in order, a line for each, and we make the motion between them.
        </Text>
        {objective !== DEFAULT_OBJECTIVE ? (
          <Text style={styles.objectiveTxt}>
            {`Planned for: ${objectiveLabel(objective)}`}
          </Text>
        ) : null}
      </View>

      {/* ─── A PLAN FROM THE AGENT, WAITING FOR HER ANSWER ──────────────────────────────────────
          Inline, never a native alert: on web an alert cannot offer two buttons. */}
      {pendingSeed && seedAction === "wait" ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTxt}>
            {
              "The agent's plan is ready. It can go on the board once this run finishes."
            }
          </Text>
          <View style={styles.bannerActions}>
            <Pressable
              style={styles.bannerBtn}
              onPress={() => setPendingSeed(null)}
              accessibilityRole="button"
              accessibilityLabel="Dismiss the agent's plan"
            >
              <Text style={styles.bannerBtnTxt}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {reopenError ? (
        // A stored plan that could not be opened (PR 6, 6d) — said, never silently an empty board.
        <View style={styles.banner}>
          <Text style={styles.bannerTxt}>{reopenError}</Text>
        </View>
      ) : null}
      {pendingSeed && seedAction === "ask" ? (
        <View style={styles.banner}>
          <Text style={styles.bannerTxt}>
            {`Put the agent's plan here? It replaces the ${rows.length} ${rows.length === 1 ? "shot" : "shots"} on your board.`}
          </Text>
          <View style={styles.bannerActions}>
            <Pressable
              style={[styles.bannerBtn, styles.bannerBtnOn]}
              onPress={() => applySeed(pendingSeed)}
              accessibilityRole="button"
              accessibilityLabel="Replace my board with the agent's plan"
            >
              <Text style={[styles.bannerBtnTxt, styles.bannerBtnTxtOn]}>
                Replace
              </Text>
            </Pressable>
            <Pressable
              style={styles.bannerBtn}
              onPress={() => setPendingSeed(null)}
              accessibilityRole="button"
              accessibilityLabel="Keep my board"
            >
              <Text style={styles.bannerBtnTxt}>Keep mine</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="film" size={18} color={Colors.light.textMuted} />
          <Text style={styles.emptyTitle}>Start with a photo.</Text>
          <Text style={styles.emptyBody}>
            Each one becomes a few seconds of video. Pick them in the order you
            want them to play.
          </Text>
        </View>
      ) : (
        rows.map((row, i) => (
          <BoardRow
            key={row.key}
            row={row}
            index={i}
            onPrompt={(t) => setRows((l) => setPrompt(l, i, t))}
            onKind={(k) => setRows((l) => setKind(l, i, k))}
            onSlot={(slot, value) =>
              setRows((l) => setShotSlot(l, i, slot, value, STUDIO_COMPOSER))
            }
            onAudio={() => setRows((l) => setAudio(l, i, !row.audio))}
            onBridge={() =>
              setRows((l) => setBridge(l, i, !row.bridgeRequested))
            }
            canBridge={bridgeable(rows, i)}
            canCut={cutAllowed(rows, i)}
            onCut={() => setRows((l) => setCut(l, i, !row.cutIn))}
            holdLimits={stitchLimits}
            onHold={(sec) => {
              if (stitchLimits)
                setRows((l) => setStillSec(l, i, sec, stitchLimits));
            }}
            onMotion={(motion) => setRows((l) => setStillMotion(l, i, motion))}
            onFocus={(focus) => setRows((l) => setStillFocus(l, i, focus))}
            beat={stitchPlan?.beat[row.key] ?? null}
            onWholeClip={() => setRows((l) => clearClipTrim(l, i))}
            onUp={() => setRows((l) => moveRow(l, i, i - 1))}
            onDown={() => setRows((l) => moveRow(l, i, i + 1))}
            onRemove={() => setRows((l) => removeRow(l, i))}
            last={i === rows.length - 1}
            clipView={views[`${row.key}:clip`] ?? null}
            bridgeView={views[`${row.key}:bridge`] ?? null}
            onOpenDetail={onOpenDetail}
            action={actionFor(row)}
            onAction={(step) =>
              step === "run" ? void runRow(row.key) : void priceRow(row.key)
            }
            onTryAgain={(kind, corrective) =>
              void priceRow(row.key, { kind, corrective })
            }
          />
        ))
      )}

      <Pressable
        style={styles.addText}
        onPress={addTextShot}
        accessibilityRole="button"
        accessibilityLabel="Add a shot with no photo, described in words"
      >
        <Feather name="type" size={14} color={Colors.light.primary} />
        <Text style={styles.addTextTxt}>
          Add a shot without a photo — just describe it
        </Text>
      </Pressable>

      {passthrough.length > 0 ? (
        <View style={styles.videos}>
          <Text style={styles.libLabel}>
            YOUR VIDEOS — JOINED AT THE END WHEN YOU STITCH
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.lib}>
              {passthrough.map((v) => (
                <View key={v.assetId} style={styles.libTile}>
                  {v.posterUrl ? (
                    <Image
                      source={{ uri: v.posterUrl }}
                      style={styles.libImg}
                    />
                  ) : (
                    <View style={[styles.libImg, styles.libBlank]} />
                  )}
                  <Pressable
                    style={styles.videoRemove}
                    onPress={() =>
                      setPassthrough((l) =>
                        l.filter((x) => x.assetId !== v.assetId),
                      )
                    }
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Leave this video out"
                  >
                    <Feather
                      name="x"
                      size={11}
                      color={Colors.light.buttonText}
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}

      {/* Her uploads and what she made here — the shared picker, in this strip's own tile. Each tap
          adds a row, exactly as before; "View more" searches and pages the rest of her library. */}
      <Text style={styles.libLabel}>YOUR PHOTOS</Text>
      {/* What a tap does with the photo: make a shot of it, or hold it as it is. Two pills shaped
          like the kind pills; the strip beneath is the same either way. */}
      <View style={styles.kinds}>
        {(
          [
            ["shot", "Make a shot of it"],
            ["hold", "Hold it as it is · $0"],
          ] as const
        ).map(([mode, label]) => (
          <Pressable
            key={mode}
            style={[styles.kind, pickMode === mode && styles.kindOn]}
            onPress={() => setPickMode(mode)}
            accessibilityRole="button"
            accessibilityState={{ selected: pickMode === mode }}
            accessibilityLabel={label}
          >
            <Text
              style={[styles.kindTxt, pickMode === mode && styles.kindTxtOn]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {pickMode === "hold" ? (
        <Text style={styles.kindHint}>
          {stitchLimits
            ? `A held photo shows as it is, for ${stitchLimits.defaultStillSec}s to start — change it on the row. Nothing is made, so it costs nothing.`
            : "One moment — checking how long a photo can be held."}
        </Text>
      ) : null}
      <StudioMediaPicker
        kind="photos"
        origins={MOUNT_ORIGINS.board}
        context="board"
        upload="photo"
        label={
          pickMode === "hold"
            ? "Hold this photo on the board"
            : "Add this photo to the board"
        }
        empty="No photos yet — upload one from View more."
        onPick={(r) =>
          (pickMode === "hold" ? addHeldPhoto : addPhotoShot)(
            r.assetId,
            r.kind === "photo" ? r.thumbUrl : null,
          )
        }
        renderTile={(r, t) => {
          const uri = r.kind === "photo" ? r.thumbUrl : r.posterUrl;
          return (
            <Pressable
              onPress={t.onPress}
              style={styles.libTile}
              accessibilityRole="button"
              accessibilityLabel={
                pickMode === "hold"
                  ? "Hold this photo on the board"
                  : "Add this photo to the board"
              }
            >
              {uri ? (
                <Image source={{ uri }} style={styles.libImg} />
              ) : (
                <View style={[styles.libImg, styles.libBlank]} />
              )}
            </Pressable>
          );
        }}
      />

      {/* The Agent's door: below her uploads, above the price — it builds the board above, it does
          not price or spend anything itself. */}
      {onOpenAgent ? (
        <Pressable
          style={styles.agentDoor}
          onPress={() => onOpenAgent({ fromPlanId: boardPlanId })}
          accessibilityRole="button"
          accessibilityLabel="Let the agent build this board for you"
        >
          <Feather name="compass" size={14} color={Colors.light.primary} />
          <Text style={styles.agentDoorTxt}>
            or let the agent build this for you
          </Text>
        </Pressable>
      ) : null}

      {/* ⚠️ HIDDEN ON A BOARD OF ONLY STILLS — there is nothing to price, admit or make, and
          `runBoardPieces` rightly refuses an empty list. Its button is the stitch panel below,
          which such a board shows at once. A mixed board keeps the panel, and admits its
          generating pieces whole, exactly as before. */}
      {rows.length > 0 && pieces.length === 0 ? null : (
        <QuotePanel
          rows={rows}
          gaps={gaps}
          ceilingUsd={quote.ceilingUsd}
          expectedUsd={quote.expectedUsd}
          showMoney={showMoney}
          // The quote's refusal first — it is what disables the button. Then "re-pricing" while the
          // quote is for a board she has since edited (gaps are listed by the panel itself). Then a
          // run that admission stopped, in the server's words.
          refusal={
            quote.refusal ??
            (block === STALE_QUOTE_NOTE ? block : null) ??
            runState.refusal
          }
          canApprove={canApprove}
          running={runState.running}
          done={runState.done}
          quoteError={quotes.error}
          onApprove={runBoard}
          progress={progress}
        />
      )}

      {/* ─── STITCH WHAT WAS MADE — only once the run has settled ────────────────────────────────
          She sees, before tapping, how many clips go in and which pieces are left out. */}
      {stitchPlan ? (
        <View style={styles.quote}>
          <Text style={styles.eyebrow}>ONE VIDEO</Text>
          {stitchPlan.skipped.map((label) => (
            <View key={label} style={styles.gap}>
              <Feather
                name="minus-circle"
                size={11}
                color={Colors.light.textMuted}
              />
              <Text style={styles.gapTxt}>
                {`${label} didn't make it — it's left out.`}
              </Text>
            </View>
          ))}
          {/* ─── MUSIC, AND CUTTING ON ITS BEAT (A2) ────────────────────────────────────────
              A curated bed by name, or none. When the track has a measured grid, "On the beat"
              ends every photo on a beat and makes the joins beside photos cuts — each row then
              says whether it lands on one. $0 like the rest of the stitch. */}
          <View style={styles.slot}>
            <Text style={styles.slotLabel}>Music</Text>
            {suggested ? (
              <MusicSuggestion
                label={suggested.label}
                reason={suggested.reason}
              />
            ) : null}
            <View style={styles.kinds}>
              {[null, ...bedChoices.map((b) => b.name)].map((name) => {
                const on = (chosenBed?.name ?? null) === name;
                const label =
                  name === null
                    ? "None"
                    : (bedChoices.find((b) => b.name === name)?.label ?? name);
                const off = name !== null && !musicReady;
                return (
                  <Pressable
                    key={name ?? "none"}
                    style={[
                      styles.kind,
                      on && styles.kindOn,
                      off && styles.kindOff,
                    ]}
                    onPress={() =>
                      setMusic((m) => ({ ...m, bed: name, touched: true }))
                    }
                    disabled={off}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on, disabled: off }}
                    accessibilityLabel={name === null ? "No music" : label}
                  >
                    <Text
                      style={[
                        styles.kindTxt,
                        on && styles.kindTxtOn,
                        off && styles.kindTxtOff,
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {!musicReady && bedChoices.length > 0 ? (
              <Text style={styles.kindHint}>
                Music isn&apos;t available yet — this one will be put together
                without it.
              </Text>
            ) : chosenBed?.beat ? (
              <>
                <View style={styles.kinds}>
                  {(
                    [
                      [true, "On the beat"],
                      [false, "Your holds"],
                    ] as const
                  ).map(([onBeat, txt]) => {
                    const on = music.onBeat === onBeat;
                    return (
                      <Pressable
                        key={txt}
                        style={[styles.kind, on && styles.kindOn]}
                        onPress={() => setMusic((m) => ({ ...m, onBeat }))}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={txt}
                      >
                        <Text style={[styles.kindTxt, on && styles.kindTxtOn]}>
                          {txt}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.kindHint}>
                  {music.onBeat
                    ? `Every photo ends on a beat (${Math.round(chosenBed.beat.bpm)} BPM), and the joins beside photos are cuts.`
                    : "Each photo is held as you set it, with the joins as the board shows them."}
                </Text>
              </>
            ) : chosenBed ? (
              <Text style={styles.kindHint}>
                Laid under the video. This track has no beat grid yet, so the
                photos keep your holds.
              </Text>
            ) : null}
          </View>
          {stillCount > 0 ? (
            <View style={styles.slot}>
              <Text style={styles.slotLabel}>Look</Text>
              <View style={styles.kinds}>
                {LOOK_CHOICES.map(([name, txt]) => {
                  const on = look === name;
                  return (
                    <Pressable
                      key={txt}
                      style={[styles.kind, on && styles.kindOn]}
                      onPress={() => setLook(name)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`Look: ${txt}`}
                    >
                      <Text style={[styles.kindTxt, on && styles.kindTxtOn]}>
                        {txt}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.kindHint}>
                {look
                  ? "Every photo is balanced and matched first, then given this look — so shots from different phones and days sit together. It costs nothing."
                  : "Each photo exactly as it is."}
              </Text>
            </View>
          ) : null}
          {stitchPlan.refusal ? (
            <View style={styles.refusal}>
              <Feather
                name="alert-circle"
                size={13}
                color={Colors.light.primary}
              />
              <Text style={styles.refusalTxt}>{stitchPlan.refusal}</Text>
            </View>
          ) : null}
          {stitch.error ? (
            <View style={styles.refusal}>
              <Feather
                name="alert-circle"
                size={13}
                color={Colors.light.primary}
              />
              <Text style={styles.refusalTxt}>{stitch.error}</Text>
            </View>
          ) : null}
          <Pressable
            style={[
              styles.cta,
              (!stitchPlan.body || stitch.sending || stitch.view?.working) &&
                styles.ctaOff,
            ]}
            onPress={onStitch}
            disabled={
              !stitchPlan.body || stitch.sending || !!stitch.view?.working
            }
            accessibilityRole="button"
            accessibilityState={{
              disabled:
                !stitchPlan.body || stitch.sending || !!stitch.view?.working,
              busy: stitch.sending,
            }}
            accessibilityLabel={stitchPlan.label}
          >
            {stitch.sending ? (
              <ActivityIndicator size="small" color={Colors.light.textMuted} />
            ) : (
              <Feather
                name="film"
                size={15}
                color={
                  stitchPlan.body
                    ? Colors.light.buttonText
                    : Colors.light.textMuted
                }
              />
            )}
            <Text
              style={[
                styles.ctaTxt,
                stitchPlan.body && !stitch.sending && !stitch.view?.working
                  ? styles.ctaTxtOn
                  : null,
              ]}
            >
              {stitchPlan.label}
            </Text>
          </Pressable>
          <Text style={styles.ctaNote}>
            Joining clips costs nothing. Joins you didn&apos;t bridge crossfade,
            as the board said.
          </Text>
          {stitch.view ? (
            <View style={styles.entry}>
              <VideoEntry
                view={stitch.view}
                caption="Your video"
                onOpenDetail={onOpenDetail}
                muted={false}
                ratio={ratioForTarget("portrait")}
              />
            </View>
          ) : null}
          {onFineTune && stitchedId ? (
            <>
              <Pressable
                style={[styles.cta, styles.ctaGhost]}
                onPress={() =>
                  onFineTune(
                    stitchedId,
                    STUDIO_COMPOSER
                      ? { feel: feelFromRows(rows), objective }
                      : undefined,
                  )
                }
                accessibilityRole="button"
                accessibilityLabel="Fine-tune in Video"
              >
                <Feather
                  name="sliders"
                  size={15}
                  color={Colors.light.primary}
                />
                <Text style={[styles.ctaTxt, styles.ctaGhostTxt]}>
                  Fine-tune in Video
                </Text>
              </Pressable>
              <Text style={styles.ctaNote}>
                Opens it on the Video tab&apos;s timeline. The board isn&apos;t
                kept when you leave it — this video and its clips are saved.
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

function BoardRow({
  row,
  index,
  last,
  onPrompt,
  onKind,
  onSlot,
  onAudio,
  onBridge,
  canBridge,
  canCut,
  onCut,
  holdLimits,
  onHold,
  onMotion,
  onFocus,
  beat,
  onWholeClip,
  onUp,
  onDown,
  onRemove,
  clipView,
  bridgeView,
  onOpenDetail,
  action,
  onAction,
  onTryAgain,
}: {
  row: StoryboardRow;
  index: number;
  last: boolean;
  /** This row's own price-then-run button — null when there is nothing to offer (storyboardRun). */
  action: RowActionView | null;
  onAction: (step: "price" | "run") => void;
  /**
   * quality-scrappy (ADI-QS-2): a clip or bridge the output gate failed — price this row again WITH the fix. Spends
   * nothing: the row's own button runs the new quote on her tap.
   */
  onTryAgain?: (kind: "bridge" | "clip", corrective: string[]) => void;
  /** Where this row's clip has got to, once it has been asked for. Null before that. */
  clipView: VideoEntryView | null;
  bridgeView: VideoEntryView | null;
  onOpenDetail?: (assetId: string) => void;
  onPrompt: (t: string) => void;
  onKind: (k: ShotKind) => void;
  /** A chip tap. The same value again clears it — `setShotSlot` decides, not this row. */
  onSlot: <K extends StudioShotSlot>(
    slot: K,
    value: NonNullable<StudioShotSpec[K]>,
  ) => void;
  /** Sound on or off for this shot. A toggle, like the join — `setAudio` decides, not this row. */
  onAudio: () => void;
  onBridge: () => void;
  /** Whether this join can be a generated bridge — a photo on both sides (storyboardLogic `bridgeable`). */
  canBridge: boolean;
  /** Whether this join is beside a still — then it is Cut or Fade, never a bridge (`cutAllowed`). */
  canCut: boolean;
  onCut: () => void;
  /** The server's hold bounds, for a still's chips — null until the options have arrived. */
  holdLimits: { minStillSec: number; maxStillSec: number } | null;
  onHold: (seconds: number) => void;
  /** How a still moves over its hold (`setStillMotion`, D2 + A1). */
  onMotion: (motion: StillMotionName | null) => void;
  /** Where a zoom, pan or punch heads — her tap, or null for the photo's own point (`setStillFocus`). */
  onFocus: (focus: { x: number; y: number } | null) => void;
  /** How this row sits on the music when the stitch is cut on the beat (boardStitch `beat`), or null. */
  beat: {
    onBeat: boolean;
    holdSec: number | null;
    beats: number | null;
  } | null;
  /** A clip row cut to a beat: use the whole clip instead (`clearClipTrim`). */
  onWholeClip: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  // A clip row's play: bumped on every tap, so the same window plays again (BoardClipPlayer).
  const [playToken, setPlayToken] = useState(0);
  // Two guards now, and each pill shows its own. Neither hides — an option that silently vanishes
  // teaches her nothing about why the product works the way it does.
  const refusalFor: Record<ShotKind, string | null> = {
    broll: brollRefusal(row),
    motion: motionRefusal(row),
    product: productRefusal(row),
    // Never a pill (a still is made, not chosen — `setKind`); listed so this map stays exhaustive.
    still: stillRefusal(row),
    // Never a pill either — one of her clips is placed by a plan, never chosen on a row.
    clip: clipRefusal(row),
  };

  return (
    <View style={styles.card}>
      {/* ⚠️ THE JOIN SITS ABOVE THE ROW IT ARRIVES AT, which is where `bridgeRequested` means it is.
          Row 0 renders none: there is nothing before it to come from. Same rule the timeline has. */}
      {index > 0 && canCut ? (
        /* Beside a held photo the join is Cut or Fade — never a bridge, which is generated from a
           frame to a frame and a still is neither. The same two the Video tab offers beside a still. */
        <Pressable
          style={[styles.join, row.cutIn && styles.joinOn]}
          onPress={onCut}
          accessibilityRole="button"
          accessibilityLabel={
            row.cutIn
              ? "Crossfade into this one instead"
              : "Cut into this one instead of a crossfade"
          }
        >
          <Feather
            name={row.cutIn ? "scissors" : "more-horizontal"}
            size={12}
            color={row.cutIn ? Colors.light.primary : Colors.light.textMuted}
          />
          <Text style={[styles.joinTxt, row.cutIn && styles.joinTxtOn]}>
            {row.cutIn ? "Cut" : "Crossfade · free"}
          </Text>
        </Pressable>
      ) : index > 0 && !canBridge ? (
        /* Beside a shot made from words there is no frame to bridge from or to, so the join is the
           free crossfade and says why it cannot be more — never a pill that asks for a price that
           can never arrive (see storyboardLogic `bridgeable`). */
        <View
          style={styles.join}
          accessibilityRole="text"
          accessibilityLabel="Crossfade, free. A generated bridge needs a photo on both sides."
        >
          <Feather
            name="more-horizontal"
            size={12}
            color={Colors.light.textMuted}
          />
          <Text style={styles.joinTxt}>
            Crossfade · free — a bridge needs a photo on both sides
          </Text>
        </View>
      ) : index > 0 ? (
        <Pressable
          style={[styles.join, row.bridgeRequested && styles.joinOn]}
          onPress={onBridge}
          accessibilityRole="button"
          accessibilityLabel={
            row.bridgeRequested
              ? "Use a plain crossfade into this shot instead"
              : "Make a generated transition into this shot"
          }
        >
          <Feather
            name={row.bridgeRequested ? "git-merge" : "more-horizontal"}
            size={12}
            color={
              row.bridgeRequested
                ? Colors.light.primary
                : Colors.light.textMuted
            }
          />
          <Text
            style={[styles.joinTxt, row.bridgeRequested && styles.joinTxtOn]}
          >
            {row.bridgeRequested ? "Bridge · costs extra" : "Crossfade · free"}
          </Text>
        </Pressable>
      ) : null}

      {/* The bridge's own progress, beside the join it IS rather than inside the shot it joins. */}
      {bridgeView ? (
        <View style={styles.entry}>
          <VideoEntry
            view={bridgeView}
            caption={`Bridge into shot ${index + 1}`}
            onOpenDetail={onOpenDetail}
            gate={{
              onTryAgain: onTryAgain
                ? (corrective) => onTryAgain("bridge", corrective)
                : undefined,
            }}
          />
        </View>
      ) : null}

      {/* ─── A CLIP ROW PLAYS ITS WINDOW (enrichment fixes, 22 Sep 2026) ────────────────────
          Tap the poster: the row's mp4 plays from clipTrim.startSec and pauses at endSec, its
          sound as the row has it. Tap again to play it again. A row seeded before `videoUrl`
          existed keeps a plain poster. */}
      {isClipRow(row) && row.videoUrl && playToken > 0 ? (
        <Pressable
          onPress={() => setPlayToken((t) => t + 1)}
          accessibilityRole="button"
          accessibilityLabel="Play this window again"
        >
          <BoardClipPlayer
            uri={row.videoUrl}
            window={{
              startSec: row.clipTrim?.startSec ?? 0,
              endSec: row.clipTrim?.endSec ?? null,
            }}
            muted={!row.audio}
            token={playToken}
            maxHeight={260}
          />
        </Pressable>
      ) : null}
      <View style={styles.cardBody}>
        {isClipRow(row) && row.videoUrl ? (
          <Pressable
            onPress={() => setPlayToken((t) => t + 1)}
            accessibilityRole="button"
            accessibilityLabel={
              row.clipTrim
                ? `Play ${row.clipTrim.startSec} to ${row.clipTrim.endSec} seconds`
                : "Play this clip"
            }
            style={styles.thumbPlay}
          >
            {row.thumbUrl ? (
              <Image source={{ uri: row.thumbUrl }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]} />
            )}
            <View style={styles.playBadge}>
              <Feather name="play" size={12} color={Colors.light.onHero} />
            </View>
          </Pressable>
        ) : row.thumbUrl ? (
          <Image source={{ uri: row.thumbUrl }} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbEmpty]}>
            <Feather
              name={row.assetId ? "image" : "type"}
              size={16}
              color={Colors.light.textMuted}
            />
          </View>
        )}

        <View style={styles.cardMain}>
          <View style={styles.cardHead}>
            <Text style={styles.idx}>
              {isStillRow(row)
                ? `PHOTO ${index + 1} · HELD ${
                    beat?.holdSec != null && beat.beats != null
                      ? `${beat.holdSec.toFixed(2)}S · ${beat.beats} BEAT${beat.beats === 1 ? "" : "S"}`
                      : `${row.stillSec ?? "—"}S`
                  }${row.stillMotion ? ` · ${MOTION_HEAD[row.stillMotion]}` : ""} · $0`
                : isClipRow(row)
                  ? `YOUR CLIP ${index + 1} · ${
                      row.clipTrim
                        ? `${row.clipTrim.startSec}–${row.clipTrim.endSec}S`
                        : `WHOLE${row.clipSec !== undefined ? ` · ${row.clipSec}S` : ""}`
                    } · $0`
                  : `SHOT ${index + 1}`}
            </Text>
            <View style={styles.rowIcons}>
              <Ico
                label="Move up"
                name="arrow-up"
                onPress={onUp}
                off={index === 0}
              />
              <Ico
                label="Move down"
                name="arrow-down"
                onPress={onDown}
                off={last}
              />
              <Ico
                label={
                  isStillRow(row)
                    ? "Remove this photo"
                    : isClipRow(row)
                      ? "Remove this clip"
                      : "Remove this shot"
                }
                name="x"
                onPress={onRemove}
              />
            </View>
          </View>
          {beat?.onBeat ? (
            <View
              style={styles.onBeat}
              accessibilityLabel="This one starts on the beat"
            >
              <Feather name="music" size={11} color={Colors.light.primary} />
              <Text style={styles.onBeatTxt}>On the beat</Text>
            </View>
          ) : null}

          {isStillRow(row) ? (
            /* ─── A HELD PHOTO: ITS HOLD, AND NOTHING ELSE ─────────────────────────────────────
               No line (nothing happens in it), no kind (it is made, not chosen), no camera and no
               sound (nothing is filmed), no redo (nothing was made — `rowActionView` is null). The
               chips are the Video tab's holds, clamped to the server's bounds by `setStillSec`. */
            <View style={styles.slot}>
              <Text style={styles.slotLabel}>Hold this photo for</Text>
              <View style={styles.kinds}>
                {holdChoices(row.stillSec, holdLimits).map((sec) => {
                  const on = sec === row.stillSec;
                  return (
                    <Pressable
                      key={sec}
                      style={[styles.kind, on && styles.kindOn]}
                      onPress={() => onHold(sec)}
                      disabled={!holdLimits}
                      accessibilityRole="button"
                      accessibilityState={{
                        selected: on,
                        disabled: !holdLimits,
                      }}
                      accessibilityLabel={`Hold for ${sec} seconds`}
                    >
                      <Text style={[styles.kindTxt, on && styles.kindTxtOn]}>
                        {`${sec}s`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.slotLabel}>Movement</Text>
              <View style={styles.kinds}>
                {MOTION_CHOICES.map(([motion, txt]) => {
                  const on = (row.stillMotion ?? null) === motion;
                  return (
                    <Pressable
                      key={txt}
                      style={[styles.kind, on && styles.kindOn]}
                      onPress={() => onMotion(motion)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={txt}
                    >
                      <Text style={[styles.kindTxt, on && styles.kindTxtOn]}>
                        {txt}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.kindHint}>
                {MOTION_HINT[row.stillMotion ?? "none"]}
              </Text>
              {takesFocus(row.stillMotion) && row.thumbUrl ? (
                <StillFocusPicker
                  imageUrl={row.thumbUrl}
                  focus={row.stillFocus ?? null}
                  onFocus={onFocus}
                />
              ) : null}
            </View>
          ) : isClipRow(row) ? (
            /* ─── ONE OF HER CLIPS: ITS WINDOW AND ITS SOUND, NOTHING ELSE (C2 Half B) ────────
               No line, no kind, no camera. The window is the beat the plan cut it to — "Use the
               whole clip" clears it. Sound is the clip's OWN and free: kept when on, muted when off.
               No redo: nothing was made. */
            <View style={styles.slot}>
              <Text style={styles.slotLabel}>
                {row.clipTrim
                  ? `Cut to ${row.clipTrim.startSec}–${row.clipTrim.endSec}s${
                      clipPlays(row) !== null ? ` (${clipPlays(row)}s)` : ""
                    }`
                  : `The whole clip${row.clipSec !== undefined ? ` (${row.clipSec}s)` : ""}`}
              </Text>
              <View style={styles.kinds}>
                {row.clipTrim ? (
                  <Pressable
                    style={styles.kind}
                    onPress={onWholeClip}
                    accessibilityRole="button"
                    accessibilityLabel="Use the whole clip"
                  >
                    <Text style={styles.kindTxt}>Use the whole clip</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={[styles.kind, row.audio && styles.kindOn]}
                  onPress={onAudio}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!row.audio }}
                  accessibilityLabel={
                    row.audio ? "Mute this clip" : "Keep this clip's sound"
                  }
                >
                  <Text style={[styles.kindTxt, row.audio && styles.kindTxtOn]}>
                    {row.audio ? "Its sound: on" : "Its sound: off"}
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.kindHint}>
                Your own footage, placed as it is. Nothing is made, so it costs
                nothing.
              </Text>
            </View>
          ) : (
            <>
              <TextInput
                style={styles.prompt}
                value={row.prompt}
                onChangeText={onPrompt}
                // ONE action per clip is the rule that holds up for these models, and it lives HERE, as
                // copy, not in the template: a template line saying "one action" would contradict any
                // sentence of hers that has two, and nothing server-side reads her sentence for verbs.
                placeholder="One thing that happens in this shot"
                placeholderTextColor={Colors.light.textMuted}
                multiline
              />

              <View style={styles.kinds}>
                {KINDS.map((k) => {
                  // ⚠️ GREYED AND EXPLAINED, NEVER HIDDEN. An option that silently vanishes teaches her
                  // nothing; `brollRefusal` returns the sentence precisely so it can be shown.
                  const blocked = refusalFor[k.value] !== null;
                  const on = row.kind === k.value;
                  return (
                    <Pressable
                      key={k.value}
                      style={[
                        styles.kind,
                        on && styles.kindOn,
                        blocked && styles.kindOff,
                      ]}
                      onPress={() => onKind(k.value)}
                      disabled={blocked}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on, disabled: blocked }}
                      accessibilityLabel={
                        blocked
                          ? `${k.label} — ${refusalFor[k.value]}`
                          : k.label
                      }
                    >
                      <Text
                        style={[
                          styles.kindTxt,
                          on && styles.kindTxtOn,
                          blocked && styles.kindTxtOff,
                        ]}
                      >
                        {k.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.kindHint}>
                {/* The blocked option's reason if there is one, else what the chosen kind means. On an
                image-less row that reads "Slight movement needs a photo to move", which is the
                whole explanation of why only one pill is live. */}
                {/* The chosen kind's meaning first — on a photo row two pills are always blocked
                    now (b-roll on any photo, product or motion by who is in it), so leading with
                    a refusal would explain a pill she did not pick over the one she did. */}
                {KINDS.find((k) => k.value === row.kind)?.hint ??
                  refusalFor.broll ??
                  refusalFor.motion}
              </Text>

              {/* ─── THE SHOT SLOTS — CHIPS, NOT WORDS ──────────────────────────────────────────────
              What she taps here is compiled into the prompt by lookup, server-side, and frozen on
              the brief: the prompt she is quoted is the prompt that runs. Nothing rewrites her
              sentence. Only the slots this row can take are offered (`slotsAllowed` mirrors the
              server's rule); the rest are EXPLAINED in one line rather than shown greyed —
              thirteen dead pills on every photo row would teach her less than the sentence does. */}
              {slotsAllowed(row, STUDIO_COMPOSER).map((slot) => (
                <View key={slot} style={styles.slot}>
                  <Text style={styles.slotLabel}>{SLOT_LABELS[slot]}</Text>
                  <View style={styles.kinds}>
                    {shotSlotValues(slot, STUDIO_COMPOSER).map((value) => {
                      const on = row.shot?.[slot] === value;
                      return (
                        <Pressable
                          key={value}
                          style={[styles.kind, on && styles.kindOn]}
                          onPress={() =>
                            onSlot(
                              slot,
                              value as NonNullable<StudioShotSpec[typeof slot]>,
                            )
                          }
                          accessibilityRole="button"
                          accessibilityState={{ selected: on }}
                          accessibilityLabel={`${SLOT_LABELS[slot]}: ${slotValueLabel(value)}`}
                        >
                          <Text
                            style={[styles.kindTxt, on && styles.kindTxtOn]}
                          >
                            {slotValueLabel(value)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ))}
              {/* ─── SOUND — ONE PILL THAT TOGGLES, NOT A ROW OF VALUES ─────────────────────────────
              The chips above choose BETWEEN values; this is on or off, so it is shaped like the
              join above the row rather than like a slot: the same control turns it back off, and
              `setAudio` deletes the key rather than writing `false`.

              ⚠️ OFFERED ON EVERY ROW, warned about on some. A person row is Veo, whose audio SKU is
              double the silent one; every other row is seedance, where sound is free. So the note
              below fires only where it costs — a warning on a free shot would teach her to ignore
              the warning that isn't. */}
              <View style={styles.slot}>
                <Text style={styles.slotLabel}>Sound</Text>
                <View style={styles.kinds}>
                  <Pressable
                    style={[styles.kind, row.audio && styles.kindOn]}
                    onPress={onAudio}
                    accessibilityRole="button"
                    accessibilityState={{ selected: Boolean(row.audio) }}
                    accessibilityLabel={
                      row.audio
                        ? "Turn sound off for this shot"
                        : "Give this shot sound"
                    }
                  >
                    <Text
                      style={[styles.kindTxt, row.audio && styles.kindTxtOn]}
                    >
                      {row.audio ? "On" : "Off"}
                    </Text>
                  </Pressable>
                </View>
              </View>
              {audioNote(row) ? (
                <Text style={styles.kindHint}>{audioNote(row)}</Text>
              ) : null}
              {slotsNote(row, STUDIO_COMPOSER) ? (
                <Text style={styles.kindHint}>
                  {slotsNote(row, STUDIO_COMPOSER)}
                </Text>
              ) : null}
            </>
          )}

          {/* WHY THE PLAN PUT IT HERE (PR 6, 6d) — every kind of row, only a seeded one has it. */}
          <WhyChip words={row.why} />

          {/* ⚠️ MOUNTED, NOT REIMPLEMENTED. `VideoEntry` already renders a phase, a poster and a
              player from a `VideoEntryView`, and `videoEntryFromJob` already turns a job read into
              one. A board-shaped copy of either would be a second thing to keep correct. */}
          {clipView ? (
            <View style={styles.entry}>
              <VideoEntry
                view={clipView}
                caption={`Shot ${index + 1}`}
                onOpenDetail={onOpenDetail}
                gate={{
                  onTryAgain: onTryAgain
                    ? (corrective) => onTryAgain("clip", corrective)
                    : undefined,
                }}
              />
            </View>
          ) : null}

          {/* One row on its own: price it fresh, then run it through admission like the board. The
              price is on the button before the tap that spends. */}
          {action ? (
            <View style={styles.rowAction}>
              {action.stale ? (
                <Text style={styles.kindHint}>
                  This clip was made from an earlier version of this shot.
                </Text>
              ) : null}
              <Pressable
                style={[
                  styles.rowActionBtn,
                  action.disabled && styles.rowActionOff,
                ]}
                onPress={() => {
                  if (action.step !== "busy") onAction(action.step);
                }}
                disabled={action.disabled || action.step === "busy"}
                accessibilityRole="button"
                accessibilityState={{
                  disabled: action.disabled || action.step === "busy",
                  busy: action.step === "busy",
                }}
                accessibilityLabel={action.label}
              >
                <Feather
                  name={action.step === "run" ? "play" : "refresh-cw"}
                  size={12}
                  color={Colors.light.primary}
                />
                <Text style={styles.rowActionTxt}>{action.label}</Text>
              </Pressable>
              {action.refusal ? (
                <View style={styles.refusal}>
                  <Feather
                    name="alert-circle"
                    size={13}
                    color={Colors.light.primary}
                  />
                  <Text style={styles.refusalTxt}>{action.refusal}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * What the board costs, and why it cannot run.
 *
 * ⚠️ TWO FIGURES, BOTH SHOWN. The ceiling is what may be spent and what every refusal is measured
 * against; the expected figure is what the invoice has actually come back as. Showing only the
 * ceiling reads as a price rise; showing only the expected one is a promise the quote does not make.
 */
function QuotePanel({
  rows,
  gaps,
  ceilingUsd,
  expectedUsd,
  showMoney,
  refusal,
  canApprove,
  running,
  done,
  quoteError,
  onApprove,
  progress,
}: {
  rows: StoryboardRow[];
  gaps: string[];
  ceilingUsd: number;
  expectedUsd: number;
  /** ⚠️ False ⇒ RENDER NO FIGURE. A sum of nothing is 0 and looks exactly like free. */
  showMoney: boolean;
  refusal: string | null;
  canApprove: boolean;
  running: boolean;
  done: Record<string, "ok" | string>;
  quoteError: string | null;
  onApprove: () => void;
  progress: ReturnType<typeof boardProgress>;
}) {
  const bridges = rows.filter((r) => r.bridgeRequested).length;
  const held = rows.filter(isStillRow).length;
  const own = rows.filter(isClipRow).length;
  const shots = rows.length - held - own;
  // Every piece failed, and all with the same words.
  const outcomes = Object.values(done);
  const sharedFailure =
    outcomes.length > 1 &&
    outcomes.every((o) => o !== "ok" && o === outcomes[0])
      ? outcomes[0]
      : null;

  return (
    <View style={styles.quote}>
      <Text style={styles.eyebrow}>WHAT THIS WILL COST</Text>

      <View style={styles.quoteRow}>
        <Text style={styles.quoteLabel}>
          {shots} {shots === 1 ? "shot" : "shots"}
          {bridges ? ` · ${bridges} bridge${bridges === 1 ? "" : "s"}` : ""}
          {held
            ? ` · ${held} ${held === 1 ? "photo" : "photos"} held · $0`
            : ""}
          {own ? ` · ${own} ${own === 1 ? "clip" : "clips"} of yours · $0` : ""}
        </Text>
        <Text style={styles.quoteBig}>
          {showMoney ? money(ceilingUsd) : "—"}
        </Text>
      </View>
      {/* ⚠️ NO FIGURE UNTIL THERE IS ONE. This said "Up to $0.00 — usually about $0.00" beside two
          real shots while the refusal below it said the price was still being worked out. The
          refusal was right and the headline was a lie, and the headline is what she reads first. */}
      <Text style={styles.quoteSub}>
        {!showMoney
          ? "Each shot is priced before anything runs. You only pay for what runs."
          : expectedUsd < ceilingUsd
            ? // Two figures only when they ARE two. The server returns one `amountUsd` today, so
              // "up to X — usually about X" was the same number twice dressed as a range.
              `Up to ${money(ceilingUsd)} — usually about ${money(expectedUsd)}. You only pay for what runs.`
            : "You only pay for what runs."}
      </Text>

      {gaps.map((g) => (
        <View key={g} style={styles.gap}>
          <Feather name="circle" size={11} color={Colors.light.textMuted} />
          <Text style={styles.gapTxt}>{g}</Text>
        </View>
      ))}

      {refusal ? (
        <View style={styles.refusal}>
          <Feather name="alert-circle" size={13} color={Colors.light.primary} />
          <Text style={styles.refusalTxt}>{refusal}</Text>
        </View>
      ) : null}

      {quoteError ? (
        <View style={styles.refusal}>
          <Feather name="alert-circle" size={13} color={Colors.light.primary} />
          <Text style={styles.refusalTxt}>{quoteError}</Text>
        </View>
      ) : null}

      {/* ⚠️ ONE LINE WHEN THE WHOLE BOARD FAILED THE SAME WAY. Every piece hitting the same wall —
          the video flag being off is the obvious one — printed the identical paragraph once per
          shot, which buries the single fact she needs under repetition of it. Per-piece lines are
          for when the pieces genuinely differ. */}
      {sharedFailure ? (
        <View style={styles.refusal}>
          <Feather name="alert-circle" size={13} color={Colors.light.primary} />
          <Text style={styles.refusalTxt}>{sharedFailure}</Text>
        </View>
      ) : (
        Object.entries(done).map(([label, outcome]) => (
          <View key={label} style={styles.gap}>
            <Feather
              name={outcome === "ok" ? "check" : "alert-circle"}
              size={11}
              color={
                outcome === "ok" ? Colors.light.success : Colors.light.primary
              }
            />
            <Text style={styles.gapTxt}>
              {label} — {outcome === "ok" ? "made" : outcome}
            </Text>
          </View>
        ))
      )}

      {/* ⚠️ THE ONE THING ON THIS SCREEN THAT SPENDS. Disabled against the SAME refusal the panel
          shows, so what gates the money is what she was told. */}
      <Pressable
        style={[styles.cta, (!canApprove || running) && styles.ctaOff]}
        onPress={onApprove}
        disabled={!canApprove || running}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canApprove || running, busy: running }}
        accessibilityLabel="Make the board"
      >
        {running ? (
          <ActivityIndicator size="small" color={Colors.light.textMuted} />
        ) : (
          <Feather
            name="zap"
            size={15}
            color={
              canApprove ? Colors.light.buttonText : Colors.light.textMuted
            }
          />
        )}
        <Text
          style={[styles.ctaTxt, canApprove && !running && styles.ctaTxtOn]}
        >
          {running ? "Making it…" : "Make the board"}
        </Text>
      </Pressable>
      {progress.settled ? (
        <View style={styles.handoff}>
          <Text style={styles.handoffTxt}>
            {progress.failed === 0
              ? `${progress.made} ${progress.made === 1 ? "shot" : "shots"} made.`
              : `${progress.made} made, ${progress.failed} didn't.`}
            {progress.hasClips
              ? " They're in your clips — open the Video tab to put them in order and add transitions."
              : ""}
          </Text>
        </View>
      ) : (
        <Text style={styles.ctaNote}>
          {running
            ? "One shot at a time. A shot that fails doesn't stop the rest."
            : "Each shot is its own job, checked before it runs."}
        </Text>
      )}
    </View>
  );
}

function Ico({
  label,
  name,
  onPress,
  off,
}: {
  label: string;
  name: React.ComponentProps<typeof Feather>["name"];
  onPress: () => void;
  off?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off }}
    >
      <Feather
        name={name}
        size={15}
        color={off ? Colors.light.border : Colors.light.textSecondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    alignSelf: "flex-start",
    marginBottom: Spacing.xs,
  },
  backLinkTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    fontWeight: "600",
    color: Colors.light.primary,
  },
  rowAction: { gap: Spacing.xs, marginTop: Spacing.sm },
  rowActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minWidth: 120,
    alignSelf: "flex-start",
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.primary,
  },
  rowActionOff: { opacity: 0.5 },
  rowActionTxt: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12.5,
    fontWeight: "600",
    color: Colors.light.primary,
  },
  root: { flex: 1 },
  content: { padding: Spacing.lg, paddingBottom: 48, gap: Spacing.md },
  head: { gap: 2 },
  title: {
    fontFamily: Fonts.displayBold,
    fontSize: 22,
    fontWeight: "700",
    color: Colors.light.text,
  },
  sub: {
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.light.textMuted,
  },

  empty: {
    gap: Spacing.xs,
    padding: Spacing.lg,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.light.border,
    alignItems: "center",
  },
  emptyTitle: {
    fontFamily: Fonts.bodyBold,
    fontSize: 14.5,
    fontWeight: "700",
    color: Colors.light.text,
  },
  emptyBody: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.textMuted,
    textAlign: "center",
  },

  card: { gap: Spacing.xs },
  entry: { marginTop: Spacing.xs },
  cardBody: {
    flexDirection: "row",
    gap: Spacing.md,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  cardMain: { flex: 1, gap: Spacing.sm },
  cardHead: { flexDirection: "row", alignItems: "center" },
  idx: {
    flex: 1,
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
  },
  rowIcons: { flexDirection: "row", gap: Spacing.md, alignItems: "center" },
  thumbEmpty: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.light.border,
    backgroundColor: "transparent",
  },
  addText: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    paddingVertical: 11,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: Colors.light.primary,
  },
  addTextTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    color: Colors.light.primary,
  },
  objectiveTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    color: Colors.light.primary,
    marginTop: 2,
  },
  banner: {
    gap: Spacing.sm,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.primaryLight,
  },
  bannerTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.light.text,
  },
  bannerActions: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs },
  bannerBtn: {
    minWidth: 120,
    alignItems: "center",
    paddingVertical: 9,
    paddingHorizontal: Spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.primary,
    backgroundColor: Colors.light.card,
  },
  bannerBtnOn: { backgroundColor: Colors.light.primary },
  bannerBtnTxt: {
    fontFamily: Fonts.bodyBold,
    fontSize: 13,
    fontWeight: "700",
    color: Colors.light.primary,
  },
  bannerBtnTxtOn: { color: Colors.light.buttonText },
  videos: { gap: Spacing.xs },
  videoRemove: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: Colors.light.text,
    alignItems: "center",
    justifyContent: "center",
  },
  agentDoor: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minWidth: 120,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: Colors.light.primaryLight,
    marginTop: Spacing.sm,
  },
  agentDoorTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    color: Colors.light.primary,
  },
  thumb: {
    width: 64,
    height: 88,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.border,
  },
  thumbPlay: { width: 64, height: 88 },
  playBadge: {
    position: "absolute",
    right: 4,
    bottom: 4,
    width: 22,
    height: 22,
    borderRadius: BorderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    // The one sanctioned translucent overlay: a floating control over media. Not blurred.
    backgroundColor: "rgba(13,11,8,0.55)",
  },
  prompt: {
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 18,
    color: Colors.light.text,
    minHeight: 38,
    padding: Spacing.sm,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.backgroundDefault,
  },

  kinds: { flexDirection: "row", gap: Spacing.xs, flexWrap: "wrap" },
  kind: {
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  kindOn: {
    borderColor: Colors.light.primary,
    backgroundColor: Colors.light.primaryLight,
  },
  kindOff: { opacity: 0.45 },
  kindTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12,
    color: Colors.light.textSecondary,
  },
  kindTxtOn: { color: Colors.light.primary },
  kindTxtOff: { color: Colors.light.textMuted },
  // The slot chips reuse the kind pill's styles on purpose — one chip language per row.
  slot: { gap: 4 },
  slotLabel: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11.5,
    color: Colors.light.textMuted,
  },
  onBeat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: Colors.light.primaryLight,
  },
  onBeatTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    color: Colors.light.primary,
  },
  kindHint: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
  },

  join: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.backgroundDefault,
  },
  joinOn: {
    borderColor: Colors.light.primary,
    backgroundColor: Colors.light.primaryLight,
  },
  joinTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11.5,
    color: Colors.light.textMuted,
  },
  joinTxtOn: { color: Colors.light.primary },

  libLabel: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
    marginTop: Spacing.sm,
  },
  lib: { flexDirection: "row", gap: Spacing.xs },
  libTile: { borderRadius: BorderRadius.xs, overflow: "hidden" },
  libImg: { width: 56, height: 76, borderRadius: BorderRadius.xs },
  libBlank: { backgroundColor: Colors.light.border },

  quote: {
    gap: Spacing.xs,
    padding: Spacing.md,
    borderRadius: BorderRadius.lg,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    marginTop: Spacing.sm,
  },
  eyebrow: {
    fontFamily: Fonts.bodyBold,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: Colors.light.textMuted,
  },
  quoteRow: { flexDirection: "row", alignItems: "baseline", gap: Spacing.sm },
  quoteLabel: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 13,
    color: Colors.light.text,
  },
  quoteBig: {
    fontFamily: Fonts.displayBold,
    fontSize: 20,
    fontWeight: "700",
    color: Colors.light.text,
  },
  quoteSub: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
  },

  gap: { flexDirection: "row", gap: 6, alignItems: "center" },
  gapTxt: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.textMuted,
  },
  refusal: {
    flexDirection: "row",
    gap: 6,
    alignItems: "flex-start",
    marginTop: Spacing.xs,
  },
  refusalTxt: {
    flex: 1,
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.primary,
  },

  cta: {
    flexDirection: "row",
    gap: 7,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 120,
    paddingVertical: 13,
    borderRadius: 999,
    backgroundColor: Colors.light.primary,
    marginTop: Spacing.sm,
  },
  ctaOff: { backgroundColor: Colors.light.border },
  ctaTxt: {
    fontFamily: Fonts.bodyBold,
    fontSize: 14,
    fontWeight: "700",
    color: Colors.light.textMuted,
  },
  ctaTxtOn: { color: Colors.light.buttonText },
  ctaGhost: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: Colors.light.primary,
  },
  ctaGhostTxt: { color: Colors.light.primary },
  handoff: {
    marginTop: Spacing.xs,
    padding: Spacing.sm,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.backgroundDefault,
  },
  handoffTxt: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 12.5,
    lineHeight: 17,
    color: Colors.light.text,
    textAlign: "center",
  },
  ctaNote: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textMuted,
    textAlign: "center",
  },
});
