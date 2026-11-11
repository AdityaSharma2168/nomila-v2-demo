/**
 * bookingCall.web.ts — her booked video call on WEB: not supported. She joins from the app on her phone (camera and
 * mic through the native build); the buyer is the one on the web, through the server's /s/:token page. Same exported
 * shape as bookingCall.ts so the screen cannot tell which it holds; `start` reports "unsupported" and the screen
 * offers the backup link instead.
 */
import type { JoinTokenResponse } from "../../lib/bookingSessionLogic";

export type CallStatus =
  | "idle" | "permission" | "permission_denied" | "connecting" | "waiting" | "in_call" | "reconnecting" | "ended" | "error" | "unsupported";

export interface CallSnapshot {
  status: CallStatus;
  localVideo: unknown | null;
  remoteVideo: unknown | null;
  remoteJoined: boolean;
  /** Everyone else in the call (a group call has several; 1:1 has one), in join order. remoteVideo is the first's. */
  remotes: RemoteTile[];
  remoteLeft: boolean;
  micOn: boolean;
  camOn: boolean;
  facing: "user" | "environment";
  error: string | null;
}

/** One other person in the call: their call identity (for her name map and "Remove"), the name they joined with. */
export interface RemoteTile { identity: string; name: string | null; video: unknown | null }

export interface BookingCall {
  start: (fetchToken: () => Promise<JoinTokenResponse>) => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
  flip: () => Promise<void>;
  leave: () => Promise<void>;
}

export const INITIAL_CALL: CallSnapshot = {
  status: "idle", localVideo: null, remoteVideo: null, remoteJoined: false, remotes: [], remoteLeft: false, micOn: true, camOn: true, facing: "user", error: null,
};

export function createBookingCall(onChange: (s: CallSnapshot) => void): BookingCall {
  const noop = async () => {};
  return {
    start: async () => { onChange({ ...INITIAL_CALL, status: "unsupported" }); },
    toggleMic: noop, toggleCam: noop, flip: noop, leave: noop,
  };
}
