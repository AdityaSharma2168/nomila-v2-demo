/**
 * use-studio-pending — the one place where "the server does not do this yet" lives.
 *
 * ─── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────────
 * The Studio UI is being built to the agreed design rather than to what the backend currently
 * serves, because the missing capabilities are being built underneath it. That only works if the
 * gaps are honest and in ONE place. Scatter hardcoded arrays through the screens and we end up with
 * a UI that looks finished and cannot be wired without a rewrite.
 *
 * So every hook here has the signature its real version will have. Screens consume them exactly as
 * they consume `useStudioContent` — same shape, same loading states — and cannot tell which is
 * which. When a server capability lands, the body of one function changes and no screen moves.
 *
 * ─── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 * A hook here is marked SERVER: not built, SERVER: partial, or it does not belong in this file.
 * `PENDING` at the bottom is the machine-readable version of those marks — it is what generates the
 * endpoint list handed to the backend, so it must stay true.
 *
 * Nothing here can reach an athlete: every consumer is behind STUDIO_ENABLED, which is unset in
 * every environment.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  usePreviewGeneration, useStudioClassify, useStudioContent, useStudioDeliverables,
  type GenerationPreview, type StudioContentItem, type StudioRegion,
} from "./use-studio";
import {
  STUDIO_ENABLED,
  STUDIO_IMAGE_OPS,
  STUDIO_INTERPRETER,
  STUDIO_SERVER_ROUTING,
  STUDIO_SESSIONS,
} from "../lib/flags";
import { useSessionsList } from "./use-studio-sessions";
import type { PackPolicy } from "../lib/identityPack";
import type { ListAnswer } from "../screens/studio/threadLogic";
import {
  MAX_ENGINE_REFERENCES,
  askCopyFor, markedFrame, objectPhotosIn, plannedIntent, previewRequestFor, seededPreview, stylePhotosIn,
  type Attachment, type BuiltFrom, type EngineReferences, type GenerationPlanView,
  type PlanFrame, type PreviewSeed, type StudioFormat,
  numberRepeatedNames,
} from "../lib/studio-contract";

// ─── Vocabulary ─────────────────────────────────────────────────────────────────────────────────

/**
 * Who a finished piece was made FOR. The Made shelf's sections, and the same fork the ＋ menu makes.
 *
 * SERVER: partial. `brand` and `personal` are answered by `StudioContentItem.brandName`, off the
 * job's frozen brief. `pitch` and `anything` are not properties of the asset at all — one is a deck
 * it was placed into, the other is which door she came through — so both stay unreachable until
 * something records them. See surfaceOf() below.
 */
export type StudioSurface = "brand" | "personal" | "anything" | "pitch";

/**
 * Where a piece is in its life. Deliberately separate from StudioSurface: one is who it is for, the
 * other is what stage it is at, and the old shelf mixed them into a single pill row.
 *
 * Note `awaiting` vs `draft`. `media_assets.approval_status = 'draft'` means not yet cleared, so it
 * is waiting on HER — that is `awaiting`. Cleared and not yet scheduled is `draft`. The engine's
 * approval header is explicit that clearance, render state and publish state are three different
 * things and must not be merged; this keeps them apart.
 */
export type MadeState = "awaiting" | "draft" | "making" | "scheduled" | "posted" | "archived";

export interface MadeItem {
  assetId: string;
  surface: StudioSurface;
  state: MadeState;
  mediaType: string;
  url: string | null;
  thumbUrl: string | null;
  /** Who it is for — a brand name, or "Yours". */
  title: string;
  /** The deliverable line, when there is one: "Ad 2 of 3". */
  subtitle: string | null;
  scheduledFor: string | null;
  postedAt: string | null;
  createdAt: string | null;
}

/** A thing owed to a brand under a deal. */
export interface Deliverable {
  id: string;
  dealId: string | null;
  brandId: number | null;
  brandName: string;
  campaign: string;
  /** The contract's own words for the format — "Reel · 9:16" — not our vocabulary. */
  format: string;
  dueOn: string | null;
  optional: boolean;
  delivered: number;
  total: number;
}

/** A fixture from her schedule. What makes "three hours before kickoff" a real sentence. */
export interface Fixture {
  id: string;
  startsAt: string;
  opponent: string;
  venue: string | null;
  home: boolean;
}

/** One saved Create-anything conversation. */
export interface StudioThread {
  id: string;
  title: string;
  updatedAt: string;
  /** The last thing it made, for the row's thumbnail. Null when it made nothing. */
  thumbUrl: string | null;
  archived: boolean;
}

/** The three things that can land on a day, on one axis. */
export type CalendarEntry =
  | { kind: "fixture"; at: string; fixture: Fixture }
  | { kind: "due"; at: string; deliverable: Deliverable }
  | { kind: "post"; at: string; item: MadeItem };

/**
 * Every hook here returns this, so a screen never branches on whether a thing is real yet.
 *
 * `isError` and `isUnavailable` are additive and default to false, so a hook that cannot fail (the
 * not-built ones below return a constant) simply never sets them and its consumers are unchanged.
 * They exist because collapsing a failed fetch into `data: []` is the one thing this shape must not
 * do: an empty array and a 500 render identically, and the screen tells the athlete she has made
 * nothing when in fact we could not ask. See useMadeShelf.
 */
export interface Pending<T> {
  data: T;
  isLoading: boolean;
  /** True while the server cannot answer this. Screens may surface it in dev; nothing requires it. */
  isStub: boolean;
  /** The read failed. NOT the same as empty, and must never be rendered as empty. */
  isError?: boolean;
  /** The server has this surface switched off (a 404 from the flag). Also not empty, and not an error. */
  isUnavailable?: boolean;
}

// ─── The shelf ──────────────────────────────────────────────────────────────────────────────────

/**
 * State IS derivable from what the server sends, and is read from it here rather than stubbed.
 * `published` answers posted; `approval_status` answers cleared. Only `scheduled` needs the
 * scheduling table, so it cannot appear yet.
 */
function stateOf(item: StudioContentItem): MadeState {
  if (item.published) return "posted";
  if (item.approvalStatus === "rejected") return "archived";
  if (item.approvalStatus === "draft") return "awaiting";
  return "draft";
}

/**
 * Who a finished piece was made FOR, read from the server rather than guessed.
 *
 * `brandId` is the brand named in the job's FROZEN BRIEF (`generation_jobs.brand_id`), which is the
 * only linkage that is actually populated for generated work — both `deal_id` columns are NULL on
 * every generated row, because nothing writes the one on media_assets and nothing publishes Studio
 * output into content_posts yet. See the studio/content.ts header.
 *
 * A brand was named, so it is a brand post; none was, so it is hers. Nothing is inferred from a
 * caption — a shelf that sorts wrongly but looks right is worse than one that admits to one section.
 *
 * `pitch` and `anything` are still unreachable: neither is a property of the asset. A pitch is a
 * deck the piece was placed into and `anything` is which door she came through, and the payload
 * carries neither. SECTION_ORDER already renders only the sections that have something in them, so
 * they simply stay empty until there is something real to put in them.
 */
function surfaceOf(item: StudioContentItem): StudioSurface {
  // `!= null` rather than truthiness: this asks whether a brand was NAMED, which is a question
  // about presence, not about the value of an id.
  return item.brandId != null ? "brand" : "personal";
}

/**
 * The Made shelf — the athlete's own generated assets, newest first, off the real content store.
 *
 * ─── THIS IS NOT A STUB, AND THE ONE FIELD THAT STILL IS SAYS SO ───────────────────────────────
 * Content, state, audience and title are all server-answered: the read is `listStudioContent`, the
 * same athlete-scoped query the Posts & Ads strip uses, reused rather than duplicated. Ordering is
 * the server's `created_at DESC`; this hook deliberately does not re-sort, so there is one ordering
 * rule and it lives next to the LIMIT that depends on it.
 *
 * `scheduledFor` is the last stub and stays null with its SERVER mark, because there is no
 * scheduling table and inventing a time would put a date on a tile that nothing will honour.
 * `subtitle` is null for the same reason one door down — the deliverable line is "Ad 2 of 3", and
 * the "of 3" needs deal_deliverables, which is useDeliverables' gap rather than this one. A format
 * string alone ("Ad") would read as a count that had lost its denominator.
 *
 * ─── A FAILED READ IS NOT AN EMPTY SHELF ───────────────────────────────────────────────────────
 * This used to return `isLoading: state === "loading"` and drop the rest of the state on the floor.
 * Because a failed query yields `items: []`, a 500 arrived at the screen as `data: []` — rendering
 * "Nothing here yet. Anything you make lands here", which tells the athlete her work is gone when
 * the truth is that we could not ask. The three outcomes are kept apart here and rendered apart in
 * MadeShelf, exactly as StudioContentStrip already does for the same query.
 */
export function useMadeShelf(enabled: boolean): Pending<MadeItem[]> {
  const { items, state } = useStudioContent(enabled);

  const data = useMemo<MadeItem[]>(
    () =>
      items.map((it) => ({
        assetId: it.assetId,
        surface: surfaceOf(it),
        state: stateOf(it),
        mediaType: it.mediaType,
        url: it.url,
        thumbUrl: it.thumbUrl,
        // Her own work is "Yours" rather than her name: the shelf is hers, and a brand name here
        // means the piece belongs to someone else's campaign.
        title: it.brandName ?? "Yours",
        subtitle: null, // SERVER: partial — needs deal_deliverables for the "of 3".
        scheduledFor: null, // SERVER: not built — no scheduling table.
        postedAt: it.published?.postedAt ?? null,
        createdAt: it.createdAt,
      })),
    [items],
  );

  return {
    data,
    isLoading: state === "loading",
    isStub: false,
    isError: state === "error",
    isUnavailable: state === "unavailable",
  };
}

// ─── Not built at all ───────────────────────────────────────────────────────────────────────────

/**
 * What she still OWES a brand — now real, off `deal_deliverables` and GET /studio/deliverables.
 *
 * This was the single biggest gap in this file: `generation_jobs.deliverable` is a format string
 * describing one render, not a commitment, so nothing could answer "what do I owe gorjana" and the
 * Now screen's deadline rows, the calendar's DUE entries and the brand-post brief picker were all
 * blocked on the same missing table.
 *
 * ─── OUTSTANDING, NOT ALL ──────────────────────────────────────────────────────────────────────
 * The server filters to open, un-superseded obligations on deals she did not reject. That is right
 * for all three surfaces here, and WRONG for a deal-history view, which needs the fulfilled and
 * amended rows to show what a deal contained and how it changed. Do not reuse this hook there —
 * see the header on server/studio/dealDeliverables.ts.
 *
 * ─── `delivered` IS 0 TODAY, AND THAT IS TRUE ──────────────────────────────────────────────────
 * It is derived by counting assets whose `deal_deliverable_id` points at the obligation, and
 * nothing writes that column yet — attribution is a separate PR. So "0 of 3 delivered" is an
 * accurate sentence rather than a placeholder, and the number starts moving on its own once
 * something writes the link. Nothing here needs to change when it does.
 *
 * `dueOn` is passed through as the DATE STRING the server sent. It must not be parsed here: that
 * is what nowLogic.localDay() is for, and doing it with `new Date()` is the off-by-one that put
 * "1 day late" on work due today.
 */
export function useDeliverables(brandId?: number | null): Pending<Deliverable[]> {
  // Gated here rather than by a parameter because the signature is the one its callers already
  // use — NowFeed asks for all brands, BrandPostScreen for one, neither passes an `enabled`. The
  // flag is read directly for the reason this file's header gives: nothing here may reach an
  // athlete while the surface is unreleased.
  const { items, state } = useStudioDeliverables(STUDIO_ENABLED, brandId);

  const data = useMemo<Deliverable[]>(
    () => items.map((it) => ({
      id: it.id,
      dealId: it.dealId,
      brandId: it.brandId,
      brandName: it.brandName,
      campaign: it.campaign,
      format: it.format,
      dueOn: it.dueOn,
      optional: it.optional,
      delivered: it.delivered,
      total: it.total,
    })),
    [items],
  );

  return {
    data,
    isLoading: state === "loading",
    isStub: false,
    // Kept apart for the reason useMadeShelf states: a failed read rendered as an empty list tells
    // her she owes nobody anything, which is the one wrong answer this screen can give.
    isError: state === "error",
    isUnavailable: state === "unavailable",
  };
}

/** SERVER: not built. No fixtures table. Powers the time recommendation and the calendar. */
export function useFixtures(): Pending<Fixture[]> {
  return { data: [], isLoading: false, isStub: true };
}

/**
 * SERVER: not built. `content_posts` records what was posted; there is no `scheduled_for` and no
 * runner.
 *
 * ⚠️ When this is built: `generation_jobs` has NO LEASING, and the schema comment says that is only
 * safe because nothing polls. Cloud Run runs minScale 1 / maxScale 3. A scheduling runner added
 * without leasing means two instances claim one row and BOTH SPEND. Leasing belongs in the first
 * commit of that work, not a later one.
 */
export function useScheduledPosts(): Pending<MadeItem[]> {
  return { data: [], isLoading: false, isStub: true };
}

/**
 * Her Create anything threads — open ones, then archived ones, each newest first — off
 * GET /studio/sessions (server/routes/studioSessions.ts; the tables are `studio_sessions` and
 * `studio_session_entries`, migrations/0054, created by scripts/db-migrate.sh on deploy — never
 * `db:push` them).
 *
 * With EXPO_PUBLIC_STUDIO_SESSIONS off this is exactly the stub it was: no request, nothing listed.
 * With it on and the server's half off, the list answers 404 and this says `isUnavailable` rather
 * than an empty list — and a failed read says `isError`, for the reason useMadeShelf gives: an
 * empty list and a 500 must not render alike. At most 30 of each (the server's page; no paging
 * in v1).
 */
export function useStudioThreads(): Pending<StudioThread[]> {
  const open = useSessionsList(false, STUDIO_SESSIONS);
  const archived = useSessionsList(true, STUDIO_SESSIONS);

  const data = useMemo<StudioThread[]>(() => {
    const rows = (a: ListAnswer) => (a.kind === "ok" ? a.sessions : []);
    return [...rows(open.answer), ...rows(archived.answer)].map((s) => ({
      id: s.id,
      // A thread's title is her first prompt. One whose first saved entry was Mila's has none yet.
      title: s.title ?? "Untitled thread",
      updatedAt: s.updatedAt,
      thumbUrl: s.thumbUrl,
      archived: s.archived,
    }));
  }, [open.answer, archived.answer]);

  if (!STUDIO_SESSIONS) return { data: [], isLoading: false, isStub: true };
  return {
    data,
    isLoading:
      open.answer.kind === "loading" || archived.answer.kind === "loading",
    isStub: false,
    isError: open.answer.kind === "error" || archived.answer.kind === "error",
    isUnavailable: open.answer.kind === "unavailable",
  };
}

// ─── The plan ───────────────────────────────────────────────────────────────────────────────────

/**
 * What the Make it screen renders — now the ENGINE's answer, not a guess at it.
 *
 * ─── THE CHECK RUNS ONCE PER JOB ───────────────────────────────────────────────────────────────
 * `POST /studio/preview` costs nothing and runs nothing, but it is still a MUTATION rather than a
 * query on purpose: it happens when she asks, not on every keystroke. By the time this screen
 * mounts the brief is fixed — arriving here IS the ask — so the check fires once, behind a ref
 * guard that survives StrictMode's double-invoke. Going back to change something and returning
 * re-mounts the screen, which re-asks.
 *
 * The guard holds the FINGERPRINT of the job it fired for rather than a bare boolean. Nothing on
 * this screen is typed and its inputs are route params, so in the ordinary flow that string is
 * computed once and the behaviour is identical to firing on mount. What it adds is the case where
 * the params change under a screen that did not remount — see the fingerprint's own note for the
 * navigate-merge that would otherwise leave a new brief sitting over the previous job's previewId.
 *
 * ─── WHAT IS STILL ASSEMBLED HERE, AND WHY ─────────────────────────────────────────────────────
 * Per-frame COST and TIER. `GenerationPlan.cost` is one EstimatedCost for the whole job, so the
 * frames below carry a SHARE of that one number rather than a quote of their own — and the share is
 * split so the frames sum to the server's figure exactly, to the cent. Nothing renders a per-frame
 * price as though the engine quoted one; see the Make it screen's job line.
 */
export function useGenerationPlan(input: {
  title: string;
  line: string;
  format: StudioFormat;
  attachments: Attachment[];
  brandName?: string | null;
  /** Her own words, passed through to the brief. The prompt itself, out of Create anything. */
  direction?: string | null;
  /** Threaded from the deal. Decides the objective, and tailors the brief to the partner. */
  brandId?: number | null;
  /**
   * Her CORRECTION to the derived box, when she has made one. Absent on the first check, which is
   * what lets the server derive one — sending regions is what says "do not derive, use these".
   *
   * SESSION-ONLY, like everything else on this screen: it lives in component state and dies with
   * the screen. Nothing here persists a thread. See the boundary note in CreateAnythingScreen.
   */
  regions?: StudioRegion[] | null;
  /**
   * WHICH attachment is the frame being edited — her mark, carried from the screen she marked it
   * on. Null — or omitted — is NO frame, whatever photographs of hers are attached: they are her
   * likeness for a new image (frame defaulting, 2026-09-16; see `routeMarked`). Every caller passes
   * it: Create anything its mark, SetupScreen its first photograph, explicitly, as it always routed.
   */
  frameAssetId?: string | null;
  /**
   * "JUST THESE" (PR 17, R-3): her per-request word that the pack may not top up her likeness slots.
   * Absent is top-up. Rides to usePreviewGeneration beside the request and is stripped before send;
   * it is in the fingerprint because a policy change is a different job.
   */
  packPolicy?: PackPolicy;
  /**
   * WHAT THE COMPOSER'S SEND ALREADY CHECKED, when it did (catch-all through the interpreter, C2): the interpreter
   * read her words at send and proposed an edit. When it was checked for exactly the request below, that preview is
   * what this screen shows, and the check does not run again — a second reading could differ (F-I5). Anything else
   * — no seed, or a request that moved (her mask correction) — checks as it always did.
   */
  seed?: PreviewSeed | null;
  /** quality-scrappy piece 5: the gate's codes on a Try again — the check re-quotes with the fix. Absent: as it was. */
  corrective?: string[];
}): Pending<GenerationPlanView> {
  const { title, line, format, attachments, direction, brandId, regions, frameAssetId, seed, packPolicy, corrective } = input;

  const preview = usePreviewGeneration();

  /**
   * ─── THE ROUTING CUTOVER ───────────────────────────────────────────────────────────────────
   *
   * With STUDIO_SERVER_ROUTING on, what she asked for is decided by the server's classifier and
   * this hook consumes the answer. With it off, the query never fires (`enabled` is false), the
   * classification is undefined, and `routeWithServer` falls back to `engineIntentFor` — the verb
   * list, byte for byte, which is what keeps the old path reachable for one release.
   *
   * `hasSourcePhoto` is `sourceFrameFor`, not `editBaseFor`: the question the server is being asked
   * is "is there a photograph here that COULD be edited", which must not be filtered through the
   * verb gate the server is replacing. Asking it through the old gate would mean the classifier
   * only ever saw the sentences the old list already routed, and "make the socks blue" — the case
   * this exists for — would never reach it.
   *
   * It is also not `frameFor`, and the difference is the point of the split: this is a BOOLEAN
   * about whether an edit is possible at all, and the answer does not change with which photograph
   * she marked. `frameFor` decides WHICH, once, below — and only that one feeds `sourceAssetId`.
   *
   * ─── 2026-09-16, FRAME DEFAULTING: THE ANSWER DOES CHANGE WITH HER MARK NOW ────────────────────
   *
   * The two paragraphs above were written when any photograph of hers could be the frame. It was
   * `sourceFrameFor` — "is there one attached" — and with a reference pack attached the classifier
   * was always told there was a photo to edit, so "generate a pic of me playing soccer" asked
   * (fast_path_declined) instead of generating. An edit is possible when she MARKED a photograph, so
   * that is the question: `markedFrame`, still asked without the verb gate. With nothing marked the
   * classifier sees no photo, and only GENERATE is open to it.
   */
  const sourceFrame = useMemo(
    () => markedFrame(attachments, frameAssetId ?? null),
    [attachments, frameAssetId],
  );
  // How many Object photos go with this job — "change my earrings to these gold hoops" routes with one
  // and asks without (replace with reference). The survivors that are sent, never the raw tray.
  const objectPhotos = useMemo(
    () => objectPhotosIn(attachments),
    [attachments],
  );
  // PR 19 (B): her Style references, so "match this look" can find one. Zero with the flag off: the body is unchanged.
  const stylePhotos = useMemo(
    () => (STUDIO_IMAGE_OPS ? stylePhotosIn(attachments) : 0),
    [attachments],
  );
  const classify = useStudioClassify(
    direction,
    sourceFrame !== null,
    STUDIO_SERVER_ROUTING,
    objectPhotos,
    undefined,
    stylePhotos,
  );

  /**
   * ⚠️ `classify.data` ONLY WHEN THE QUERY SUCCEEDED. An error leaves it undefined, which
   * `routeWithServer` reads as "no answer" and falls back to the pre-cutover path. A classifier we
   * cannot reach must not be able to change what happens — least of all by defaulting to the one
   * answer that replaces her photograph.
   */
  /**
   * The routing, the references, and the request this screen's CURRENT inputs describe — built by
   * `previewRequestFor`, the one builder the composer's send-time check uses too, so a preview it passes
   * through is for exactly this request (catch-all through the interpreter).
   *
   * Derived rather than frozen in a ref — see the fingerprint below for why the difference matters.
   * `regions` DOES get sent once she corrects the derived box; that is the re-check below.
   */
  const { routed, refs, request } = useMemo(
    () =>
      previewRequestFor({
        format,
        classification: classify.data,
        direction,
        attachments,
        frameAssetId: frameAssetId ?? null,
        brandId,
        regions,
        interpreter: STUDIO_INTERPRETER,
        imageOps: STUDIO_IMAGE_OPS,
        corrective,
      }),
    [format, classify.data, direction, attachments, frameAssetId, brandId, regions, corrective],
  );

  /**
   * The photograph being EDITED. Null for every generate, which is still the ordinary case.
   */
  const editBase = routed.editBase;

  /**
   * Nothing to check yet: the server would only tell us what the screen already knows.
   *
   * ─── TWO CUTOVER-ONLY REASONS TO HOLD, BOTH ABOUT NOT ASKING TOO EARLY ─────────────────────
   *
   * ⚠️ WAIT FOR THE ROUTING ANSWER BEFORE FIRING THE CHECK. Without this the hook fires once on
   * the fallback intent the moment the screen mounts, and again when the classification lands —
   * and the first of those two is the pre-cutover answer. For "make the socks blue" that means a
   * preview row written for a GENERATE, and a Generate button briefly live over its previewId,
   * before the classifier's edit ever arrives. `isLoading` is `isPending && isFetching` in v5, so
   * it is false when the query is disabled (flag off) and false once it has answered or failed —
   * the hold lasts exactly as long as the round trip.
   *
   * AND DO NOT CHECK SOMETHING WE HAVE DECLINED TO ROUTE. An ASK means we have not agreed what she
   * asked for, so there is nothing to price. The screen says why instead.
   */
  const ready =
    title.trim().length > 0 &&
    attachments.every((a) => Boolean(a.assetId)) &&
    !classify.isLoading &&
    routed.askReason === null;

  /** The send's preview, when it was for exactly this request and the check may run (C2). Null otherwise. */
  const seeded = useMemo(
    () => (ready ? seededPreview(seed, request) : null),
    [ready, seed, request],
  );

  /**
   * WHAT THE CHECK IS FOR, as one comparable value.
   *
   * The check still runs ONCE per job — this is not a keystroke trigger, because nothing on the
   * Make it screen is typed. Its inputs are route params, fixed for as long as the screen is
   * mounted, so in the ordinary flow this string is computed once and the effect fires once.
   *
   * It exists for the case where they are NOT fixed. React Navigation 7's `navigate` merges params
   * into an EXISTING route rather than mounting a second one whenever a screen of that name is
   * already in the stack. No caller does that to this screen today — both push onto a stack that
   * has already popped it — but a mount-frozen ref would survive such a navigate silently: the
   * screen would render the new title, the new tray and the new brief over the PREVIOUS job's
   * previewId, and the button under all of it would spend against the old brief. That is not a
   * failure anyone would catch by looking, which is why it is closed here rather than left to the
   * next caller to know about.
   *
   * `title` rides in the fingerprint but not the request: it is not sent, but it is the piece's
   * identity on screen, and a title change with an unchanged body is still a different job.
   */
  const fingerprint = JSON.stringify({ title, request, packPolicy: packPolicy ?? null });

  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || firedFor.current === fingerprint) return;
    const rearming = firedFor.current !== null;
    firedFor.current = fingerprint;
    // Drop the previous answer BEFORE asking again. Between the two there is a window where
    // `preview.data` still holds the old verdict, and a live Generate button over a stale
    // previewId is exactly the spend this guard exists to prevent.
    if (rearming) preview.reset();
    // THE SEND ALREADY CHECKED THIS REQUEST (C2): its preview is the answer, and nothing is asked again.
    if (seededPreview(seed, request)) return;
    preview.mutate(packPolicy ? { ...request, packPolicy } : request);
    // `preview` is a stable mutation handle; keying on it would re-run this on every state change
    // it makes, which is the auto-trigger loop this hook has always avoided.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fingerprint]);

  const data = useMemo<GenerationPlanView>(
    () => ({
      ...toPlanView({
        title, line, format, attachments, refs, ready, editBase,
        askReason: routed.askReason,
        interpreting: routed.interpreting === true,
        routing: classify.isLoading,
        preview: seeded ?? preview.data, error: seeded ? null : preview.error,
      }),
      // PR 19 (R-6): the vague ask's chips ride beside its code; every other plan is exactly what it was.
      // PR 19: an ask's chips (vague, angle) and the ad ask's payload ride beside its code.
      ...(STUDIO_IMAGE_OPS && routed.askReason && classify.data?.suggestions?.length
        ? { askSuggestions: classify.data.suggestions }
        : {}),
      // PR 19 (K-IO12): what the plan runs as, for the thread's new-image line.
      ...(STUDIO_IMAGE_OPS
        ? { intent: plannedIntent(routed.intent, seeded ?? preview.data) }
        : {}),
    }),
    [
      title, line, format, attachments, refs, ready, editBase, routed.askReason,
      routed.interpreting, routed.intent, classify.isLoading, classify.data, seeded, preview.data, preview.error,
    ],
  );

  /**
   * The routing round trip counts as CHECKING, because to her it is the same wait: she tapped and
   * the screen is working out what her sentence asked for. Reporting it as settled would show her
   * an empty frame strip and a blocker for a check that has not been allowed to run yet.
   */
  return {
    data,
    isLoading: preview.isPending || classify.isLoading,
    isStub: false,
  };
}

/**
 * The engine's answer, in the shape the screen renders.
 *
 * Everything that stops the button is a BLOCKER and everything that merely shapes the result is a
 * warning — the same split the brief itself uses, carried through rather than re-decided.
 */
function toPlanView(args: {
  title: string;
  line: string;
  format: StudioFormat;
  attachments: Attachment[];
  refs: EngineReferences;
  /** False when the check was never asked for, because the brief was not complete enough to ask. */
  ready: boolean;
  /** The photograph being edited, when this is an edit. Null otherwise. */
  editBase: Attachment | null;
  /** The classifier declined to route this, and why. Null on every answer that routes. */
  askReason: string | null;
  /** Her sentence went to the preview to be interpreted (the interpreter, I.6). */
  interpreting: boolean;
  /** The routing round trip is still in flight, so nothing has been decided yet either way. */
  routing: boolean;
  preview: GenerationPreview | undefined;
  error: Error | null;
}): GenerationPlanView {
  const { title, line, format, attachments, refs, ready, askReason, routing, preview, error } = args;

  const jobCostUsd = preview?.cost?.amountUsd ?? null;
  const unpriced = Boolean(preview?.unpriced ?? preview?.cost?.unpriced);

  const blockers = [
    /**
     * The check never ran, so there is nothing else to say. Without this the screen would sit on a
     * disabled button with an empty blocker list and no account of why — the one failure state
     * that looks identical to a bug.
     *
     * ⚠️ AN ASK IS ALSO A CHECK THAT NEVER RAN, AND IT IS NOT AN UPLOAD PROBLEM. It gets its own
     * sentence, from its own reason code — telling her something "hasn't finished uploading" when
     * the classifier declined to route her sentence would be a wrong answer, not a vague one.
     */
    ...(askReason ? [askCopyFor(askReason)] : []),
    /**
     * ⚠️ AND NOT WHILE THE ROUTING ANSWER IS IN FLIGHT EITHER. `ready` is deliberately false for the
     * length of that round trip, so without this clause every cutover request would flash "hasn't
     * finished uploading" at her for as long as the classifier takes to answer — a wrong sentence
     * about her tray, on the way to a screen that was working correctly.
     */
    ...(ready || askReason || routing
      ? []
      : ["Something here hasn't finished uploading yet. Go back and check the tray."]),
    ...(preview?.blockers ?? []).map((g) => g.note),
    // A capability we are missing, rather than a gap in her material.
    ...(preview?.unavailable ? [preview.unavailable.reason] : []),
    ...(error ? [error.message] : []),
    /**
     * ASSUMPTION, STATED: an unpriced job can still CHARGE. The engine returns `unpriced` when it
     * cannot put a number on the route — not when the route is free — so the safe reading is "we
     * do not know what this costs", and asking her to approve a spend nobody can name is the one
     * thing this screen exists to prevent. It blocks rather than warns. If the engine ever means
     * "genuinely free" by this flag, this is the line to revisit.
     */
    ...(unpriced ? ["We can't price this one yet, so it can't be approved from here."] : []),
  ];

  const warnings = [
    ...(preview?.warnings ?? []).map((g) => g.note),
    ...dropNotes(refs),
  ];

  return {
    previewId: preview?.previewId ?? null,
    title,
    line,
    heroUri: heroFrom(attachments),
    format,
    frames: framesFromPreview(refs, preview, jobCostUsd),
    blockers,
    warnings,
    /**
     * THE SERVER'S VERDICT, not ours. It re-derives the quote and owns the refusal; the client's
     * only job is to not offer a button the server would reject. The previewId check is not
     * belt-and-braces — /studio/generate is sent nothing else, so without it there is no spend to
     * authorize.
     */
    canGenerate:
      preview?.status === "ready" &&
      preview.verdict.canGenerate === true &&
      Boolean(preview.previewId) &&
      !unpriced,
    jobCostUsd,
    unpriced,
    builtFrom: builtFromOf(attachments, refs),
    // Only when the SERVER derived it. A box she drew is one she is already looking at.
    derivedRegions: args.preview?.derivedRegions ?? null,
    editBaseUri: args.editBase?.uri ?? null,
    askReason,
    // Only what the server proposed: the frozen intent's lines, never anything a model wrote (I.6).
    interpretation: args.preview?.interpretation ?? null,
    // The rules' card, when her keep froze beside their steps (A3b) — the frozen intent's lines too.
    card: args.preview?.card ?? null,
    interpreting: args.interpreting,
  };
}

/**
 * The survivors, rejoined to their thumbnails.
 *
 * Deliberately walks `refs.references` rather than the tray: those are two different lists, and an
 * inspiration image is in one and not the other. Showing the tray here would tell her a photograph
 * anchored the result when it was never sent — the same dishonesty the frame tiers were fixed to
 * avoid. The join is by assetId because the mapped reference no longer carries her label for it.
 */
/** A survivor with no tray name. An object is its own word — it was "Product" before PR C′. */
const UNNAMED: Record<BuiltFrom["role"], string> = {
  person: "You",
  product: "Product",
  object: "Object",
  style_reference: "Style",
};

/**
 * NUMBERED WHEN A NAME REPEATS — wave C card 2, the plural-You row.
 *
 * Three photographs of her rendered three tiles all captioned YOU, and the screen reader said "You. Open it."
 * three times: nothing in the strip told her WHICH of her photographs each tile was, and the accessible name
 * was ambiguous between three different tappable things. Reference packs made that the normal case rather than
 * an edge one (MAX_PERSON is 3), so it is worth fixing rather than noting.
 *
 * The numbering itself is `numberRepeatedNames` (lib/studio-contract), which is where its rules are stated and
 * where they are tested — this file imports React, so nothing in it is reachable from a pure-logic suite.
 *
 * Order is the engine's reference order, which is the order the manifest numbers them in (studio/refOrder.ts) —
 * so "YOU 2" here and "Image 2" in the prompt are the same photograph, and a later card can say so.
 */
function builtFromOf(attachments: Attachment[], refs: EngineReferences): BuiltFrom[] {
  const named = refs.references.map((r) => {
    const a = attachments.find((x) => x.assetId === r.assetId);
    return {
      assetId: r.assetId,
      role: r.role,
      name: a?.name ?? UNNAMED[r.role],
      uri: a?.uri ?? null,
    };
  });
  return numberRepeatedNames(named);
}

/** What the screen shows behind the title: what this is being built FROM. */
function heroFrom(attachments: Attachment[]): string | null {
  const mine = attachments.find((a) => a.role === "source-frame" && a.uri);
  return mine?.uri ?? attachments.find((a) => a.uri)?.uri ?? null;
}

/** Everything she attached that could not go, in her language. Never silent. */
function dropNotes(refs: EngineReferences): string[] {
  const out: string[] = [];
  if (refs.droppedInspiration > 0) {
    out.push(
      `${refs.droppedInspiration === 1 ? "Your inspiration image is" : `Your ${refs.droppedInspiration} inspiration images are`} ` +
      "not sent to the engine — it has no way to read a look without risking putting it in the " +
      "picture. Describe the look in your words instead.",
    );
  }
  if (refs.droppedOverCap > 0) {
    out.push(`Only the first ${MAX_ENGINE_REFERENCES} photos go on one job — ${refs.droppedOverCap} did not fit.`);
  }
  if (refs.droppedDuplicate > 0) {
    out.push("The same photo was attached twice; it counts once.");
  }
  if (refs.droppedUnresolved > 0) {
    out.push("Something you attached has not finished uploading, so it is not on this job.");
  }
  return out;
}

/**
 * The output frames, and their SHARE of the one cost the engine quoted.
 *
 * These are what will be MADE, not what she attached — on a reference-conditioned generation every
 * output pixel is rendered new, and her photographs are what anchor the likeness rather than
 * frames that pass through. Calling them "untouched" because a photograph went in would be the
 * exact mislabelling the tiers exist to prevent.
 */
function framesFromPreview(
  refs: EngineReferences,
  preview: GenerationPreview | undefined,
  jobCostUsd: number | null,
): PlanFrame[] {
  const n = Math.max(1, preview?.plan?.inputs.n ?? 1);
  const shares = splitCost(jobCostUsd ?? 0, n);
  const anchors = refs.references.filter((r) => r.role === "person").length;

  const why = anchors > 0
    ? `Rendered new, anchored on ${anchors === 1 ? "your photo" : `your ${anchors} photos`} so it looks like you.`
    : "No photograph of yours under this one, so all of it is invented.";

  return Array.from({ length: n }, (_, i) => ({
    id: `frame-${i + 1}`,
    assetId: null,
    name: n === 1 ? "The frame" : `Frame ${i + 1}`,
    uri: null,
    tier: "invented" as const,
    costUsd: shares[i],
    label: "generated",
    note: null,
    why,
  }));
}

/**
 * One job cost, split across n frames so the parts sum to the whole EXACTLY.
 *
 * Done in cents with the remainder on the last frame, because dividing by three and rounding each
 * share is how a $0.13 job renders as $0.15. planTotal() sums these and must land on the server's
 * own figure to the cent.
 */
function splitCost(total: number, n: number): number[] {
  if (n <= 0) return [];
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const remainder = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i === n - 1 ? remainder : 0)) / 100);
}

// ─── The merged calendar ────────────────────────────────────────────────────────────────────────

/**
 * Fixtures, deliverable dates and scheduled posts on one time axis, newest first.
 *
 * Deliverables are REAL now, so DUE entries land here off deal_deliverables. Fixtures and scheduled
 * posts are still stubs, which is why this keeps `isStub: true` — the axis is partly lit, not lit.
 */
export function useStudioCalendar(): Pending<CalendarEntry[]> {
  const fixtures = useFixtures();
  const deliverables = useDeliverables();
  const posts = useScheduledPosts();

  const data = useMemo<CalendarEntry[]>(() => {
    const out: CalendarEntry[] = [
      ...fixtures.data.map((f) => ({ kind: "fixture" as const, at: f.startsAt, fixture: f })),
      ...deliverables.data
        .filter((d) => d.dueOn)
        .map((d) => ({ kind: "due" as const, at: d.dueOn as string, deliverable: d })),
      ...posts.data
        .filter((p) => p.scheduledFor)
        .map((p) => ({ kind: "post" as const, at: p.scheduledFor as string, item: p })),
    ];
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [fixtures.data, deliverables.data, posts.data]);

  return {
    data,
    isLoading: fixtures.isLoading || deliverables.isLoading || posts.isLoading,
    isStub: true,
  };
}

// ─── The handover ───────────────────────────────────────────────────────────────────────────────

/**
 * What the backend still owes this UI. Kept beside the hooks so it cannot drift from them, and
 * ordered by what unblocks the most screens.
 *
 * This is the list to hand over — not a wish list. Every entry has a consumer above it that is
 * already written and already compiles.
 */
export const PENDING = [
  {
    hook: "useScheduledPosts",
    needs: "a scheduled_posts table + a cron runner WITH LEASING",
    unblocks: "everything after 'It is made'",
  },
  {
    hook: "useFixtures",
    needs: "an athlete fixtures table + GET /studio/fixtures",
    unblocks: "time recommendations, the calendar's offset notes",
  },
  {
    hook: "useGenerationPlan",
    needs: "per-frame cost and tier on the preview response — the job total is real and wired; only the itemisation is one number spread across n frames",
    unblocks: "the Make it screen quoting each frame instead of showing one job total",
  },
  {
    hook: "useMadeShelf",
    needs: "a deck linkage for `pitch` and a door marker for `anything` — brand vs personal is wired and real, off generation_jobs.brand_id. NOT deal_id: both deal_id columns are NULL on every generated row",
    unblocks: "the Made shelf's remaining two sections; the other two already sort themselves",
  },
] as const;
