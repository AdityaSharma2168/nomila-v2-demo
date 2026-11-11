/**
 * bookingSessionPage.video.test — the buyer's call page (server/public/booking-session.html, /s/:token): how the video
 * is drawn and the Flip control. The page's inline script is run in node:vm against a small fake DOM, a fake fetch and a
 * fake LivekitClient; the stylesheet is read as source.
 *
 *   V1 sizing: every <video> fills its box; the self tile and preview are cover, the other person is contain (shown whole)
 *   V2 Flip appears only with more than one camera; it restarts the camera with the other facingMode and mirrors only
 *      the front camera — in the preview and in the call
 *   V3 the self tile takes the camera's shape (landscape laptop → wide tile)
 *   V4 the one look: no blue, pill buttons, raspberry main action, 16 cards
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html = fs.readFileSync(path.join(__dirname, "..", "public", "booking-session.html"), "utf8");
const css = /<style nonce="__NONCE__">([\s\S]*?)<\/style>/.exec(html)![1];
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
  querySelectorAll(sel: string) { const tags = sel.split(","); return this.children.filter((c) => tags.includes(c.tag)); }
  remove() {}
  focus() {}
}

function boot(opts: { cameras: number }) {
  const els: Record<string, El> = {};
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) els[m[1]] = new El(m[1]);
  // textContent = "" must clear children (the page empties the preview and self tile that way)
  for (const id of ["pj-preview", "self-tile"]) {
    const e = els[id]; let t = "";
    Object.defineProperty(e, "textContent", { get: () => t, set: (v: string) => { t = v; if (v === "") e.children = []; } });
  }
  const restarts: unknown[] = [];
  const videoTrack = {
    kind: "video", mediaStreamTrack: { enabled: true }, attached: [] as El[],
    attach() { const v = new El("", "video"); this.attached.push(v); return v; },
    restartTrack(o: unknown) { restarts.push(o); this.mediaStreamTrack = { enabled: true }; return Promise.resolve(); },
    mute() { return Promise.resolve(); }, unmute() { return Promise.resolve(); }, stop() {},
  };
  const audioTrack = { kind: "audio", mediaStreamTrack: { enabled: true }, attach: () => new El("", "audio"), mute() {}, unmute() {}, stop() {} };
  class Room {
    remoteParticipants = new Map();
    localParticipant = { publishTrack: () => Promise.resolve() };
    on() { return this; }
    connect() { return Promise.resolve(); }
    disconnect() {}
  }
  const LivekitClient = { createLocalTracks: () => Promise.resolve([audioTrack, videoTrack]), Room, RoomEvent: {} };
  const state = {
    supportEmail: "support@nomila.co", serverNow: "2026-10-12T19:55:00Z",
    booking: { athleteFirstName: "Mia", title: "Video call", startsAt: "2026-10-12T20:00:00Z", endsAt: "2099-10-12T20:30:00Z", durationMinutes: 30, status: "confirmed" },
    video: { mode: "livekit", joinState: "open", joinOpensAt: "2026-10-12T19:50:00Z", joinClosesAt: "2099-10-12T21:00:00Z", fallbackLink: null },
    after: { reportOpen: false, itHappenedAt: null, canSayItHappened: false, canReport: true },
  };
  const fetch = (url: string) => {
    const body = url.endsWith("/join") ? { wsUrl: "wss://lk.example", token: "t" } : state;
    return Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
  };
  const devices = Array.from({ length: opts.cameras }, (_, i) => ({ kind: "videoinput", deviceId: `cam${i}` })).concat([{ kind: "audioinput", deviceId: "mic" }]);
  const sandbox: Record<string, unknown> = {
    document: { getElementById: (id: string) => els[id] },
    location: { pathname: "/s/tok" },
    navigator: { mediaDevices: { enumerateDevices: () => Promise.resolve(devices) } },
    fetch, LivekitClient, setInterval: () => 0, clearInterval: () => {},
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox);
  return { els, restarts, videoTrack };
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

describe("V1 video sizing", () => {
  it("the self tile's and preview's <video> fill their box (cover); the other person is shown whole (contain)", () => {
    expect(css).toMatch(/\.preview video, \.tile video, \.self video \{[^}]*width: 100%;[^}]*height: 100%;/);
    expect(css).toMatch(/\.preview video, \.self video \{ object-fit: cover; \}/);
    expect(css).toMatch(/\.tile video \{ object-fit: contain;/);
    expect(css).toMatch(/\.mirror video \{ transform: scaleX\(-1\); \}/);
  });
});

describe("V2 Flip", () => {
  it("is hidden on a one-camera device (a laptop)", async () => {
    const { els } = boot({ cameras: 1 });
    await flush();
    els.check.fire("click"); await flush();
    expect(els["t-flip"].hidden).toBe(true);
    els.join.fire("click"); await flush();
    expect(els["v-call"].hidden).toBe(false);
    expect(els["c-flip"].hidden).toBe(true);
  });

  it("with two cameras: flips in the preview and in the call, mirroring only the front camera", async () => {
    const { els, restarts } = boot({ cameras: 2 });
    await flush();
    els.check.fire("click"); await flush();
    expect(els["t-flip"].hidden).toBe(false);
    expect(els["pj-preview"].classList.contains("mirror")).toBe(true);

    els["t-flip"].fire("click"); await flush();
    expect(restarts).toEqual([{ facingMode: "environment" }]);
    expect(els["pj-preview"].classList.contains("mirror")).toBe(false);

    els.join.fire("click"); await flush();
    expect(els["v-call"].hidden).toBe(false);
    expect(els["c-flip"].hidden).toBe(false);
    expect(els["self-tile"].children).toHaveLength(1);
    expect(els["self-tile"].classList.contains("mirror")).toBe(false);

    els["c-flip"].fire("click"); await flush();
    expect(restarts).toEqual([{ facingMode: "environment" }, { facingMode: "user" }]);
    expect(els["self-tile"].classList.contains("mirror")).toBe(true);
    expect(els["self-tile"].children).toHaveLength(1); // the same <video> carries on

    els["c-cam"].fire("click"); await flush(); // camera off → no flip
    expect(els["c-flip"].disabled).toBe(true);
    els["c-flip"].fire("click"); await flush();
    expect(restarts).toHaveLength(2);
  });
});

describe("V3 the self tile takes the camera's shape", () => {
  it("a landscape camera makes a wide tile; a portrait one a tall tile", async () => {
    const { els } = boot({ cameras: 1 });
    await flush();
    els.check.fire("click"); await flush();
    els.join.fire("click"); await flush();
    const v = els["self-tile"].children[0];
    v.videoWidth = 1280; v.videoHeight = 720; v.fire("loadedmetadata");
    expect(els["self-tile"].style.aspectRatio).toBe("1280 / 720");
    expect(els["self-tile"].classList.contains("wide")).toBe(true);
    v.videoWidth = 720; v.videoHeight = 1280; v.fire("resize");
    expect(els["self-tile"].style.aspectRatio).toBe("720 / 1280");
    expect(els["self-tile"].classList.contains("wide")).toBe(false);
  });
});

describe("V4 the one look", () => {
  it("no blue, pill buttons, raspberry main action, 16px cards", () => {
    expect(html).not.toMatch(/#2D6BFF/i);
    expect(css).not.toMatch(/border-radius: 4px/);
    expect(css).toMatch(/--act:#C8325A/);
    expect(css).toMatch(/\.btn \{[^}]*border-radius: 999px;[^}]*background: var\(--act\); color: #fff;[^}]*text-transform: uppercase;/);
    expect(css).toMatch(/\.card \{[^}]*border-radius: 16px;/);
    expect(css).toMatch(/\.link \{ color: var\(--ink\);/);
  });
});
