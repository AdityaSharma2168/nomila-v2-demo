/**
 * roomAdmin.test — the RoomService calls behind Remove (0153) and Mute / Turn off camera (0154), with LiveKit's
 * RoomServiceClient mocked (never a real call): the https host from LIVEKIT_URL, mutePublishedTrack(muted=true) on
 * exactly that identity's microphone or camera track(s), "not in the call" when they aren't there or publish no such
 * track, "unreachable" (nothing changed) when LiveKit fails or isn't configured.
 */
const svc = { removeParticipant: jest.fn(), getParticipant: jest.fn(), mutePublishedTrack: jest.fn() };
const ctor = jest.fn();
jest.mock("livekit-server-sdk", () => {
  const actual = jest.requireActual("livekit-server-sdk");
  return { ...actual, RoomServiceClient: jest.fn().mockImplementation((...args: unknown[]) => { ctor(...args); return svc; }) };
});

import { TrackSource } from "livekit-server-sdk";
import { muteInRoom, removeFromRoom } from "./roomAdmin";

const ENV = { LIVEKIT_URL: "wss://room-admin.livekit.cloud", LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "secret" };

beforeEach(() => {
  Object.assign(process.env, ENV);
  for (const f of [...Object.values(svc), ctor]) f.mockReset();
});
afterAll(() => { for (const k of Object.keys(ENV)) delete process.env[k]; });

describe("muteInRoom", () => {
  it("mutes that identity's microphone track(s) only, on the https host", async () => {
    svc.getParticipant.mockResolvedValue({ tracks: [
      { sid: "TR_mic", source: TrackSource.MICROPHONE, muted: false },
      { sid: "TR_cam", source: TrackSource.CAMERA, muted: false },
    ] });
    expect(await muteInRoom("booking_x", "b_fan", "microphone")).toBe("muted");
    expect(ctor).toHaveBeenCalledWith("https://room-admin.livekit.cloud", "APIkey", "secret");
    expect(svc.getParticipant).toHaveBeenCalledWith("booking_x", "b_fan");
    expect(svc.mutePublishedTrack.mock.calls).toEqual([["booking_x", "b_fan", "TR_mic", true]]);
  });

  it("turns off the camera; an already-muted track is left alone", async () => {
    svc.getParticipant.mockResolvedValue({ tracks: [
      { sid: "TR_cam", source: TrackSource.CAMERA, muted: false },
      { sid: "TR_cam2", source: TrackSource.CAMERA, muted: true },
      { sid: "TR_mic", source: TrackSource.MICROPHONE, muted: false },
    ] });
    expect(await muteInRoom("booking_x", "g_friend", "camera")).toBe("muted");
    expect(svc.mutePublishedTrack.mock.calls).toEqual([["booking_x", "g_friend", "TR_cam", true]]);
  });

  it("not in the call: not found, or no such track published", async () => {
    svc.getParticipant.mockRejectedValueOnce(Object.assign(new Error("participant not found"), { status: 404 }));
    expect(await muteInRoom("booking_x", "b_gone", "microphone")).toBe("not_in_call");
    svc.getParticipant.mockResolvedValueOnce({ tracks: [{ sid: "TR_cam", source: TrackSource.CAMERA, muted: false }] });
    expect(await muteInRoom("booking_x", "b_nomic", "microphone")).toBe("not_in_call");
    expect(svc.mutePublishedTrack).not.toHaveBeenCalled();
  });

  it("unreachable: LiveKit fails, or isn't configured (nothing is called)", async () => {
    svc.getParticipant.mockResolvedValue({ tracks: [{ sid: "TR_mic", source: TrackSource.MICROPHONE, muted: false }] });
    svc.mutePublishedTrack.mockRejectedValueOnce(new Error("twirp error: internal"));
    expect(await muteInRoom("booking_x", "b_fan", "microphone")).toBe("unreachable");
    delete process.env.LIVEKIT_API_SECRET;
    svc.getParticipant.mockClear();
    expect(await muteInRoom("booking_x", "b_fan", "microphone")).toBe("unreachable");
    expect(svc.getParticipant).not.toHaveBeenCalled();
  });
});

describe("removeFromRoom (unchanged)", () => {
  it("true when removed or already gone; false when LiveKit fails", async () => {
    svc.removeParticipant.mockResolvedValueOnce(undefined);
    expect(await removeFromRoom("booking_x", "b_fan")).toBe(true);
    svc.removeParticipant.mockRejectedValueOnce(new Error("room not found"));
    expect(await removeFromRoom("booking_x", "b_fan")).toBe(true);
    svc.removeParticipant.mockRejectedValueOnce(new Error("boom"));
    expect(await removeFromRoom("booking_x", "b_fan")).toBe(false);
  });
});
