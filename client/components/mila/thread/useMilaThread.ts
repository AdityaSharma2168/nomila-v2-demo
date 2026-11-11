/**
 * thread/useMilaThread — the chat v2 conversation: the AI SDK's useChat over our transport (thread/api.ts), handed to
 * assistant-ui as its runtime (useAISDKRuntime), plus the three things neither library does for us:
 *
 *   Stop      — POST /chat/v2/runs/:runId/stop (the server stops the turn), then abort the stream. Asked before the
 *               run id has arrived, the stop waits for it (STOP_WAIT_MS at most), so the turn is stopped, not just
 *               the reading.
 *   Catch-up  — a dropped stream (an error, or an end without `data-mila-done`) or the app coming back while a run is
 *               unfinished: poll GET /chat/v2/runs/:runId while it is "running", with a growing wait (POLL_MS ×
 *               POLL_BACKOFF up to POLL_MAX_MS), until the server's turn timeout has passed (at most POLL_CAP looks),
 *               then load the saved turns (GET /me/conversations/:id). "Mila is still working…" shows meanwhile. The
 *               server keeps working when the phone drops (decision 4), so the reply is there when we look. Still
 *               running past the timeout: THREAD_COPY.slow, calmly, with no error and no Retry (only a stopped or
 *               failed run shows those); coming back to the app looks again.
 *   Retry     — on the last turn only, once it ended stopped, failed or in an error: the athlete's last text, sent again
 *               as a NEW turn through the same request ({ conversationId, message: { text } }). Never history.
 *
 * The conversation id is the app's (a UUID it mints, as v1 does); the server checks it belongs to her. The Mila tab and
 * Home's sheet share one thread through `sharedThread`, as v1's surfaces do.
 *
 * Voice (today's chat's, unchanged): the live session gets this conversation id, so its turns are saved into THIS
 * thread by the voice worker (server/voice/transcriptRoute.ts → chat_messages, source 'voice'), the same server path
 * today's chat relies on. `appendTranscript` / `appendWidgetMessage` only SHOW them live (marked `voice`), with today's
 * collapse rule (hooks/transcriptCollapse); a reopened chat replays the saved rows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import { useChat } from "@ai-sdk/react";
import { useAISDKRuntime } from "@assistant-ui/ai-sdk";
import type { AttachmentAdapter } from "@assistant-ui/react-native";
import type * as ImagePicker from "expo-image-picker";
import { getApiUrl, getAuthHeaders } from "../../../lib/query-client";
import { markConversationSeen } from "../../../lib/milaUnread";
import type { ChatPhase } from "../../../hooks/use-mila-chat";
import { createTranscriptTracker, planTranscriptUpdate } from "../../../hooks/transcriptCollapse";
import type { CameraRollPickOptions, CameraRollPickResult, MediaItem, UploadRole } from "../../../hooks/use-media-library";
import type { ParsedWidgetPush, TranscriptUpdate, UseMilaVoice } from "../useMilaVoice";
import { createMilaApi, type FetchLike, type MilaApi } from "./api";
import {
  doneOf, lastTypedOf, lastUserAttachments, lastUserText, textOf, unfinishedRunOf, type MilaAttachmentData, type MilaUIMessage,
} from "./wire";
import { THREAD_COPY } from "./copy";

/** The catch-up's first wait between two looks at the run; each next wait is POLL_BACKOFF times longer, up to POLL_MAX_MS. */
export const POLL_MS = 3000;
export const POLL_BACKOFF = 1.6;
export const POLL_MAX_MS = 20_000;
/** A ceiling on the looks of one catch-up, whatever the deadline says (with the back-off, ~20 looks fill 4 minutes). */
export const POLL_CAP = 60;
/** How long the catch-up waits for a running run: the server's turn timeout (GET /runs/:runId turnTimeoutMs, the engine's
 *  TF.turnTimeoutMs) less how far into it the run already is, plus WAIT_GRACE_MS for the reply to be saved after it. The
 *  default is the engine's own default, for a server that does not say; MAX_WAIT_MS bounds whatever it says. */
export const DEFAULT_TURN_TIMEOUT_MS = 240_000;
export const WAIT_GRACE_MS = 30_000;
export const MAX_WAIT_MS = 15 * 60_000;
/** Looks in a row that could not read the run (offline, a 404) before the catch-up gives up and says so. */
export const MISSED_LOOKS_CAP = 3;
export const STOP_WAIT_MS = 5000;

/**
 * How the last turn ended, when that is something to say. Completed turns are null. "stopped", "failed" and "error"
 * offer Retry; "slow" (still running when the catch-up's wait ran out) says so calmly and offers nothing: she is not
 * asked to send it again while Mila is still on it.
 */
export type TurnOutcome = "stopped" | "failed" | "error" | "slow" | null;

/** How long one catch-up may wait for this run, from the first look's answer (ms; never negative, never over MAX_WAIT_MS). */
export function catchUpBudgetMs(run: { turnTimeoutMs?: number; runningForMs?: number } | null, graceMs = WAIT_GRACE_MS): number {
  const timeout = typeof run?.turnTimeoutMs === "number" && run.turnTimeoutMs > 0 ? run.turnTimeoutMs : DEFAULT_TURN_TIMEOUT_MS;
  const used = typeof run?.runningForMs === "number" && run.runningForMs > 0 ? run.runningForMs : 0;
  return Math.min(MAX_WAIT_MS, Math.max(0, timeout - used + graceMs));
}

/** One conversation across the Mila surfaces (the tab, Home's sheet): its id and a revision bumped on every change. */
export const sharedThread: { id: string | null; rev: number } = { id: null, rev: 0 };

export interface MilaThreadOptions {
  pollMs?: number;
  pollMaxMs?: number;
  pollCap?: number;
  /** Added to the server's turn timeout before the catch-up gives up waiting (tests shorten it). */
  waitGraceMs?: number;
  stopWaitMs?: number;
  /** Tests and the gallery hand in their own; the app uses expo/fetch + the signed-in headers. */
  api?: (deps: { conversationId: () => string }) => MilaApi;
  /** Tests and the gallery: the voice session (the app uses useMilaVoice, which needs the signed-in athlete). Fixed for
   *  the life of the screen. */
  useVoice?: (opts: {
    conversationId?: string | null;
    onTranscript?: (u: TranscriptUpdate) => void;
    onWidget?: (p: ParsedWidgetPush) => void;
  }) => UseMilaVoice;
  /** Tests and the gallery: the media upload (the app uses useUploadMedia) and the camera-roll picker. */
  upload?: (input: { asset: ImagePicker.ImagePickerAsset; ackRights?: boolean; role?: UploadRole }) => Promise<MediaItem>;
  pick?: (mode: "photo" | "all", opts: CameraRollPickOptions) => Promise<CameraRollPickResult | null>;
}

/** A wait the catch-up can cut short: an abort (New chat, a new turn, the app going to the background, unmount)
 *  clears the timer at once, so no poll outlives the thing that asked for it. */
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const onAbort = () => { clearTimeout(t); resolve(); };
  const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
});

export function useMilaThread(opts: MilaThreadOptions = {}, extra: { attachments?: AttachmentAdapter } = {}) {
  const pollMs = opts.pollMs ?? POLL_MS;
  const pollMaxMs = opts.pollMaxMs ?? POLL_MAX_MS;
  const pollCap = opts.pollCap ?? POLL_CAP;
  const waitGraceMs = opts.waitGraceMs ?? WAIT_GRACE_MS;
  const stopWaitMs = opts.stopWaitMs ?? STOP_WAIT_MS;

  const conversationRef = useRef<string>("");
  const seenRevRef = useRef(0);
  if (!conversationRef.current) {
    if (!sharedThread.id) sharedThread.id = Crypto.randomUUID();
    conversationRef.current = sharedThread.id;
    seenRevRef.current = sharedThread.rev;
  }

  const makeApi = opts.api;
  const api = useMemo<MilaApi>(
    () => makeApi?.({ conversationId: () => conversationRef.current }) ?? createMilaApi({
      apiUrl: getApiUrl,
      headers: getAuthHeaders,
      conversationId: () => conversationRef.current,
      fetch: expoFetch as unknown as FetchLike,
    }),
    // One transport for the life of the screen: the conversation id is read per request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The latest status line and how much text there was when it arrived: a status newer than the text is what she is
  // doing now; text past it means she is writing.
  const [live, setLive] = useState<{ label: string; phase: "thinking" | "tool"; textLen: number } | null>(null);
  const messagesRef = useRef<MilaUIMessage[]>([]);

  const chat = useChat<MilaUIMessage>({
    transport: api.transport,
    onData: (part) => {
      if (part.type !== "data-mila-status") return;
      const d = part.data as { label: string; phase: "thinking" | "tool" };
      const last = messagesRef.current[messagesRef.current.length - 1];
      setLive({ label: d.label, phase: d.phase, textLen: last?.role === "assistant" ? textOf(last).length : 0 });
    },
  });
  messagesRef.current = chat.messages;
  // Our attachment adapter (thread/attachments.ts) onto the existing media upload; the transport sends only the ids.
  const runtime = useAISDKRuntime(chat, { joinStrategy: "none", ...(extra.attachments ? { adapters: { attachments: extra.attachments } } : {}) });

  const [outcome, setOutcome] = useState<TurnOutcome>(null);
  const [recovering, setRecovering] = useState(false);
  const genRef = useRef(0);           // bumped by newChat / open / unmount: a catch-up from before stops writing
  const stopAskedRef = useRef(false); // the athlete tapped Stop on this turn
  const sendingRef = useRef(false);   // a send / retry is being handed to useChat right now (double-tap guard)
  // The catch-up in progress (null: none). Aborting it stops its polling at once (its timer is cleared too).
  const recoveryRef = useRef<AbortController | null>(null);
  // The stream that is ending was let go of on purpose (New chat, opening a saved one): its end is not a drop, and it
  // never starts a catch-up. Cleared by her next turn.
  const discardRef = useRef(false);
  // A Stop tapped before the run id arrived, waiting for it (STOP_WAIT_MS at most).
  const pendingStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingStop = () => {
    if (pendingStopRef.current) { clearTimeout(pendingStopRef.current); pendingStopRef.current = null; }
  };

  const busy = chat.status === "submitted" || chat.status === "streaming";
  const inFlight = busy || recovering;

  // The live voice lines' bookkeeping (hooks/transcriptCollapse): which line each spoken stream fills. Every wholesale
  // replacement of the messages (new chat, a saved chat, a catch-up) invalidates it.
  const txRef = useRef(createTranscriptTracker());
  const voiceIdRef = useRef(0);
  const resetTranscript = useCallback(() => {
    txRef.current.streamToId.clear();
    txRef.current.lastUser = null;
  }, []);

  // ── Catch-up after a drop ─────────────────────────────────────────────────────────────────────────────────────────
  const cancelRecovery = useCallback(() => {
    if (!recoveryRef.current) return;
    recoveryRef.current.abort();
    recoveryRef.current = null;
    setRecovering(false);
  }, []);

  const recover = useCallback(async (runId: string) => {
    if (recoveryRef.current) return; // one catch-up at a time (the stream's end and the app coming back can both ask)
    const ac = new AbortController();
    recoveryRef.current = ac;
    const gen = genRef.current;
    const conversationId = conversationRef.current;
    const alive = () => !ac.signal.aborted && gen === genRef.current && conversationId === conversationRef.current;
    setRecovering(true);
    setOutcome(null);
    try {
      // While the run says running: look again after a wait that grows (POLL_MS × POLL_BACKOFF, up to pollMaxMs), until
      // the server's own turn timeout (plus grace) has passed, and never more than pollCap looks. A look that cannot read
      // the run is tried again, MISSED_LOOKS_CAP times in a row at most.
      let run = await api.getRun(runId, ac.signal);
      let known = run;
      let missed = run ? 0 : 1;
      const deadline = Date.now() + catchUpBudgetMs(run, waitGraceMs);
      let wait = pollMs;
      for (let i = 1; (run?.status === "running" || (!run && missed < MISSED_LOOKS_CAP)) && i < pollCap; i++) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        await sleep(Math.min(wait, left), ac.signal);
        if (!alive()) return;
        wait = Math.min(wait * POLL_BACKOFF, pollMaxMs);
        run = await api.getRun(runId, ac.signal);
        if (run) { known = run; missed = 0; } else missed += 1;
      }
      if (!alive()) return;
      if (known?.status === "running") {
        // Still working when the wait ran out: say so calmly, keep what has arrived, and stop looking. Coming back to
        // the app (AppState active) looks again; nothing is offered to send again.
        setOutcome("slow");
        setRecovering(false);
        return;
      }
      const saved = await api.loadConversation(conversationId);
      if (!alive()) return;
      if (saved && saved.length) { resetTranscript(); chat.setMessages(saved); }
      // Only a run that ended stopped or failed (or one that could not be read at all) says so and offers Retry.
      setOutcome(known?.status === "completed" ? null : known?.status === "stopped" ? "stopped" : known?.status === "failed" ? "failed" : "error");
      setRecovering(false);
    } finally {
      if (recoveryRef.current === ac) recoveryRef.current = null;
    }
  }, [api, chat, pollCap, pollMs, pollMaxMs, waitGraceMs, resetTranscript]);

  // The stream ended (or broke). Done: say how it ended. No done and not stopped by her: catch up from the server.
  // `turnOpenRef` is set when her turn starts (below) or a stream is seen running, so a submitted → error that happens
  // between two renders (a refused request) is still noticed.
  const turnOpenRef = useRef(false);
  if (busy) turnOpenRef.current = true;
  // A new turn of hers — from the composer (through assistant-ui's runtime), an opener, a card or Retry — starts clean.
  // In the same effect as the ending, and first: a refused request can start and end within one render.
  const lastUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const newest = chat.messages[chat.messages.length - 1];
    if (newest?.role === "user" && !newest.metadata?.saved && !newest.metadata?.voice && newest.id !== lastUserIdRef.current) {
      lastUserIdRef.current = newest.id;
      turnOpenRef.current = true;
      stopAskedRef.current = false;
      discardRef.current = false;
      // A catch-up of the turn before must not land its saved turns over this one, and a Stop still waiting for the
      // turn before's run id must not stop this one.
      cancelRecovery();
      clearPendingStop();
      setOutcome(null);
      setLive(null);
      sharedThread.id = conversationRef.current;
      sharedThread.rev += 1;
      seenRevRef.current = sharedThread.rev;
    }
    if (chat.status !== "ready" && chat.status !== "error") return;
    if (!turnOpenRef.current) return;
    turnOpenRef.current = false;
    if (discardRef.current) return;
    // The typed turn's own reply: a voice line that landed after it says nothing about how it ended.
    const last = lastTypedOf(chat.messages);
    if (stopAskedRef.current) { setOutcome("stopped"); return; }
    const done = last?.role === "assistant" ? doneOf(last) : null;
    if (done) { setOutcome(done.status === "completed" ? null : done.status); return; }
    const runId = unfinishedRunOf(chat.messages);
    if (runId) { void recover(runId); return; }
    setOutcome(chat.status === "error" ? "error" : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.status, chat.messages, recover, cancelRecovery]);

  // To the background: the catch-up stops polling (nothing ticks while she is away). Back, with a run unfinished and
  // no live stream: catch up again.
  const appStateRef = useRef<(s: string) => void>(() => {});
  appStateRef.current = (s: string) => {
    if (s === "background") { cancelRecovery(); return; }
    if (s !== "active" || busy || recoveryRef.current) return;
    const runId = unfinishedRunOf(chat.messages);
    if (runId) void recover(runId);
  };
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => appStateRef.current(s));
    return () => sub.remove();
  }, []);

  // ── Send / Retry ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** Send her text as a new turn (an opener, a card's reply, Retry), with what she attached (Retry only). The composer
   *  sends through the runtime instead. */
  const send = useCallback(async (text: string, attachments: readonly MilaAttachmentData[] = []) => {
    const q = text.trim();
    if ((!q && !attachments.length) || sendingRef.current || busy) return;
    sendingRef.current = true;
    try {
      if (!attachments.length) await chat.sendMessage({ text: q });
      else {
        await chat.sendMessage({
          parts: [
            ...(q ? [{ type: "text" as const, text: q }] : []),
            ...attachments.map((data) => ({ type: "data-mila-attachment" as const, data })),
          ],
        } as Parameters<typeof chat.sendMessage>[0]);
      }
    } finally {
      sendingRef.current = false;
    }
  }, [chat, busy]);

  const canRetry = !inFlight && outcome !== null && outcome !== "slow" && chat.messages.length > 0;
  const retry = useCallback(() => {
    if (!canRetry || sendingRef.current) return;
    const text = lastUserText(chat.messages);
    const attachments = lastUserAttachments(chat.messages);
    if (!text && !attachments.length) return;
    void send(text, attachments);
  }, [canRetry, chat.messages, send]);

  // ── Voice: live turns from the voice session, shown as they happen (the worker saves them) ─────────────────────────
  const voiceTouched = () => {
    // The other Mila surface is now behind this thread; a typed turn's ending says nothing about a spoken one.
    sharedThread.id = conversationRef.current;
    sharedThread.rev += 1;
    seenRevRef.current = sharedThread.rev;
    setOutcome(null);
  };
  const appendTranscript = useCallback((update: TranscriptUpdate) => {
    const plan = planTranscriptUpdate(txRef.current, update, Date.now(), (role) => `voice-${role}-${++voiceIdRef.current}`);
    if (plan.kind === "ignore") return;
    const textPart = (text: string, streaming: boolean) => ({ type: "text" as const, text, state: streaming ? ("streaming" as const) : ("done" as const) });
    if (plan.kind === "update") {
      chat.setMessages((prev) => prev.map((m) => {
        if (m.id !== plan.id) return m;
        const text = plan.content ?? textOf(m);
        return { ...m, parts: [textPart(text, plan.streaming)] };
      }));
      return;
    }
    chat.setMessages((prev) => [...prev, { id: plan.id, role: plan.role, parts: [textPart(plan.content, plan.streaming)], metadata: { voice: true } }]);
    voiceTouched();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);
  /** A card pushed live from the voice session (already validated, components/mila/widgetPush.ts): her line + the card. */
  const appendWidgetMessage = useCallback((push: ParsedWidgetPush) => {
    const line = push.line.trim();
    if (!line) return;
    chat.setMessages((prev) => [...prev, {
      id: `voice-widget-${++voiceIdRef.current}`,
      role: "assistant",
      parts: [{ type: "text", text: line, state: "done" }, { type: "data-mila-widget", data: push.widget }],
      metadata: { voice: true },
    } as MilaUIMessage]);
    voiceTouched();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

  // ── Stop ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const stopNow = useCallback((runId: string | null) => {
    clearPendingStop();
    if (runId) void api.stopRun(runId);
    void chat.stop();
  }, [api, chat]);

  const runIdOfLive = (): string | null => {
    const last = chat.messages[chat.messages.length - 1];
    return last?.role === "assistant" && !last.metadata?.saved ? last.metadata?.runId ?? null : null;
  };

  const stop = useCallback(() => {
    if (!busy || stopAskedRef.current) return;
    stopAskedRef.current = true;
    const runId = runIdOfLive();
    if (runId) { stopNow(runId); return; }
    // No run id yet (the `start` part has not arrived): wait for it, but never longer than stopWaitMs.
    pendingStopRef.current = setTimeout(() => stopNow(runIdOfLive()), stopWaitMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, stopNow, stopWaitMs, chat.messages]);

  useEffect(() => {
    if (!pendingStopRef.current) return;
    const runId = runIdOfLive();
    if (runId) stopNow(runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages, stopNow]);

  // Unmount: no poll, no waiting Stop and no catch-up outlives the screen.
  useEffect(() => () => {
    genRef.current += 1;
    recoveryRef.current?.abort();
    recoveryRef.current = null;
    clearPendingStop();
  }, []);

  // ── New chat / open a saved one / catch up with the other surface ────────────────────────────────────────────────
  const reset = useCallback(() => {
    genRef.current += 1;
    // Always, not only when busy: a send handed to useChat a moment ago may not show as busy yet, and must not land in
    // the next chat. useChat aborts synchronously, so nothing of that stream is written after this. The server's turn
    // goes on (decision 4).
    void chat.stop();
    discardRef.current = true;
    stopAskedRef.current = false;
    clearPendingStop();
    recoveryRef.current?.abort();
    recoveryRef.current = null;
    setRecovering(false);
    setOutcome(null);
    setLive(null);
    resetTranscript();
  }, [chat, resetTranscript]);

  const newChat = useCallback(() => {
    reset();
    conversationRef.current = Crypto.randomUUID();
    sharedThread.id = conversationRef.current;
    sharedThread.rev += 1;
    seenRevRef.current = sharedThread.rev;
    chat.setMessages([]);
  }, [chat, reset]);

  const openConversation = useCallback(async (conversationId: string) => {
    reset();
    const gen = genRef.current;
    const saved = await api.loadConversation(conversationId);
    if (gen !== genRef.current || saved === null) return;
    conversationRef.current = conversationId;
    sharedThread.id = conversationId;
    seenRevRef.current = sharedThread.rev;
    chat.setMessages(saved);
    // Opening the chat is seeing it: its Mila-started messages stop counting toward the Mila tab's dot (as today).
    if (saved.some((m) => m.metadata?.unread)) void markConversationSeen(conversationId);
  }, [api, chat, reset]);

  /** When the other Mila surface moved the shared thread since this one last looked, re-read it. */
  const syncToShared = useCallback(async () => {
    if (inFlight || !sharedThread.id) return;
    if (sharedThread.id === conversationRef.current && sharedThread.rev === seenRevRef.current) return;
    await openConversation(sharedThread.id);
  }, [inFlight, openConversation]);

  // ── What the screen shows ─────────────────────────────────────────────────────────────────────────────────────────
  const last = chat.messages[chat.messages.length - 1];
  const textNow = last?.role === "assistant" ? textOf(last).length : 0;
  const statusFresh = !!live && textNow <= live.textLen;
  const phase: ChatPhase = !inFlight ? "idle"
    : recovering ? "thinking"
    : statusFresh ? (live!.phase === "tool" ? "tool" : "thinking")
    : textNow > 0 ? "writing" : "thinking";
  const statusLabel: string | null = !inFlight ? null
    : recovering ? THREAD_COPY.stillWorking
    : statusFresh ? live!.label
    : textNow > 0 ? null : THREAD_COPY.thinking;

  return {
    runtime,
    messages: chat.messages,
    send,
    stop,
    retry,
    canRetry,
    appendTranscript,
    appendWidgetMessage,
    newChat,
    openConversation,
    syncToShared,
    inFlight,
    busy,
    recovering,
    outcome,
    phase,
    statusLabel,
    conversationId: conversationRef.current,
  };
}

export type MilaThread = ReturnType<typeof useMilaThread>;
