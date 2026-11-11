/**
 * bookingSessionPage.muted.test — the buyer's call page (server/public/booking-session.html, /s/:token), sessions
 * safety (0154). The page's inline script runs in node:vm against a small fake DOM, a fake fetch and a fake
 * LivekitClient whose Room keeps its event handlers (so a test can fire LiveKit's own events).
 *
 *   M1 a group call joins MUTED: the pre-join toggle reads "Mic off", the audio track is published and muted, the call
 *      button reads "Unmute"; one tap turns it on
 *   M2 a 1:1 is unchanged: mic on
 *   M3 the server's startMuted alone (an older state without joinMuted) still joins muted
 *   M4 she mutes them from her app (LiveKit TrackMuted on the LOCAL participant): the page follows and says so; their
 *      own mute says nothing; another participant's mute is not theirs
 *   M5 "didn't join" after the call follows the evidence: unknown → "We couldn't confirm attendance"
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html = fs.readFileSync(path.join(__dirname, "..", "public", "booking-session.html"), "utf8");
const script = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(html)![1];

type Listener = (ev?: unknown) => void;
class El {
  hidden = false; disabled = false; textContent = ""; value = ""; href = ""; muted = false;
  videoWidth = 0; videoHeight = 0;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  children: El[] = [];
  listeners: Record<string, Listener[]> = {};
  private classes = new Set<string>();
  classList = {
    toggle: (c: string, on?: boolean) => { const v = on ?? !this.classes.has(c); if (v) this.classes.add(c); else this.classes.delete(c); return v; },
    contains: (c: string) => this.classes.has(c),
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
  };
  constructor(public id = "", public tag = "div") {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(t: string, f: Listener) { (this.listeners[t] ??= []).push(f); }
  fire(t: string, ev: unknown = { preventDefault() {} }) { (this.listeners[t] ?? []).forEach((f) => f(ev)); }
  appendChild(c: El) { this.children.push(c); return c; }
  remove() {}
  focus() {}
}

interface Boot {
  audience?: string; joinMuted?: boolean; startMuted?: boolean;
  after?: Record<string, unknown>; ended?: boolean;
}

function boot(o: Boot = {}) {
  const els: Record<string, El> = {};
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) els[m[1]] = new El(m[1]);
  const track = (kind: string) => ({
    kind, mediaStreamTrack: { enabled: true }, isMuted: false, calls: [] as string[],
    attach() { return new El("", kind); },
    mute() { this.isMuted = true; this.calls.push("mute"); return Promise.resolve(); },
    unmute() { this.isMuted = false; this.calls.push("unmute"); return Promise.resolve(); },
    restartTrack() { return Promise.resolve(); }, stop() {},
  });
  const audio = track("audio"), video = track("video");
  const published: unknown[] = [];
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const local = { publishTrack: (t: unknown) => { published.push(t); return Promise.resolve(); } };
  class Room {
    remoteParticipants = new Map();
    localParticipant = local;
    on(ev: string, f: (...a: unknown[]) => void) { (handlers[ev] ??= []).push(f); return this; }
    connect() { return Promise.resolve(); }
    disconnect() {}
  }
  const RoomEvent = Object.fromEntries(["ParticipantConnected", "ParticipantDisconnected", "TrackSubscribed", "TrackUnsubscribed", "TrackMuted", "Reconnecting", "Reconnected", "Disconnected"].map((k) => [k, k]));
  const LivekitClient = { createLocalTracks: () => Promise.resolve([audio, video]), Room, RoomEvent };
  const state = {
    supportEmail: "support@nomila.co", serverNow: "2026-10-12T19:55:00Z",
    booking: { athleteFirstName: "Mia", title: "Video call", startsAt: "2026-10-12T20:00:00Z", endsAt: o.ended ? "2026-10-12T20:30:00Z" : "2099-10-12T20:30:00Z", durationMinutes: 30, status: "confirmed", audience: o.audience ?? "one" },
    video: { mode: "livekit", joinState: o.ended ? "closed" : "open", joinOpensAt: "2026-10-12T19:50:00Z", joinClosesAt: "2099-10-12T21:00:00Z", fallbackLink: null, athleteIdentity: "a_mia", ...(o.joinMuted === undefined ? {} : { joinMuted: o.joinMuted }) },
    after: { reportOpen: false, itHappenedAt: null, canSayItHappened: false, canReport: true, ...o.after },
    you: { role: "buyer" },
  };
  const fetch = (url: string) => {
    const body = url.endsWith("/join") ? { wsUrl: "wss://lk.example", token: "t", startMuted: !!o.startMuted } : state;
    return Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
  };
  const sandbox: Record<string, unknown> = {
    document: { getElementById: (id: string) => els[id] },
    location: { pathname: "/s/tok" },
    navigator: { mediaDevices: { enumerateDevices: () => Promise.resolve([{ kind: "videoinput" }]) } },
    fetch, LivekitClient, setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox);
  const emit = (ev: string, ...args: unknown[]) => (handlers[ev] ?? []).forEach((f) => f(...args));
  return { els, audio, video, published, emit, local };
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

async function joined(o: Boot) {
  const b = boot(o);
  await flush();
  b.els.check.fire("click"); await flush();
  const prejoin = { mic: b.els["t-mic"].textContent, pressed: b.els["t-mic"].getAttribute("aria-pressed"), status: b.els["pj-status"].textContent, enabled: b.audio.mediaStreamTrack.enabled };
  b.els.join.fire("click"); await flush();
  return { ...b, prejoin };
}

describe("M1 a group call joins muted", () => {
  it.each(["private_group", "open_group"])("%s: mic off before and in the call; one tap turns it on", async (audience) => {
    const { els, audio, published, prejoin } = await joined({ audience, joinMuted: true, startMuted: true });
    expect(prejoin).toMatchObject({ mic: "Mic off", pressed: "false", enabled: false });
    expect(prejoin.status).toMatch(/join with your mic off/);
    expect(els["v-call"].hidden).toBe(false);
    expect(published).toContain(audio);
    expect(audio.isMuted).toBe(true);
    expect(els["c-mic"].textContent).toBe("Unmute");
    expect(els["c-mic"].getAttribute("aria-pressed")).toBe("false");
    els["c-mic"].fire("click"); await flush();
    expect(audio.isMuted).toBe(false);
    expect(els["c-mic"].textContent).toBe("Mute");
  });
});

describe("M2 a 1:1 is unchanged", () => {
  it("mic on before and in the call", async () => {
    const { els, audio, prejoin } = await joined({ audience: "one", joinMuted: false, startMuted: false });
    expect(prejoin).toMatchObject({ mic: "Mic on", enabled: true });
    expect(audio.isMuted).toBe(false);
    expect(els["c-mic"].textContent).toBe("Mute");
  });
});

describe("M3 the join answer's startMuted alone still joins muted", () => {
  it("an older state without joinMuted", async () => {
    const { els, audio, prejoin } = await joined({ audience: "private_group", startMuted: true });
    expect(prejoin.mic).toBe("Mic on");
    expect(audio.isMuted).toBe(true);
    expect(els["c-mic"].textContent).toBe("Unmute");
  });
});

describe("M4 she mutes them from her app", () => {
  it("the page follows a LiveKit mute of THEIR track and says so; they can turn it back on", async () => {
    const { els, audio, video, emit, local } = await joined({ audience: "one" });
    emit("TrackMuted", { kind: "audio" }, local); await flush();
    expect(els["c-mic"].textContent).toBe("Unmute");
    expect(els.banner.hidden).toBe(false);
    expect(els.banner.textContent).toBe("Mia muted your mic. You can turn it back on.");
    emit("TrackMuted", { kind: "video" }, local); await flush();
    expect(els["c-cam"].textContent).toBe("Camera on");
    expect(els.banner.textContent).toBe("Mia turned off your camera. You can turn it back on.");
    els["c-mic"].fire("click"); await flush();
    expect(audio.isMuted).toBe(false);
    els["c-cam"].fire("click"); await flush();
    expect(video.isMuted).toBe(false);
  });

  it("their own mute says nothing; someone else's mute isn't theirs", async () => {
    const { els, emit, local } = await joined({ audience: "open_group", joinMuted: true });
    emit("TrackMuted", { kind: "audio" }, local); await flush();   // already off (they joined muted)
    expect(els.banner.textContent).toBe("");
    emit("TrackMuted", { kind: "video" }, { identity: "b_other" }); await flush();
    expect(els["c-cam"].textContent).toBe("Camera off");
    expect(els.banner.textContent).toBe("");
  });
});

describe("M5 'didn't join' follows the evidence", () => {
  it.each([
    ["unknown", /^We couldn't confirm attendance for this call\. Mia marked it as a no-show\./],
    ["seen", /our call shows you joined/],
    ["not_seen", /^Mia says you didn't join\./],
  ])("%s", async (attendance, line) => {
    const { els } = boot({ ended: true, after: { markedYouNoShow: true, attendance, releaseDueAt: null, canReportNoShowFrom: null } });
    await flush();
    expect(els["v-after"].hidden).toBe(false);
    expect(els["af-text"].textContent).toMatch(line as RegExp);
  });
});
