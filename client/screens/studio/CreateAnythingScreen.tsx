/**
 * CreateAnythingScreen — say it and I make it.
 *
 * ─── NOTHING RUNS WITHOUT A PRESS ──────────────────────────────────────────────────────────────
 * The rule this screen is built around. Attaching something only attaches it: it lands in the tray
 * and the conversation waits. Earlier this fired generation the moment a product photo arrived,
 * which meant you could never attach two things, and never attach something and THEN say what to
 * do with it — the first attachment ended the conversation.
 *
 * So the send button is the only thing that starts a job, with one exception that is not an
 * exception: when a gate has stopped an already-sent prompt, satisfying it offers a one-tap
 * "Make it" rather than making her retype. Still a press.
 *
 * ─── THE THREAD FOLLOWS ITS OWN TAIL ───────────────────────────────────────────────────────────
 * A chat reads bottom-up. Appending a card without scrolling to it looks like nothing happened —
 * which is exactly what it looked like before, and read as a dead button rather than a scroll
 * position. Every append scrolls.
 *
 * ─── WHERE IT GOES ─────────────────────────────────────────────────────────────────────────────
 * To Make it, with the prompt and the tray. With EXPO_PUBLIC_STUDIO_SESSIONS off that is a push to
 * StudioMakeIt, and Made it after. With it on, Make it opens as a sheet over this thread
 * (ThreadMakeIt), and approving it runs the generate from here — the same hook, the same body — so
 * the result lands in the thread where its loading tile was. Either way the spend is authorised by
 * the preview she was shown, and nothing else.
 *
 * ─── EDITING LIVES HERE NOW, AND IT IS THE SENTENCE THAT SAYS SO ───────────────────────────────
 *
 * "Remove the soccer ball" with a photo attached is an EDIT: the photograph is the thing being
 * changed, the server derives the region from the words (server/studio/autoMask.ts), and the result
 * is her original with only that region different. "Put me on a rooftop" with the SAME attachment
 * is a generate, where the photograph is an identity anchor.
 *
 * One tile, two meanings — the documented `source-frame` collision — and the instruction is the only
 * thing that separates them, which is why `engineIntentFor` takes it. There is no edit door and no
 * mode toggle: asking her to classify her own request is asking a question the sentence already
 * answers. `isEdit` below is the cost gate in front of the server's decision, never the decision.
 *
 * 2026-09-16, FRAME DEFAULTING — the paragraph above is now true only of a photo she MARKED. Her first
 * photograph used to be marked on attach, so every photo of hers was a frame and a reference pack could
 * not be asked for. Now a tap on a photo of hers puts the EDITING badge on it (a second tap takes it
 * off), and only a marked photo — or Edit this, or a thread's continuation — is ever edited. The sentence
 * still decides edit-or-generate for THAT photo; an unmarked one is her likeness for a new image.
 *
 * ─── WHAT IS KEPT, AND WHAT IS STILL NOT ────────────────────────────────────────────────────────
 *
 * With EXPO_PUBLIC_STUDIO_SESSIONS off, nothing here persists: the turns, the tray and (on the next
 * screen) a corrected mask are component state and die with the screen, as they always have.
 *
 * With it on — and the server's STUDIO_SESSIONS — the THREAD is kept, and only the thread
 * (session persistence plan v2; docs/plans/studio-sessions-plan-v2.md). What she said, which gate
 * stopped it, the plan each check showed her and Mila's asks are entries in `studio_session_entries`,
 * saved behind her by the append queue; what came of a plan is DERIVED at read from the preview and
 * job rows that already hold it. The door resumes her latest open thread, and a run that was going
 * when she left is watched until it lands.
 *
 * What is still NOT kept, deliberately (D7): the unsent tray, the draft, the frame mark, the gate's
 * own card, a corrected mask. Coming back is the history plus a fresh composer. A tray that outlived
 * its prompt is how one job's material conditioned another's — the bug `handOff` exists to prevent
 * — so the thread stores what was SENT with each plan (ids and roles), never the tray. Do not add
 * AsyncStorage, a query cache or a route param to keep any of the rest "just for now"; if one of
 * them should be kept, it becomes an entry, not a second storage mechanism.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  View,
  Text,
  ScrollView,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  TextInput,
  Image,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { HapticPressable } from "../../components/HapticPressable";
import { MediaLibraryView } from "../../components/media/MediaLibraryView";
import { AssetViewer } from "../../components/studio/AssetViewer";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { trayLabelFor } from "../../lib/studio-contract";
import {
  askCopyFor,
  markedFrame,
  nextFrameAssetId,
  objectPhotosIn,
  stylePhotosIn,
  type Attachment,
  type GenerationPlanView,
  type PreviewSeed,
} from "../../lib/studio-contract";
import {
  STUDIO_IMAGE_OPS,
  STUDIO_INTERPRETER,
  STUDIO_SERVER_ROUTING,
  STUDIO_SESSIONS,
} from "../../lib/flags";
import {
  classifyNow,
  previewNow,
  useGenerate,
  useStudioClassify,
} from "../../hooks/use-studio";
import {
  newId,
  readPlanEntry,
  useAppendQueue,
  useRunWatch,
  useSessionsList,
  useThreadPages,
  type Availability,
} from "../../hooks/use-studio-sessions";
import {
  afterAttach,
  autoFrame,
  autoMarkShape,
  autoOffAfterAttach,
  autoOffAfterReject,
  badgedFrame,
  canSend,
  canvasesIn,
  frameCompanions,
  FRAME_ASK,
  FRAME_PICK,
  frameChoice,
  frameChoiceNeeded,
  handOff,
  resolveSend,
  tapBadge,
  whatIsMissing,
  type FrameChoice,
} from "./createAnythingLogic";
import { AttachSheet, type PickableRole } from "./AttachSheet";
import { StyleReferenceList } from "../../components/studio/StyleReferenceList";
import { PlanCard, Pill, type ThreadImageRef } from "./ThreadCards";
import { ThreadMakeIt } from "./ThreadMakeIt";
import {
  afterGenerate,
  askBody,
  checkAgainJob,
  composerAfterReject,
  continuationFrame,
  editFromChat,
  gateLineFor,
  generateFailure,
  historyPlanView,
  livePlanFrom,
  livePlanView,
  LOST_NOTE,
  notSavedLine,
  outputFromRun,
  planBody,
  promptBody,
  recoverLost,
  resolveThread,
  runsToWatch,
  supersededIds,
  toHistory,
  type HistoryItem,
  type LivePlan,
  type RunOverlay,
  type SheetJob,
} from "./threadLogic";

/**
 * A turn in the thread. `card` is what the turn offers, beyond its words. `plan` is Mila's answer to a send when
 * threads are on (EXPO_PUBLIC_STUDIO_SESSIONS) — the card for a preview the sheet rendered; nothing else makes one.
 */
type Card = "product" | "photo" | "ready" | "frame" | "plan" | null;

/** An attachment this screen can actually hold. See PickableRole in AttachSheet. */
type PickedAttachment = Attachment & { role: PickableRole };

interface Turn {
  id: string;
  who: "you" | "mila";
  text: string;
  card: Card;
  /** The live plan a `plan` turn renders. */
  planKey?: string;
  /** Threads only: the entry this turn is, so a save that failed can say so under it. */
  entryId?: string;
  /** PR 19 (R-6): the vague ask's op chips — each fills her draft on a tap; nothing is sent. */
  chips?: string[];
}

/** How long a lost run is given to reach the server before its plan entry is read to find it (`recoverLost`). */
const LOST_RECHECK_MS = 2_000;
/** Within this many points of the bottom she is still "at the tail", and the thread keeps following it. */
const TAIL_SLOP = 120;

/** A plan whose preview was spent never folds under a later check — it is where an output came from. */
const SPENT: ReadonlySet<LivePlan["state"]> = new Set([
  "making",
  "made",
  "failed",
  "stalled",
]);

const OPENERS = [
  "Put me on a rooftop at dusk, city behind me",
  "Turn my coast photo into an 8 second loop",
  "A poster for the last game, bold type",
];

/**
 * The chip label for every role she can actually attach.
 *
 * Excluding `inspiration` rather than carrying a dead entry is deliberate: a future inspiration
 * chip then fails to COMPILE instead of rendering blank. Safe because attachments aren't persisted
 * (local state + route params only; useStudioThreads is a stub). If threads ever persist,
 * inspiration becomes a legacy-draft case and these maps need a fallback, not Exclude.
 */
const ROLE_LABEL: Record<PickableRole, string> = {
  "source-frame": "YOURS",
  product: "PRODUCT",
  object: "OBJECT",
  style: "STYLE",
};

let seq = 0;
const nextId = () => `t${Date.now()}-${seq++}`;

/**
 * CreateAnythingRoute — what the navigator mounts, and the only reason it exists.
 *
 * "New thread" on the Threads screen is `navigate("StudioCreateAnything", …)`, and under React
 * Navigation 7 `navigate` does NOT mount a second screen when one of that name is already in the
 * stack: it pops back to the existing instance and merges the params in. That instance still holds
 * the previous thread's turns and — the part that matters — its attachment tray. So the button
 * labelled "New thread" handed her the old thread with the old photographs still loaded, and the
 * next thing she sent was built from them.
 *
 * `route.params.sessionId` is a React key as well as data. A new value unmounts the screen and
 * mounts a fresh one, which reinitialises every piece of state below by construction — there is no
 * list of fields to keep in sync with `useState`, and a field added later is covered for free.
 * Omitting it (StudioHome's own entry point, where nothing is in the stack to pop back to) keeps
 * whatever is there, which is what a plain push already gives.
 *
 * With EXPO_PUBLIC_STUDIO_SESSIONS on it is also WHICH thread — see ThreadRoute.
 */
export function CreateAnythingRoute() {
  const { params } = useRoute<RouteProp<StudioStackParamList, "StudioCreateAnything">>();
  if (STUDIO_SESSIONS) return <ThreadRoute named={params?.sessionId} />;
  return <CreateAnythingScreen key={params?.sessionId ?? "thread"} />;
}

/**
 * THE DOOR (D2a): the thread she named, else her latest open one, else a new one — `resolveThread`.
 *
 * The answer is written back into the route the moment it is known, so it is the route's from then on: the list
 * is read fresh on every mount, and a later read that found another thread newer (another device, say) must not
 * be able to move her out of the one she is in. A failed list is a retry, never an empty thread over hers.
 */
function ThreadRoute({ named }: { named: string | undefined }) {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const list = useSessionsList(false, true);
  const [minted] = useState(newId);
  const resolution = resolveThread(named, list.answer, () => minted);
  const resolved = resolution.kind === "thread" ? resolution.sessionId : null;

  useEffect(() => {
    if (!named && resolved) nav.setParams({ sessionId: resolved });
  }, [named, resolved, nav]);

  const availability: Availability =
    list.answer.kind === "ok"
      ? "on"
      : list.answer.kind === "unavailable"
        ? "off"
        : "unknown";

  if (resolution.kind === "thread") {
    return (
      <CreateAnythingScreen
        key={resolution.sessionId}
        sessionId={resolution.sessionId}
        availability={availability}
      />
    );
  }
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.topbar}>
        <HapticPressable
          onPress={() => nav.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <Text style={styles.topTitle}>Create anything</Text>
      </View>
      {resolution.kind === "waiting" ? (
        <View style={styles.gate}>
          <ActivityIndicator color={Colors.light.textMuted} />
        </View>
      ) : (
        <ThreadReadFailed onRetry={() => void list.refetch()} />
      )}
    </SafeAreaView>
  );
}

/** How long her words must stay still before the badge's classifier is asked about them (auto-mark). */
const DRAFT_SETTLE_MS = 600;

/** `value`, once it has stopped changing for `ms` — so a question about her words waits for her to pause. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** A read that failed is said, with a retry — never shown as an empty thread (plan §4). */
function ThreadReadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.gate}>
      <Text style={styles.gateTitle}>Couldn&apos;t load this thread</Text>
      <Text style={styles.gateBody}>
        Nothing is lost — it just didn&apos;t come through.
      </Text>
      <Pill label="Try again" icon="refresh-cw" ghost onPress={onRetry} />
    </View>
  );
}

export function CreateAnythingScreen({
  sessionId,
  availability = "off",
}: {
  /** The thread (EXPO_PUBLIC_STUDIO_SESSIONS). Absent with the flag off, and then nothing below is kept. */
  sessionId?: string;
  /** Whether the server keeps threads: its list's answer. `off` — or unknown for good — is session-only. */
  availability?: Availability;
} = {}) {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  /**
   * WHICH photograph is the frame being edited — her mark, and the reason this screen has a badge.
   *
   * It is state rather than a derivation because the whole point is that it does NOT move when the
   * tray changes: `nextFrameAssetId` only ever lets it go when the photograph it names is removed.
   * Nothing ever fills it in but her (frame defaulting): a tap on the photo, Edit this, or the continuation.
   */
  const [frameAssetId, setFrameAssetId] = useState<string | null>(null);
  /**
   * AUTO-MARK IS OFF (auto-mark, D3): she took a badge off — hers or auto-mark's — or "Not what I meant" gave back a
   * tray she had sent with no frame. Back on when the tray empties at send, or another photo of hers is attached.
   */
  const [autoOff, setAutoOff] = useState(false);
  /**
   * THE SEND IS READING HER WORDS (catch-all through the interpreter, C2; Adi's D4): the interpreter's check at send,
   * ~2s. Her words are already in the thread; the send button spins and stays off until the check is back or given
   * up on, so a second send cannot hand the same tray over twice. Never true with STUDIO_INTERPRETER off.
   */
  const [reading, setReading] = useState(false);
  /**
   * The send waiting on the frame ask (`frameChoiceNeeded`): her words, and their entry. Her answer acts on the tray
   * as it is when she taps, so a tray she fixed by hand in the meantime is not overruled by the one she sent.
   */
  const [frameAsk, setFrameAsk] = useState<{
    prompt: string;
    promptEntryId: string | null;
    /** FRAME_ASK (a marked photo beside others of her), or FRAME_PICK (several, none marked — auto-mark, D4). */
    code: typeof FRAME_ASK | typeof FRAME_PICK;
  } | null>(null);
  const [carriedOn, setCarriedOn] = useState(false);
  /** The prompt a gate stopped, if any. Null when nothing is waiting. */
  const [gated, setGated] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [picking, setPicking] = useState<PickableRole | null>(null);

  // ── threads (EXPO_PUBLIC_STUDIO_SESSIONS) — unused with the flag off ───────────────────────────────
  /** The sheet's job, and whether it is showing. Closing hides it; a check still in flight still lands. */
  const [sheet, setSheet] = useState<SheetJob | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** This mount's plans: the previews its sheets rendered, and the runs they started. Keyed by entry id. */
  const [plans, setPlans] = useState<Record<string, LivePlan>>({});
  /** Which preview each plan card is for — synchronous, so a check is carded once however often it reports. */
  const byPreview = useRef(new Map<string, string>());
  /** The prompt a gate stopped, as an entry — so the plan that finally answers it groups under it. */
  const gatedEntry = useRef<string | null>(null);
  /** What each picked asset is, so Edit this is offered only on an image. */
  const [mediaTypes, setMediaTypes] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<ThreadImageRef | null>(null);
  const input = useRef<TextInput>(null);
  const gen = useGenerate();

  // ── keeping it (and the server's half on) ────────────────────────────────────────────────────
  const kept = STUDIO_SESSIONS && !!sessionId;
  const pages = useThreadPages(sessionId ?? "", kept && availability !== "off");
  // A thread the server has just read back proves it keeps threads, whatever the list is still saying (a list
  // that failed, say) — so its entries are saved rather than held for an answer that may not come.
  const saving: Availability =
    availability === "unknown" && pages.state === "ok" ? "on" : availability;
  const queue = useAppendQueue(sessionId ?? "", kept ? saving : "off");
  /** What a watch of a HISTORY run heard since the page was read — newer than the page, so it wins. */
  const [overlays, setOverlays] = useState<Record<string, RunOverlay>>({});
  /** Every entry this mount made. They render live; a re-read that includes them must not render them twice. */
  const liveIds = useMemo(
    () => new Set(turns.flatMap((t) => (t.entryId ? [t.entryId] : []))),
    [turns],
  );
  const history = useMemo(
    () => toHistory(pages.pages, liveIds),
    [pages.pages, liveIds],
  );
  const notSavedFor = (entryId: string | undefined) => {
    const reason = entryId ? queue.failed[entryId] : undefined;
    return reason ? notSavedLine(reason) : null;
  };

  /** The last image she declined to continue from (the indicator's ×) — so her next send starts fresh. */
  const [declined, setDeclined] = useState<string | null>(null);
  /**
   * CONTINUATION (`continuationFrame`): with nothing in the tray, her next send edits the thread's latest image —
   * history's and this mount's, in thread order, a watch's answer over the page's. Null with the flag off, and
   * whenever the tray holds anything.
   */
  const continuation = useMemo(() => {
    if (!STUDIO_SESSIONS) return null;
    const none = new Set<string>();
    const cards = [
      ...history.items.flatMap((it) =>
        it.kind === "plan"
          ? [
              historyPlanView(it.entry, {
                assets: history.assets,
                prompts: history.prompts,
                collapsed: none,
                overlay: overlays[it.entry.id],
              }),
            ]
          : [],
      ),
      ...turns.flatMap((t) => {
        const p = t.planKey ? plans[t.planKey] : undefined;
        return p ? [livePlanView(p, { collapsed: none, mediaTypes })] : [];
      }),
    ];
    return continuationFrame(cards, attachments, declined);
  }, [history, overlays, turns, plans, mediaTypes, attachments, declined]);

  const scroller = useRef<ScrollView>(null);
  /**
   * Threads: whether she is at the bottom of the thread. The thread follows its tail — unless she has scrolled up
   * to read, when "Load earlier" or an image landing above must not yank her down. With the flag off it stays
   * true, and every content change scrolls to the end exactly as before.
   */
  const atTail = useRef(true);
  const toTail = useCallback(() => {
    atTail.current = true;
    requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }));
  }, []);

  const say = useCallback(
    (who: Turn["who"], text: string, card: Card = null, entryId?: string) => {
      setTurns((t) => [
        ...t.filter((x) => x.card !== "ready"),
        { id: nextId(), who, text, card, entryId },
      ]);
      toTail();
    },
    [toTail],
  );

  const gateState = useMemo(() => ({ attachments, carriedOn }), [attachments, carriedOn]);

  // ── auto-mark: the EDITING badge follows her words (auto-mark, 2026-09-16) ───────────────────────────
  /**
   * With one photo of hers in the tray and an edit-shaped sentence in the box, that photo is badged as the frame —
   * the job goes out as if she had tapped it (createAnythingLogic, `autoFrame`). The classifier is asked about her
   * words once she pauses, tagged `draft` so a half-typed sentence never lands in its log, and only while auto-mark
   * could apply: a photo of hers attached, none marked by her, and not switched off. The answer is a hint for the
   * BADGE only — what is sent is decided at send, on the exact words sent (`resolveSend`).
   */
  const settledDraft = useSettled(draft, DRAFT_SETTLE_MS);
  const probing =
    STUDIO_SERVER_ROUTING &&
    canvasesIn(attachments, mediaTypes).length > 0 &&
    !markedFrame(attachments, frameAssetId) &&
    !autoOff;
  const draftShape = useStudioClassify(
    settledDraft,
    true,
    probing,
    objectPhotosIn(attachments),
    "draft",
    // PR 19 (B): her Style tile, so the badge reads "match this look" as the send will. Zero with the flag off.
    STUDIO_IMAGE_OPS ? stylePhotosIn(attachments) : 0,
  );
  // Nothing typed, nothing badged: a draft answer kept from earlier words never outlives the words themselves.
  const auto = draft.trim()
    ? autoFrame(
        attachments,
        { frameAssetId, autoOff },
        autoMarkShape(
          STUDIO_SERVER_ROUTING,
          draftShape.data,
          STUDIO_SERVER_ROUTING ? settledDraft : draft,
          attachments,
          STUDIO_IMAGE_OPS,
        ),
        mediaTypes,
      )
    : null;
  const badged = badgedFrame(attachments, { frameAssetId, autoOff }, auto);
  /**
   * The tray and mark AS THEY ARE, for `resolveSend` to read after its question comes back — a tap while it was in
   * flight must win over the render that sent. Kept current after every commit, and at once by a tap.
   */
  const latest = useRef({
    tray: attachments,
    mark: { frameAssetId, autoOff },
    mediaTypes,
  });
  useEffect(() => {
    latest.current = { tray: attachments, mark: { frameAssetId, autoOff }, mediaTypes };
  });

  // ── sending ─────────────────────────────────────────────────────────────────────────────────
  const send = () => {
    const text = draft.trim();
    if (!canSend(text) || reading) return;
    setDraft("");
    // A frame ask still open belongs to the words before these: its answers go, its question stays in the thread.
    retireFrameAsk();
    // Threads: her words are an entry from the moment she sends them, whatever happens next.
    const entryId = STUDIO_SESSIONS ? newId() : undefined;
    say("you", text, null, entryId);

    // CONTINUATION: nothing in the tray, and the thread has made something — that image is the frame, put there
    // exactly as Edit this would. It answers the photo gate the way attaching her photo does.
    const carried = continuation ? editFromChat([], continuation) : null;
    if (carried) {
      setMediaTypes((t) => ({ ...t, [carried.frameAssetId]: "IMAGE" }));
    }
    const missing = whatIsMissing(
      text,
      carried ? { attachments: carried.tray, carriedOn } : gateState,
    );
    if (entryId) queue.append(promptBody(entryId, text, missing));
    if (carried && missing) {
      // A gate stopped it: the frame waits in the tray as a chip, so it is still the frame when she answers.
      setAttachments(carried.tray);
      setFrameAssetId(carried.frameAssetId);
    }
    if (missing === "product") {
      setGated(text);
      gatedEntry.current = entryId ?? null;
      say("mila", "You are naming a specific product and I have never seen it. If I generate now I will invent one that looks close but is not theirs.", "product");
      return;
    }
    if (missing === "photo") {
      setGated(text);
      gatedEntry.current = entryId ?? null;
      say("mila", "That puts something onto you, so I need a photo of you to put it into.", "photo");
      return;
    }
    make(text, entryId ?? null, carried);
  };

  /**
   * Out to the plan. Nothing has been spent at this point and nothing will be until she presses the
   * button on the Make it screen — this hands over what she asked for and what she attached, and
   * that screen renders the preview.
   *
   * ─── THE TRAY IS EMPTIED ON THE WAY OUT ────────────────────────────────────────────────────────
   * Every send here is a SEPARATE job, and this screen stays mounted underneath Make it — so an
   * attachment used to survive into the next one. Come back, type something completely different,
   * send, and the previous piece's photographs went with it: the tray was cumulative while the
   * prompt was not. That is how one job's references ended up conditioning another's.
   *
   * `handOff` takes the snapshot and returns the empty tray in one place, so the rule is a tested
   * property (createAnythingLogic.test.ts) rather than a line here that a later edit can drop. The
   * turns stay: the thread is the conversation, and the conversation is not an input to anything.
   *
   * ─── A MARKED PHOTO BESIDE OTHER PHOTOS OF HER ASKS FIRST (frame defaulting, F.4) ─────────────────
   * An edit cannot also be built from photos of her (`refusedOnEdit`), so that tray never reaches a check: Mila
   * asks which she meant (`askFrame`), and her answer comes back here with the tray and frame it chose.
   */
  const make = (
    prompt: string,
    promptEntryId: string | null = null,
    /**
     * The tray and frame to send INSTEAD of the screen's: the continuation's (threads — see send), or the one her
     * answer to the frame ask chose. A null frame here is a real "no frame", never "use the screen's", and auto-mark
     * has no say in it: her answer, or the thread's continuation, already decided.
     */
    material: {
      tray: PickedAttachment[];
      frameAssetId: string | null;
    } | null = null,
  ) => {
    if (material) {
      hand(prompt, promptEntryId, material);
      return;
    }
    // THE SCREEN'S TRAY: her mark, or auto-mark's on the exact words sent — asked again, never read off the badge.
    // And words the rules could not read, with one photo of hers, are read by the interpreter first (C2): a proposal
    // marks the photo and its preview goes to the sheet as the seed; anything else is a new image.
    void resolveSend({
      text: prompt,
      routing: STUDIO_SERVER_ROUTING,
      current: () => latest.current,
      ask: (text, objectPhotos, stylePhotos) =>
        classifyNow(text, true, objectPhotos, "shape", stylePhotos ?? 0),
      interpreter: STUDIO_INTERPRETER,
      imageOps: STUDIO_IMAGE_OPS,
      preview: previewNow,
      onReading: setReading,
    }).then((r) =>
      r.kind === "ask"
        ? // Several photos of her and words asking for an edit: she says which (D4). Nothing is checked yet.
          askFrame(prompt, promptEntryId, r.tray, null, r.code)
        : hand(
            prompt,
            promptEntryId,
            { tray: r.tray, frameAssetId: r.frameAssetId },
            r.seed,
          ),
    );
  };

  /** The send itself, with its tray and frame decided — and the preview the send already checked, when it did (C2). */
  const hand = (
    prompt: string,
    promptEntryId: string | null,
    material: { tray: PickedAttachment[]; frameAssetId: string | null },
    seed?: PreviewSeed,
  ) => {
    const tray0 = material.tray;
    const frame0 = material.frameAssetId;
    if (frameChoiceNeeded(tray0, frame0)) {
      askFrame(prompt, promptEntryId, tray0, frame0);
      return;
    }
    setGated(null);
    gatedEntry.current = null;
    const { sent, tray } = handOff(tray0);
    if (STUDIO_SESSIONS) {
      // THE SHEET, OVER THE THREAD (D1a). The same Make it, the same snapshot of the tray — handOff's rule holds
      // exactly as it does for the push below — and nothing navigates: the answer lands in this thread.
      setSheet({
        key: newId(),
        promptEntryId,
        prompt,
        attachments: sent,
        frameAssetId: frame0,
        carriedOn,
        format: "photo",
        ...(seed ? { seed } : {}),
      });
      setSheetOpen(true);
      // Nothing navigates any more, so nothing takes the keyboard down: the sheet would open under it on iOS.
      input.current?.blur();
    } else {
      nav.navigate("StudioMakeIt", {
        title: prompt,
        line: "Made from what you said and what you attached.",
        // Nothing here picks a format. Motion is a choice she has not been offered yet, and the
        // engine task follows from the format — see engineIntentFor().
        format: "photo",
        attachments: sent,
        // Her mark travels rather than being worked out again from the tray — see the param's note.
        frameAssetId: frame0,
        // The prompt IS the direction on this screen. `title` carries the same words for display;
        // this is the copy the brief actually reads, so her sentence reaches the model verbatim
        // rather than only labelling the plan.
        direction: prompt,
        // What the send already checked (C2): Make it shows it rather than asking again.
        ...(seed ? { seed } : {}),
      });
    }
    setAttachments(tray);
    // ⚠️ THE MARK GOES WITH THE TRAY. `handOff` empties the tray because every send is its own job;
    // a mark left behind names a photograph that is no longer here, and the next send would carry a
    // frame she can no longer see (and, beside a new photo of hers, be asked about it).
    //
    // Re-resolved through the same rule the tray uses everywhere else rather than set to null by
    // hand: "the mark is whatever `nextFrameAssetId` says about the tray in front of you" is one
    // sentence and one tested function, and an emptied tray already returns null from it.
    setFrameAssetId((current) => nextFrameAssetId(tray, current));
    // A new tray, a new question: auto-mark is back on for whatever she attaches next (D3).
    setAutoOff(false);
  };

  /**
   * THE FRAME ASK — Mila's question in the thread, with both answers on its card. Nothing is checked or spent. With
   * threads kept it is an ask entry like the classifier's (`askBody`, FRAME_ASK), carrying the tray she sent, so
   * history shows the question where it was asked.
   */
  const askFrame = (
    prompt: string,
    promptEntryId: string | null,
    tray: PickedAttachment[],
    frame: string | null,
    code: typeof FRAME_ASK | typeof FRAME_PICK = FRAME_ASK,
  ) => {
    // Whatever gate this came through is answered: what is open now is this question.
    setGated(null);
    gatedEntry.current = null;
    setFrameAsk({ prompt, promptEntryId, code });
    const entryId = STUDIO_SESSIONS ? newId() : undefined;
    if (entryId) {
      queue.append(
        askBody(entryId, code, {
          promptEntryId,
          prompt,
          attachments: tray,
          frameAssetId: frame,
          carriedOn,
          format: "photo",
        }),
      );
    }
    // F-AM7: the ask fires for a clip exactly as it does for a photo — only the sentence changes.
    // `frameCompanions` is null for FRAME_PICK (nothing is marked), and `askCopyFor` reads the
    // option for `frame_with_likeness` alone, so the other codes are untouched.
    say(
      "mila",
      askCopyFor(code, { companions: frameCompanions(tray, frame, mediaTypes) ?? undefined }),
      "frame",
      entryId,
    );
  };

  /** The question stays in the thread; its answers go. Used by an answer, "Never mind", and a new send. */
  const retireFrameAsk = () => {
    setFrameAsk(null);
    setTurns((t) =>
      t.map((x) => (x.card === "frame" ? { ...x, card: null } : x)),
    );
  };

  /** Her answer — `frameChoice` over the tray in front of her now, then the send it was holding. */
  const answerFrame = (choice: FrameChoice) => {
    const asked = frameAsk;
    if (!asked) return;
    // "Edit the marked photo" is only offered once one is marked; with none, it is not an answer (the pick ask).
    if (choice === "edit" && !markedFrame(attachments, frameAssetId)) return;
    retireFrameAsk();
    make(
      asked.prompt,
      asked.promptEntryId,
      frameChoice(attachments, frameAssetId, choice),
    );
  };

  // ── the thread's answers (EXPO_PUBLIC_STUDIO_SESSIONS) ───────────────────────────────────────
  const updatePlan = useCallback(
    (entryId: string, f: (p: LivePlan) => LivePlan) => {
      setPlans((all) =>
        all[entryId] ? { ...all, [entryId]: f(all[entryId]) } : all,
      );
    },
    [],
  );

  /** The card for a check the sheet rendered — once per preview, however many times it is reported. */
  const cardFor = (
    job: SheetJob,
    previewId: string,
    plan: GenerationPlanView,
  ): string => {
    const known = byPreview.current.get(previewId);
    if (known) return known;
    const entryId = newId();
    byPreview.current.set(previewId, entryId);
    setPlans((all) => ({
      ...all,
      [entryId]: livePlanFrom(entryId, job, { ...plan, previewId }),
    }));
    setTurns((t) => [
      ...t.filter((x) => x.card !== "ready"),
      {
        id: nextId(),
        who: "mila",
        text: "",
        card: "plan",
        planKey: entryId,
        entryId,
      },
    ]);
    toTail();
    // Kept: the plan names the preview she was shown. The server's unique index on it dedupes a retry.
    queue.append(planBody(entryId, previewId, job));
    return entryId;
  };

  /** The check asked instead of pricing — Mila's reply, in the thread, in the words Make it shows. */
  const askIn = (job: SheetJob, reason: string, suggestions?: string[]) => {
    const entryId = newId();
    if (suggestions?.length) {
      // PR 19 (R-6): the vague ask, with its op chips on the same turn. Only the code is saved to her thread, as
      // for every ask; the chips are the server's fixed list and come back with the next classify.
      setTurns((t) => [
        ...t.filter((x) => x.card !== "ready"),
        {
          id: nextId(),
          who: "mila",
          text: askCopyFor(reason),
          card: null,
          entryId,
          chips: suggestions,
        },
      ]);
      toTail();
    } else {
      say("mila", askCopyFor(reason), null, entryId);
    }
    queue.append(askBody(entryId, reason, job));
  };

  /**
   * SHE APPROVED. The sheet closes and the THREAD runs it — the same `useGenerate`, the same `{ previewId }` body,
   * the only generate call site this screen has — so the run outlives the sheet and its answer lands on the card,
   * in place of the loading tile. See `afterGenerate` for what the answer means and `generateFailure` for why a
   * dropped connection is not reported as a failure.
   */
  const startRun = (entryId: string, previewId: string) => {
    updatePlan(entryId, (p) => ({ ...p, state: "making", note: null }));
    toTail();
    gen.mutateAsync({ previewId }).then(
      (run) => {
        const u = afterGenerate(run);
        updatePlan(entryId, (p) => ({
          ...p,
          state: u.state,
          jobId: u.jobId,
          outputs: u.state === "made" ? u.outputs : p.outputs,
          note: u.note,
        }));
      },
      (err: unknown) => {
        const f = generateFailure(err);
        if (f.kind === "failed") {
          updatePlan(entryId, (p) => ({ ...p, state: "failed", note: f.note }));
          return;
        }
        // LOST. The tile stays while the thread finds out what happened — the plan entry, read a moment later,
        // says whether the preview was spent and on which job (`recoverLost`). Session-only, there is nothing to
        // read, so it says where to look instead.
        if (!sessionId || saving !== "on") {
          updatePlan(entryId, (p) => ({
            ...p,
            state: "stalled",
            note: LOST_NOTE,
          }));
          return;
        }
        setTimeout(() => {
          void readPlanEntry(sessionId, entryId).then((entry) => {
            const r = recoverLost(entry);
            updatePlan(entryId, (p) => ({
              ...p,
              state: r.state,
              jobId: r.jobId,
              note: r.note,
            }));
          });
        }, LOST_RECHECK_MS);
      },
    );
  };

  /** "Not what I meant", recorded: the card says so, and her words — with what they were about — come back. */
  const rejectedIn = (job: SheetJob, previewId: string) => {
    setSheetOpen(false);
    const entryId = byPreview.current.get(previewId);
    if (entryId)
      updatePlan(entryId, (p) => ({ ...p, state: "not_meant", note: null }));
    const next = composerAfterReject(
      { draft, tray: attachments, frameAssetId },
      job,
    );
    setDraft(next.draft);
    setAttachments(next.tray);
    setFrameAssetId(next.frameAssetId);
    // A tray given back with no frame was a new image, and stays one on her next send (auto-mark, D3).
    setAutoOff((off) => autoOffAfterReject({ tray: attachments, autoOff: off }, job));
  };

  /** A FRESH check from a card's material — never a Generate over a preview this sheet did not render. */
  const checkAgain = (job: Omit<SheetJob, "key">) => {
    setSheet({ ...job, key: newId() });
    setSheetOpen(true);
  };

  /**
   * THE RE-ATTACH. Every run the thread is waiting on: this mount's that answered "already running" (or that a
   * lost connection turned out to be making), and every history plan the server says is still making — the
   * resume rule, `runsToWatch`. Each lands in place when it settles.
   */
  const watches = useMemo(
    () => [
      ...Object.values(plans).flatMap((p) =>
        p.state === "making" && p.jobId
          ? [{ key: p.entryId, jobId: p.jobId }]
          : [],
      ),
      ...runsToWatch(history.items, overlays).map((w) => ({
        key: w.entryId,
        jobId: w.jobId,
      })),
    ],
    [plans, history.items, overlays],
  );
  useRunWatch(watches, (key, outcome, read) => {
    const outputs = (read?.assets ?? []).map(outputFromRun);
    if (plans[key]) {
      updatePlan(key, (p) =>
        outcome === "made"
          ? { ...p, state: "made", outputs, note: null }
          : { ...p, state: outcome, note: null },
      );
      return;
    }
    setOverlays((o) => ({ ...o, [key]: { state: outcome, outputs } }));
  });

  /** Which plans fold under a later check for the same words — history's and this mount's, in thread order. */
  const collapsed = useMemo(
    () =>
      supersededIds([
        ...history.items.flatMap((it) =>
          it.kind === "plan"
            ? [
                {
                  id: it.entry.id,
                  promptEntryId: it.entry.promptEntryId,
                  consumed: it.entry.run !== null,
                },
              ]
            : [],
        ),
        ...turns.flatMap((t) => {
          const p = t.planKey ? plans[t.planKey] : undefined;
          return p
            ? [
                {
                  id: p.entryId,
                  promptEntryId: p.job.promptEntryId,
                  consumed: SPENT.has(p.state),
                },
              ]
            : [];
        }),
      ]),
    [history.items, turns, plans],
  );

  // ── attaching ───────────────────────────────────────────────────────────────────────────────
  /**
   * ATTACHING IS NOT MARKING (frame defaulting). A photo of hers lands in the tray as her likeness, and the mark —
   * if she has one — does not move, however many photos arrive around it.
   *
   * ─── THE SECOND PHOTOGRAPH OF HERS USED TO BE A QUESTION HERE ─────────────────────────────────
   * "You have two of your own photos on this now. Which one am I working on?" fired the moment a second photo of
   * hers arrived beside the mark, because the mark was defaulted onto the first. Its "keep the first — use this as
   * a reference" answer always ended in the server's refusal: an edit cannot also be built from photos of her. The
   * question now waits until she sends, and asks what can actually be made — edit the marked one, or a new image
   * from all of them (`askFrame`, Adi's D1 option B). A tray with no mark asks nothing: it is a new image already.
   */
  const addAttachment = (a: PickedAttachment) => {
    const next = [...attachments, a];
    setAttachments(next);
    // Another photo of hers is a new question for auto-mark, even after she switched it off (D3).
    setAutoOff((off) => autoOffAfterAttach(a.role, off));
    resolveAfterAttach({ attachments: next, carriedOn });
  };

  const carryOnWithout = () => {
    setCarriedOn(true);
    setTurns((t) => t.filter((x) => x.card !== "product"));
    // Copy reviewed and approved by Adi, wave C card 2 (row 13). The line used to open "Fine —",
    // which conceded a dispute she was not having: she tapped a button we offered her. It then said
    // "I will not pass it off as the real product", which puts the suspicion on HER rather than
    // stating what we will do. And it left her nowhere to go. The commitment is kept — "rather than
    // their actual product" says exactly what the output will be — and the way back is named, because
    // the Product tile stays reachable from ＋ for the whole composer.
    say("mila", "Then it will be a generic one rather than their actual product. Attach a photo of it any time and I will use that instead.");
    resolveAfterAttach({ attachments, carriedOn: true });
  };

  /** Never generates. Offers the press when nothing is missing; names the next ask when something is. */
  const resolveAfterAttach = (state: { attachments: Attachment[]; carriedOn: boolean }) => {
    const outcome = afterAttach(gated, state);
    setTurns((t) => t.filter((x) => x.card !== "ready" && x.card !== "product" && x.card !== "photo"));
    if (outcome.next === "ready") {
      say("mila", "That is what I was missing.", "ready");
    } else if (outcome.next === "ask") {
      say(
        "mila",
        outcome.missing === "product"
          ? "Still need to see the actual product."
          : "Good. It still needs a photo of you to put that into.",
        outcome.missing,
      );
    } else {
      toTail();
    }
  };

  /**
   * EDIT THIS (plan v2 §4) — any image in the thread, an output or a photo it was built from, becomes THE frame
   * being edited: into the tray as hers, with the mark on it (`editFromChat`). There is no "which one?" — the tap
   * is the answer. A gate waiting for a photo of her is satisfied exactly as attaching one would satisfy it.
   * Nothing is pre-filled (D5): the composer asks "What should change?", and her next send's check is an edit of
   * this image, its card and result landing below.
   */
  const editThis = (image: ThreadImageRef) => {
    if (!image.editable || !image.uri) return;
    setViewing(null);
    const next = editFromChat(attachments, {
      assetId: image.assetId,
      uri: image.uri,
    });
    setAttachments(next.tray);
    setFrameAssetId(next.frameAssetId);
    setMediaTypes((t) => ({ ...t, [image.assetId]: "IMAGE" }));
    resolveAfterAttach({ attachments: next.tray, carriedOn });
    input.current?.focus();
  };

  /**
   * A TAP ON A PHOTO OF HERS IN THE TRAY: it becomes the frame, or — if it already was — stops being one
   * (`toggleFrame`). The badge follows. Nothing is asked and nothing else in the tray moves; the gate reads roles,
   * not the mark, so there is nothing to re-check. An open frame ask stays open — its answers read the tray as it is.
   */
  const tapFrame = (assetId: string | null) => {
    // Over the badge she can SEE, auto-mark's included: taking it off keeps auto-mark off (`tapBadge`, D3). The ref
    // moves at once, so a send in the same instant — or one already asking — reads her tap, not the render before it.
    const next = tapBadge(attachments, { frameAssetId, autoOff }, auto, assetId);
    latest.current = { ...latest.current, mark: next };
    setFrameAssetId(next.frameAssetId);
    setAutoOff(next.autoOff);
  };

  const removeAttachment = (id: string) =>
    setAttachments((a) => {
      const next = a.filter((x) => x.id !== id);
      // The mark can outlive the photograph it names, so it is re-resolved against what is left —
      // `nextFrameAssetId` keeps it where it is unless the photograph itself is gone.
      setFrameAssetId((current) => nextFrameAssetId(next, current));
      return next;
    });

  const dismissCard = (card: Card) =>
    setTurns((t) => t.filter((x) => x.card !== card));

  const ready = canSend(draft) && !reading;

  /**
   * The opener is for a thread with nothing in it — not for one whose history is still loading, and never for one
   * whose read failed (that says so instead). With the flag off it is exactly `turns.length === 0`.
   */
  const showOpener =
    turns.length === 0 &&
    (!kept ||
      (pages.state !== "loading" &&
        pages.state !== "error" &&
        history.items.length === 0));

  const onThreadScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    atTail.current =
      contentOffset.y + layoutMeasurement.height >=
      contentSize.height - TAIL_SLOP;
  };

  /**
   * HISTORY — inert (see threadLogic's header). Her words, what stopped them, Mila's asks, and each plan as the
   * server now derives it, with a watch's newer answer laid over it. The only doors out start something new.
   */
  const renderHistory = (it: HistoryItem) => {
    if (it.kind === "prompt") {
      const gate = gateLineFor(it.entry.stoppedFor);
      return (
        <React.Fragment key={it.key}>
          <View style={styles.youRow}>
            <View style={styles.youBubble}>
              <Text style={styles.youTxt}>{it.entry.text}</Text>
            </View>
          </View>
          {gate ? (
            <MilaRow>
              <Text style={styles.milaTxt}>{gate}</Text>
            </MilaRow>
          ) : null}
        </React.Fragment>
      );
    }
    if (it.kind === "ask") {
      return (
        <MilaRow key={it.key}>
          <Text style={styles.milaTxt}>{askCopyFor(it.entry.reason)}</Text>
        </MilaRow>
      );
    }
    const entry = it.entry;
    const view = historyPlanView(entry, {
      assets: history.assets,
      prompts: history.prompts,
      collapsed,
      overlay: overlays[entry.id],
    });
    const card = (
      <PlanCard
        view={view}
        onCheckAgain={() => {
          const job = checkAgainJob(
            entry,
            entry.promptEntryId
              ? history.prompts.get(entry.promptEntryId)
              : undefined,
            history.assets,
          );
          if (job) checkAgain(job);
        }}
        // quality-scrappy piece 5: the same fresh check, carrying the gate's fix — her tap on its quote is the spend.
        onTryAgain={(corrective) => {
          const job = checkAgainJob(
            entry,
            entry.promptEntryId
              ? history.prompts.get(entry.promptEntryId)
              : undefined,
            history.assets,
          );
          if (job) checkAgain({ ...job, corrective });
        }}
        onOpen={setViewing}
        onEdit={editThis}
        onOpenDetail={(assetId) => nav.navigate("MediaDetail", { assetId })}
      />
    );
    return view.collapsed ? (
      <React.Fragment key={it.key}>{card}</React.Fragment>
    ) : (
      <MilaRow key={it.key}>{card}</MilaRow>
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.topbar}>
        <HapticPressable onPress={() => nav.goBack()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <Text style={styles.topTitle}>Create anything</Text>
        {STUDIO_SESSIONS ? (
          // A new thread: a new id is a new key (see CreateAnythingRoute), so this is a fresh mount with an
          // empty tray — and the one she leaves stays open in Threads, untouched (D3a).
          <HapticPressable
            style={styles.threadsBtn}
            onPress={() => nav.setParams({ sessionId: newId() })}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="New thread"
          >
            <Feather name="plus" size={17} color={Colors.light.textSecondary} />
          </HapticPressable>
        ) : null}
        <HapticPressable
          style={styles.threadsBtn}
          onPress={() => nav.navigate("StudioThreads")}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Your threads"
        >
          <Feather name="list" size={17} color={Colors.light.textSecondary} />
        </HapticPressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={8}
      >
        <ScrollView
          ref={scroller}
          style={{ flex: 1 }}
          contentContainerStyle={styles.thread}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => {
            if (atTail.current)
              scroller.current?.scrollToEnd({ animated: false });
          }}
          onScroll={kept ? onThreadScroll : undefined}
          scrollEventThrottle={kept ? 64 : undefined}
        >
          {kept && pages.state === "loading" ? (
            <View style={styles.threadNote}>
              <ActivityIndicator color={Colors.light.textMuted} />
            </View>
          ) : null}
          {kept && pages.state === "error" ? (
            <ThreadReadFailed onRetry={() => void pages.refetch()} />
          ) : null}
          {kept && pages.hasEarlier ? (
            <View style={styles.threadNote}>
              {pages.loadingEarlier ? (
                <ActivityIndicator color={Colors.light.textMuted} />
              ) : (
                <Pill
                  label={
                    pages.earlierFailed
                      ? "Couldn't load — try again"
                      : "Load earlier"
                  }
                  icon="chevron-up"
                  ghost
                  onPress={() => {
                    atTail.current = false;
                    void pages.loadEarlier();
                  }}
                />
              )}
            </View>
          ) : null}
          {kept ? history.items.map(renderHistory) : null}

          {showOpener ? (
            <View style={styles.opener}>
              <Text style={styles.openerTitle}>What do you want to make?</Text>
              <Text style={styles.openerSub}>An image, a video, an edit, a concept. Just say it.</Text>
              <View style={styles.openerList}>
                {OPENERS.map((o) => (
                  <HapticPressable
                    key={o}
                    style={styles.openerRow}
                    onPress={() => setDraft(o)}
                    accessibilityRole="button"
                    accessibilityLabel={o}
                  >
                    <Text style={styles.openerTxt}>{o}</Text>
                  </HapticPressable>
                ))}
              </View>
            </View>
          ) : null}
          {turns.map((t) => {
            const plan =
              t.card === "plan" && t.planKey ? plans[t.planKey] : undefined;
            if (plan) {
              const view = livePlanView(plan, { collapsed, mediaTypes });
              const card = (
                <PlanCard
                  view={view}
                  notSaved={notSavedFor(t.entryId)}
                  onCheckAgain={() => checkAgain(plan.job)}
                  onTryAgain={(corrective) =>
                    checkAgain({ ...plan.job, corrective })
                  }
                  onOpen={setViewing}
                  onEdit={editThis}
                  onOpenDetail={(assetId) =>
                    nav.navigate("MediaDetail", { assetId })
                  }
                />
              );
              return view.collapsed ? (
                <React.Fragment key={t.id}>{card}</React.Fragment>
              ) : (
                <MilaRow key={t.id}>{card}</MilaRow>
              );
            }
            return (
              <Bubble
                key={t.id}
                turn={t}
                notSaved={notSavedFor(t.entryId)}
                onPickRole={(role) => setPicking(role)}
                onCarryOn={carryOnWithout}
                onDismiss={() =>
                  t.card === "frame" ? retireFrameAsk() : dismissCard(t.card)
                }
                onMake={() => make(gated ?? "", gatedEntry.current)}
                onFrame={answerFrame}
                frameCode={frameAsk?.code ?? FRAME_ASK}
                frameMarked={!!markedFrame(attachments, frameAssetId)}
                onChip={setDraft}
              />
            );
          })}
        </ScrollView>

        <View style={styles.composer}>
          {/* Threads: what her next send will edit, when she has attached nothing — visible, and declinable. */}
          {continuation ? (
            <View
              style={styles.continuing}
              accessible
              accessibilityLabel="Your next message edits your last image"
            >
              <Image
                source={{ uri: continuation.uri }}
                style={styles.continuingThumb}
              />
              <Feather name="arrow-up" size={12} color={Colors.light.primary} />
              <Text style={styles.continuingTxt}>Editing your last image</Text>
              <HapticPressable
                style={styles.continuingX}
                onPress={() => setDeclined(continuation.assetId)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Start fresh instead"
              >
                <Feather
                  name="x"
                  size={12}
                  color={Colors.light.textSecondary}
                />
              </HapticPressable>
            </View>
          ) : null}
          {/*
            F-CA4, the badge she sees while typing — wave C card 2.

            The EDITING badge follows `autoMarkShape` on the DRAFT answer, and for an S2 ask the interpreter
            takes, the photo is marked only if the reading at send proposes. "put me mid-air dunking" is badged
            as she types, the interpreter declines at send, and she gets a new image with the badge gone. The
            badge was not wrong — it was a draft — but nothing said so, so it read as a promise.

            Said only over AUTO-MARK's badge, never over hers: a mark she placed herself is not a guess and is
            not going to be withdrawn. Hiding the auto badge instead would move D2's live badge, which F-CA4
            rules out; this tells the truth and leaves the badge where it is.
          */}
          {badged && badged !== frameAssetId ? (
            <Text style={styles.draftBadgeNote}>
              We&rsquo;ll try to edit this photo. If your words turn out to need a new picture, we&rsquo;ll make one instead.
            </Text>
          ) : null}

          {attachments.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tray}
            >
              {attachments.map((a) => {
                /**
                 * THE BADGE IS HER MARK, AND ONLY HER MARK (frame defaulting, 2026-09-16).
                 *
                 * It used to appear only with two or more photos of hers, because the mark was
                 * DEFAULTED onto the first one — on a single photo the label would have been wrong
                 * on every generate ("create an adidas ad featuring me"), so it was hidden, and the
                 * frame stayed marked underneath where she could neither see nor clear it. Nothing
                 * is defaulted now, so the badge is shown wherever a photo is marked, one photo or
                 * several, and is never on a photo she did not mark.
                 *
                 * AUTO-MARK, 2026-09-16: or on the ONE photo of hers auto-mark badged because her words are
                 * edit-shaped (`autoFrame`). It is the same badge on purpose — it is the frame the send will
                 * carry, whoever put it there — and the same tap takes it off.
                 */
                // By role as well as id: the same photo can sit in the tray twice, as hers and as a product.
                // Hers, or auto-mark's (`badged`): the badge she sees is the frame the send will carry.
                const isFrame =
                  a.role === "source-frame" && !!a.assetId && a.assetId === badged;
                // Only a photograph of HERS can be the frame, so only those are tappable — a
                // product or an object has nothing to become. The marked one is tappable too: a
                // second tap takes the badge off.
                const canTap = a.role === "source-frame" && !!a.assetId;
                return (
                <View key={a.id} style={styles.chip}>
                  <HapticPressable
                    style={styles.chipImg}
                    disabled={!canTap}
                    onPress={() => tapFrame(a.assetId)}
                    accessibilityRole={canTap ? "button" : "image"}
                    accessibilityLabel={
                      isFrame
                        ? `${a.name}. This is the photo being edited. Tap to stop editing it.`
                        : canTap
                          ? `${a.name}. Tap to edit this photo.`
                          : a.name
                    }
                    accessibilityState={canTap ? { selected: isFrame } : undefined}
                  >
                    {a.uri ? (
                      <Image source={{ uri: a.uri }} style={StyleSheet.absoluteFill} />
                    ) : (
                      <View style={[StyleSheet.absoluteFill, styles.chipBlank]}>
                        <Feather name="link" size={16} color={Colors.light.primary} />
                      </View>
                    )}
                    <View style={styles.chipScrim} />
                    <Text style={styles.chipRole}>{ROLE_LABEL[a.role]}</Text>
                    {isFrame ? (
                      <View style={styles.chipFrame}>
                        <Feather name="edit-2" size={8} color={Colors.light.buttonText} />
                        <Text style={styles.chipFrameTxt}>EDITING</Text>
                      </View>
                    ) : null}
                  </HapticPressable>
                  <HapticPressable
                    style={styles.chipX}
                    onPress={() => removeAttachment(a.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${a.name}`}
                  >
                    <Feather name="x" size={10} color={Colors.light.buttonText} />
                  </HapticPressable>
                </View>
                );
              })}
            </ScrollView>
          ) : null}

          <View style={styles.inputRow}>
            <HapticPressable
              style={styles.plus}
              onPress={() => setAttachOpen(true)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Add something"
            >
              <Feather name="plus" size={18} color={Colors.light.textSecondary} />
            </HapticPressable>
            <TextInput
              ref={input}
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={
                // An edit is coming: the thread's continuation, or a photo she marked (the badge, or Edit this).
                continuation || markedFrame(attachments, frameAssetId)
                  ? "What should change?"
                  : "Describe what you want…"
              }
              placeholderTextColor={Colors.light.tabIconDefault}
              multiline
              onSubmitEditing={send}
            />
            <HapticPressable
              style={[styles.send, !ready && styles.sendOff]}
              onPress={send}
              disabled={!ready}
              accessibilityRole="button"
              accessibilityLabel="Send"
              accessibilityState={
                reading ? { disabled: true, busy: true } : { disabled: !ready }
              }
            >
              {reading ? (
                // The interpreter is reading her words (C2) — the ~2s before the sheet opens.
                <ActivityIndicator
                  size="small"
                  color={Colors.light.textMuted}
                />
              ) : (
                <Feather name="arrow-right" size={17} color={ready ? Colors.light.buttonText : Colors.light.tabIconDefault} />
              )}
            </HapticPressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <AttachSheet visible={attachOpen} onClose={() => setAttachOpen(false)} onPick={(r) => setPicking(r)} />

      {/* The SOURCE choice, once the role is known. Same library everywhere else uses. */}
      <Modal visible={picking !== null} animationType="slide" onRequestClose={() => setPicking(null)}>
        <SafeAreaView style={styles.safe}>
          <View style={styles.topbar}>
            <HapticPressable onPress={() => setPicking(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
              <Feather name="chevron-left" size={22} color={Colors.light.text} />
            </HapticPressable>
            <Text style={styles.topTitle}>
              {picking === "product"
                ? "Which product is it?"
                : picking === "style"
                  ? "Pick a look you've had read"
                  : "Pick from your library"}
            </Text>
          </View>
          {/* PR 18: the Style tile lists only references she has already had read — never her library. */}
          {picking === "style" ? (
            <View style={styles.styleList}>
              <StyleReferenceList
                onPick={(r) => {
                  setPicking(null);
                  addAttachment({
                    id: `style:${r.assetId}`,
                    role: "style",
                    name: "Style",
                    uri: r.thumbUrl,
                    assetId: r.assetId,
                    mediaType: "IMAGE",
                  });
                }}
              />
            </View>
          ) : (
          <MediaLibraryView
            onPick={(m) => {
              const role = picking;
              if (!role) return;
              setPicking(null);
              // Always, not only with threads: auto-mark never badges a video as the frame (`canvasesIn`).
              //
              // BOTH, and they are not redundant. The map still answers for OUTPUTS — assets that
              // were never in the tray, which `livePlanView` asks about (threadLogic.ts). The
              // attachment answers for the TRAY, and has to, because the tray travels to places
              // this screen's state does not: a `SheetJob`, and MakeItScreen's navigation params.
              // That is F-AM7's sheet half — a clip whose media type did not travel with it was
              // read as "not a clip" and sent as a likeness.
              setMediaTypes((t) => ({ ...t, [m.asset_id]: m.media_type }));
              addAttachment({
                id: `${role}:${m.asset_id}`,
                role,
                name: trayLabelFor(m.shot_type, role),
                uri: m.thumb_url ?? m.url,
                assetId: m.asset_id,
                mediaType: m.media_type,
              });
            }}
          />
          )}
        </SafeAreaView>
      </Modal>

      {/* Threads: Make it as a sheet over this thread (D1a), and the viewer for anything in it. */}
      {STUDIO_SESSIONS && sheet ? (
        <ThreadMakeIt
          key={sheet.key}
          job={sheet}
          open={sheetOpen}
          onPreview={(previewId, plan) => cardFor(sheet, previewId, plan)}
          onAsk={(reason, suggestions) => askIn(sheet, reason, suggestions)}
          onApprove={(previewId, plan) => {
            setSheetOpen(false);
            startRun(cardFor(sheet, previewId, plan), previewId);
          }}
          onRejected={(previewId) => rejectedIn(sheet, previewId)}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
      {STUDIO_SESSIONS ? (
        <AssetViewer
          visible={viewing !== null}
          uri={viewing?.uri ?? null}
          assetId={viewing?.assetId ?? null}
          onClose={() => setViewing(null)}
          onEdit={viewing?.editable ? () => editThis(viewing) : undefined}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** Mila's side of the thread, for a card that is not a Bubble's: the same avatar and the same column. */
function MilaRow({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.milaRow}>
      <View style={styles.avatar}>
        <Feather name="zap" size={13} color={Colors.light.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  );
}

function Bubble({
  turn,
  notSaved,
  onPickRole,
  onCarryOn,
  onDismiss,
  onMake,
  onFrame,
  frameCode = FRAME_ASK,
  frameMarked = true,
  onChip,
}: {
  turn: Turn;
  /** Threads: the quiet line when this turn could not be saved. Never set with the flag off. */
  notSaved?: string | null;
  onPickRole: (role: PickableRole) => void;
  onCarryOn: () => void;
  onDismiss: () => void;
  onMake: () => void;
  onFrame: (answer: FrameChoice) => void;
  /** Which frame question the card answers — the pick ask offers "Edit the marked photo" only once she has marked one. */
  frameCode?: typeof FRAME_ASK | typeof FRAME_PICK;
  frameMarked?: boolean;
  /** PR 19 (R-6): a tapped op chip fills her draft. */
  onChip?: (text: string) => void;
}) {
  if (turn.who === "you") {
    const bubble = (
      <View style={styles.youRow}>
        <View style={styles.youBubble}><Text style={styles.youTxt}>{turn.text}</Text></View>
      </View>
    );
    return notSaved ? (
      <>
        {bubble}
        <Text style={styles.notSavedYou}>{notSaved}</Text>
      </>
    ) : (
      bubble
    );
  }

  return (
    <View style={styles.milaRow}>
      <View style={styles.avatar}>
        <Feather name="zap" size={13} color={Colors.light.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.milaTxt}>{turn.text}</Text>
        {notSaved ? <Text style={styles.notSavedMila}>{notSaved}</Text> : null}

        {/* PR 19 (R-6): the vague ask's op chips, as the openers are — a tap fills her draft, nothing is sent. */}
        {turn.chips?.length && onChip ? (
          <View style={styles.card}>
            {turn.chips.map((c) => (
              <HapticPressable
                key={c}
                style={styles.openerRow}
                onPress={() => onChip(c)}
                accessibilityRole="button"
                accessibilityLabel={c}
                testID="vague-chip"
              >
                <Text style={styles.openerTxt}>{c}</Text>
              </HapticPressable>
            ))}
          </View>
        ) : null}

        {turn.card === "product" ? (
          <View style={styles.card}>
            <CardRow icon="image" label="Give me a picture of it" onPress={() => onPickRole("product")} />
            <HapticPressable style={styles.quiet} onPress={onCarryOn} accessibilityRole="button">
              <Text style={styles.quietTxt}>Carry on without a specific one</Text>
            </HapticPressable>
            <HapticPressable style={styles.quiet} onPress={onDismiss} accessibilityRole="button">
              <Text style={styles.quietTxt}>Never mind</Text>
            </HapticPressable>
          </View>
        ) : null}

        {turn.card === "photo" ? (
          <View style={styles.card}>
            <CardRow icon="image" label="Add a photo of you" onPress={() => onPickRole("source-frame")} />
            <HapticPressable style={styles.quiet} onPress={onDismiss} accessibilityRole="button">
              <Text style={styles.quietTxt}>Never mind</Text>
            </HapticPressable>
          </View>
        ) : null}

        {/* The frame ask (F.4). Copy reviewed and approved by Adi, wave C card 2 — "marked" is OUR word and
            never reaches her: the badge she sees says EDITING, so the notes below say what a tap DOES. */}
        {turn.card === "frame" ? (
          <View style={styles.card}>
            {frameCode !== FRAME_PICK || frameMarked ? (
              <CardRow icon="edit-2" label="Edit the marked photo" onPress={() => onFrame("edit")} />
            ) : null}
            <CardRow icon="image"  label="Make a new image from all of them" onPress={() => onFrame("new")} />
            <HapticPressable style={styles.quiet} onPress={onDismiss} accessibilityRole="button">
              <Text style={styles.quietTxt}>Never mind</Text>
            </HapticPressable>
            <Text style={styles.cardNote}>
              {frameCode === FRAME_PICK && !frameMarked
                ? "Tap the photo you want to edit."
                : "Or tap a different photo to edit that one instead."}
            </Text>
          </View>
        ) : null}

        {turn.card === "ready" ? (
          <View style={styles.card}>
            <HapticPressable style={styles.cta} onPress={onMake} accessibilityRole="button" accessibilityLabel="Make it">
              <Text style={styles.ctaTxt}>Make it</Text>
              <Feather name="chevron-right" size={15} color={Colors.light.buttonText} />
            </HapticPressable>
            <Text style={styles.cardNote}>Or add more first — nothing runs until you tap it.</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CardRow({
  icon, label, onPress,
}: {
  icon: React.ComponentProps<typeof Feather>["name"]; label: string; onPress: () => void;
}) {
  return (
    <HapticPressable style={styles.cardRow} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <Feather name={icon} size={15} color={Colors.light.primary} />
      <Text style={styles.cardRowTxt}>{label}</Text>
    </HapticPressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  styleList: { padding: Spacing.lg },

  topbar: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: Spacing.xl, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.light.border,
  },
  topTitle: {
    flex: 1, fontFamily: Fonts.bodyBold, fontSize: 15.5, fontWeight: "700", color: Colors.light.text,
  },
  threadsBtn: {
    width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },

  thread: { padding: Spacing.lg, paddingBottom: 8 },

  // Threads: the read's own states, "Load earlier", and a save that failed — all quiet, none of them a card.
  threadNote: { alignItems: "center", paddingVertical: 10 },
  gate: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 28,
    paddingHorizontal: 24,
  },
  gateTitle: {
    fontFamily: Fonts.bodyBold,
    fontSize: 14,
    fontWeight: "700",
    color: Colors.light.text,
  },
  gateBody: {
    fontFamily: Fonts.body,
    fontSize: 12.5,
    lineHeight: 18,
    textAlign: "center",
    color: Colors.light.textMuted,
  },
  notSavedYou: {
    alignSelf: "flex-end",
    marginTop: -7,
    marginBottom: 11,
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textMuted,
  },
  notSavedMila: {
    marginTop: 4,
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textMuted,
  },

  // Continuation: a quiet line above the input, not a tray chip — nothing is attached until she sends.
  continuing: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingBottom: 8,
  },
  continuingThumb: {
    width: 28,
    height: 28,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.primaryLight,
  },
  continuingTxt: {
    flex: 1,
    fontFamily: Fonts.bodySemiBold,
    fontSize: 12,
    fontWeight: "600",
    color: Colors.light.textSecondary,
  },
  continuingX: {
    width: 24,
    height: 24,
    borderRadius: 99,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.light.border,
  },

  opener: { paddingVertical: 18, paddingHorizontal: 4 },
  openerTitle: {
    fontFamily: Fonts.display, fontSize: 19, fontWeight: "800",
    letterSpacing: -0.35, color: Colors.light.text,
  },
  openerSub: {
    fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18,
    color: Colors.light.textMuted, marginTop: 7,
  },
  openerList: { gap: 7, marginTop: 16 },
  openerRow: {
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 13, paddingVertical: 11, paddingHorizontal: 12,
  },
  openerTxt: { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 17, color: Colors.light.textSecondary },

  youRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 11 },
  youBubble: {
    maxWidth: "80%", backgroundColor: Colors.light.primary,
    borderRadius: 16, borderBottomRightRadius: 4, paddingVertical: 10, paddingHorizontal: 13,
  },
  youTxt: { fontFamily: Fonts.body, fontSize: 13.5, lineHeight: 19, color: Colors.light.buttonText },

  milaRow: { flexDirection: "row", gap: 9, marginBottom: 13 },
  avatar: {
    width: 26, height: 26, borderRadius: 99, backgroundColor: Colors.light.primaryLight,
    alignItems: "center", justifyContent: "center",
  },
  milaTxt: { fontFamily: Fonts.body, fontSize: 13.5, lineHeight: 19, color: Colors.light.text },

  card: { marginTop: 10, gap: 7 },
  /** Above the tray, quiet: an aside about a badge she can see, not an error. */
  draftBadgeNote: {
    fontFamily: Fonts.body,
    fontSize: 11.5,
    lineHeight: 16,
    color: Colors.light.textMuted,
    paddingHorizontal: 2,
    marginBottom: 7,
  },
  cardRow: {
    flexDirection: "row", alignItems: "center", gap: 9,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 12, padding: 11,
  },
  cardRowTxt: { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.text },
  cardNote: { fontFamily: Fonts.body, fontSize: 10.5, lineHeight: 15, color: Colors.light.textMuted },
  quiet: { alignItems: "center", paddingVertical: 8 },
  quietTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 12, fontWeight: "600", color: Colors.light.textMuted },
  cta: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.light.primary, borderRadius: 12, paddingVertical: 12,
  },
  ctaTxt: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.buttonText },

  composer: {
    borderTopWidth: 1, borderTopColor: Colors.light.border,
    backgroundColor: Colors.light.card,
    paddingHorizontal: Spacing.lg, paddingTop: 9, paddingBottom: 14,
  },
  tray: { gap: 7, paddingBottom: 9, paddingTop: 1, paddingRight: 4 },
  chip: { width: 56 },
  chipImg: {
    width: 56, height: 56, borderRadius: 13, overflow: "hidden",
    borderWidth: 1, borderColor: Colors.light.border,
    backgroundColor: Colors.light.primaryLight,
  },
  chipBlank: { alignItems: "center", justifyContent: "center" },
  chipScrim: { position: "absolute", left: 0, right: 0, bottom: 0, height: 20, backgroundColor: "rgba(13,11,8,0.62)" },
  chipRole: {
    position: "absolute", left: 0, right: 0, bottom: 3,
    fontFamily: Fonts.bodyBold, fontSize: 7.5, fontWeight: "700",
    color: Colors.light.buttonText, textAlign: "center", letterSpacing: 0.4,
  },
  /**
   * THE FRAME BADGE. Top-left so it cannot collide with the remove button at top-right, and on the
   * primary rather than the scrim so "this is the one being changed" reads at 56px without a
   * legend. Never blurred — DESIGN.md reserves blur for floating buttons over media.
   */
  chipFrame: {
    position: "absolute", left: 0, top: 0,
    flexDirection: "row", alignItems: "center", gap: 2,
    paddingHorizontal: 3.5, paddingVertical: 2,
    borderTopLeftRadius: 12, borderBottomRightRadius: 8,
    backgroundColor: Colors.light.primary,
  },
  chipFrameTxt: {
    fontFamily: Fonts.bodyBold, fontSize: 6.5, fontWeight: "700",
    color: Colors.light.buttonText, letterSpacing: 0.3,
  },
  chipX: {
    position: "absolute", right: -4, top: -4, width: 19, height: 19, borderRadius: 99,
    backgroundColor: Colors.light.text, borderWidth: 2, borderColor: Colors.light.card,
    alignItems: "center", justifyContent: "center",
  },

  inputRow: {
    flexDirection: "row", alignItems: "flex-end", gap: 9,
    backgroundColor: Colors.light.backgroundDefault,
    borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 22, paddingLeft: 5, paddingRight: 5, paddingVertical: 5,
  },
  plus: {
    width: 34, height: 34, borderRadius: 99, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },
  input: {
    flex: 1, fontFamily: Fonts.body, fontSize: 13.5, lineHeight: 19,
    color: Colors.light.text, paddingVertical: 8, maxHeight: 110,
  },
  send: {
    width: 34, height: 34, borderRadius: 99, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.primary,
  },
  sendOff: { backgroundColor: Colors.light.backgroundTertiary },
});
