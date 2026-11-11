/**
 * thread/MilaThreadView — the transcript and the composer of chat v2, drawn with assistant-ui's unstyled React Native
 * primitives and OUR views: the old chat's look, value for value (MilaSearchOverlay's styles: the Muse frosted
 * composer, ink user bubbles, her still beside "Mila", Outfit through `oppsFont`, the `N` tokens). No new visual design.
 *
 * What the primitives do: hold the messages (ThreadPrimitive.MessageByIndex per row), split each into its parts
 * (MessagePrimitive.Content: text, and the `data-mila-card` data parts — drawn in the order they arrived, so a card shows
 * while the rest of the answer is still coming), and own the composer's text (ComposerPrimitive.Input: on web, Enter
 * sends and Shift+Enter is a new line; ComposerPrimitive.Send).
 *
 * What stays ours: the transcript's ScrollView and its "follow the newest message unless she scrolled up" rule (the old
 * chat's, which opens at the newest message on web too — #1155's FlatList did not), the status line, Stop, Copy, Retry,
 * "Mila is still working…", and the cards (cards/MilaCardView, the existing card components).
 *
 * Today's chat's pieces, reused as they are: the ＋ (MilaThreadScreen opens today's sheet; the picks are assistant-ui
 * composer attachments through our adapter, drawn as today's chips, MilaAttachmentViews), the voice button and the voice
 * bar that stands where the composer was while a call is live (MilaVoiceButton / MilaVoiceBar), a voice card (MilaWidget),
 * and the nav chips and follow-ups under the newest answer (MilaFollowUps).
 *
 * Mila's words are drawn as plain text, as the old chat draws them (it has no markdown renderer).
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  Animated, Image, Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, View,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import {
  ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState,
} from "@assistant-ui/react-native";
import { N, oppsFont } from "../../deals/opps/tokens";
import { Bold } from "../../../constants/theme";
import { Frost, SOFT_LIFT } from "../Frost";
import { MilaCardView } from "../cards/MilaCardView";
import { MilaWidget } from "../MilaWidget";
import { MilaFollowUps } from "../MilaFollowUps";
import { MilaAttachmentChip, MilaAttachmentChipRow, MilaBubbleThumbs } from "../MilaAttachmentViews";
import { MilaVoiceButton } from "../MilaVoiceButton";
import { MilaVoiceBar } from "../MilaVoiceBar";
import type { UseMilaVoice } from "../useMilaVoice";
import type { MilaNavTarget, MilaWidget as MilaWidgetData } from "../../../hooks/use-mila-chat";
import { haptics } from "../../../lib/haptics";
import { copyText } from "./clipboard";
import { THREAD_COPY } from "./copy";
import { useStatusAnnouncement } from "./announce";
import { NO_OUTLINE, useFocusRing, useKeyboardInset } from "./webInput";
import { ATTACHMENT_ONLY_TEXT, followUpsOf, plainTextForCopy, type MilaAttachmentData } from "./wire";
import { pickedOf, RIGHTS_ACK_MESSAGE } from "./attachments";
import type { MilaThread } from "./useMilaThread";

const MILA_STILL = require("../../../../assets/mila/mila-still.png");
const LABEL_AVATAR_SIZE = 22;
const COMPOSER_BTN = 38;
const COMPOSER_RADIUS = 26;
const ROW_RADIUS = 18;
const ICON_BTN = 30;
/** Within this many points of the end, the transcript counts as "at the newest" and follows the reply. */
const STICK_THRESHOLD = 80;
const KEYBOARD_DISMISS_MODE = Platform.OS === "ios" ? "interactive" : "on-drag";
const COPIED_MS = 1600;
/** How long opening ON a message waits for it to be drawn before following the end again (today's chat's 4 s). */
const TARGET_WAIT_MS = 4000;
/**
 * The keyboard focus ring (DESIGN.md §14 asks for a visible :focus-visible ring; its electric blue was retired by the one
 * look, §18): the one accent, raspberry (Bold.act), thin, offset off the frosted pill.
 */
const FOCUS_RING = Bold.act;

/** The thread's state for the rows (they are drawn by the primitives, so they read it from here, not from props). */
const ThreadCtx = createContext<MilaThread | null>(null);
const useThread = () => useContext(ThreadCtx)!;

/** What the screen does with taps that leave the transcript (a nav chip, a voice card's Reply / Open), and a message's
 *  own layout (opening ON a message, from a push). */
interface ViewActions {
  onNav: (target: MilaNavTarget) => void;
  onMessageLayout: (messageId: string, y: number) => void;
}
const ActionsCtx = createContext<ViewActions>({ onNav: () => {}, onMessageLayout: () => {} });

// ─── Small pieces (the old chat's) ───────────────────────────────────────────────────────────────────────────────────

function ThinkingDots() {
  const dots = useRef([new Animated.Value(0.2), new Animated.Value(0.2), new Animated.Value(0.2)]).current;
  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(Animated.sequence([
        Animated.delay(i * 160),
        Animated.timing(v, { toValue: 1, duration: 280, useNativeDriver: Platform.OS !== "web" }),
        Animated.timing(v, { toValue: 0.2, duration: 280, useNativeDriver: Platform.OS !== "web" }),
        Animated.delay((2 - i) * 160 + 200),
      ])),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);
  return (
    <View style={styles.dotsRow} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {dots.map((v, i) => <Animated.View key={i} style={[styles.dot, { opacity: v }]} />)}
    </View>
  );
}

function MilaLabel() {
  return (
    <View style={styles.milaLabelRow}>
      <Image source={MILA_STILL} style={styles.milaLabelAvatar} accessibilityIgnoresInvertColors />
      <Text style={styles.milaLabelText}>Mila</Text>
    </View>
  );
}

/** What she is doing, in the server's fixed words — announced politely by screen readers. */
function StatusLine({ label }: { label: string }) {
  return (
    <View style={styles.thinkingRow} testID="thread-status">
      <Text
        style={styles.thinkingText}
        accessibilityLiveRegion="polite"
        accessibilityRole={Platform.OS === "web" ? undefined : "text"}
        // react-native-web: accessibilityLiveRegion becomes aria-live; role=status says what it is.
        {...(Platform.OS === "web" ? ({ role: "status" } as object) : {})}
        testID="thread-status-text"
      >
        {label.replace(/…$/, "")}
      </Text>
      <ThinkingDots />
    </View>
  );
}

/** The run is still going after the catch-up's wait ran out: one calm line, no error and no Retry. */
function SlowLine() {
  return (
    <Text
      style={styles.thinkingText}
      accessibilityLiveRegion="polite"
      {...(Platform.OS === "web" ? ({ role: "status" } as object) : {})}
      testID="thread-slow"
    >
      {THREAD_COPY.slow}
    </Text>
  );
}

/** A small frosted circle with a glyph (Muse): Copy. ≥ 44 touch target through hitSlop. */
function IconButton({ icon, label, onPress, testID, children }: {
  icon: React.ComponentProps<typeof Feather>["name"]; label: string; onPress: () => void; testID: string; children?: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.iconBtnRow, pressed && { opacity: 0.6 }]}
      testID={testID}
    >
      <Frost radius={ICON_BTN / 2} style={styles.iconBtn}>
        <Feather name={icon} size={14} color={N.ink500} />
      </Frost>
      {children}
    </Pressable>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onPress = useCallback(async () => {
    const ok = await copyText(plainTextForCopy(text));
    if (!ok) return;
    haptics.press();
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, [text]);
  return (
    <IconButton icon={copied ? "check" : "copy"} label={THREAD_COPY.copyLabel} onPress={onPress} testID="thread-copy">
      {copied ? <Text style={styles.quietText} accessibilityLiveRegion="polite" testID="thread-copied">{THREAD_COPY.copied}</Text> : null}
    </IconButton>
  );
}

function RetryButton() {
  const t = useThread();
  return (
    <Pressable
      onPress={() => { haptics.press(); t.retry(); }}
      disabled={!t.canRetry}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={THREAD_COPY.retryLabel}
      accessibilityState={{ disabled: !t.canRetry }}
      style={({ pressed }) => pressed && { opacity: 0.6 }}
      testID="thread-retry"
    >
      <Frost radius={ICON_BTN / 2} style={styles.retryPill}>
        <Feather name="rotate-ccw" size={13} color={N.ink700} />
        <Text style={styles.retryText}>{THREAD_COPY.retry}</Text>
      </Frost>
    </Pressable>
  );
}

// ─── Message rows (drawn by ThreadPrimitive.MessageByIndex) ──────────────────────────────────────────────────────────

function UserMessage() {
  const attachments = useAuiState((s) => s.message.parts)
    .flatMap((p) => (p.type === "data" && p.name === "mila-attachment" ? [p.data as MilaAttachmentData] : []));
  const hasText = useAuiState((s) => s.message.parts.some((p) => p.type === "text" && p.text.trim().length > 0));
  return (
    <View style={styles.userRow} testID="thread-user-msg">
      <View style={styles.userBubble}>
        <MilaBubbleThumbs items={attachments.map((a, i) => ({ key: `${a.assetId}-${i}`, thumbUrl: a.thumbUrl, role: a.role }))} />
        <MessagePrimitive.Content
          renderText={({ part }) => (part.text ? <Text style={styles.userBubbleText} selectable>{part.text}</Text> : <></>)}
          renderData={() => <></>}
        />
        {/* An attachment-only turn reads as the words it was sent with (today's chat shows them too). */}
        {!hasText && attachments.length ? <Text style={styles.userBubbleText} selectable>{ATTACHMENT_ONLY_TEXT}</Text> : null}
      </View>
    </View>
  );
}

/** A v1 card (a voice push, or a reopened chat's widget): today's MilaWidget, with today's taps. */
function WidgetPart({ widget }: { widget: MilaWidgetData }) {
  const t = useThread();
  const { onNav } = useContext(ActionsCtx);
  return (
    <MilaWidget
      widget={widget}
      onReply={(brand) => { void t.send(`Draft a reply to the ${brand} deal.`); }}
      onOpenDeal={(dealId) => onNav({ screen: "deal_detail", dealId })}
    />
  );
}

function AssistantMessage() {
  const t = useThread();
  const index = useAuiState((s) => s.message.index);
  const count = useAuiState((s) => s.thread.messages.length);
  const prevRole = useAuiState((s) => (s.message.index > 0 ? s.thread.messages[s.message.index - 1]?.role : undefined));
  const text = useAuiState((s) => s.message.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
  const messageId = useAuiState((s) => s.message.id);
  const { onMessageLayout } = useContext(ActionsCtx);
  const isLast = index === count - 1;
  const working = isLast && t.inFlight;
  const failed = isLast && !t.inFlight && (t.outcome === "failed" || t.outcome === "error");
  return (
    <View style={styles.milaBlock} testID="thread-mila-msg" onLayout={(e) => onMessageLayout(messageId, e.nativeEvent.layout.y)}>
      {prevRole === "assistant" ? null : <MilaLabel />}
      <View style={styles.parts}>
        <MessagePrimitive.Content
          renderText={({ part }) => (part.text ? <Text style={styles.answerText} selectable testID="thread-answer">{part.text}</Text> : <></>)}
          renderData={({ part }) => (
            part.name === "mila-card" ? <MilaCardView dto={part.data} />
              : part.name === "mila-widget" ? <WidgetPart widget={part.data as MilaWidgetData} />
              : <></>
          )}
        />
      </View>
      {working && t.statusLabel ? <StatusLine label={t.statusLabel} /> : null}
      {failed ? <Text style={[styles.errorText, text ? styles.errorAfterText : null]} testID="thread-error">{THREAD_COPY.error}</Text> : null}
      {isLast && !t.inFlight && t.outcome === "slow" ? <SlowLine /> : null}
      {!working && (text || (isLast && t.canRetry)) ? (
        <View style={styles.actionsRow}>
          {text ? <CopyButton text={text} /> : null}
          {isLast && t.canRetry ? <RetryButton /> : null}
        </View>
      ) : null}
    </View>
  );
}

const ROWS = { UserMessage, AssistantMessage } as const;

/**
 * Before Mila's turn has a message of its own (sent, nothing back yet; or the stream broke before it began): her label
 * and the status line, or the error and Retry.
 */
function PendingMila() {
  const t = useThread();
  const lastRole = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1]?.role);
  if (lastRole !== "user") return null;
  if (t.inFlight) {
    return (
      <View style={styles.milaBlock} testID="thread-mila-pending">
        <MilaLabel />
        <StatusLine label={t.statusLabel ?? THREAD_COPY.thinking} />
      </View>
    );
  }
  if (t.outcome === "slow") {
    return (
      <View style={styles.milaBlock} testID="thread-mila-pending">
        <MilaLabel />
        <SlowLine />
      </View>
    );
  }
  if (!t.canRetry) return null;
  return (
    <View style={styles.milaBlock} testID="thread-mila-pending">
      <MilaLabel />
      {t.outcome === "stopped" ? null : <Text style={styles.errorText} testID="thread-error">{THREAD_COPY.error}</Text>}
      <View style={styles.actionsRow}><RetryButton /></View>
    </View>
  );
}

/** Today's nav chips and follow-ups, under the newest answer once it has finished. */
function FollowUps() {
  const t = useThread();
  const { onNav } = useContext(ActionsCtx);
  const last = t.messages[t.messages.length - 1];
  if (!last || last.role !== "assistant" || t.inFlight) return null;
  const f = followUpsOf(last);
  if (!f) return null;
  return (
    <MilaFollowUps
      actions={f.actions}
      suggestions={f.suggestions}
      onNav={onNav}
      onAsk={(q) => { void t.send(q); }}
    />
  );
}

// ─── Transcript ──────────────────────────────────────────────────────────────────────────────────────────────────────

function Transcript({ topInset, empty, convoTop, targetMessageId, onNav }: {
  topInset: number;
  empty?: React.ReactNode;
  convoTop?: React.ReactNode;
  targetMessageId?: string | null;
  onNav: (target: MilaNavTarget) => void;
}) {
  const t = useThread();
  const count = useAuiState((s) => s.thread.messages.length);
  const scrollRef = useRef<ScrollView>(null);
  // Opening ON a message (a push for a message Mila started): hold the transcript off the end until that message is
  // drawn, then scroll to it; give up after TARGET_WAIT_MS and follow the end again (today's chat's rule).
  const targetRef = useRef<string | null>(null);
  const tapYRef = useRef(0);
  const convoYRef = useRef(0);
  // Follow the newest message while she is at (or near) the end; once she scrolls up to read, stay put until she sends
  // or scrolls back down. Only HER scrolling moves the flag (programmatic scrolls fire scroll events too).
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
  // A new turn of hers re-attaches the transcript to the end.
  const lastRole = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1]?.role);
  useEffect(() => { if (lastRole === "user") stickRef.current = true; }, [lastRole, count]);
  // Opening a chat (or a long one loaded after a drop) lands on the newest message at once; only a reply that is
  // arriving scrolls with animation.
  const toEnd = useCallback(() => {
    if (count && stickRef.current) scrollRef.current?.scrollToEnd({ animated: t.inFlight });
  }, [count, t.inFlight]);
  useEffect(() => {
    if (!targetMessageId) return undefined;
    targetRef.current = `saved-${targetMessageId}`;
    stickRef.current = false;
    const timer = setTimeout(() => {
      if (!targetRef.current) return;
      targetRef.current = null;
      stickRef.current = true;
      scrollRef.current?.scrollToEnd({ animated: true });
    }, TARGET_WAIT_MS);
    return () => clearTimeout(timer);
  }, [targetMessageId]);
  const actions = React.useMemo<ViewActions>(() => ({
    onNav,
    onMessageLayout: (messageId, y) => {
      if (!targetRef.current || messageId !== targetRef.current) return;
      targetRef.current = null;
      scrollRef.current?.scrollTo({ y: Math.max(0, tapYRef.current + convoYRef.current + y - topInset - 12), animated: false });
    },
  }), [onNav, topInset]);

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.flex}
      contentContainerStyle={[styles.bodyInner, { paddingTop: topInset + 12 }]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={KEYBOARD_DISMISS_MODE}
      scrollEventThrottle={32}
      onScroll={onScroll}
      onScrollBeginDrag={() => { draggingRef.current = true; }}
      onScrollEndDrag={(e) => { draggingRef.current = false; stickRef.current = atEnd(e); }}
      onMomentumScrollEnd={(e) => { stickRef.current = atEnd(e); }}
      onContentSizeChange={toEnd}
      onLayout={() => { if (count && stickRef.current) scrollRef.current?.scrollToEnd({ animated: false }); }}
      testID="thread-transcript"
    >
      {/* A tap on the transcript (not on a control) puts the keyboard away (Muse). A dismiss target, not a button. */}
      <Pressable
        onPress={() => Keyboard.dismiss()}
        accessible={false}
        style={[styles.transcriptTap, count > 0 && styles.transcriptBottom]}
        onLayout={(e) => { tapYRef.current = e.nativeEvent.layout.y; }}
        testID="thread-transcript-tap"
      >
        <ActionsCtx.Provider value={actions}>
          {count === 0 ? empty : (
            <View style={styles.convo} onLayout={(e) => { convoYRef.current = e.nativeEvent.layout.y; }}>
              {convoTop}
              {Array.from({ length: count }, (_, i) => <ThreadPrimitive.MessageByIndex key={i} index={i} components={ROWS} />)}
              <PendingMila />
              <FollowUps />
            </View>
          )}
        </ActionsCtx.Provider>
      </Pressable>
    </ScrollView>
  );
}

// ─── Composer ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The staged attachments above the input (assistant-ui's composer attachments, drawn as today's chips). */
function AttachmentChips() {
  const aui = useAui();
  const count = useAuiState((s) => s.composer.attachments.length);
  if (!count) return null;
  return (
    <MilaAttachmentChipRow>
      <ComposerPrimitive.Attachments>
        {({ attachment }) => {
          const picked = pickedOf(attachment);
          const st = attachment.status.type;
          // Waiting for the rights acknowledgment is not a failure: the screen takes it out and asks once.
          if (st === "incomplete" && "message" in attachment.status && attachment.status.message === RIGHTS_ACK_MESSAGE) return null;
          return (
            <MilaAttachmentChip
              key={attachment.id}
              uri={picked?.asset.uri ?? ""}
              role={picked?.role === "product" ? "product" : picked?.asset.type === "video" ? "video" : "photo"}
              status={st === "running" ? "uploading" : st === "incomplete" ? "failed" : "ready"}
              onRemove={() => { void aui.composer.attachment({ id: attachment.id }).remove().catch(() => {}); }}
              testID="thread-attachment-chip"
            />
          );
        }}
      </ComposerPrimitive.Attachments>
    </MilaAttachmentChipRow>
  );
}

function Composer({ bottomInset, voice, onAttach, composerTop }: {
  bottomInset: number;
  voice?: UseMilaVoice | null;
  onAttach?: () => void;
  composerTop?: React.ReactNode;
}) {
  const t = useThread();
  const aui = useAui();
  const hasText = useAuiState((s) => s.composer.text.trim().length > 0);
  // An uploaded attachment can be sent on its own (today's chat: "Say something about it, or just send").
  const readyAttachments = useAuiState((s) => s.composer.attachments.filter((a) => a.status.type === "requires-action" || a.status.type === "complete").length);
  const ready = hasText || readyAttachments > 0;
  const keyboardInset = useKeyboardInset();
  const focus = useFocusRing();
  const voiceOn = !!voice?.supported;
  const toggleVoice = () => { haptics.press(); voice?.toggle(); };
  return (
    <View style={[styles.inputBar, { paddingBottom: 12 + bottomInset + keyboardInset }]}>
      {/* Voice status: one line, only when there is something to say (a failure, or a notice). */}
      {voiceOn && (voice!.error || voice!.notice) ? <Text style={styles.voiceStatus} testID="thread-voice-status">{voice!.error ?? voice!.notice}</Text> : null}
      {voiceOn && voice!.active ? (
        // Live: the voice bar IS the composer (one bar, one mic: End). Staged attachments stay and come back with it.
        <MilaVoiceBar variant="composer" state={voice!.state} justEnded={voice!.justEnded} onEnd={toggleVoice} audioBlocked={voice!.audioBlocked} onResumeAudio={voice!.resumeAudio} />
      ) : (
      <>
      {voiceOn && voice!.justEnded ? <MilaVoiceBar state={voice!.state} justEnded={voice!.justEnded} onEnd={toggleVoice} /> : null}
      {composerTop}
      <ComposerPrimitive.Root>
        <AttachmentChips />
        <Frost radius={COMPOSER_RADIUS} style={[styles.inputPill, onAttach && styles.inputPillWithAdd, focus.focusRing && styles.focusRing]} testID="thread-composer">
          {/* ＋ — photos, a product, a contract, or a web search (today's sheet). */}
          {onAttach ? (
            <Pressable
              onPress={() => { haptics.press(); Keyboard.dismiss(); onAttach(); }}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Add something"
              accessibilityHint="Attach a photo, a product, a contract, or search the web"
              style={({ pressed }) => pressed && { opacity: 0.7 }}
              testID="thread-add"
            >
              <Frost radius={COMPOSER_BTN / 2} style={styles.roundBtn}>
                <Feather name="plus" size={20} color={N.ink700} />
              </Frost>
            </Pressable>
          ) : null}
          {/* In a View: on web a View is positioned, so it stacks over the Frost's glass (a bare <textarea> is not, and
              the glass painted over its text, blurring it). */}
          <View style={styles.inputWrap}>
          <ComposerPrimitive.Input
            style={[styles.input, NO_OUTLINE]}
            placeholder={readyAttachments ? THREAD_COPY.placeholderWithAttachment : THREAD_COPY.placeholder}
            placeholderTextColor={N.ink500}
            accessibilityLabel={THREAD_COPY.composerLabel}
            autoCorrect={false}
            // Web: a textarea, so Shift+Enter is a new line and Enter sends (the primitive's submitMode "enter").
            multiline={Platform.OS === "web"}
            submitMode="enter"
            returnKeyType="send"
            blurOnSubmit={Platform.OS !== "web"}
            onSubmitEditing={Platform.OS === "web" ? undefined : () => { if (!t.busy) { Keyboard.dismiss(); aui.composer.send(); } }}
            onFocus={focus.onFocus}
            onBlur={focus.onBlur}
            testID="thread-input"
          />
          </View>
          {/* The voice toggle (live voice with Mila) — today's button, only where voice is available. */}
          {voiceOn ? <MilaVoiceButton state={voice!.state} onPress={toggleVoice} /> : null}
          {t.busy ? (
            <Pressable
              onPress={() => { haptics.press(); t.stop(); }}
              accessibilityRole="button"
              accessibilityLabel={THREAD_COPY.stop}
              hitSlop={6}
              style={({ pressed }) => pressed && { opacity: 0.8 }}
              testID="thread-stop"
            >
              <View style={[styles.roundBtn, styles.sendReady]}>
                <Feather name="square" size={18} color={N.ink900} />
              </View>
            </Pressable>
          ) : (
            <ComposerPrimitive.Send
              accessibilityLabel={THREAD_COPY.send}
              hitSlop={6}
              onPressIn={() => { if (ready) { haptics.press(); Keyboard.dismiss(); } }}
              style={({ pressed }: { pressed: boolean }) => pressed && { opacity: 0.8 }}
              testID="thread-send"
            >
              {ready ? (
                <View style={[styles.roundBtn, styles.sendReady]}>
                  <Feather name="arrow-up" size={18} color={N.ink900} />
                </View>
              ) : (
                <Frost radius={COMPOSER_BTN / 2} style={styles.roundBtn}>
                  <Feather name="arrow-up" size={18} color={N.ink300} />
                </Frost>
              )}
            </ComposerPrimitive.Send>
          )}
        </Frost>
      </ComposerPrimitive.Root>
      </>
      )}
    </View>
  );
}

// ─── The view ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MilaThreadViewProps {
  thread: MilaThread;
  /** The floating header's height: the transcript starts below her and scrolls under her. */
  topInset: number;
  /** The home indicator (0 in the tab, where the bottom menu sits under the composer). */
  bottomInset?: number;
  /** The empty state (greeting + openers), drawn when the conversation has no messages. */
  empty?: React.ReactNode;
  /** Drawn at the top of a conversation (Mila's camera-roll offer, as in today's chat). */
  convoTop?: React.ReactNode;
  /** The live voice session (today's): its button in the composer, its bar in the composer's place while live. */
  voice?: UseMilaVoice | null;
  /** The ＋: opens today's attach sheet. */
  onAttach?: () => void;
  /** Above the composer (the one-time rights acknowledgment). */
  composerTop?: React.ReactNode;
  /** A nav chip or a voice card's link: the screen opens it. */
  onNav?: (target: MilaNavTarget) => void;
  /** A saved message to open ON (its server id), from a push. */
  targetMessageId?: string | null;
}

const NO_NAV = () => {};

/** Must sit inside the runtime's AssistantRuntimeProvider (MilaThreadScreen puts it there). */
export function MilaThreadView({
  thread, topInset, bottomInset = 0, empty, convoTop, voice, onAttach, composerTop, onNav = NO_NAV, targetMessageId,
}: MilaThreadViewProps) {
  // iOS: VoiceOver has no live regions, so the status line (and the calm "taking longer" line) is spoken (announce.ts).
  useStatusAnnouncement(thread.inFlight ? thread.statusLabel : thread.outcome === "slow" ? THREAD_COPY.slow : null);
  return (
    <ThreadCtx.Provider value={thread}>
      <View style={styles.flex} testID="thread-v2">
        <Transcript topInset={topInset} empty={empty} convoTop={convoTop} targetMessageId={targetMessageId} onNav={onNav} />
        <Composer bottomInset={bottomInset} voice={voice} onAttach={onAttach} composerTop={composerTop} />
      </View>
    </ThreadCtx.Provider>
  );
}

/** An opener row of the empty state (the old chat's SuggestRow): her still, the line, a quiet arrow. */
export function OpenerRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => pressed && { opacity: 0.7 }}>
      <Frost radius={ROW_RADIUS} style={styles.suggestRow}>
        <Image source={MILA_STILL} style={styles.suggestAvatar} accessibilityIgnoresInvertColors />
        <Text style={styles.suggestRowText}>{label}</Text>
        <Feather name="arrow-up-right" size={15} color={N.ink300} />
      </Frost>
    </Pressable>
  );
}

// Values from MilaSearchOverlay's StyleSheet, so the two chats look the same.
export const styles = StyleSheet.create({
  flex: { flex: 1 },
  bodyInner: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20, flexGrow: 1 },
  transcriptTap: { flexGrow: 1 },
  transcriptBottom: { justifyContent: "flex-end" },
  convo: { gap: 18 },
  userRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8 },
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
  userBubbleText: { fontFamily: oppsFont(500), fontSize: 14.5, color: "#fff", lineHeight: 21 },
  milaBlock: { alignSelf: "stretch" },
  parts: { gap: 12 },
  milaLabelRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  milaLabelAvatar: { width: LABEL_AVATAR_SIZE, height: LABEL_AVATAR_SIZE, borderRadius: LABEL_AVATAR_SIZE / 2, backgroundColor: N.cream200 },
  milaLabelText: { fontFamily: oppsFont(700), fontSize: 13, color: N.ink900 },
  answerText: { fontFamily: oppsFont(400), fontSize: 15, color: N.ink900, lineHeight: 23 },
  errorText: { fontFamily: oppsFont(500), fontSize: 15, color: N.error, lineHeight: 23 },
  errorAfterText: { marginTop: 8 },
  thinkingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  thinkingText: { fontFamily: oppsFont(500), fontSize: 14, color: N.ink500 },
  dotsRow: { flexDirection: "row", gap: 3, marginLeft: 1 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: N.ink300 },
  actionsRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 },
  iconBtnRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconBtn: { width: ICON_BTN, height: ICON_BTN, alignItems: "center", justifyContent: "center" },
  quietText: { fontFamily: oppsFont(500), fontSize: 12.5, color: N.ink500 },
  retryPill: { flexDirection: "row", alignItems: "center", gap: 6, height: ICON_BTN, paddingHorizontal: 12 },
  retryText: { fontFamily: oppsFont(700), fontSize: 12.5, color: N.ink900 },
  inputBar: { paddingTop: 10, paddingHorizontal: 16 },
  inputPill: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16, paddingRight: 7, minHeight: 52 },
  // With the ＋ at its left, the pill's padding is the old chat's (7 each side).
  inputPillWithAdd: { paddingLeft: 7 },
  // Voice status line, directly above the composer: the turn error's red (one failure colour, as in today's chat).
  voiceStatus: { fontFamily: oppsFont(500), fontSize: 12, color: N.error, paddingHorizontal: 8, paddingBottom: 8 },
  focusRing: Platform.OS === "web"
    ? ({ outlineStyle: "solid", outlineWidth: 1.5, outlineColor: FOCUS_RING, outlineOffset: 2 } as object)
    : {},
  roundBtn: { width: COMPOSER_BTN, height: COMPOSER_BTN, borderRadius: COMPOSER_BTN / 2, alignItems: "center", justifyContent: "center" },
  sendReady: { backgroundColor: N.white, ...SOFT_LIFT },
  inputWrap: { flex: 1, minWidth: 0, justifyContent: "center" },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: oppsFont(500),
    fontSize: 15,
    color: N.ink900,
    padding: 0,
    ...(Platform.OS === "web" ? { paddingVertical: 15, maxHeight: 120 } : {}),
  },
  suggestRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  suggestAvatar: { width: 20, height: 20, borderRadius: 10, backgroundColor: N.cream200 },
  suggestRowText: { flex: 1, fontFamily: oppsFont(600), fontSize: 15, color: N.ink900 },
});
