/**
 * voiceSession.ts — the LiveKit connection for Ask Mila voice, on NATIVE.
 *
 * Metro resolves ./voiceSession to voiceSession.web.ts on web and to this file
 * everywhere else. `tsc` resolves the extensionless import to THIS file, so the
 * types exported here are the contract every caller is checked against — they
 * must stay identical to the web module's, and they are deliberately duplicated
 * rather than extracted to a shared module, because extracting them would mean
 * editing the web module for a native feature.
 *
 * ── Not a port of voiceSession.web.ts ────────────────────────────────────────
 * Same sequence, different transport. The web module drives browser WebRTC
 * through `livekit-client` and renders remote audio into an <audio> element it
 * appends to the document. Here the peer connection is react-native-webrtc and
 * remote audio is played by the OS audio device module, so three things change:
 *
 *   GONE  — the autoplay gate (`canPlaybackAudio` / `startAudio`). There is no
 *           autoplay policy outside a browser.
 *   GONE  — TrackSubscribed → `track.attach()` → `document.body.appendChild`,
 *           and the element list teardown had to sweep. The RN SDK ships no
 *           audio render component at all: a subscribed audio track is already
 *           playing by the time we would have attached it.
 *   NEW   — AudioSession. iOS and Android need to be told this is a voice call
 *           (category, mode, audio focus, speaker routing) before the room
 *           connects, and told again when it ends.
 *
 * Everything else — the token mint, the agent-join deadline, the transcript
 * stream, the widget bridge, the state machine — is the same sequence in the
 * same order, because that order was proven by ear and none of it is
 * browser-specific. useMilaVoice cannot tell which of the two it is holding.
 *
 * ── This file depends on registerGlobals() having run ────────────────────────
 * client/index.js imports lib/voiceGlobals at entry. That is not only about
 * WebRTC: it installs the TextDecoder used by the widget bridge below, the
 * async-iterator support the transcript handler needs, and the global that tells
 * `livekit-client` it is on React Native rather than in a browser. If it did not
 * run, `Room.connect` throws "WebRTC isn't detected, have you called
 * registerGlobals?" — mapped to a human line in `connect` rather than shown raw,
 * because the realistic cause is a JS bundle newer than the native binary.
 *
 * ── Where the athlete id comes from (not from here) ──────────────────────────
 * Unchanged from web, and worth restating because it is the security boundary:
 * this file sends a Firebase ID token and nothing else that bears on identity.
 * It never sends an athlete id, and the endpoint would ignore one if it did —
 * the server reads `req.athleteId` from the verified session, because a
 * client-supplied id is a request to be somebody else.
 *
 * The conversation id IS sent, and is a different kind of value: it says "put my
 * spoken turns in the thread I am looking at", which is a preference, not a
 * permission. The server resolves it against ownership and answers with the id
 * it actually decided on, so the response is what to believe — and a request
 * that was NOT honoured is surfaced as a notice rather than left to be found
 * later as a transcript that quietly went missing.
 */

import { AndroidAudioTypePresets, AudioSession } from "@livekit/react-native";
import { Room, RoomEvent } from "livekit-client";
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
  /** Web only (the browser's autoplay block). Native has no such gate; never fires here. */
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
  /** Web only: lift the browser's autoplay block from a tap. Absent on native. */
  resumeAudio?: () => void;
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

/**
 * How the OS should treat this call.
 *
 * `communication` on Android is the voice-call preset: audio focus taken with
 * MODE_IN_COMMUNICATION, the voice-call stream, speech content type. It routes
 * to the earpiece-or-better device list and lets the mic use the call's echo
 * cancellation, which the media preset does not.
 *
 * `defaultOutput: "speaker"` on iOS is what makes this a hands-free assistant
 * rather than a phone call held to the ear. It only applies when nothing better
 * is attached — a headset or a Bluetooth device still wins.
 */
const AUDIO_CONFIG = {
  android: { audioTypeOptions: AndroidAudioTypePresets.communication },
  ios: { defaultOutput: "speaker" as const },
};

export function createVoiceSession(
  cb: VoiceSessionCallbacks,
  opts: VoiceSessionOptions = {},
): VoiceSession {
  let room: Room | null = null;
  let agentTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether the OS audio session is ours to stop. Tracked rather than assumed:
   * teardown runs on paths where the session was never started (a token fetch
   * that failed), and stopping one we never started would tear down whatever
   * audio the rest of the app is doing.
   */
  let audioSessionStarted = false;

  const clearAgentTimer = () => {
    if (agentTimer) clearTimeout(agentTimer);
    agentTimer = null;
  };

  /**
   * Synchronous, because it runs from the Disconnected event handler. Stopping
   * the audio session is the one async part and nothing waits on it — the call
   * is already over, and a failure to hand the session back is not something the
   * athlete can act on.
   */
  const teardown = () => {
    clearAgentTimer();
    if (audioSessionStarted) {
      audioSessionStarted = false;
      void AudioSession.stopAudioSession().catch(() => {});
    }
    room = null;
  };

  const fail = (message: string) => {
    cb.onError(message);
    cb.onState("error");
  };

  async function connect(): Promise<void> {
    if (room) return; // Already live; the button should not have allowed this.

    cb.onState("connecting");

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
      // http://localhost:8080 under __DEV__. getAuthHeaders() is the SAME
      // Firebase ID token the chat sends on every request. Without it this
      // endpoint answers 401 — identity is the point of the call, not a detail
      // of it. Plain fetch: a one-shot JSON POST, not an SSE stream.
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
              : // A 404 here is the server's own voice flag being off, which is
                // the expected answer anywhere voice should not exist yet.
                (body?.error ?? `Token request failed (${res.status})`),
        );
      }
      cfg = body;

      // The unified-transcript check, against the SERVER's answer.
      // `resolveVoiceConversation` hands back a different id whenever the one we
      // asked for was malformed or belongs to another athlete — so a divergence
      // here means the call works perfectly and the spoken turns land in a
      // thread the athlete is not looking at. Nothing else would ever say so.
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

    const r = new Room();
    room = r;

    // ── Live transcript ──────────────────────────────────────────────────────
    // The framework already publishes both sides of the conversation on this
    // topic. Registered BEFORE connect: streams opened during the join handshake
    // would be missed by a handler attached afterwards.
    //
    // NOT RoomEvent.TranscriptionReceived — deprecated, and it uses a different
    // delivery mechanism, so it never fires for lk.transcription text streams.
    //
    // The `for await` below needs Symbol.asyncIterator and the reader needs web
    // streams; both come from registerGlobals() at entry, not from Hermes.
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
    // DataReceived, NOT registerTextStreamHandler: publishData and text streams
    // are different delivery mechanisms and do not cross. A handler on the wrong
    // one is a silent no-op.
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
        // the validator impossible to exercise by looking at the app.
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
        // TextDecoder is a polyfill here, installed by registerGlobals().
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

    // No TrackSubscribed handler, and that is not an omission. On web the remote
    // track has to be attached to an element in the document before a single
    // sample plays. Here playback belongs to the native audio device module —
    // the track is audible from the moment it is subscribed, and the SDK ships
    // no audio render component to attach it to.

    r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const remote = speakers.filter(
        (s) => s.identity !== r.localParticipant.identity,
      );
      cb.onState(remote.length ? "speaking" : "listening");
    });

    r.on(RoomEvent.Disconnected, () => {
      teardown();
      cb.onState("idle");
    });

    try {
      // ── Hand the OS its instructions, before this becomes a call ───────────
      // `configureAudio` has to precede the CONNECT for the configuration to
      // apply — not the construction above, which is why it sits here and not
      // earlier. Inside the same try as the connect on purpose: a session
      // started outside it could be left running by a later throw, and on iOS
      // that means audio ducked and the orange mic indicator lit until the app
      // is killed. Nothing between the start and the catch can escape it.
      //
      // At app entry this would have been wrong too: an athlete who never taps
      // the mic should never have their audio session touched. Its lifetime is
      // exactly the call's.
      await AudioSession.configureAudio(AUDIO_CONFIG);
      await AudioSession.startAudioSession();
      audioSessionStarted = true;

      await r.connect(cfg.wsUrl, cfg.token);
      // Publishing the mic is what triggers the OS permission prompt, inside
      // react-native-webrtc's getUserMedia. On iOS that prompt requires
      // NSMicrophoneUsageDescription in app.json — without it the OS does not
      // deny the request, it terminates the app.
      await r.localParticipant.setMicrophoneEnabled(true);
    } catch (err: any) {
      await r.disconnect().catch(() => {});
      const audioNeverStarted = !audioSessionStarted;
      teardown();

      // Failing before the session was ever taken means the OS refused us the
      // audio hardware — usually another call app holding it. Distinguished
      // here because it is the one failure in this block that has nothing to do
      // with the network or the mic permission.
      if (audioNeverStarted) {
        fail("Couldn't get access to audio — try closing other call apps");
        return;
      }

      // react-native-webrtc rejects a denied mic with a MediaStreamError, which
      // is NOT an Error subclass and whose name is "SecurityError" — the web's
      // "NotAllowedError" never appears here. Both are checked anyway: this
      // module is the one place the two transports' error vocabularies meet,
      // and the message regex is the backstop for whatever a future version
      // decides to call it.
      const name: string = err?.name ?? "";
      const message: string = err?.message ?? "";
      const denied =
        name === "SecurityError" ||
        name === "NotAllowedError" ||
        /permission|denied/i.test(message);

      fail(
        denied
          ? "Microphone permission denied"
          : // The entry setup did not run — realistically a JS bundle that
            // reached a binary built before the native module existed. Naming
            // "update" is the only actionable thing an athlete could do.
            /registerGlobals/i.test(message)
            ? "Voice needs a newer version of the app"
            : "Couldn't connect to voice — check your connection",
      );
    }
  }

  async function disconnect(): Promise<void> {
    const r = room;
    if (!r) return;
    // Teardown runs from the Disconnected handler, which fires for both a local
    // disconnect and a dropped connection — one path, so state cannot diverge,
    // and the audio session is handed back exactly once either way.
    await r.disconnect().catch(() => {});
  }

  return { connect, disconnect };
}
