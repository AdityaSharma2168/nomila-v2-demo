/**
 * roomAdmin.ts — the server-side LiveKit room actions a booked call needs: taking a participant OUT of a call (0153) and
 * muting one of their tracks (0154). Room-level only (a room name and an identity), so the later Live feature reuses it.
 *
 * Her tap only (athlete auth, her own booking or group time; routes/bookingSession.ts) or the booker removing a friend
 * they invited (guests.ts). Uses LiveKit's RoomService with the API key and secret (the join tokens never carry
 * roomAdmin). The caller records the action on the booking first (sessionStore), so a removed person gets no new join
 * token; these calls only act on the connection they have now. Best-effort: a participant who is not in the room (or a
 * room that already closed) is not an error.
 *
 * MUTE is LiveKit's mutePublishedTrack(muted = true) on that identity's microphone or camera track. The participant can
 * turn it back on themselves (a hard lock would need a permission change; not needed now).
 */
import { RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { createLogger } from "../../../logger";

const logger = createLogger("bookings/roomAdmin");

/** LIVEKIT_URL is the client's wss:// address; RoomService speaks https to the same host. */
function apiHost(): string | null {
  const raw = process.env.LIVEKIT_URL?.trim();
  if (!raw) return null;
  return raw.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

function client(): RoomServiceClient | null {
  const host = apiHost();
  const key = process.env.LIVEKIT_API_KEY?.trim();
  const secret = process.env.LIVEKIT_API_SECRET?.trim();
  return host && key && secret ? new RoomServiceClient(host, key, secret) : null;
}

const notFound = (err: any) => /not.?found/i.test(String(err?.message ?? "")) || err?.status === 404;

/** Remove `identity` from `room`. True when LiveKit confirmed it (or it was not there); false when it couldn't be reached. */
export async function removeFromRoom(room: string, identity: string): Promise<boolean> {
  const svc = client();
  if (!svc) return false;
  try {
    await svc.removeParticipant(room, identity);
    return true;
  } catch (err: any) {
    // "participant not found" / "room not found": they are not in the call now, which is what was asked.
    if (notFound(err)) return true;
    logger.warn({ error: err?.message }, "LiveKit removeParticipant failed");
    return false;
  }
}

export type MuteSource = "microphone" | "camera";
/**
 * muted        LiveKit muted the track (or it was already muted)
 * not_in_call  they are not in the room, or have no such track published (nothing to mute)
 * unreachable  LiveKit couldn't be reached (or isn't configured); nothing changed
 */
export type MuteOutcome = "muted" | "not_in_call" | "unreachable";

/** Mute `identity`'s microphone or camera in `room` (mutePublishedTrack on each matching track). */
export async function muteInRoom(room: string, identity: string, source: MuteSource): Promise<MuteOutcome> {
  const svc = client();
  if (!svc) return "unreachable";
  const want = source === "microphone" ? TrackSource.MICROPHONE : TrackSource.CAMERA;
  try {
    const p = await svc.getParticipant(room, identity);
    const tracks = (p?.tracks ?? []).filter((t) => t.source === want);
    if (!tracks.length) return "not_in_call";
    for (const t of tracks) if (!t.muted) await svc.mutePublishedTrack(room, identity, t.sid, true);
    return "muted";
  } catch (err: any) {
    if (notFound(err)) return "not_in_call";
    logger.warn({ error: err?.message, source }, "LiveKit mutePublishedTrack failed");
    return "unreachable";
  }
}
