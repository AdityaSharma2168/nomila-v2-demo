/**
 * useMilaVoice.ts — the React surface over ./voiceSession.
 *
 * One state enum, one toggle, one error line. Everything the button needs and
 * nothing it doesn't: the room, the tracks and the autoplay gate stay inside the
 * session module, which is the part that was proven by ear in Stage 1 and should
 * not be re-derived per component.
 *
 * ── Why the session lives in a ref and not in state ──────────────────────────
 * It is a mutable connection, not a rendered value. Putting it in state would
 * re-render on every internal change and, worse, make the identity of the live
 * room depend on render timing — which is how you end up with two rooms and one
 * button. The ref is created once, on first use.
 *
 * ── Native ───────────────────────────────────────────────────────────────────
 * iOS and Android both have a real transport now (voiceSession.ts, LiveKit's
 * React Native SDK), behind EXPO_PUBLIC_MILA_VOICE_NATIVE. This hook did not
 * have to learn anything about it: the two session modules expose the same five
 * callbacks and the same state enum, so everything below is transport-agnostic
 * and the platform question is confined to `supported`. With the gate closed,
 * native never constructs a session at all, so the answer does not depend on a
 * bundler resolution being right.
 *
 * ── Availability ─────────────────────────────────────────────────────────────
 * `supported` also carries the SERVER's answer, not just the platform's: voice
 * ships behind MILA_VOICE_WEB, and with the flag off the token endpoint 404s. The
 * flag arrives on the athlete profile rather than from a probe request, so the
 * button knows whether it can work before it is ever painted. See `supported`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useAuth } from "../../lib/auth-context";
import {
  createVoiceSession,
  type ParsedWidgetPush,
  type TranscriptUpdate,
  type VoiceSession,
  type VoiceState,
} from "./voiceSession";

export type { VoiceState, TranscriptUpdate, ParsedWidgetPush };

export interface UseMilaVoice {
  state: VoiceState;
  /** A short, human line when state is "error"; null otherwise. */
  error: string | null;
  /** Non-fatal: the call works, but something is worth saying. */
  notice: string | null;
  /**
   * False off web, and false when the server has voice turned off. The button
   * hides rather than offering something inert or something that 404s.
   */
  supported: boolean;
  /** Connect when idle or errored, disconnect when live. */
  toggle: () => void;
  /** Live in the sense that matters to the UI: connected or connecting. */
  active: boolean;
  /**
   * True for a few seconds after a live session ends.
   *
   * Ending is the moment a voice UI is least trustworthy: everything that said
   * "your mic is on" disappears at once, and absence is not a message. This lets
   * the UI say "Mic off" out loud instead of leaving the athlete to infer it
   * from a control that vanished.
   */
  justEnded: boolean;
  /**
   * Web only: the call is live but the browser is holding Mila's audio back
   * (autoplay policy). The live bar then shows "Tap to hear Mila", wired to
   * `resumeAudio`. Optional so fixtures and native read as "not blocked".
   */
  audioBlocked?: boolean;
  /** Call from a tap handler, synchronously — the tap is the permission. */
  resumeAudio?: () => void;
}

/** How long "Mic off" stays on screen. Long enough to read, short enough to
 *  not become furniture. */
const MIC_OFF_NOTICE_MS = 3_000;

/**
 * The native kill switch, iOS and Android alike. Compared to the string "true"
 * because EXPO_PUBLIC_* vars are inlined as text at bundle time — an unset var
 * is `undefined`, and anything other than an explicit opt-in must read as OFF.
 * See `supported` below.
 */
const NATIVE_VOICE_ENABLED =
  process.env.EXPO_PUBLIC_MILA_VOICE_NATIVE === "true";

export function useMilaVoice(
  opts: {
    conversationId?: string | null;
    /**
     * Receives every live transcript update. Read through a ref below so the
     * session — built once — always calls the CURRENT handler, and so passing
     * an inline arrow from the overlay doesn't rebuild the session each render.
     */
    onTranscript?: (update: TranscriptUpdate) => void;
    /** Receives a validated card pushed over the widget bridge. */
    onWidget?: (push: ParsedWidgetPush) => void;
  } = {},
): UseMilaVoice {
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [justEnded, setJustEnded] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const sessionRef = useRef<VoiceSession | null>(null);
  /** Tracks whether the last state was live, so "ended" can be distinguished
   *  from "never started" — only the former deserves a mic-off notice. */
  const wasActive = useRef(false);
  const micOffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Read through a ref so the session is built once and still sees the CURRENT
   * conversation id. Putting it in getSession's deps would rebuild the session
   * whenever the chat rotates threads — mid-call, that orphans a live room.
   */
  const conversationIdRef = useRef(opts.conversationId);
  conversationIdRef.current = opts.conversationId;
  const onTranscriptRef = useRef(opts.onTranscript);
  onTranscriptRef.current = opts.onTranscript;
  const onWidgetRef = useRef(opts.onWidget);
  onWidgetRef.current = opts.onWidget;
  /**
   * Guards against a callback landing after unmount — a disconnect resolves
   * asynchronously and would otherwise setState on a dead component.
   */
  const mounted = useRef(true);

  /**
   * Two independent conditions, and they fail for different reasons.
   *
   * PLATFORM — web, or a native platform with the native transport switched
   * on. Web stays a term of its own rather than being folded into one loosened
   * check: web voice is shipped and proven, and nothing about turning the
   * native transport on or off should be able to change the answer web has
   * been giving. Android rides the same flag as iOS instead of getting a third
   * term, because the two share one transport and one audio path —
   * voiceSession already asks for the communication audio preset, which is the
   * piece Android actually needed — so a per-platform switch would gate
   * nothing different. What kept Android false until now was not a technical
   * gap but that no one had heard it, and the flag is what still holds it shut
   * by default.
   *
   * BUILD FLAG — `EXPO_PUBLIC_MILA_VOICE_NATIVE`, inlined at bundle time. The
   * `preview` and `production` EAS profiles set it to "true", so those builds
   * ship with native voice live. The `development` profile did not, and that
   * asymmetry is the likeliest reason no one has heard Android: a dev client
   * runs the bundle Metro builds on the developer's machine, so the value it
   * sees comes from the shell that started Metro, and an unset shell leaves the
   * transport compiled in and dark. That profile now carries the flag too, so a
   * dev-client build is no longer the odd one out — but exporting the variable
   * before `npm run expo:dev` is still what decides what Metro inlines. Read as
   * a module-level constant because that is what it is — this cannot change
   * while the app is running.
   *
   * SERVER FLAG — `MILA_VOICE_WEB`, delivered on the athlete profile (the one
   * authenticated bootstrap the app already fetches, see auth-context). Without
   * it the token endpoint 404s, so rendering the button would offer a control
   * that fails the moment it is tapped. Native mints its token from that same
   * endpoint, so this gates both platforms despite the name.
   *
   * `=== true` rather than a truthiness check: the field is optional, and an
   * older cached profile or a server that predates it must read as OFF.
   */
  const { athlete } = useAuth();
  const platformSupported =
    Platform.OS === "web" ||
    ((Platform.OS === "ios" || Platform.OS === "android") &&
      NATIVE_VOICE_ENABLED);
  const supported = platformSupported && athlete?.voiceEnabled === true;

  const getSession = useCallback((): VoiceSession => {
    if (!sessionRef.current) {
      sessionRef.current = createVoiceSession(
        {
          onState: (s) => {
            if (!mounted.current) return;
            setState(s);
            // Any successful transition clears a stale error, so a retry that
            // works doesn't leave the previous failure on screen.
            if (s !== "error") setError(null);

            // Live → not live is the only transition that earns a mic-off
            // notice. Reaching "error" from a live call counts: the mic really
            // did just close, and the error line alone doesn't say so.
            const live =
              s === "connecting" || s === "listening" || s === "speaking";
            if (wasActive.current && !live) {
              setJustEnded(true);
              if (micOffTimer.current) clearTimeout(micOffTimer.current);
              micOffTimer.current = setTimeout(() => {
                if (mounted.current) setJustEnded(false);
              }, MIC_OFF_NOTICE_MS);
            }
            // Starting again retracts a pending notice — "Mic off" must never
            // sit on screen while the mic is hot.
            if (live) {
              if (micOffTimer.current) clearTimeout(micOffTimer.current);
              setJustEnded(false);
            }
            wasActive.current = live;
          },
          onError: (message) => {
            if (!mounted.current) return;
            setError(message);
          },
          onAudioBlocked: (blocked) => {
            if (!mounted.current) return;
            setAudioBlocked(blocked);
          },
          onNotice: (message) => {
            if (!mounted.current) return;
            setNotice(message);
          },
          onTranscript: (update) => {
            if (!mounted.current) return;
            onTranscriptRef.current?.(update);
          },
          onWidget: (push) => {
            if (!mounted.current) return;
            onWidgetRef.current?.(push);
          },
        },
        {
          get conversationId() {
            return conversationIdRef.current;
          },
        },
      );
    }
    return sessionRef.current;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (micOffTimer.current) clearTimeout(micOffTimer.current);
      // Leaving Ask Mila ends the call. Without this the room outlives the
      // overlay: the mic stays open and Mila keeps talking to a closed sheet.
      void sessionRef.current?.disconnect();
    };
  }, []);

  const toggle = useCallback(() => {
    if (!supported) return;
    const session = getSession();
    // "error" is a resting state, not a live one — toggling from it retries.
    if (state === "idle" || state === "error") void session.connect();
    else void session.disconnect();
  }, [supported, getSession, state]);

  const resumeAudio = useCallback(() => {
    sessionRef.current?.resumeAudio?.();
  }, []);

  const live =
    state === "connecting" || state === "listening" || state === "speaking";

  return {
    state,
    error,
    notice,
    supported,
    toggle,
    active: live,
    justEnded,
    audioBlocked: live && audioBlocked,
    resumeAudio,
  };
}
