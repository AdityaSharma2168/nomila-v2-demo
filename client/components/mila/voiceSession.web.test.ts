/**
 * voiceSession.web.test.ts — the web voice call's order of operations, against a mocked livekit-client.
 *
 * Pinned (each one is a bug the owner hit on a phone browser):
 *  - audio is unlocked INSIDE the tap: startAudio() is called before connect() first awaits anything;
 *  - the mic is taken BEFORE the token and the room, and published as that same track (no second
 *    getUserMedia via setMicrophoneEnabled);
 *  - a refused mic says how to fix it, and never opens a room;
 *  - an autoplay refusal is NOT reported as "Microphone permission denied" and does not end the call —
 *    it raises onAudioBlocked, and resumeAudio() (from a tap) lifts it;
 *  - a second call in the same page reuses the mic (no second prompt); after the grace it is stopped;
 *  - ending while still setting up returns to idle instead of hanging on "Joining…".
 */

type Handler = (...args: unknown[]) => void;

const created: FakeRoom[] = [];
const micTracks: FakeMic[] = [];
let micError: unknown = null;
let startAudioImpl: (room: FakeRoom) => Promise<void> = async () => {};

class FakeMic {
  isMuted = false;
  mediaStreamTrack = { readyState: "live" as "live" | "ended" };
  mute = jest.fn(async () => {
    this.isMuted = true;
    return this;
  });
  unmute = jest.fn(async () => {
    this.isMuted = false;
    return this;
  });
  stop = jest.fn(() => {
    this.mediaStreamTrack.readyState = "ended";
  });
}

class FakeRoom {
  state = "disconnected";
  canPlaybackAudio = true;
  handlers = new Map<string, Handler[]>();
  localParticipant = {
    identity: "me",
    publishTrack: jest.fn(async () => ({})),
    setMicrophoneEnabled: jest.fn(async () => ({})),
  };
  /** Mirrors livekit-client: startAudio() opens an AudioContext and (iOS) a silent element whose
   *  cleanup is a once(Disconnected) listener — which only a Disconnected event ever runs. */
  audioContext?: { state: string; close: jest.Mock };
  dummyCleaned = false;
  startAudio = jest.fn(() => {
    if (!this.audioContext) {
      const ctx = { state: "running", close: jest.fn(async () => { ctx.state = "closed"; }) };
      this.audioContext = ctx;
      this.once("disconnected", () => { this.dummyCleaned = true; });
    }
    return startAudioImpl(this);
  });
  connect = jest.fn(async () => {
    this.state = "connected";
    this.emit("connected");
  });
  /** Mirrors Room.disconnect: an already-disconnected room returns early and emits NOTHING. */
  disconnect = jest.fn(async (_stopTracks?: boolean) => {
    if (this.state === "disconnected") return;
    this.state = "disconnected";
    this.emit("disconnected");
  });
  registerTextStreamHandler = jest.fn();
  constructor() {
    created.push(this);
  }
  on(event: string, h: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
    return this;
  }
  once(event: string, h: Handler) {
    const wrapped: Handler = (...args) => {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((x) => x !== wrapped));
      h(...args);
    };
    return this.on(event, wrapped);
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(...args);
  }
}

jest.mock("livekit-client", () => ({
  ConnectionState: { Disconnected: "disconnected", Connected: "connected" },
  RoomEvent: {
    Connected: "connected",
    Disconnected: "disconnected",
    ParticipantConnected: "participantConnected",
    TrackSubscribed: "trackSubscribed",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    DataReceived: "dataReceived",
    AudioPlaybackStatusChanged: "audioPlaybackChanged",
  },
  Room: jest.fn().mockImplementation(() => new FakeRoom()),
  createLocalAudioTrack: jest.fn(async () => {
    if (micError) throw micError;
    const m = new FakeMic();
    micTracks.push(m);
    return m;
  }),
}));

const getAuthHeaders = jest.fn(async () => ({ Authorization: "Bearer t" }));
jest.mock("../../lib/query-client", () => ({
  getApiUrl: () => "http://api.test",
  getAuthHeaders: () => getAuthHeaders(),
}));

import { createVoiceSession, __resetPageMicForTests } from "./voiceSession.web";

// Loosely typed: cases replace the response with their own shapes.
const fetchMock = jest.fn(async (..._args: unknown[]): Promise<any> => ({
  ok: true,
  status: 200,
  json: async () => ({ wsUrl: "wss://lk.test", token: "tok", room: "r1", identity: "me", conversationId: null }),
}));

const windowListen = jest.fn();

function domError(name: string, message = "") {
  return Object.assign(new Error(message), { name });
}

function makeCallbacks() {
  return {
    onState: jest.fn(),
    onError: jest.fn(),
    onAudioBlocked: jest.fn(),
    onNotice: jest.fn(),
  };
}

beforeAll(() => {
  (globalThis as any).__DEV__ = false;
  (globalThis as any).fetch = fetchMock;
  (globalThis as any).window = { addEventListener: windowListen };
  (globalThis as any).document = { getElementById: () => null, body: { appendChild: jest.fn() } };
});

beforeEach(() => {
  created.length = 0;
  micTracks.length = 0;
  micError = null;
  startAudioImpl = async () => {};
  fetchMock.mockClear();
  getAuthHeaders.mockClear();
  __resetPageMicForTests();
  // Fake timers throughout: the agent-join deadline and the mic grace are 30 s real timers.
  jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
});

afterEach(() => {
  __resetPageMicForTests();
  jest.clearAllTimers();
  jest.useRealTimers();
});

const flush = () => new Promise((r) => setImmediate(r));

test("audio is unlocked synchronously inside the tap, before any await", () => {
  const session = createVoiceSession(makeCallbacks());
  void session.connect(); // NOT awaited — this is what the click handler does.
  expect(created).toHaveLength(1);
  expect(created[0].startAudio).toHaveBeenCalledTimes(1);
  // Nothing async has happened yet: the token has not even been asked for.
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the mic is taken before the token and the room, and that same track is published", async () => {
  const lk = jest.requireMock("livekit-client");
  const order: string[] = [];
  lk.createLocalAudioTrack.mockImplementationOnce(async () => {
    order.push("mic");
    const m = new FakeMic();
    micTracks.push(m);
    return m;
  });
  fetchMock.mockImplementationOnce(async () => {
    order.push("token");
    return {
      ok: true,
      status: 200,
      json: async () => ({ wsUrl: "wss://lk.test", token: "tok", room: "r1", identity: "me" }),
    };
  });
  const cb = makeCallbacks();
  await createVoiceSession(cb).connect();
  const room = created[0];
  expect(order).toEqual(["mic", "token"]);
  expect(room.connect).toHaveBeenCalledTimes(1);
  expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(micTracks[0]);
  expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  expect(cb.onState).toHaveBeenLastCalledWith("listening");
  expect(cb.onError).not.toHaveBeenCalled();
});

test("a refused mic says how to fix it and never opens a room", async () => {
  micError = domError("NotAllowedError", "Permission denied");
  const cb = makeCallbacks();
  await createVoiceSession(cb).connect();
  expect(cb.onError).toHaveBeenCalledWith(expect.stringMatching(/blocked for this site.*settings.*reload/i));
  expect(cb.onState).toHaveBeenLastCalledWith("error");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(created[0].connect).not.toHaveBeenCalled();
});

test("a busy mic is named as busy, not as denied", async () => {
  micError = domError("NotReadableError", "Could not start audio source");
  const cb = makeCallbacks();
  await createVoiceSession(cb).connect();
  expect(cb.onError).toHaveBeenCalledWith(expect.stringMatching(/busy/i));
});

test("an autoplay refusal is not a mic denial: the call stays up and offers a tap to hear", async () => {
  // What iOS Safari does to startAudio() once the tap's gesture is gone.
  startAudioImpl = async (room) => {
    room.canPlaybackAudio = false;
    throw domError("NotAllowedError", "The request is not allowed by the user agent");
  };
  const cb = makeCallbacks();
  const session = createVoiceSession(cb);
  await session.connect();
  const room = created[0];
  expect(cb.onError).not.toHaveBeenCalled();
  expect(cb.onState).toHaveBeenLastCalledWith("listening");
  expect(cb.onAudioBlocked).toHaveBeenLastCalledWith(true);

  // The athlete taps "Tap to hear Mila": startAudio from the tap succeeds.
  startAudioImpl = async (r) => {
    r.canPlaybackAudio = true;
  };
  session.resumeAudio!();
  await flush();
  expect(room.startAudio).toHaveBeenCalledTimes(2);
  expect(cb.onAudioBlocked).toHaveBeenLastCalledWith(false);
});

test("a connection failure is reported as a connection failure", async () => {
  startAudioImpl = async () => {
    throw domError("NotAllowedError");
  };
  const lk = jest.requireMock("livekit-client");
  lk.Room.mockImplementationOnce(() => {
    const r = new FakeRoom();
    r.connect.mockImplementationOnce(async () => {
      throw new Error("could not establish signal connection");
    });
    return r;
  });
  const cb = makeCallbacks();
  await createVoiceSession(cb).connect();
  expect(cb.onError).toHaveBeenCalledWith(expect.stringMatching(/connect to voice/i));
  expect(cb.onError).not.toHaveBeenCalledWith(expect.stringMatching(/microphone/i));
});

test("a second call in the same page reuses the mic; after the grace it is stopped", async () => {
  const cb = makeCallbacks();
  const session = createVoiceSession(cb);
  const lk = jest.requireMock("livekit-client");
  lk.createLocalAudioTrack.mockClear();

  await session.connect();
  await session.disconnect();
  expect(created[0].disconnect).toHaveBeenCalledWith(false); // the room does not stop the page's mic
  expect(micTracks[0].mute).toHaveBeenCalled();
  expect(micTracks[0].stop).not.toHaveBeenCalled();
  expect(cb.onState).toHaveBeenLastCalledWith("idle");

  await session.connect();
  expect(lk.createLocalAudioTrack).toHaveBeenCalledTimes(1); // no second getUserMedia → no second prompt
  expect(micTracks[0].unmute).toHaveBeenCalled();
  expect(created[1].localParticipant.publishTrack).toHaveBeenCalledWith(micTracks[0]);

  await session.disconnect();
  jest.advanceTimersByTime(30_000);
  expect(micTracks[0].stop).toHaveBeenCalledTimes(1);

  await session.connect();
  expect(lk.createLocalAudioTrack).toHaveBeenCalledTimes(2);
});

test("ending while the mic prompt is still up returns to idle and never connects", async () => {
  let release: (m: FakeMic) => void = () => {};
  const lk = jest.requireMock("livekit-client");
  lk.createLocalAudioTrack.mockImplementationOnce(
    () =>
      new Promise((res) => {
        release = (m) => {
          micTracks.push(m);
          res(m);
        };
      }),
  );
  const cb = makeCallbacks();
  const session = createVoiceSession(cb);
  const pending = session.connect();
  await flush();
  await session.disconnect();
  expect(cb.onState).toHaveBeenLastCalledWith("idle");

  release(new FakeMic());
  await pending;
  expect(fetchMock).not.toHaveBeenCalled();
  expect(created[0].connect).not.toHaveBeenCalled();
  expect(micTracks[0].mute).toHaveBeenCalled(); // parked, not left hot
  expect(cb.onState).toHaveBeenLastCalledWith("idle");
});

test("tap → End while the mic prompt is open → tap again: ONE acquisition, and its track is the one stopped", async () => {
  let release: (m: FakeMic) => void = () => {};
  const lk = jest.requireMock("livekit-client");
  lk.createLocalAudioTrack.mockClear();
  lk.createLocalAudioTrack.mockImplementationOnce(
    () =>
      new Promise((res) => {
        release = (m) => {
          micTracks.push(m);
          res(m);
        };
      }),
  );
  const cb = makeCallbacks();
  const session = createVoiceSession(cb);
  const first = session.connect();
  await flush();
  await session.disconnect(); // End while the prompt is still up
  const second = session.connect(); // tap again, prompt still the same one
  await flush();
  expect(lk.createLocalAudioTrack).toHaveBeenCalledTimes(1);

  release(new FakeMic());
  await first;
  await second;
  const track = micTracks[0];
  expect(created[1].localParticipant.publishTrack).toHaveBeenCalledWith(track);
  // The cancelled first call's release must not leave the live call's mic muted.
  expect(track.isMuted).toBe(false);
  expect(track.stop).not.toHaveBeenCalled();

  await session.disconnect();
  jest.advanceTimersByTime(30_000);
  expect(track.stop).toHaveBeenCalledTimes(1);
});

test("leaving the page stops every mic it ever got", async () => {
  const session = createVoiceSession(makeCallbacks());
  await session.connect();
  const onPageHide = windowListen.mock.calls.find(([e]) => e === "pagehide")?.[1] as () => void;
  expect(onPageHide).toBeDefined();
  onPageHide();
  expect(micTracks[0].stop).toHaveBeenCalled();
});

test.each([
  ["the mic is refused", () => { micError = domError("NotAllowedError"); }],
  ["the token request fails", () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  }],
])("a room that never connected is let go of when %s (silent element + AudioContext)", async (_label, arrange) => {
  arrange();
  await createVoiceSession(makeCallbacks()).connect();
  const room = created[0];
  expect(room.connect).not.toHaveBeenCalled();
  expect(room.dummyCleaned).toBe(true);
  expect(room.audioContext!.close).toHaveBeenCalled();
});

test("End during setup lets the never-connected room go too", async () => {
  let release: (m: FakeMic) => void = () => {};
  const lk = jest.requireMock("livekit-client");
  lk.createLocalAudioTrack.mockImplementationOnce(
    () => new Promise((res) => { release = (m) => { micTracks.push(m); res(m); }; }),
  );
  const session = createVoiceSession(makeCallbacks());
  const pending = session.connect();
  await flush();
  await session.disconnect();
  expect(created[0].dummyCleaned).toBe(true);
  expect(created[0].audioContext!.close).toHaveBeenCalled();
  release(new FakeMic());
  await pending;
});

test("End while the room is still connecting is not reported as a failure", async () => {
  const lk = jest.requireMock("livekit-client");
  let rejectConnect: (e: Error) => void = () => {};
  lk.Room.mockImplementationOnce(() => {
    const r = new FakeRoom();
    r.connect.mockImplementationOnce(
      () =>
        new Promise<void>((_res, rej) => {
          r.state = "connecting";
          rejectConnect = rej;
        }),
    );
    r.disconnect.mockImplementationOnce(async () => {
      // Room.disconnect during Connecting: aborts the connect, then Disconnected.
      rejectConnect(new Error("Client initiated disconnect"));
      r.state = "disconnected";
      r.emit("disconnected");
    });
    return r;
  });
  const cb = makeCallbacks();
  const session = createVoiceSession(cb);
  const pending = session.connect();
  await flush();
  expect(created[0].state).toBe("connecting");
  await session.disconnect();
  await pending;
  expect(cb.onError).not.toHaveBeenCalled();
  expect(cb.onState).toHaveBeenLastCalledWith("idle");
});
