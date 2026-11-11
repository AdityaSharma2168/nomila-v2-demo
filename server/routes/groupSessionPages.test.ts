/**
 * groupSessionPages.test — the three buyer pages with group sessions (0153). Each page's script runs in node:vm against
 * a small fake DOM and a fake fetch (no jsdom in this repo), like bookingStatusPage.autoSend / bookingSessionPage.video.
 *
 *   P1 the Book door (server/public/p/book.js): "Group · $X per person"; an open group lists "N of M spots left" and
 *      shows a full time as Full (not bookable); a private group asks "How many people?", re-prices the all-in total
 *      from the quote endpoint, and sends that party size and that exact total
 *   P2 the private page (/b/:token, booking-status.html): the party on the summary; a paid private group gets "Invite
 *      your friends" (add posts the email; remove asks twice, then deletes); an open group says "You're in"
 *   P3 the call page (/s/:token, booking-session.html): a tile per person in a grid, hers first and marked, names from
 *      LiveKit ("Fan" between strangers); one other person still fills the screen
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

type Listener = (ev?: any) => void;
class Node {
  children: Node[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  private text = "";
  disabled = false; hidden = false; value = ""; selected = false; className = ""; parentNode: Node | null = null;
  scrollTop = 0;
  private classes = new Set<string>();
  classList = {
    toggle: (c: string, on?: boolean) => { const v = on ?? !this.classes.has(c); if (v) this.classes.add(c); else this.classes.delete(c); return v; },
    contains: (c: string) => this.classes.has(c) || this.className.split(" ").includes(c),
    add: (c: string) => { this.classes.add(c); }, remove: (c: string) => { this.classes.delete(c); },
  };
  constructor(public tag: string, public id = "") {}
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; if (v === "") this.children = []; }
  get firstChild(): Node | null { return this.children[0] ?? null; }
  appendChild(c: Node): Node { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c: Node, ref: Node): Node { const i = this.children.indexOf(ref); c.parentNode = this; this.children.splice(i < 0 ? this.children.length : i, 0, c); return c; }
  removeChild(c: Node): Node { this.children = this.children.filter((x) => x !== c); return c; }
  remove(): void { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); if (k === "class") this.className = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(e: string, f: Listener): void { (this.listeners[e] ??= []).push(f); }
  fire(e: string, ev: any = { preventDefault() {} }): void { (this.listeners[e] ?? []).forEach((f) => f(ev)); }
  focus(): void { /* no-op */ }
  all(): Node[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel: string): Node | null { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): Node[] {
    const tags = sel.split(",").map((s) => s.trim());
    return this.all().filter((n) => tags.some((t) => (t.startsWith("[") ? t.slice(1, -1) in n.attrs : n.tag === t)));
  }
  allText(): string { return [this.text, ...this.children.map((c) => c.allText())].join(" "); }
  byText(t: string, tag = "button"): Node | undefined { return this.all().find((n) => n.tag === tag && n.allText().includes(t)); }
}
const docOf = () => ({
  createElement: (t: string) => new Node(t),
  createTextNode: (t: string) => { const n = new Node("#text"); n.textContent = t; return n; },
});
const respond = (status: number, body: unknown) => Promise.resolve({ status, json: () => Promise.resolve(body) });

// ─── P1 the Book door ──────────────────────────────────────────────────────────────────────────────────────────────

const quote = (party: number) => ({ priceCents: 15_000 * party, serviceFeeCents: 2_796 * party, buyerTotalCents: 17_796 * party - (party - 1), athleteReceivesCents: 15_000 * party, currency: "usd", unitPriceCents: 15_000, partySize: party });
const offerBase = {
  athleteFirstName: "Ava", format: "video_call", description: null, durationMinutes: 60, locationMode: "virtual",
  schedulingMode: "slots", freeCancelHours: 24, allowMinorAttendees: false, idCheckRequired: false, quote: quote(1),
  allInLine: "", maxProposedTimes: 3, available: true, supportEmail: "support@nomila.co",
};
const T = (h: number) => new Date(Date.UTC(2099, 0, 1, h)).toISOString();

function bookDoor(offersList: any[]) {
  const box = new Node("div");
  box.setAttribute("data-book", "");
  box.setAttribute("data-book-handle", "ava");
  const root = new Node("main"); root.appendChild(box);
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const sandbox: any = {
    document: { ...docOf(), readyState: "complete", querySelector: (s: string) => root.querySelector(s), addEventListener: () => {} },
    fetch: (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init?.method ?? "GET", url, body });
      if (url.includes("/cards/ava/offers")) return respond(200, { offers: offersList });
      const m = /quote\?party_size=(\d+)/.exec(url);
      if (m) return respond(200, { quote: quote(Number(m[1])) });
      if (url.endsWith("/requests")) return respond(201, { token: "tok", maskedEmail: "a•••@x.test" });
      return respond(404, {});
    },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    location: { href: "" }, setTimeout, Intl, Date, JSON, Number, String, Object, Array, Promise,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(read("server/public/p/book.js"), sandbox);
  return { box, calls };
}

describe("P1 the Book door", () => {
  it("an open group: per-person price, spots left per time, a full time shown but not bookable", async () => {
    const open = { ...offerBase, publicId: "og", title: "Film room", audience: "open_group", maxPeople: 10,
      slots: [{ id: "s1", startsAt: T(10), endsAt: T(11), spotsLeft: 3, capacity: 10 }], fullSlots: [{ id: "s0", startsAt: T(8), endsAt: T(9) }] };
    const one = { ...offerBase, publicId: "o1", title: "1:1 call", audience: "one", maxPeople: 1, slots: [{ id: "s9", startsAt: T(12), endsAt: T(13) }], fullSlots: [] };
    const { box } = bookDoor([open, one]);
    await flush();
    expect(box.allText()).toContain("Group · $177.96 per person");
    expect(box.allText()).toContain("$177.96");
    box.byText("Film room")!.fire("click");
    const times = box.all().filter((n) => n.tag === "button" && n.className.includes("pc-btn--wide"));
    expect(times).toHaveLength(2);
    expect(times[0].allText()).toContain("Full");
    expect(times[0].attrs).toHaveProperty("disabled");   // the attribute: a real browser never fires its click
    expect(times[1].allText()).toContain("3 of 10 spots left");
    times[0].fire("click");
    expect(box.allText()).not.toContain("Your name");          // a full time goes nowhere
    times[1].fire("click");
    expect(box.allText()).toContain("Your name");
    expect(box.byText("How many people?", "label")).toBeUndefined();   // an open group is one spot each
  });

  it("a private group: 'How many people?' re-prices live and sends that party and that exact total", async () => {
    const pg = { ...offerBase, publicId: "pg", title: "Team session", audience: "private_group", maxPeople: 4, slots: [{ id: "s1", startsAt: T(10), endsAt: T(11) }], fullSlots: [] };
    const { box, calls } = bookDoor([pg]);
    await flush();
    box.all().find((n) => n.tag === "button" && n.className.includes("pc-btn--wide"))!.fire("click");   // the one time
    const sel = box.all().find((n) => n.tag === "select")!;
    expect(sel.children.map((o) => o.textContent)).toEqual(["Just me", "2 people", "3 people", "4 people"]);
    expect(box.allText()).toContain("All-in for 1 person: $177.96.");
    sel.value = "3"; sel.fire("change");
    await flush();
    expect(calls.some((c) => c.url === "/api/v1/book/offers/pg/quote?party_size=3")).toBe(true);
    expect(box.allText()).toContain("All-in for 3 people: $533.86.");
    const inputs = box.all().filter((n) => n.tag === "input");
    inputs[0].value = "Riley Booker"; inputs[1].value = "riley@example.test";
    inputs.filter((i) => i.attrs.type === "checkbox").forEach((c) => { (c as any).checked = true; });
    box.byText("Email me a code")!.fire("click");
    await flush();
    const sent = calls.find((c) => c.url.endsWith("/offers/pg/requests"))!;
    expect(sent.body).toMatchObject({ party_size: 3, displayed_total_cents: 53_386, slot_id: "s1" });
  });
});

// ─── P2 the private page ───────────────────────────────────────────────────────────────────────────────────────────

const booked = (over: any = {}) => ({
  ref: "NB-1", status: "confirmed", phase: "booked", nextStep: "done", athleteFirstName: "Ava", title: "Team session", format: "video_call",
  locationMode: "virtual", startsAt: T(10), endsAt: T(11), proposedTimes: [], athleteProposedTimes: [], respondBy: null, payBy: null,
  quote: quote(3), freeCancelHours: 24, freeCancelUntil: T(9), venue: null, meetingLink: null, holdPlaced: false, charged: true,
  canceledBy: null, refundOutcome: null, noShowBy: null, athleteDoneAt: null, releaseDueAt: null, sessionUrl: "https://book.test/s/x",
  actions: { withdraw: false, cancel: true, pickTime: false, message: false, guests: true },
  audience: "private_group", partySize: 3, unitPriceCents: 15_000, groupSpots: null,
  guests: [{ id: "g1", name: "Sam", email: "sam@example.test", invitedAt: T(1) }], guestsLeft: 1, supportEmail: "support@nomila.co", ...over,
});

function statusPage(booking: any) {
  const view = new Node("div"); const foot = new Node("footer"); const ref = new Node("span");
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const ctx: any = {
    document: { ...docOf(), body: new Node("body"), getElementById: (id: string) => (id === "view" ? view : id === "ref" ? ref : foot) },
    location: { pathname: "/b/tok123", search: "", href: "", origin: "https://example.test" },
    history: { replaceState: () => undefined },
    sessionStorage: { getItem: (k: string) => (k.startsWith("nb-access:") ? "key" : null), setItem: () => {} },
    URLSearchParams,
    fetch: (url: string, init: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, url, body });
      if (url.endsWith("/guests") && init.method === "POST") return respond(201, { guests: [...booking.guests, { id: "g2", name: null, email: body.email, invitedAt: T(2) }] });
      if (/\/guests\/g1$/.test(url) && init.method === "DELETE") return respond(200, { guests: [] });
      return respond(200, { booking });
    },
    Date, Number, String, JSON, Promise, Math, setTimeout, clearTimeout,
  };
  vm.runInNewContext(read("server/public/booking-status.html").split(/<script[^>]*>/)[1].split("</script>")[0], ctx);
  return { view, calls };
}

describe("P2 the private booking page", () => {
  it("a private group: the party on the summary, 'Invite your friends', add and remove", async () => {
    const { view, calls } = statusPage(booked());
    await flush();
    const text = view.allText();
    expect(text).toContain("Group session · 3 people");
    expect(text).toContain("($150.00 × 3)");
    expect(text).toContain("Invite your friends");
    expect(text).toContain("Add up to 1 friend.");
    expect(text).toContain("sam@example.test");
    const email = view.all().find((n) => n.tag === "input" && n.attrs.type === "email")!;
    email.value = "kai@example.test";
    view.byText("Send them a link")!.fire("click");
    await flush();
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/guests"))!.body).toEqual({ email: "kai@example.test" });
    expect(view.allText()).toContain("kai@example.test");
    expect(view.allText()).toContain("Everyone in your group is added.");
    const rm = view.byText("Remove")!;
    rm.fire("click");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);   // asks twice
    rm.fire("click");
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/guests/g1"))).toBe(true);
  });

  it("an open group: 'You're in', the spot on the summary, no friends section", async () => {
    const { view } = statusPage(booked({ audience: "open_group", partySize: 1, groupSpots: 10, quote: quote(1), guests: [], guestsLeft: 0, actions: { withdraw: false, cancel: true, pickTime: false, message: false, guests: false } }));
    await flush();
    expect(view.allText()).toContain("You're in");
    expect(view.allText()).toContain("Group session · 1 of 10 spots");
    expect(view.allText()).not.toContain("Invite your friends");
  });

  it("a 1:1 booking reads as before", async () => {
    const { view } = statusPage(booked({ audience: "one", partySize: 1, quote: quote(1), guests: [], guestsLeft: 0, actions: { withdraw: false, cancel: true, pickTime: false, message: false, guests: false } }));
    await flush();
    expect(view.allText()).toContain("You're booked");
    expect(view.allText()).not.toContain("Group session");
    expect(view.allText()).not.toContain("×");
  });
});

// ─── P3 the call page ──────────────────────────────────────────────────────────────────────────────────────────────

function callPage(remotes: Array<{ identity: string; name: string }>, state: any = {}) {
  const html = read("server/public/booking-session.html");
  const script = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(html)![1];
  const els: Record<string, Node> = {};
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) els[m[1]] = new Node("div", m[1]);
  const track = (kind: string) => ({ kind, mediaStreamTrack: { enabled: true }, attach: () => new Node(kind), mute() {}, unmute() {}, stop() {}, restartTrack: () => Promise.resolve() });
  const participants = remotes.map((r) => ({ ...r, trackPublications: new Map([["v", { track: track("video"), isSubscribed: true }]]) }));
  class Room {
    remoteParticipants = new Map(participants.map((p) => [p.identity, p]));
    localParticipant = { publishTrack: () => Promise.resolve() };
    on() { return this; } connect() { return Promise.resolve(); } disconnect() {}
  }
  const s = {
    supportEmail: "support@nomila.co", serverNow: "2026-10-12T19:55:00Z", you: { role: "buyer" },
    booking: { athleteFirstName: "Ava", title: "Film room", startsAt: "2026-10-12T20:00:00Z", endsAt: "2099-10-12T20:30:00Z", durationMinutes: 30, status: "confirmed", audience: "open_group", groupSize: 10 },
    video: { mode: "livekit", joinState: "open", joinOpensAt: "2026-10-12T19:50:00Z", joinClosesAt: "2099-10-12T21:00:00Z", fallbackLink: null, athleteIdentity: "a_her" },
    after: { reportOpen: false, itHappenedAt: null, canSayItHappened: false, canReport: true }, ...state,
  };
  const sandbox: any = {
    document: { ...docOf(), getElementById: (id: string) => els[id] },
    location: { pathname: "/s/tok" },
    navigator: { mediaDevices: { enumerateDevices: () => Promise.resolve([{ kind: "videoinput" }]) } },
    fetch: (url: string) => respond(200, url.endsWith("/join") ? { wsUrl: "wss://lk.test", token: "t" } : s),
    LivekitClient: { createLocalTracks: () => Promise.resolve([track("audio"), track("video")]), Room, RoomEvent: {} },
    setInterval: () => 0, clearInterval: () => {}, addEventListener: () => {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox);
  return els;
}

describe("P3 the call page grid", () => {
  it("three or more: a tile each, hers first and marked, fans named 'Fan'", async () => {
    const els = callPage([{ identity: "b_1", name: "Fan" }, { identity: "a_her", name: "Ava" }, { identity: "b_2", name: "Fan" }]);
    await flush();
    els.check.fire("click"); await flush();
    els.join.fire("click"); await flush();
    const grid = els.grid;
    expect(grid.getAttribute("data-count")).toBe("3");
    expect(grid.classList.contains("many")).toBe(true);
    expect(grid.children).toHaveLength(3);
    expect(grid.children[0].className).toBe("tile lead");
    expect(grid.children.map((t) => t.children.find((c) => c.className === "name")!.textContent)).toEqual(["Ava", "Fan", "Fan"]);
    expect(grid.children.every((t) => t.children.some((c) => c.tag === "video"))).toBe(true);
    expect(els.waiting.hidden).toBe(true);
  });

  it("a 1:1: one tile fills the screen; nobody yet shows 'Waiting'", async () => {
    let els = callPage([{ identity: "a_her", name: "Ava" }], { booking: { athleteFirstName: "Ava", title: "Call", startsAt: "2026-10-12T20:00:00Z", endsAt: "2099-10-12T20:30:00Z", durationMinutes: 30, status: "confirmed", audience: "one", groupSize: 1 } });
    await flush(); els.check.fire("click"); await flush(); els.join.fire("click"); await flush();
    expect(els.grid.getAttribute("data-count")).toBe("1");
    expect(els.grid.classList.contains("many")).toBe(false);
    els = callPage([]);
    await flush(); els.check.fire("click"); await flush(); els.join.fire("click"); await flush();
    expect(els.grid.children).toHaveLength(0);
    expect(els.waiting.hidden).toBe(false);
    expect(els["waiting-title"].textContent).toBe("Waiting for Ava");
  });

  it("the grid styles: one fills, two side by side, three+ tile with hers full width; every tile shows the whole picture", () => {
    const css = /<style nonce="__NONCE__">([\s\S]*?)<\/style>/.exec(read("server/public/booking-session.html"))![1];
    expect(css).toMatch(/\.grid \{[^}]*display: grid;/);
    expect(css).toMatch(/\.grid\[data-count="2"\] \{ grid-template-columns: 1fr 1fr; \}/);
    expect(css).toMatch(/\.grid\.many \.tile\.lead \{ grid-column: 1 \/ -1; \}/);
    expect(css).toMatch(/\.tile video \{ object-fit: contain;/);
  });

  it("a friend (guest) has no money taps after the call", async () => {
    const els = callPage([], {
      you: { role: "guest" },
      booking: { athleteFirstName: "Ava", title: "Team session", startsAt: "2026-10-12T20:00:00Z", endsAt: "2026-10-12T20:30:00Z", durationMinutes: 30, status: "in_review", audience: "private_group", groupSize: 3 },
      serverNow: "2026-10-12T21:30:00Z", video: { mode: "livekit", joinState: "closed", joinOpensAt: null, joinClosesAt: null, fallbackLink: null, athleteIdentity: "a_her" },
      after: { reportOpen: false, itHappenedAt: null, canSayItHappened: false, canReport: false },
    });
    await flush();
    expect(els["af-title"].textContent).toBe("Thanks for joining");
    expect(els.happened.hidden).toBe(true);
    expect(els["open-report"].hidden).toBe(true);
  });
});
