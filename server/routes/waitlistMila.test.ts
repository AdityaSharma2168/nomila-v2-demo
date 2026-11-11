/**
 * waitlistMila.test.ts — the landing's Mila routes (MILA_TF_WAITLIST; docs/design/mila-hosted-waitlist.md).
 *
 *   flag off (prod)  GET says enabled false and POST /turn is 404: the landing runs today's screens, the turn never runs
 *   flag on          the turn runs for the TOKEN's athlete (never the body's), with the moment or her message; `done`
 *                    carries status and stopReason so the landing knows when to fall back; a failed turn still ends
 *                    with done { status: "failed" }
 *   input            no token ⇒ 401; neither or both of moment / message ⇒ 400; an unknown moment ⇒ 400; too long ⇒ 400;
 *                    a signed-in caller with no waitlist row ⇒ 404
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createWaitlistMilaRouter } from "./waitlistMila";
import { initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";

const ENV: Record<string, string> = {
  // The waitlist needs only its own flag (no engine switch, no /mcp, no TRUEFORGE_* settings).
  MILA_TF_WAITLIST: "true",
};
const saved: Record<string, string | undefined> = {};
const runTurn = jest.fn();
let server: Server;
let base = "";
let athleteId = "";

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  await initTestDb();
  athleteId = await seedAthlete("Rowan Vale", { auth_id: "uid-rowan", status: "waitlisted" } as any);
  const app = express();
  app.use(express.json());
  app.use("/api/v1/waitlist/mila", createWaitlistMilaRouter({
    verify: async (t) => { if (!t.startsWith("ok:")) throw Object.assign(new Error("bad"), { code: "auth/argument-error" }); return { uid: t.slice(3) }; },
    runTurn: runTurn as any,
  }));
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/waitlist/mila`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await closeTestDb();
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => { runTurn.mockReset(); process.env.MILA_TF_WAITLIST = "true"; });

const post = (body: unknown, token = "ok:uid-rowan") =>
  fetch(`${base}/turn`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
/** The SSE body's data lines, parsed. */
const events = async (r: Response) => (await r.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));

describe("flag off", () => {
  it("GET says disabled; POST /turn is 404 and never runs a turn", async () => {
    process.env.MILA_TF_WAITLIST = "false";
    const g = await fetch(base, { headers: { Authorization: "Bearer ok:uid-rowan" } });
    expect(await g.json()).toEqual({ enabled: false });
    expect((await post({ moment: "hello" })).status).toBe(404);
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("flag on", () => {
  it("GET says enabled", async () => {
    const g = await fetch(base, { headers: { Authorization: "Bearer ok:uid-rowan" } });
    expect(await g.json()).toEqual({ enabled: true });
  });

  it("a moment turn runs for the token's athlete and streams tokens then done with its status", async () => {
    runTurn.mockImplementation(async (p: any) => {
      p.sse.token("Hi Rowan.");
      p.sse.done({ runId: "run-1", cards: [{ id: "w", kind: "waitlist-card", title: "sport", payload: { card: "sport" }, links: [], runId: "run-1" }] });
      return { runId: "run-1", text: "Hi Rowan.", status: "completed", stopReason: null, cards: [], cost: {} };
    });
    const r = await post({ moment: "hello", athleteId: "someone-else" });
    expect(r.status).toBe(200);
    const ev = await events(r);
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ athleteId, moment: "hello", message: null }));
    expect(ev[0]).toEqual({ token: "Hi Rowan." });
    expect(ev[ev.length - 1]).toMatchObject({ done: true, runId: "run-1", status: "completed", stopReason: null, cards: [expect.objectContaining({ kind: "waitlist-card" })] });
  });

  it("a message turn passes her words; a failed turn still ends with done failed", async () => {
    runTurn.mockImplementation(async () => { throw new Error("TrueForge unreachable"); });
    const ev = await events(await post({ message: "  how long   does it take? " }));
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ moment: null, message: "how long does it take?" }));
    expect(ev[ev.length - 1]).toMatchObject({ done: true, status: "failed", stopReason: "error" });
  });

  it("refuses bad input and unknown callers", async () => {
    expect((await post({ moment: "hello" }, "bad")).status).toBe(401);
    expect((await post({})).status).toBe(400);
    expect((await post({ moment: "hello", message: "hi" })).status).toBe(400);
    expect((await post({ moment: "dance" })).status).toBe(400);
    expect((await post({ message: "x".repeat(1001) })).status).toBe(400);
    expect((await post({ moment: "hello" }, "ok:uid-nobody")).status).toBe(404);
    expect(runTurn).not.toHaveBeenCalled();
  });
});
