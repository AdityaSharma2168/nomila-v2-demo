// "Ask Mila" — the chat with Mila. In the shell it is the centre tab's own screen (presentation "tab", see
// client/navigation/milaTab.tsx), so the bottom menu stays under it (Muse); the first entry shows it as a full-screen
// Modal (presentation "modal"). Originally the Variant B full-screen agentic search overlay.
// Ported from MilaSearchOverlay in opps-screen-b.jsx (design source) to React
// Native, wired to the REAL chat backend via useMilaChat. Renders the full
// conversation (useMilaChat's message array) — each turn reuses the original
// single-exchange bubble/block styles. The design's per-answer MiniResult deal
// cards are omitted because the chat backend streams prose (no deal ids) — see
// report.

import React, { useState, useRef, useEffect, useCallback } from "react";
import { haptics } from "../lib/haptics";
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Image,
  Keyboard,
  AccessibilityInfo,
  Linking,
  PanResponder,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import type * as ImagePicker from "expo-image-picker";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useMilaChat,
  type ChatAttachment,
  type MilaContext,
  type MilaMessage,
  type MilaNavTarget,
} from "../hooks/use-mila-chat";
import {
  pickFromCameraRoll,
  useUploadMedia,
  RightsAckRequired,
  type MediaItem,
} from "../hooks/use-media-library";
import { RightsAckPanel } from "../components/media/RightsAckPanel";
import { MilaAttachSheet, type MilaAttachKind } from "../components/mila/MilaAttachSheet";
import { AddContractSheet } from "../components/deals/AddContractSheet";
import { RequestDocumentSheet } from "../components/requests/RequestDocumentSheet";
import { MilaWidget } from "../components/mila/MilaWidget";
import { MilaFollowUps } from "../components/mila/MilaFollowUps";
import { MilaAttachmentChip, MilaAttachmentChipRow, MilaBubbleThumbs } from "../components/mila/MilaAttachmentViews";
import { SavedChatsSheet } from "../components/mila/SavedChatsSheet";
import { MilaChatMenu, type MilaChatMenuAction } from "../components/mila/MilaChatMenu";
import { confirmDeleteChat } from "../lib/milaChats";
import { MilaProfileConfirm } from "../components/mila/MilaProfileConfirm";
import { MilaVoiceButton } from "../components/mila/MilaVoiceButton";
import { MilaVoiceBar } from "../components/mila/MilaVoiceBar";
import { useMilaVoice } from "../components/mila/useMilaVoice";
import { MilaHeader, HEADER_AVATAR_LARGE } from "../components/mila/MilaHeader";
import { Frost, SOFT_LIFT } from "../components/mila/Frost";
import { activityFrom, useHeldActivity } from "../components/mila/milaActivity";
import { N, oppsFont } from "../components/deals/opps/tokens";
import { openersFor, greetingFor, emptySubtitleFor } from "./milaOpeners";
import { AGENT_V3 } from "../lib/flags";
import { AgentCardList } from "../components/agent/AgentCard";
import { AgentCardHandlersProvider, type AgentCardHandlers } from "../components/agent/handlers";
import { chatTargetFor } from "../lib/agent/navigate";
import { connectService } from "../lib/agent/connect";

export type { MilaContext, MilaNavTarget };

// ─── Constants ──────────────────────────────────────────────────────────────

/** Her still (the idle loop's first frame) beside each "Mila" label — one image, not a video player per turn. */
const MILA_STILL = require("../../assets/mila/mila-still.png");
const LABEL_AVATAR_SIZE = 22;

/** The floating header's height before its first layout (large avatar + label). */
const HEADER_ESTIMATE = HEADER_AVATAR_LARGE + 44;
/** Round frosted top-bar buttons: 40 visible, hitSlop 8 → a 56pt touch target (>= 44). */
const TOP_BTN = 40;
/** The composer's round buttons (＋, send) — frosted, 38 visible, inside the frosted bar. */
const COMPOSER_BTN = 38;
/** The composer bar's corner. */
const COMPOSER_RADIUS = 26;
/** Opener, follow-up and nav rows: soft frosted rows (DESIGN.md §16), never dark or outlined pills. */
const ROW_RADIUS = 18;

/** Within this many points of the end, the transcript counts as "at the newest" and follows the reply. */
const STICK_THRESHOLD = 80;
/** Home's half-sheet height, as a share of the window (drag the handle up for full screen). */
const SHEET_HALF = 0.62;
/** iOS drags the keyboard down with the finger (Muse); Android has no interactive mode, so a drag dismisses it. */
const KEYBOARD_DISMISS_MODE = Platform.OS === "ios" ? "interactive" : "on-drag";

/** Most attachments on one turn — the server refuses more. */
const MAX_ATTACHMENTS = 4;

/** A picked photo or video on its way into the library, shown as a chip above the input. */
interface PendingAttachment {
  localId: string;
  asset: ImagePicker.ImagePickerAsset;
  role: "photo" | "product";
  status: "uploading" | "ready" | "failed";
  item?: MediaItem;
}

// Empty-state openers + greeting now live in ./milaOpeners (pure + unit-tested).

// ─── Pulsing "Searching your deals" dots ────────────────────────────────────────

function ThinkingDots() {
  const dots = useRef([new Animated.Value(0.2), new Animated.Value(0.2), new Animated.Value(0.2)]).current;

  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 280, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.2, duration: 280, useNativeDriver: true }),
          Animated.delay((2 - i) * 160 + 200),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);

  return (
    <View style={styles.dotsRow}>
      {dots.map((v, i) => (
        <Animated.View key={i} style={[styles.dot, { opacity: v }]} />
      ))}
    </View>
  );
}

// ─── Suggested prompt row (empty state) ──────────────────────────────────────────

function SuggestRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => pressed && { opacity: 0.7 }}
    >
      <Frost radius={ROW_RADIUS} style={styles.suggestRow}>
        {/* Her still, not a magnifier — these are things to ask her, not searches. */}
        <Image source={MILA_STILL} style={styles.suggestAvatar} accessibilityIgnoresInvertColors />
        <Text style={styles.suggestRowText}>{label}</Text>
        <Feather name="arrow-up-right" size={15} color={N.ink300} />
      </Frost>
    </Pressable>
  );
}

// Follow-up rows and nav chips (after an answer) live in components/mila/MilaFollowUps (shared with chat v2).

// ─── MilaSearchOverlay ──────────────────────────────────────────────────────────

function MilaSearchOverlayV1({
  visible,
  onClose,
  onNavigate,
  initialPrompt,
  initialDraft,
  initialContext,
  variant = "default",
  presentation = "modal",
  onOnboardingDone,
  onInitialPromptSent,
  offer,
  initialConversationId,
  initialMessageId,
  onInitialConversationOpened,
}: {
  visible: boolean;
  onClose: () => void;
  // Tapping a read-only nav-chip closes the overlay and hands the target up to
  // the launcher (which owns the navigator). Undefined → nav-chips no-op.
  onNavigate?: (target: MilaNavTarget) => void;
  initialPrompt?: string;
  // Pre-filled in the composer on open, NOT sent — the athlete taps send or edits it.
  initialDraft?: string;
  initialContext?: MilaContext;
  // "onboarding" = the first entry (OnboardingScreen): title reads "Meet Mila", the
  // close / history / new-chat controls are hidden (the run ends the screen, not a
  // tap), and the receipt card's done signal is forwarded to onOnboardingDone.
  variant?: "default" | "onboarding";
  // "tab" = the Mila tab's own screen (the shell): no Modal, so the bottom tabs stay visible under the chat, and
  // switching tabs is how she leaves (no Close). "modal" = a full-screen Modal (the first entry, OnboardingScreen).
  // "sheet" = Home's half-sheet (Mila's briefing): the same chat in a frosted sheet over Home at ~60% height; drag the
  // handle up for full screen, down (or tap above it) to go back to Home.
  presentation?: "modal" | "tab" | "sheet";
  onOnboardingDone?: (door: "profile" | "deals" | null) => void;
  /** AGENT_V3: told once `initialPrompt` has been sent, so the launcher can clear it (it is a one-shot tap). */
  onInitialPromptSent?: () => void;
  /**
   * EXPO_PUBLIC_CAMERA_ROLL_INTAKE: Mila's one-tap offer of a camera-roll review the app-open check already prepared.
   * Drawn as one of her rows (her still, the line, an arrow) at the top of the chat; the tap opens the review.
   */
  offer?: { label: string; onPress: () => void } | null;
  /** A saved chat to open when shown (a Mila suggestion: the push and Home's row open the chat its card is in). */
  initialConversationId?: string;
  /** A message in that chat to open ON (one Mila started, from its notification): scrolled to once it is drawn. */
  initialMessageId?: string;
  onInitialConversationOpened?: () => void;
}) {
  const onboarding = variant === "onboarding";
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const inTab = presentation === "tab";
  const inSheet = presentation === "sheet";
  const { height: winH } = useWindowDimensions();
  const [sheetFull, setSheetFull] = useState(false);
  // Reduce Transparency (iOS): the sheet is solid, not frosted.
  const [solidSheet, setSolidSheet] = useState(false);
  useEffect(() => {
    if (!inSheet) return undefined;
    let alive = true;
    AccessibilityInfo.isReduceTransparencyEnabled?.().then((on) => { if (alive) setSolidSheet(!!on); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.("reduceTransparencyChanged", (on: boolean) => setSolidSheet(!!on));
    return () => { alive = false; sub?.remove?.(); };
  }, [inSheet]);
  useEffect(() => { if (!visible) setSheetFull(false); }, [visible]);
  const sheetFullRef = useRef(sheetFull);
  sheetFullRef.current = sheetFull;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The sheet's handle: up past a short drag → full screen; down → half again, or closed from half.
  const sheetPan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 6,
    onPanResponderRelease: (_e, g) => {
      if (g.dy < -40) setSheetFull(true);
      else if (g.dy > 60) { if (sheetFullRef.current) setSheetFull(false); else onCloseRef.current(); }
    },
  })).current;
  // Half-sheet: no status bar above it, so the chat's top pad is small; full screen keeps the safe area.
  const topPad = inSheet && !sheetFull ? 8 : insets.top;

  // ── Following the newest message ──────────────────────────────────────────────
  // The transcript follows the reply as it streams — but only while she is at (or near) the end. Once she drags up to
  // read history it stays where she put it; sending (or scrolling back down) re-attaches it. Only HER scrolling moves
  // the flag: programmatic scrollToEnd fires scroll events too, mid-animation, and must not detach it.
  const stickRef = useRef(true);
  const draggingRef = useRef(false);
  const atEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    return contentSize.height - (contentOffset.y + layoutMeasurement.height) < STICK_THRESHOLD;
  };
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Web has no drag events (wheel / trackpad), so every scroll there is hers.
    if (draggingRef.current || Platform.OS === "web") stickRef.current = atEnd(e);
  }, []);
  const onScrollBeginDrag = useCallback(() => { draggingRef.current = true; }, []);
  const onScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    draggingRef.current = false;
    stickRef.current = atEnd(e);
  }, []);
  const onMomentumScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    stickRef.current = atEnd(e);
  }, []);

  // ── Entrance (the Mila tab) ───────────────────────────────────────────────────
  // As a Modal she slid up; as a tab she rises in softly (DESIGN.md §7 "normal") — or simply appears under reduce
  // motion. null = the OS setting is not read yet: no motion until it is.
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (mounted) setReduceMotion(v); })
      .catch(() => { if (mounted) setReduceMotion(true); });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { mounted = false; sub?.remove?.(); };
  }, []);
  const enter = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!inTab || !visible || reduceMotion !== false) return undefined;
    enter.setValue(0);
    const anim = Animated.timing(enter, { toValue: 1, duration: 250, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
    // Only on becoming visible: a later reduce-motion read must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inTab, visible]);
  const enterStyle = inTab
    ? { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }
    : null;

  // The one frosted menu (saved chats, new chat, delete) — Muse's single round button at the top left.
  const [menuOpen, setMenuOpen] = useState(false);

  const { send, stop, streaming, phase, messages, newChat, openConversation, syncToActiveThread, conversationId, appendTranscript, appendWidgetMessage } = useMilaChat();
  // Voice shares this chat's thread — see useMilaVoice / voiceSession. The id is
  // passed for verification only; it is never sent to the server.
  //
  // `onTranscript` is the live layer: spoken turns render here as they happen.
  // It is a VIEW — the durable copy is written server-side by the worker, so a
  // missed update costs liveness, never the transcript.
  const voice = useMilaVoice({
    conversationId,
    onTranscript: appendTranscript,
    onWidget: appendWidgetMessage,
  });

  // What she's doing, from real signals only (milaActivity): the voice room's state, and the
  // text reply's stream phase — thinking before the first token, looking things up while the
  // server runs a tool round, writing while tokens arrive. Held >= 1.2s per state so it reads.
  const activity = useHeldActivity(activityFrom(voice.state, phase));
  const [headerH, setHeaderH] = useState(HEADER_ESTIMATE);

  const [input, setInput] = useState("");
  // Saved-chats sheet — reopen a past conversation. Independent of the transcript.
  const [historyVisible, setHistoryVisible] = useState(false);

  // ── The ＋ ──────────────────────────────────────────────────────────────────
  // Attachments are uploaded to the media library the moment they are picked (that IS the
  // decided behaviour: a photo or video goes to the library; a product goes to the library
  // tagged for Studio), and sit as chips above the input until the next send carries their
  // ids. A contract never comes through here — it opens the existing contract sheet, whose
  // review step is the tap that saves. Anything else is refused by that sheet's upload gate.
  const [attachOpen, setAttachOpen] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  // Checkpoint 1: the request a chip opened a sheet for ("prompt me for my contract" / "…performance data").
  const [contractRequestId, setContractRequestId] = useState<string | null>(null);
  const [documentRequestId, setDocumentRequestId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [ackAssets, setAckAssets] = useState<{ assets: ImagePicker.ImagePickerAsset[]; role: "photo" | "product" } | null>(null);
  const upload = useUploadMedia();
  const readyAttachments = pending.filter((p): p is PendingAttachment & { item: MediaItem } => p.status === "ready" && !!p.item);

  const uploadPicked = useCallback(async (assets: ImagePicker.ImagePickerAsset[], role: "photo" | "product", ackRights?: boolean) => {
    const staged = assets.map((asset) => ({ localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, asset, role, status: "uploading" as const }));
    setPending((prev) => [...prev, ...staged].slice(0, MAX_ATTACHMENTS));
    for (const s of staged) {
      try {
        const item = await upload.mutateAsync({ asset: s.asset, ackRights, role: role === "product" ? "product" : undefined });
        setPending((prev) => prev.map((p) => (p.localId === s.localId ? { ...p, status: "ready", item } : p)));
      } catch (e) {
        if (e instanceof RightsAckRequired) {
          // One-time, account-wide: drop the staged items, show the panel once, retry the lot on confirm.
          setPending((prev) => prev.filter((p) => !staged.some((x) => x.localId === p.localId)));
          setAckAssets({ assets, role });
          return;
        }
        setPending((prev) => prev.map((p) => (p.localId === s.localId ? { ...p, status: "failed" } : p)));
      }
    }
  }, [upload]);

  const onAttachPick = useCallback(async (kind: MilaAttachKind) => {
    if (kind === "contract") { setContractOpen(true); return; }
    if (kind === "search") { setInput((v) => (v.trim() ? v : "Search the web for ")); setTimeout(() => inputRef.current?.focus(), 250); return; }
    const room = MAX_ATTACHMENTS - pending.length;
    if (room <= 0) return;
    try {
      const picked = await pickFromCameraRoll(kind === "product" ? "photo" : "all", { multiple: true, selectionLimit: room });
      if (picked?.assets.length) await uploadPicked(picked.assets, kind);
    } catch {
      // Permission refused or the picker failed: nothing staged, nothing to undo.
    }
  }, [pending.length, uploadPicked]);

  const removePending = useCallback((localId: string) => {
    setPending((prev) => prev.filter((p) => p.localId !== localId));
  }, []);
  // Id of the user turn being edited, held in a ref so submit() always reads the
  // CURRENT target — never a stale value from a render that hasn't committed.
  // Nothing renders off it, so a ref (not state) is exactly right.
  const editingIdRef = useRef<string | null>(null);

  // fromEdit = the input bar was submitted (send button / return key). Only then
  // does a pending edit resend in place — tapping a suggestion pill sends a fresh
  // turn and just abandons the pending edit. Either way the edit target is consumed.
  const submit = useCallback(
    (text: string, fromEdit = false) => {
      const q = text.trim();
      // Attachments ride only on a fresh turn from the input bar (never on an edit or a chip).
      const attachments: ChatAttachment[] | undefined =
        fromEdit && !editingIdRef.current && readyAttachments.length
          ? readyAttachments.map((p) => ({ assetId: p.item.asset_id, role: p.role === "product" ? "product" : p.item.media_type === "VIDEO" ? "video" : "photo", thumbUrl: p.item.thumb_url ?? p.item.url }))
          : undefined;
      if (!q && !attachments) return;
      // No streaming guard — send() aborts the in-flight turn (keeping its
      // partial text) and starts the new one. When resending an edit, hand
      // send() the edited turn's id: it rewrites that turn in place with the new
      // text and regenerates its answer, keeping every later turn untouched.
      const editId = editingIdRef.current;
      const opts = fromEdit && editId ? { editMessageId: editId } : undefined;
      editingIdRef.current = null;
      setInput("");
      if (attachments) setPending([]);
      // Muse: sending puts the keyboard away so the reply has the screen, and the transcript follows the new turn
      // even if she had scrolled up before sending.
      stickRef.current = true;
      Keyboard.dismiss();
      // An attachments-only send reads as "Take a look at this." — the server applies the same default.
      send(q || (attachments ? "Take a look at this." : q), initialContext, attachments ? { ...opts, attachments } : opts);
    },
    [send, initialContext, readyAttachments],
  );

  // Tap a prior user bubble (or its pencil) to edit it: load its text back into
  // the input and remember which turn — submit() then resends from there.
  const editMessage = useCallback((m: MilaMessage) => {
    editingIdRef.current = m.id;
    setInput(m.content);
    inputRef.current?.focus();
  }, []);

  // Tap a nav-chip: close the overlay, then hand the read-only target up to the
  // launcher, which owns the navigator. Read-only — never drafts or sends.
  const onNavChip = useCallback(
    (target: MilaNavTarget) => {
      haptics.press();
      // Checkpoint 1: a request chip opens the EXISTING upload surface here, over the conversation, with the request
      // attached. She does the upload; the chip only opens it. Nothing is created until she saves.
      if (target.screen === "add_contract") { setContractRequestId(target.requestId); setContractOpen(true); return; }
      if (target.screen === "add_document") { setDocumentRequestId(target.requestId); return; }
      onClose();
      onNavigate?.(target);
    },
    [onClose, onNavigate],
  );

  // Keep latest submit available to the visibility effect without retriggering it.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const onPromptSentRef = useRef(onInitialPromptSent);
  onPromptSentRef.current = onInitialPromptSent;

  // AGENT_V3: what a card's taps do outside the card. Start asks Mila (the athlete's own tap); "Tell Mila" fills the
  // composer without sending; a link routes like a nav-chip, or opens the web page.
  const cardHandlers = React.useMemo<AgentCardHandlers>(() => ({
    startWorkflow: (prompt) => submitRef.current(prompt),
    reply: (text) => submitRef.current(text),
    connect: (connectorId) => connectService(connectorId),
    prefill: (text) => { setInput(text); inputRef.current?.focus(); },
    openLink: (target) => {
      const t = chatTargetFor(target);
      if (!t) return;
      if ("url" in t) { void Linking.openURL(t.url).catch(() => {}); return; }
      onNavChip(t);
    },
  }), [onNavChip]);

  // First entry: when a receipt card says the run is finished (door chosen in words),
  // tell the launcher. Fires once per finished card; a door TAP reports through the
  // card's own onDone instead.
  const doneReportedRef = useRef(false);
  useEffect(() => {
    if (!onboarding || doneReportedRef.current) return;
    const finished = messages.find(
      (m) => m.widget?.type === "onboarding_update" && m.widget.data.next === "done",
    );
    if (finished && finished.widget?.type === "onboarding_update") {
      doneReportedRef.current = true;
      onOnboardingDone?.(finished.widget.data.door);
    }
  }, [onboarding, messages, onOnboardingDone]);

  // Optional auto-submit on open; reset on close. NO auto-focus: the keyboard used to rise over
  // the empty state and the list scrolled to its end, so the first thing an athlete saw was four
  // suggestion rows and a keyboard, with the greeting pushed off the top. The input is one tap away.
  useEffect(() => {
    if (visible) {
      let promptT: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;
      if (initialDraft) {
        setInput(initialDraft);
        setTimeout(() => inputRef.current?.focus(), 350);
      }
      // One conversation across the Mila tab and Home's half-sheet: catch up with whatever the other surface said
      // first (a named saved chat to open is handled below instead), THEN send a chip's ask, so the ask lands in the
      // same thread and the re-read can never replace it.
      const caughtUp = initialConversationId ? Promise.resolve() : syncToActiveThread();
      if (initialPrompt) {
        const started = Date.now();
        void caughtUp.finally(() => {
          if (cancelled) return;
          promptT = setTimeout(() => { submitRef.current(initialPrompt); onPromptSentRef.current?.(); }, Math.max(0, 600 - (Date.now() - started)));
        });
      }
      return () => {
        cancelled = true;
        if (promptT) clearTimeout(promptT);
      };
    }
    // Closed → KEEP the conversation. The overlay stays mounted, so the transcript
    // and the conversation id both survive close/reopen (reopening shows the same
    // conversation). Only clear the transient input + any in-progress edit; do NOT
    // clear messages and do NOT rotate the id — "New chat" is the only reset.
    setInput("");
    editingIdRef.current = null;
    return undefined;
  }, [visible, initialPrompt, initialDraft]);

  // A saved chat to open (a Mila suggestion's card): once, when shown; the launcher clears it.
  useEffect(() => {
    if (!visible || !initialConversationId) return;
    if (initialMessageId) {
      // Open ON that message: stop following the end until it is drawn (or give up after a few seconds).
      targetMsgRef.current = initialMessageId;
      stickRef.current = false;
      setTimeout(() => {
        if (targetMsgRef.current !== initialMessageId) return;
        targetMsgRef.current = null;
        stickRef.current = true;
        scrollRef.current?.scrollToEnd({ animated: true });
      }, 4000);
    }
    void openConversation(initialConversationId);
    onInitialConversationOpened?.();
  }, [visible, initialConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the conversation sits inside the transcript, so a message's own layout can be turned into a scroll offset.
  const targetMsgRef = useRef<string | null>(null);
  const tapYRef = useRef(0);
  const convoYRef = useRef(0);
  const onMessageLayout = useCallback((serverId: string | undefined, y: number) => {
    if (!serverId || serverId !== targetMsgRef.current) return;
    targetMsgRef.current = null;
    scrollRef.current?.scrollTo({ y: Math.max(0, tapYRef.current + convoYRef.current + y - headerH - 12), animated: false });
  }, [headerH]);

  // Empty-state openers + greeting line, chosen by the launching screen's context.
  const openers = openersFor(initialContext);
  const greeting = greetingFor(initialContext);

  // Follow-up chips render only under the latest assistant message, once its
  // stream has finished. Nav-chips (navigate) and ask-chips (prefill) are
  // separate rows below the answer.
  const last = messages[messages.length - 1];
  const answered = last && last.role === "assistant" && !last.streaming;
  const pillSuggestions = answered ? (last.suggestions ?? []) : [];
  const pillActions = answered ? (last.actions ?? []) : [];

  const onMenuPick = useCallback(async (action: MilaChatMenuAction) => {
    if (action === "history") setHistoryVisible(true);
    else if (action === "new") newChat();
    else if (await confirmDeleteChat(conversationId)) newChat();
  }, [newChat, conversationId]);

  const body = (
      <Animated.View style={[styles.root, { paddingTop: topPad }, inSheet && styles.sheetRoot, enterStyle]} testID="mila-chat">
        {/* The KAV's frame is measured from the top of this screen (y = the safe-area pad), so no extra offset:
            the old offset of insets.top over-lifted the composer by a status bar's height. */}
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={0}
        >
          {/* The body: the transcript, with Mila floating over its top. */}
          <View style={styles.flex}>
            <ScrollView
              ref={scrollRef}
              style={styles.flex}
              // Starts below her; scrolled content slides under the header's fade.
              contentContainerStyle={[styles.bodyInner, { paddingTop: headerH + 12 }]}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              // Muse: dragging the transcript puts the keyboard away (on iOS it follows the finger).
              keyboardDismissMode={KEYBOARD_DISMISS_MODE}
              scrollEventThrottle={32}
              onScroll={onScroll}
              onScrollBeginDrag={onScrollBeginDrag}
              onScrollEndDrag={onScrollEndDrag}
              onMomentumScrollEnd={onMomentumScrollEnd}
              // Follow the conversation, never the empty state — scrolling an empty state to its
              // end is what hid the greeting behind the keyboard. And only while she is at the end.
              onContentSizeChange={() => { if (messages.length && stickRef.current) scrollRef.current?.scrollToEnd({ animated: true }); }}
              // The viewport shrinks when the keyboard rises (and grows when it goes): keep the newest in view.
              onLayout={() => { if (messages.length && stickRef.current) scrollRef.current?.scrollToEnd({ animated: false }); }}
              testID="mila-transcript"
            >
              {/* Tapping anywhere in the transcript that is not a control puts the keyboard away (Muse). Not an
                  accessibility element: it is a dismiss target, not a button; drags still scroll. A short
                  conversation sits at the bottom, just above the composer, like a chat. */}
              <Pressable
                onPress={() => Keyboard.dismiss()}
                accessible={false}
                style={[styles.transcriptTap, messages.length > 0 && styles.transcriptBottom]}
                onLayout={(e) => { tapYRef.current = e.nativeEvent.layout.y; }}
                testID="mila-transcript-tap"
              >
              {messages.length === 0 ? (
                /* EMPTY STATE */
                <View style={styles.empty}>
                  {/* Her avatar is the floating header above — it stays when the conversation starts. */}
                  <Text style={styles.emptyTitle}>{greeting}</Text>
                  <Text style={styles.emptySubtitle}>{emptySubtitleFor()}</Text>
                  <View style={styles.suggestList}>
                    {offer ? <SuggestRow key="camera-roll-offer" label={offer.label} onPress={offer.onPress} /> : null}
                    {openers.map((s) => (
                      <SuggestRow key={s} label={s} onPress={() => submit(s)} />
                    ))}
                  </View>
                </View>
              ) : (
                /* CONVERSATION */
                <View style={styles.convo} onLayout={(e) => { convoYRef.current = e.nativeEvent.layout.y; }} testID="mila-convo">
                  {offer ? <SuggestRow label={offer.label} onPress={offer.onPress} /> : null}
                  {messages.map((m, i) =>
                    m.role === "user" ? (
                      /* User bubble — the pencil (leading side) is the ONLY edit
                         trigger; the bubble text is not tappable-to-edit. */
                      <View key={m.id} style={styles.userRow}>
                        {/* Pencil is the sole edit tap target. hitSlop widens the
                            small glyph's touch area. */}
                        <Pressable
                          onPress={() => editMessage(m)}
                          accessibilityLabel="Edit message"
                          accessibilityHint="Loads this message into the input to edit and resend"
                          hitSlop={8}
                          style={({ pressed }) => pressed && { opacity: 0.5 }}
                        >
                          <Feather name="edit-2" size={13} color={N.ink300} />
                        </Pressable>
                        {/* Plain View — tapping the text does nothing; it stays
                            selectable for normal copy. */}
                        <View style={styles.userBubble}>
                          {m.attachments?.length ? (
                            <MilaBubbleThumbs items={m.attachments.map((a) => ({ key: a.assetId, thumbUrl: a.thumbUrl, role: a.role }))} />
                          ) : null}
                          <Text style={styles.userBubbleText} selectable>
                            {m.content}
                          </Text>
                        </View>
                      </View>
                    ) : (
                      /* Mila block */
                      <View key={m.id} style={styles.milaBlock} onLayout={m.serverId ? (e) => onMessageLayout(m.serverId, e.nativeEvent.layout.y) : undefined} testID={m.serverId ? `mila-msg-${m.serverId}` : undefined}>
                        {/* Her name once per run of her turns — a voice answer arrives as two or
                            three blocks ("let me pull that up", then the answer), and a label on
                            each read as three speakers. */}
                        {messages[i - 1]?.role === "assistant" ? null : (
                          <View style={styles.milaLabelRow}>
                            <Image
                              source={MILA_STILL}
                              style={styles.milaLabelAvatar}
                              accessibilityIgnoresInvertColors
                              testID="mila-label-avatar"
                            />
                            <Text style={styles.milaLabelText}>Mila</Text>
                          </View>
                        )}

                        {m.streaming && m.content.length === 0 ? (
                          <View style={styles.thinkingRow}>
                            <Text style={styles.thinkingText}>
                              {(m.statusMessage ?? "Thinking…").replace(/…$/, "")}
                            </Text>
                            <ThinkingDots />
                          </View>
                        ) : (
                          <>
                            {m.content.length > 0 && (
                              <Text style={styles.answerText}>{m.content}</Text>
                            )}
                            {m.error && (
                              <Text
                                style={[
                                  styles.errorText,
                                  m.content.length > 0 && styles.errorAfterText,
                                ]}
                              >
                                {m.error}
                              </Text>
                            )}
                            {/* Inline card (arrives on `done`). Boundary lives
                                inside MilaWidget — a bad widget fails soft. */}
                            {m.widget && (
                              <View style={styles.widgetWrap}>
                                {/* deal_card Reply CTA reuses the ask-chip pipeline:
                                    submit() a reply request → Mila calls draft_reply
                                    → a reply_action card renders inline. */}
                                <MilaWidget
                                  widget={m.widget}
                                  onReply={(brand) =>
                                    submit(`Draft a reply to the ${brand} deal.`)
                                  }
                                  onOpenDeal={(dealId) => onNavChip({ screen: "deal_detail", dealId })}
                                  onOnboardingDone={(door) => {
                                    doneReportedRef.current = true;
                                    onOnboardingDone?.(door);
                                  }}
                                />
                              </View>
                            )}
                            {/* AGENT_V3: the harness's cards (action · progress · ready · connect · how-i-got-this, and the
                                proposed kinds), in order, with "How I got this" for the run. Each fails soft. */}
                            {AGENT_V3 && (m.cards?.length || m.runId) ? (
                              <View style={styles.widgetWrap}>
                                <AgentCardList cards={m.cards} runId={m.runId} />
                              </View>
                            ) : null}
                            {/* Proposed durable profile updates (Phase-3) — confirm
                                cards; a write happens only on a deliberate Save tap. */}
                            {m.profileUpdates?.length ? (
                              <View style={styles.profileConfirmWrap}>
                                {m.profileUpdates.map((c, i) => (
                                  <MilaProfileConfirm key={`pc-${i}`} candidate={c} />
                                ))}
                              </View>
                            ) : null}
                          </>
                        )}
                      </View>
                    ),
                  )}

                  {/* Follow-up chips — latest assistant message only. Nav-chips
                      (navigate) sit above ask-chips (prefill a question). */}
                  <MilaFollowUps actions={pillActions} suggestions={pillSuggestions} onNav={onNavChip} onAsk={(s) => submit(s)} />
                </View>
              )}
              </Pressable>
            </ScrollView>
            {/* After the transcript so it draws on top of it (no elevation games on Android). */}
            <MilaHeader
              activity={activity}
              // Small in a typed conversation; back to full size while voice is live.
              compact={messages.length > 0 && !voice.active}
              active={visible}
              onHeight={setHeaderH}
            />
            {/* Muse's controls, over the header's corners: ONE round frosted menu at the left (saved chats, new
                chat, delete), her avatar and name in the middle (the header), ONE action at the right (new chat).
                No title and no close: the bottom tabs are how she leaves. Hidden on the first entry. */}
            {onboarding ? null : (
              <View style={styles.headerControls} pointerEvents="box-none">
                <Pressable
                  onPress={() => { haptics.press(); Keyboard.dismiss(); setMenuOpen(true); }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Chat menu"
                  accessibilityHint="Saved chats, a new chat, or delete this one"
                  style={({ pressed }) => [styles.topBtn, pressed && { opacity: 0.7 }]}
                >
                  <Frost radius={TOP_BTN / 2} style={styles.topBtnGlass}>
                    <Feather name="menu" size={17} color={N.ink700} />
                  </Frost>
                </Pressable>
                <Pressable
                  onPress={() => { haptics.press(); newChat(); }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="New chat"
                  accessibilityHint="Starts a fresh conversation and clears the screen"
                  style={({ pressed }) => [styles.topBtn, pressed && { opacity: 0.7 }]}
                >
                  <Frost radius={TOP_BTN / 2} style={styles.topBtnGlass}>
                    <Feather name="edit" size={16} color={N.ink700} />
                  </Frost>
                </Pressable>
              </View>
            )}
          </View>

          {/* Input bar. While voice is live the ONE voice bar stands where the
              composer was — same place, same frosted look — instead of stacking above it:
              one bar, one mic (End), no keyboard, and the thread keeps its height.
              The voice bar names her state in words ("Listening", "Speaking") beside a
              live dot, so "is my mic on" reads at a glance. No ground or rule behind the
              bar: the frosted composer floats over the cream. */}
          {/* As a tab the bottom menu sits under the composer (and hides while the keyboard is up): no home-indicator pad. */}
          <View style={[styles.inputBar, { paddingBottom: 12 + (inTab ? 0 : insets.bottom) }]}>
            {/* Voice status. Only ever one line, and only when there is something
                to say — a failure, or a warning that spoken turns are landing in
                a different thread than the one on screen. */}
            {voice.supported && (voice.error || voice.notice) ? (
              <Text style={styles.voiceStatus}>
                {voice.error ?? voice.notice}
              </Text>
            ) : null}
            {voice.supported && voice.active ? (
              /* LIVE: the voice bar IS the composer. Chips, the ack panel and the
                 input pill are not rendered — nothing to type into, one control to
                 end. Staged attachments survive in state and return with the pill. */
              <MilaVoiceBar
                variant="composer"
                state={voice.state}
                justEnded={voice.justEnded}
                audioBlocked={voice.audioBlocked}
                onResumeAudio={voice.resumeAudio}
                onEnd={() => {
                  haptics.press();
                  voice.toggle();
                }}
              />
            ) : (
            <>
            {/* The "Mic off" receipt for a few seconds after a session ends —
                a banner above the returned composer, so ending is said, not inferred. */}
            {voice.supported && voice.justEnded && (
              <MilaVoiceBar
                state={voice.state}
                justEnded={voice.justEnded}
                onEnd={() => {
                  haptics.press();
                  voice.toggle();
                }}
              />
            )}
            {/* One-time rights acknowledgment — shown once, retries the picks on confirm. */}
            {ackAssets ? (
              <View style={styles.ackWrap}>
                <RightsAckPanel
                  busy={upload.isPending}
                  onConfirm={() => { const a = ackAssets; setAckAssets(null); void uploadPicked(a.assets, a.role, true); }}
                  onCancel={() => setAckAssets(null)}
                />
              </View>
            ) : null}
            {/* Staged attachments — chips above the input until the next send carries them. */}
            {pending.length ? (
              <MilaAttachmentChipRow>
                {pending.map((p) => (
                  <MilaAttachmentChip
                    key={p.localId}
                    uri={p.asset.uri}
                    role={p.role === "product" ? "product" : p.asset.type === "video" ? "video" : "photo"}
                    status={p.status}
                    onRemove={() => removePending(p.localId)}
                  />
                ))}
              </MilaAttachmentChipRow>
            ) : null}
            <Frost radius={COMPOSER_RADIUS} style={styles.inputPill} testID="mila-composer">
              {/* ＋ — photos, a product, a contract, or a web search. A composer, not a
                  search box: no magnifier here; search is one thing you can add. */}
              <Pressable
                onPress={() => { haptics.press(); setAttachOpen(true); }}
                hitSlop={6}
                accessibilityLabel="Add something"
                accessibilityHint="Attach a photo, a product, a contract, or search the web"
                style={({ pressed }) => pressed && { opacity: 0.7 }}
              >
                <Frost radius={COMPOSER_BTN / 2} style={styles.roundBtn}>
                  <Feather name="plus" size={20} color={N.ink700} />
                </Frost>
              </Pressable>
              <TextInput
                ref={inputRef}
                style={styles.input}
                value={input}
                onChangeText={setInput}
                placeholder={
                  readyAttachments.length
                    ? "Say something about it, or just send"
                    : "Ask Mila anything"
                }
                placeholderTextColor={N.ink500}
                returnKeyType="send"
                onSubmitEditing={() => submit(input, true)}
                autoCorrect={false}
              />
              {/* Voice toggle — the ONLY mic while idle. Live, the pill is gone and
                  the voice bar's End control is the only mic. Off web the hook reports
                  unsupported and the button is not rendered at all. */}
              {voice.supported && (
                <MilaVoiceButton
                  state={voice.state}
                  onPress={() => {
                    haptics.press();
                    voice.toggle();
                  }}
                />
              )}
              {/* Send while idle; stop while streaming. Ready: a solid white circle lifted
                  softly off the glass, ink glyph. Nothing to send: the plain frosted circle,
                  quiet arrow. Never a dark disc. */}
              <Pressable
                onPress={() => { haptics.press(); streaming ? stop() : submit(input, true); }}
                accessibilityLabel={streaming ? "Stop" : "Send"}
                disabled={!streaming && !input.trim() && !readyAttachments.length}
                style={({ pressed }) => pressed && { opacity: 0.8 }}
              >
                {streaming || input.trim() || readyAttachments.length ? (
                  <View style={[styles.roundBtn, styles.sendReady]} testID="mila-send-ready">
                    <Feather name={streaming ? "square" : "arrow-up"} size={18} color={N.ink900} />
                  </View>
                ) : (
                  <Frost radius={COMPOSER_BTN / 2} style={styles.roundBtn}>
                    <Feather name="arrow-up" size={18} color={N.ink300} />
                  </Frost>
                )}
              </Pressable>
            </Frost>
            </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Animated.View>
  );

  const drawn = AGENT_V3 ? <AgentCardHandlersProvider value={cardHandlers}>{body}</AgentCardHandlersProvider> : body;
  return (
    <>
      {inTab ? drawn : inSheet ? (
        <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
          <View style={styles.sheetWrap}>
            {/* Above the sheet: Home stays in view, dimmed; a tap there goes back to it. */}
            <Pressable style={styles.flex} onPress={onClose} accessibilityRole="button" accessibilityLabel="Back to Home" testID="mila-sheet-scrim" />
            <View style={[styles.sheet, { height: sheetFull ? winH : Math.round(winH * SHEET_HALF) }]} testID={sheetFull ? "mila-sheet-full" : "mila-sheet-half"}>
              {solidSheet
                ? <View style={[StyleSheet.absoluteFill, styles.sheetSolid]} />
                : <Frost radius={sheetFull ? 0 : 24} style={StyleSheet.absoluteFill} />}
              <View {...sheetPan.panHandlers} style={[styles.sheetHandleZone, sheetFull && { paddingTop: insets.top }]} accessibilityRole="adjustable" accessibilityLabel={sheetFull ? "Drag down for half screen" : "Drag up for full screen"} testID="mila-sheet-handle">
                <Pressable onPress={() => setSheetFull((f) => !f)} hitSlop={10} accessibilityRole="button" accessibilityLabel={sheetFull ? "Half screen" : "Full screen"}>
                  <View style={styles.sheetHandle} />
                </Pressable>
              </View>
              {drawn}
            </View>
          </View>
        </Modal>
      ) : (
        <Modal
          visible={visible}
          animationType="slide"
          statusBarTranslucent
          onRequestClose={onClose}
        >
          {drawn}
        </Modal>
      )}

      <MilaChatMenu
        visible={menuOpen}
        top={topPad + 4 + TOP_BTN + 8}
        canDelete={messages.length > 0}
        onClose={() => setMenuOpen(false)}
        onPick={(a) => { void onMenuPick(a); }}
      />

      {/* The ＋ sheet, and the contract sheet it can open. The contract path is the
          existing one — upload, read, REVIEW, save — so a contract from chat lands exactly
          where one from the Deals screen does, and a non-contract file is refused by the
          same upload gate. */}
      <MilaAttachSheet visible={attachOpen} onClose={() => setAttachOpen(false)} onPick={(k) => void onAttachPick(k)} />
      <AddContractSheet
        visible={contractOpen}
        requestId={contractRequestId ?? undefined}
        onClose={() => { setContractOpen(false); setContractRequestId(null); }}
        onCreated={() => {
          const answered = contractRequestId != null;
          setContractOpen(false);
          setContractRequestId(null);
          submit(answered ? "I just added the contract you asked me for. What should I know about it?" : "I just added a contract. What should I know about it?");
        }}
      />
      <RequestDocumentSheet
        visible={documentRequestId != null}
        requestId={documentRequestId}
        onClose={() => setDocumentRequestId(null)}
        onDone={() => { /* the sheet shows its own confirmation; the request is now acquired */ }}
      />

      {/* Saved-chats list. Selecting a chat reopens it (rebuilds the transcript +
          adopts its id) and closes the sheet. */}
      <SavedChatsSheet
        visible={historyVisible}
        onClose={() => setHistoryVisible(false)}
        onSelect={(id) => {
          setHistoryVisible(false);
          openConversation(id);
        }}
        onDeleted={(id) => {
          // The open conversation is gone from the server: clear the screen too.
          if (id === "all" || id === conversationId) newChat();
        }}
      />
    </>
  );
}

// ─── The switch: chat v2 (EXPO_PUBLIC_MILA_THREAD_V2) ─────────────────────────────

// On: the chat v2 module (client/components/mila/thread) draws every Mila surface but the first entry. Read inline from
// the env and required only when on, so a build with the flag off never bundles or loads the chat library.
const MilaThreadScreen: typeof import("../components/mila/thread").MilaThreadScreen | null =
  process.env.EXPO_PUBLIC_MILA_THREAD_V2 === "true" ? require("../components/mila/thread").MilaThreadScreen : null;

export function MilaSearchOverlay(props: React.ComponentProps<typeof MilaSearchOverlayV1>) {
  return MilaThreadScreen && props.variant !== "onboarding" ? <MilaThreadScreen {...props} /> : <MilaSearchOverlayV1 {...props} />;
}

// ─── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1 },
  root: { flex: 1, backgroundColor: N.cream100 },
  // Home's half-sheet: the frost shows through the chat's ground; the scrim above dims Home.
  sheetRoot: { backgroundColor: "transparent" },
  sheetWrap: { flex: 1, backgroundColor: "rgba(0,0,0,0.28)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden", backgroundColor: "rgba(250,247,242,0.82)" },
  sheetSolid: { backgroundColor: N.cream100 },
  sheetHandleZone: { alignItems: "center", paddingTop: 8, paddingBottom: 2 },
  sheetHandle: { width: 40, height: 5, borderRadius: 3, backgroundColor: "rgba(0,0,0,0.22)" },

  // Muse's two round controls, over the header's top corners (the avatar sits centred between them).
  headerControls: {
    position: "absolute",
    top: 4,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  // Frosted-glass circles, no outline (owner direction 8 Oct 2026, "much like Muse"; DESIGN.md §16).
  topBtn: { width: TOP_BTN, height: TOP_BTN, borderRadius: TOP_BTN / 2 },
  topBtnGlass: { width: TOP_BTN, height: TOP_BTN, alignItems: "center", justifyContent: "center" },

  // Body
  bodyInner: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20, flexGrow: 1 },
  // The tap-to-dismiss layer fills the transcript; in a conversation its content sits at the bottom.
  transcriptTap: { flexGrow: 1 },
  transcriptBottom: { justifyContent: "flex-end" },

  // Empty state
  empty: { alignItems: "center" },
  emptyTitle: {
    fontFamily: oppsFont(800),
    fontSize: 22,
    color: N.ink900,
    letterSpacing: -0.4,
    lineHeight: 26,
    maxWidth: 270,
    textAlign: "center",
  },
  emptySubtitle: {
    fontFamily: oppsFont(400),
    fontSize: 14.5,
    color: N.ink500,
    lineHeight: 22,
    marginTop: 8,
    maxWidth: 290,
    textAlign: "center",
  },
  suggestList: { gap: 10, marginTop: 28, width: "100%" },
  // A soft frosted row (Frost carries the glass, the corner and the lift) — no border.
  suggestRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  suggestAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: N.cream200,
  },
  suggestRowText: {
    flex: 1,
    fontFamily: oppsFont(600),
    fontSize: 15,
    color: N.ink900,
  },

  // Conversation
  convo: { gap: 18 },
  // Row wraps the user bubble + leading edit glyph; pushes both to the right.
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    backgroundColor: N.ink900,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  userBubbleText: {
    fontFamily: oppsFont(500),
    fontSize: 14.5,
    color: "#fff",
    lineHeight: 21,
  },

  milaBlock: { alignSelf: "stretch" },
  milaLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  milaLabelAvatar: {
    width: LABEL_AVATAR_SIZE,
    height: LABEL_AVATAR_SIZE,
    borderRadius: LABEL_AVATAR_SIZE / 2,
    backgroundColor: N.cream200,
  },
  milaLabelText: {
    fontFamily: oppsFont(700),
    fontSize: 13,
    color: N.ink900,
  },
  answerText: {
    fontFamily: oppsFont(400),
    fontSize: 15,
    color: N.ink900,
    lineHeight: 23,
  },
  // Inline widget card sits just under the answer text.
  widgetWrap: { marginTop: 12 },
  // Profile-update confirm cards, stacked under the answer.
  profileConfirmWrap: { marginTop: 12, gap: 10 },
  // Voice status line, directly above the input pill. Same red as a turn error —
  // one failure colour in this overlay, not two.
  voiceStatus: {
    fontFamily: oppsFont(500),
    fontSize: 12,
    color: N.error,
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  errorText: {
    fontFamily: oppsFont(500),
    fontSize: 15,
    color: N.error,
    lineHeight: 23,
  },
  errorAfterText: { marginTop: 8 },

  // Thinking
  thinkingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  thinkingText: {
    fontFamily: oppsFont(500),
    fontSize: 14,
    color: N.ink500,
  },
  dotsRow: { flexDirection: "row", gap: 3, marginLeft: 1 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: N.ink300 },


  // Input bar — no ground and no rule: the frosted composer floats over the cream.
  inputBar: {
    paddingTop: 10,
    paddingHorizontal: 16,
  },
  // The frosted composer (Frost carries the glass, the corner and the soft lift — no border).
  inputPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 7,
    paddingRight: 7,
    height: 52,
  },
  // ＋ and the empty send: frosted circles on the frosted bar. A ready send adds sendReady.
  roundBtn: {
    width: COMPOSER_BTN,
    height: COMPOSER_BTN,
    borderRadius: COMPOSER_BTN / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  sendReady: {
    backgroundColor: N.white,
    ...SOFT_LIFT,
  },
  ackWrap: { marginBottom: 10 },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: oppsFont(500),
    fontSize: 15,
    color: N.ink900,
    padding: 0,
  },
});
