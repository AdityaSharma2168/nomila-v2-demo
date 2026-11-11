/**
 * bookingCall.ts — her side of a booked video call, on NATIVE (LiveKit; the same stack as Mila voice, with no agent).
 *
 * Metro resolves ./bookingCall to bookingCall.web.ts on web (unsupported: she joins from the app on her phone) and to
 * this file everywhere else, the same split as components/mila/voiceSession(.web).ts and for the same reason: the
 * react-native-webrtc import must never reach the web bundle. registerGlobals() already ran at entry
 * (client/lib/voiceGlobals.ts).
 *
 * Sequence: permissions (Android asks up front; iOS asks when the camera / mic first open, and a refusal surfaces as
 * NotAllowedError) → the OS audio session as a call → local camera + mic → the token (POST …/session/token, only inside
 * the join window) → connect → publish. The controller only reports state; the screen draws it.
 *
 * Nothing is recorded: the token carries no recording grant and the room no egress (server/…/sessionRoom.ts).
 */

import { PermissionsAndroid, Platform } from "react-native";
import { AndroidAudioTypePresets, AudioSession } from "@livekit/react-native";
import {
  ConnectionState, LocalVideoTrack, Room, RoomEvent, Track, createLocalTracks,
  type LocalTrack, type RemoteTrack, type VideoTrack,
} from "livekit-client";
import type { JoinTokenResponse } from "../../lib/bookingSessionLogic";

export type CallStatus =
  | "idle" | "permission" | "permission_denied" | "connecting" | "waiting" | "in_call" | "reconnecting" | "ended" | "error" | "unsupported";

export interface CallSnapshot {
  status: CallStatus;
  localVideo: VideoTrack | null;
  remoteVideo: VideoTrack | null;
  remoteJoined: boolean;
  /** Everyone else in the call (a group call has several; 1:1 has one), in join order. remoteVideo is the first's. */
  remotes: RemoteTile[];
  /** The other side was here and left (they can rejoin while the window is open). */
  remoteLeft: boolean;
  micOn: boolean;
  camOn: boolean;
  facing: "user" | "environment";
  /** A short human line; never a raw SDK error. */
  error: string | null;
}

/** One other person in the call: their call identity (for her name map and "Remove"), the name they joined with. */
export interface RemoteTile { identity: string; name: string | null; video: VideoTrack | null }

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

const AUDIO_CONFIG = {
  android: { audioTypeOptions: AndroidAudioTypePresets.communication },
  ios: { defaultOutput: "speaker" as const },
};

async function androidPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const res = await PermissionsAndroid.requestMultiple([PermissionsAndroid.PERMISSIONS.CAMERA, PermissionsAndroid.PERMISSIONS.RECORD_AUDIO]);
  return Object.values(res).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
}

function isPermissionError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === "NotAllowedError" || e?.name === "SecurityError" || /permission/i.test(String(e?.message ?? ""));
}

export function createBookingCall(onChange: (s: CallSnapshot) => void): BookingCall {
  let snap: CallSnapshot = { ...INITIAL_CALL };
  let room: Room | null = null;
  let local: LocalTrack[] = [];
  let audioStarted = false;
  const set = (patch: Partial<CallSnapshot>) => { snap = { ...snap, ...patch }; onChange(snap); };

  const refreshRemote = () => {
    const remotes: RemoteTile[] = room ? Array.from(room.remoteParticipants.values()).map((r) => {
      const pub = Array.from(r.trackPublications.values()).find((p) => p.kind === Track.Kind.Video && p.track);
      return { identity: r.identity, name: r.name ?? null, video: (pub?.track as VideoTrack | undefined) ?? null };
    }) : [];
    const first = remotes[0];
    set({
      remotes,
      remoteJoined: !!first,
      remoteLeft: !first && (snap.remoteJoined || snap.remoteLeft),
      remoteVideo: first?.video ?? null,
      status: snap.status === "reconnecting" ? "reconnecting" : first ? "in_call" : "waiting",
    });
  };

  const teardown = async () => {
    for (const t of local) { try { t.stop(); } catch { /* already stopped */ } }
    local = [];
    if (audioStarted) { audioStarted = false; await AudioSession.stopAudioSession().catch(() => {}); }
  };

  return {
    async start(fetchToken) {
      if (room) return;
      set({ ...INITIAL_CALL, status: "permission" });
      if (!(await androidPermissions())) { set({ status: "permission_denied" }); return; }
      try {
        await AudioSession.configureAudio(AUDIO_CONFIG);
        await AudioSession.startAudioSession();
        audioStarted = true;
        local = await createLocalTracks({ audio: true, video: { facingMode: "user" } });
      } catch (err) {
        await teardown();
        set(isPermissionError(err) ? { status: "permission_denied" } : { status: "error", error: "Your camera or microphone couldn't start." });
        return;
      }
      const cam = local.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
      set({ status: "connecting", localVideo: cam ?? null });
      try {
        const t = await fetchToken();
        room = new Room({ adaptiveStream: true, dynacast: true });
        room
          .on(RoomEvent.ParticipantConnected, refreshRemote)
          .on(RoomEvent.ParticipantDisconnected, refreshRemote)
          .on(RoomEvent.TrackSubscribed, (_t: RemoteTrack) => refreshRemote())
          .on(RoomEvent.TrackUnsubscribed, refreshRemote)
          .on(RoomEvent.Reconnecting, () => set({ status: "reconnecting" }))
          .on(RoomEvent.Reconnected, () => { snap = { ...snap, status: "waiting" }; refreshRemote(); })
          .on(RoomEvent.Disconnected, () => { room = null; void teardown(); set({ status: "ended" }); });
        await room.connect(t.wsUrl, t.token);
        for (const track of local) await room.localParticipant.publishTrack(track);
        refreshRemote();
      } catch (err) {
        const r = room; room = null;
        if (r && r.state !== ConnectionState.Disconnected) await r.disconnect().catch(() => {});
        await teardown();
        set({ status: "error", error: (err as Error)?.message?.startsWith("403") ? "The call isn't open right now." : "We couldn't connect. Check your connection and try again." });
      }
    },
    async toggleMic() {
      const mic = local.find((t) => t.kind === Track.Kind.Audio);
      if (!mic) return;
      if (snap.micOn) await mic.mute(); else await mic.unmute();
      set({ micOn: !snap.micOn });
    },
    async toggleCam() {
      const cam = local.find((t) => t.kind === Track.Kind.Video);
      if (!cam) return;
      if (snap.camOn) await cam.mute(); else await cam.unmute();
      set({ camOn: !snap.camOn });
    },
    async flip() {
      const cam = local.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
      if (!cam) return;
      const facing = snap.facing === "user" ? "environment" : "user";
      await cam.restartTrack({ facingMode: facing }).catch(() => {});
      set({ facing });
    },
    async leave() {
      // Nothing started (or already over): leaving is a no-op, so an unmount before Join never reads as "call ended".
      if (!room && (snap.status === "idle" || snap.status === "ended")) return;
      const r = room; room = null;
      set({ status: "ended" });
      if (r) await r.disconnect().catch(() => {});
      await teardown();
    },
  };
}
