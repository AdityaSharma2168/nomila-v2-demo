/**
 * voiceSession.web.ts — the LiveKit connection for Ask Mila voice, on web.
 *
 * The sequence, and the order is load-bearing: unlock audio INSIDE the tap (no
 * await before it), take the microphone, mint a token, connect, publish the mic,
 * attach whatever audio arrives. Stage 1 (server/public/mila-voice.html) did the
 * autoplay unlock and the mic AFTER connecting; on a phone that lost Mila's
 * greeting (the tap's permission to play sound had expired by then, and the mic
 * prompt landed on top of her first words) and could report an autoplay refusal
 * as "Microphone permission denied". See connect() for each step's reason.
 *
 * ── Why this file is .web.ts ─────────────────────────────────────────────────
 * `livekit-client` is a browser library: WebRTC, HTMLAudioElement, `document`.
 * Metro bundles for every platform it is asked about, so a plain import would
 * pull it into the iOS bundle too and break a build that has nothing to do with
 * voice. The platform extension means native resolves ./voiceSession (the stub)
 * and never sees this module or its dependency at all. The stub carries the same
 * exported types so `tsc`, which resolves the extensionless path to the .ts, still
 * typechecks the callers.
 *
 * Native voice is not "not built yet" so much as not designed: it needs the
 * LiveKit React Native SDK and a config plugin, which is a different transport,
 * not a port of this file.
 *
 * ── Where the athlete id comes from (still not from here) ────────────────────
 * This file sends a Firebase ID token and nothing else that bears on identity.
 * It never sends an athlete id, and the endpoint would ignore one if it did:
 * the server reads `req.athleteId` from the verified session, because a
 * client-supplied id is a request to be somebody else. What changed at Stage 2
 * is only that the session is now REAL — the endpoint authenticates the caller
 * and mints for them, rather than for a test athlete in the server's env.
 *
 * The conversation id IS sent, and that is a different kind of value. It says
 * "put my spoken turns in the thread I am looking at", which is a preference,
 * not a permission: the server resolves it against ownership and hands back the
 * id it actually decided on (a fresh one if this athlete does not own the one
 * asked for). So it is safe to send and never safe to assume was honoured —
 * which is why the response is what the client should believe, not the request,
 * and why a request that was NOT honoured is surfaced as a notice rather than
 * left to be discovered later as a transcript that quietly went missing.
 */

import {
  ConnectionState,
  Room,
  RoomEvent,
  createLocalAudioTrack,
  type LocalAudioTrack,
  type RemoteTrack,
} from "livekit-client";
import { getApiUrl, getAuthHeaders } from "../../lib/query-client";
import {
  WIDGET_TOPIC,
  parseWidgetPush,
  type ParsedWidgetPush,
} from "./widgetPush";

export type { ParsedWidgetPush };

/**
 * `speaking` means MILA is speaking, not the athlete — it is driven by remote
 * active speakers. `listening` is the resting state of a live call: connected,
 * mic open, nobody talking yet.
 */
export type VoiceState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export type TranscriptRole = "user" | "assistant";

/**
 * One transcript stream's state so far. `text` is the WHOLE turn accumulated to
 * this point, not the newest delta — the consumer renders it directly and never
 * has to concatenate. `streamId` is stable for the life of one turn, which is
 * what lets the message update in place instead of appending a line per word.
 */
export interface TranscriptUpdate {
  streamId: string;
  role: TranscriptRole;
  text: string;
  /** The stream closed. No further update will arrive for this streamId. */
  done: boolean;
}

/** The topic @livekit/agents publishes transcriptions on (its own constant). */
const TRANSCRIPTION_TOPIC = "lk.transcription";

export interface VoiceSessionCallbacks {
  onState: (state: VoiceState) => void;
  /** A short line fit to show a human. Never a raw SDK error. */
  onError: (message: string) => void;
  /**
   * Fires per word as Mila speaks and once per completed athlete utterance.
   * Purely a live VIEW — the durable record is the server's transcript write,
   * which is unaffected by whether anyone is listening here.
   */
  onTranscript?: (update: TranscriptUpdate) => void;
  /**
   * A validated card to render in the chat. Already parsed key-by-key — the
   * consumer renders it directly and never re-checks. Liveness only: the durable
   * copy is written server-side.
   */
  onWidget?: (push: ParsedWidgetPush) => void;
  /**
   * Something worth saying that is NOT a failure — the call still works. Today
   * that is exactly one thing: voice is about to write into a different thread
   * than the one on screen.
   */
  onNotice?: (message: string | null) => void;
  /**
   * The browser is holding Mila's audio back (autoplay policy) — true means she
   * may be speaking and nobody can hear it. The UI answers with a "Tap to hear
   * Mila" control wired to `resumeAudio`, because only a fresh tap can lift it.
   * False once playback is allowed again. Never fires on native.
   */
  onAudioBlocked?: (blocked: boolean) => void;
}

export interface VoiceSessionOptions {
  /**
   * The conversation the CHAT is currently using, sent so spoken turns land in
   * the thread on screen rather than a new one. A preference, not a claim: the
   * server resolves it against this athlete's ownership and may answer with a
   * different id. See the header.
   */
  conversationId?: string | null;
}

export interface VoiceSession {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Lift the browser's audio block. MUST be called synchronously from a tap
   * handler — the tap is the permission. A no-op when nothing is blocked.
   */
  resumeAudio?: () => void;
}

// ── One microphone per page ────────────────────────────────────────────────────
// The mic track outlives a single call, briefly. Two reasons, both browser rules:
//
//  - Safari (every iPhone browser is Safari underneath) only reliably skips the
//    permission prompt for a page that still holds a live capture. Stop every
//    track and the next getUserMedia in the SAME tab can ask again — which is the
//    "it asked me for the mic again" report. Holding the track for a short grace
//    after a call ends means a quick retry (or a second call) reuses it and never
//    re-prompts.
//  - A second getUserMedia after the first one's tracks stopped can fail outright
//    on iOS (NotReadableError) — one track per page avoids asking twice at all.
//
// During the grace the track is MUTED (no samples flow) and unpublished (the room
// is gone), so "Mic off" stays true in substance. The browser's own capture
// indicator does stay lit until the grace runs out; that is the cost, and it is
// bounded. Set the grace to 0 to stop the mic the instant a call ends.
const MIC_REUSE_GRACE_MS = 30_000;

/** The track calls reuse. Only ever one; older ones are stopped, never handed out. */
let pageMic: LocalAudioTrack | null = null;
/** Every track this page ever got, so leaving the page can stop all of them. */
const allMics = new Set<LocalAudioTrack>();
/**
 * The getUserMedia in flight, shared. Tap → End while the prompt is open → tap
 * again must not start a SECOND acquisition: two prompts, and the loser's track
 * would never be stopped (capture indicator on for the life of the page).
 */
let micInFlight: Promise<LocalAudioTrack> | null = null;
/** Calls currently holding pageMic. It is parked only when this reaches 0. */
let micUsers = 0;
let micStopTimer: ReturnType<typeof setTimeout> | null = null;
let pageHideHooked = false;

function clearMicStopTimer() {
  if (micStopTimer) clearTimeout(micStopTimer);
  micStopTimer = null;
}

function stopTrack(t: LocalAudioTrack) {
  allMics.delete(t);
  try {
    t.stop();
  } catch {
    // Already stopped — nothing left to release.
  }
}

/** Stop every mic this page holds — capture ends, the browser indicator goes out. */
function stopAllMics() {
  clearMicStopTimer();
  for (const t of [...allMics]) stopTrack(t);
  pageMic = null;
  micUsers = 0;
}

/** Grace over: stop the parked mic, unless a call picked it back up. */
function stopParkedMic() {
  micStopTimer = null;
  if (micUsers > 0 || !pageMic) return;
  const t = pageMic;
  pageMic = null;
  stopTrack(t);
}

/**
 * The page's mic, live and unmuted, held for the caller until it calls
 * releasePageMic with the SAME track. Reuses the held track when there is one,
 * and joins an acquisition already in flight rather than starting another, so
 * this asks the browser for the microphone at most once while calls follow each
 * other within the grace.
 */
async function acquirePageMic(): Promise<LocalAudioTrack> {
  clearMicStopTimer();
  if (!pageHideHooked && typeof window !== "undefined") {
    // Leaving the page must never leave capture running.
    window.addEventListener("pagehide", stopAllMics);
    pageHideHooked = true;
  }
  let t: LocalAudioTrack;
  if (pageMic && pageMic.mediaStreamTrack.readyState !== "ended") {
    t = pageMic;
  } else {
    if (!micInFlight) {
      micInFlight = createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      })
        .then((track) => {
          allMics.add(track);
          // A previous pageMic here can only be an ended one; drop it.
          if (pageMic && pageMic !== track) stopTrack(pageMic);
          pageMic = track;
          return track;
        })
        .finally(() => {
          micInFlight = null;
        });
    }
    t = await micInFlight;
  }
  micUsers++;
  // Again after the await: a call released (and parked) this track meanwhile.
  clearMicStopTimer();
  // Unconditional: a park's mute() may still be pending, and unmute() takes the
  // same lock, so it lands after it and checks the real state.
  await t.unmute();
  return t;
}

/** A call is done with ITS track: park it if it is the page's mic and no one else holds it. */
function releasePageMic(t: LocalAudioTrack) {
  micUsers = Math.max(0, micUsers - 1);
  if (t !== pageMic) {
    // A track that is no longer the page's mic serves nobody: stop it outright.
    stopTrack(t);
    return;
  }
  if (micUsers > 0) return;
  clearMicStopTimer();
  if (MIC_REUSE_GRACE_MS <= 0) return stopParkedMic();
  void t.mute().catch(() => {});
  micStopTimer = setTimeout(stopParkedMic, MIC_REUSE_GRACE_MS);
}

/**
 * What to tell a human when the browser would not give us the microphone. The
 * names are getUserMedia's (DOMException); the message regex is the backstop for
 * browsers that name things differently.
 */
export function micErrorMessage(err: unknown): string {
  const name: string = (err as { name?: string } | null)?.name ?? "";
  const message: string = (err as { message?: string } | null)?.message ?? "";
  if (
    name === "NotAllowedError" ||
    name === "SecurityError" ||
    name === "PermissionDeniedError" ||
    /permission|denied/i.test(message)
  ) {
    // Safari remembers a "Don't Allow" for the rest of the page's life, so
    // tapping again without reloading cannot work — say so.
    return "Microphone is blocked for this site. Allow it in your browser's site settings, reload the page, then tap the mic again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone found on this device.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "Your microphone is busy in another app. Close it and try again.";
  }
  return "Couldn't start the microphone. Try again.";
}

/** livekit-client's iOS silent-audio element; removed by hand if a room never connected. */
const LK_DUMMY_AUDIO_ID = "livekit-dummy-audio-el";

/** Test seam: forget the page-scoped mic between cases. */
export function __resetPageMicForTests() {
  stopAllMics();
  micInFlight = null;
  pageHideHooked = false;
}

/**
 * Let go of a Room that never connected. livekit-client only cleans up on
 * Disconnected, and a Room that never connected never emits it: on iOS the
 * startAudio() unlock leaves a silent <audio> element whose visibilitychange
 * listener re-creates it on every tab switch, plus an open AudioContext (iOS caps
 * how many a page may hold). Emitting Disconnected runs livekit's own once-
 * listener for the element; the context is closed by hand because the Room only
 * closes it on a real disconnect. Our Disconnected handler ignores this (it is
 * guarded on `room === r`, and teardown cleared `room` first).
 */
function abandonRoom(r: Room) {
  if (r.state !== ConnectionState.Disconnected) return;
  try {
    r.emit(RoomEvent.Disconnected);
  } catch {
    // A listener threw; the room is being dropped regardless.
  }
  // Private in livekit-client; read defensively so a rename degrades to the old leak, not a crash.
  const ctx = (r as unknown as { audioContext?: AudioContext }).audioContext;
  if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  if (typeof document !== "undefined") {
    document.getElementById(LK_DUMMY_AUDIO_ID)?.remove();
  }
}

/**
 * How long a connected room may stay empty before we call it a failure.
 *
 * The worker is dispatched when the room is created and still has to start a
 * job and join. If it never does — not running, or registered under a different
 * agentName — everything else looks perfect: the room is up, the mic is live,
 * and nothing ever speaks. That silence is the single most likely failure in
 * this stack, so it gets a deadline and a message that names the cause.
 */
// The worker on LiveKit Cloud scales to zero when idle and takes several seconds to wake on the
// first call of the day. Ten seconds fired the failure line while Mila was still joining —
// and she then joined anyway. Thirty covers a cold start with room to spare.
const AGENT_JOIN_TIMEOUT_MS = 30_000;

export function createVoiceSession(
  cb: VoiceSessionCallbacks,
  opts: VoiceSessionOptions = {},
): VoiceSession {
  let room: Room | null = null;
  let agentTimer: ReturnType<typeof setTimeout> | null = null;
  /** The mic THIS session's live call holds (released, by identity, at teardown). */
  let heldMic: LocalAudioTrack | null = null;
  /** The room disconnect() is ending — its connect() must not report a failure. */
  let ending: Room | null = null;
  /** Audio elements created by track.attach(), so teardown can remove them. */
  let elements: HTMLMediaElement[] = [];

  const clearAgentTimer = () => {
    if (agentTimer) clearTimeout(agentTimer);
    agentTimer = null;
  };

  const teardown = () => {
    clearAgentTimer();
    for (const el of elements) el.remove();
    elements = [];
    const r = room;
    room = null;
    // A room that never connected gets no Disconnected of its own (see abandonRoom).
    if (r) abandonRoom(r);
    cb.onAudioBlocked?.(false);
    const m = heldMic;
    heldMic = null;
    if (m) releasePageMic(m);
  };

  const fail = (message: string) => {
    cb.onError(message);
    cb.onState("error");
  };

  async function connect(): Promise<void> {
    if (room) return; // Already live; the button should not have allowed this.

    cb.onState("connecting");

    // ── Unlock audio INSIDE the tap — before the first await ────────────────
    // This function is called synchronously from the mic button's click (RN-web
    // Pressable fires onPress from the DOM click), and everything up to the first
    // `await` still runs inside that gesture. Browsers — iOS Safari above all —
    // only let a page start sound from a gesture, and the gesture does not survive
    // the token fetch and the room connect below. So the Room is built now and
    // startAudio() is CALLED now: it creates and resumes the AudioContext and, on
    // iOS, starts LiveKit's silent element, all synchronously inside the tap. Not
    // awaited: it only has to have STARTED here. Mila's greeting then arrives into
    // a page that is already allowed to play it.
    const r = new Room();
    room = r;
    r.startAudio().catch(() => {
      // Reported through AudioPlaybackStatusChanged / onAudioBlocked below.
    });
    /** The athlete ended (or left) while we were still setting up. */
    const cancelled = () => room !== r;

    // ── The microphone, BEFORE the room ──────────────────────────────────────
    // The worker joins and starts greeting a second or two after the room
    // connects. Asking for the mic after that (as before) put the permission
    // prompt — and, on iOS, the audio-session switch that starting capture
    // causes — right on top of the greeting. Asking first means the greeting
    // arrives into a page that is already capturing, which on iOS is also what
    // lifts the autoplay block for Mila's audio. And a refused mic is now an
    // answer about the mic and nothing else: no room exists yet to clean up.
    let mic: LocalAudioTrack;
    try {
      mic = await acquirePageMic();
    } catch (err) {
      if (cancelled()) return;
      teardown();
      fail(micErrorMessage(err));
      return;
    }
    // Ended while the prompt was open: hand back exactly the track we got.
    if (cancelled()) return releasePageMic(mic);
    heldMic = mic;

    let cfg: {
      wsUrl: string;
      token: string;
      room: string;
      identity: string;
      conversationId?: string;
    };
    try {
      // getApiUrl() is the SAME base-URL resolution the chat uses
      // (client/lib/query-client.ts): EXPO_PUBLIC_API_URL when set, else
      // http://localhost:8080 under __DEV__. Plain fetch rather than expo/fetch
      // because this is a one-shot JSON POST, not an SSE stream — and on web
      // expo/fetch resolves to globalThis.fetch anyway.
      // getAuthHeaders() is the SAME Firebase ID token the chat sends on every
      // request (client/lib/query-client.ts). Without it this endpoint answers
      // 401 — identity is the point of the call, not a detail of it.
      const res = await fetch(new URL("/voice/token", getApiUrl()).toString(), {
        method: "POST",
        headers: {
          ...(await getAuthHeaders()),
          "Content-Type": "application/json",
        },
        // The thread to speak into. The server decides whether this athlete may
        // have it and answers with the id it settled on.
        body: JSON.stringify({ conversationId: opts.conversationId ?? null }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // The 503 names the env vars that are missing, which is the difference
        // between "it's broken" and "add these three lines to .env".
        const missing = Array.isArray(body?.missing) ? body.missing : null;
        // A 429 is a spend limit (today's voice time, or the platform's day limit), and its message is written for
        // the athlete: show it as it is, never as "is the server running?".
        if (res.status === 429 && typeof body?.error === "string") {
          throw Object.assign(new Error(body.error), { userFacing: true });
        }
        throw new Error(
          missing?.length
            ? `Voice not configured — missing ${missing.join(", ")}`
            : res.status === 401
              ? // Not a misconfiguration: the token expired or was never sent.
                "Sign in again to use voice"
              : // A 404 here is the dev gate, which is the expected answer
                // anywhere this endpoint should not exist.
                (body?.error ?? `Token request failed (${res.status})`),
        );
      }
      cfg = body;

      // The unified-transcript check, against the SERVER's answer rather than
      // against a second environment variable (which is what it compared before
      // Stage 2). `resolveVoiceConversation` hands back a different id whenever
      // the one we asked for was malformed or belongs to another athlete — so a
      // divergence here means the call works perfectly and the spoken turns land
      // in a thread the athlete is not looking at. Nothing else would ever say
      // so, which is exactly why it is worth one comparison.
      //
      // Only meaningful when we actually asked for a thread: sending none always
      // yields a fresh id, and that is the ordinary new-chat case, not a split.
      const requested = opts.conversationId;
      cb.onNotice?.(
        requested && cfg.conversationId && requested !== cfg.conversationId
          ? "Voice is writing to a different conversation than this chat"
          : null,
      );
    } catch (err: any) {
      if (cancelled()) return;
      teardown();
      const message: string = err?.message ?? "";
      fail(
        err?.userFacing ||
        message.startsWith("Voice not configured") ||
          message === "Sign in again to use voice"
          ? message
          : "Couldn't start voice — is the server running?",
      );
      return;
    }
    if (cancelled()) return;

    // ── Live transcript ──────────────────────────────────────────────────────
    // The framework already publishes both sides of the conversation on this
    // topic — `transcriptionEnabled` and `syncTranscription` default to true in
    // AgentSession's room output options, and a spike confirmed they flow on our
    // Gemini realtime path specifically (they are documented for the STT
    // pipeline, so that was worth proving rather than assuming).
    //
    // Registered BEFORE connect: streams opened during the join handshake would
    // be missed by a handler attached afterwards.
    //
    // NOT RoomEvent.TranscriptionReceived — deprecated, and it uses a different
    // delivery mechanism, so it never fires for lk.transcription text streams.
    try {
      r.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, from) => {
        const streamId = reader.info.id;
        // The only sender that is us is us; everyone else in this room is Mila.
        const role: TranscriptRole =
          from.identity === r.localParticipant.identity ? "user" : "assistant";

        // Chunks are DELTAS, not cumulative snapshots — measured, not assumed:
        // each chunk's length was the length of that word alone. So this
        // concatenates. Reading them as snapshots would render "II amam fine".
        let text = "";
        try {
          for await (const delta of reader) {
            text += delta;
            cb.onTranscript?.({ streamId, role, text, done: false });
          }
        } catch {
          // A stream that breaks mid-turn still leaves real words on screen.
          // Fall through to the terminal emit so the turn stops looking live.
        }
        cb.onTranscript?.({ streamId, role, text, done: true });
      });
    } catch {
      // Registering throws if the topic already has a handler. Each connect
      // builds a fresh Room so that shouldn't happen — and if it ever does, a
      // missing transcript must not cost the athlete the call.
    }

    // ── Widget bridge ────────────────────────────────────────────────────────
    // The transcript came free on lk.transcription; widgets have no built-in
    // equivalent, so this is the one channel we own end to end.
    //
    // DataReceived, NOT registerTextStreamHandler: publishData and text streams
    // are different delivery mechanisms and do not cross. A handler on the wrong
    // one is a silent no-op — the same trap as the deprecated
    // TranscriptionReceived not firing for lk.transcription.
    //
    // Four transport gates before the payload is even parsed. They establish WHO
    // sent this; widgetPush.ts establishes WHAT it is.
    r.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant, _kind, topic) => {
        // 1 — our topic, not somebody else's traffic on the same channel.
        // Checked before any logging so unrelated packets stay silent.
        if (topic !== WIDGET_TOPIC) return;

        // Dev-only. A rejected card is otherwise indistinguishable from a card
        // that was never sent — both are simply nothing on screen — which makes
        // the validator impossible to exercise by looking at the app. Silent in
        // any production bundle.
        const rejected = (reason: string, extra?: unknown) => {
          if (__DEV__) console.warn("[widget] REJECTED —", reason, extra ?? "");
        };

        // 2 — a packet with no sender came from the server, not the agent.
        if (!participant) return rejected("no sender participant");
        // 3 — never trust our own echo back off the room.
        if (participant.identity === r.localParticipant.identity) {
          return rejected("sender is us");
        }

        // 4 — decode and parse defensively. This is attacker-shaped input until
        // proven otherwise: arbitrary bytes chosen by whoever sent them.
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder().decode(payload));
        } catch {
          return rejected("payload is not valid JSON");
        }

        // Malformed, unknown kind, or a version we don't speak — drop it. The
        // durable copy lives on the server, so dropping costs liveness only.
        const parsed = parseWidgetPush(raw, (reason) => rejected(reason, raw));
        if (!parsed) return;

        if (__DEV__) console.log("[widget] accepted —", parsed.widget.type);
        cb.onWidget?.(parsed);
      },
    );

    r.on(RoomEvent.Connected, () => {
      cb.onState("listening");
      agentTimer = setTimeout(() => {
        fail("Mila is taking longer than usual to pick up — try again in a moment.");
      }, AGENT_JOIN_TIMEOUT_MS);
    });

    r.on(RoomEvent.ParticipantConnected, () => {
      // Anyone joining this room is the agent: it is a fresh room minted for
      // this session and nobody else is given the name.
      clearAgentTimer();
      cb.onState("listening");
    });

    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== "audio") return;
      const el = track.attach();
      // Attached elements must be in the document to play. Hidden because the
      // UI is the button, not a media player.
      el.style.display = "none";
      document.body.appendChild(el);
      elements.push(el);
    });

    // The autoplay gate, watched rather than assumed. If the browser still holds
    // Mila's audio back (the tap's unlock did not take, or a page-hide undid it),
    // say so and offer the one thing that fixes it: another tap.
    r.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room === r) cb.onAudioBlocked?.(!r.canPlaybackAudio);
    });

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const remote = speakers.filter(
        (s) => s.identity !== r.localParticipant.identity,
      );
      cb.onState(remote.length ? "speaking" : "listening");
    });

    r.on(RoomEvent.Disconnected, () => {
      // A room this session already let go of (abandonRoom re-emits this).
      if (room !== r) return;
      teardown();
      cb.onState("idle");
    });

    try {
      await r.connect(cfg.wsUrl, cfg.token);
      if (cancelled() || ending === r) return;
      // The mic was acquired before connecting; this only publishes it. No second
      // getUserMedia, so no second prompt.
      await r.localParticipant.publishTrack(mic);
    } catch {
      // Ended by the athlete mid-connect: the abort is the answer, not a failure.
      if (cancelled() || ending === r) return;
      // stopTracks=false: the mic is the page's (see releasePageMic), not the room's.
      await r.disconnect(false).catch(() => {});
      teardown();
      // NOT "permission denied". Before, an autoplay refusal from startAudio()
      // at this point (a NotAllowedError — the same DOMException name a refused
      // mic uses) was reported as "Microphone permission denied" and ended the
      // call. The mic has its own step and its own messages above; anything that
      // fails here is the connection.
      fail("Couldn't connect to voice — check your connection and try again.");
      return;
    }
    // Playback still blocked after all that? Do not end the call over it — the
    // call works, it just cannot be heard yet. The UI offers "Tap to hear Mila".
    if (!r.canPlaybackAudio) cb.onAudioBlocked?.(true);
  }

  async function disconnect(): Promise<void> {
    const r = room;
    if (!r) return;
    if (r.state === ConnectionState.Disconnected) {
      // Still setting up (mic prompt or token fetch in flight): there is no
      // connection to close, so no Disconnected event will ever come. Drop it
      // here and let connect() see it was cancelled — otherwise "End" would leave
      // the UI on "Joining…" for good.
      teardown();
      cb.onState("idle");
      return;
    }
    // Teardown runs from the Disconnected handler, which fires for both a local
    // disconnect and a dropped connection — one path, so state cannot diverge.
    // stopTracks=false: the page keeps its mic for the grace (releasePageMic).
    // `ending` first: a connect() still in flight sees its abort as ours, not a failure.
    ending = r;
    await r.disconnect(false).catch(() => {});
    if (ending === r) ending = null;
    if (room === r) {
      // No Disconnected arrived (disconnect raced the connect's own failure).
      teardown();
      cb.onState("idle");
    }
  }

  /** Called from a tap: the tap is what lets startAudio() succeed. */
  function resumeAudio(): void {
    const r = room;
    if (!r) return;
    r.startAudio()
      .then(() => {
        if (room === r) cb.onAudioBlocked?.(!r.canPlaybackAudio);
      })
      .catch(() => {
        if (room === r) cb.onAudioBlocked?.(true);
      });
  }

  return { connect, disconnect, resumeAudio };
}
