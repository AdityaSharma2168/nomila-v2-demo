/**
 * askMilaPublic.limiter.test.ts — the per-IP burst limiter is really mounted in front of every public Mila route (the
 * real express-rate-limit, not a stub): the 16th request in a minute is a 429 before any other check runs. The DB-backed
 * daily limits are in askMilaPublic.test.ts. No database or model is reached here.
 */
process.env.PUBLIC_CARD = "true";
process.env.ASK_MILA_PUBLIC = "true";
jest.mock("../db", () => ({ db: {} })); // never reached: every request stops at the limiter or the CSRF check
jest.mock("../mila/gemini", () => ({ streamMilaModel: jest.fn(() => { throw new Error("no model in this suite"); }) }));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAskMilaPublicRouter } from "./askMilaPublic";

let server: Server; let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createAskMilaPublicRouter());
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

it("the 16th request a minute from one IP is a 429, across the ask and tap routes", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 16; i++) {
    // no X-Nomila-Ask header: every request that passes the limiter stops at the CSRF check (403), before the DB
    const path = i % 2 ? "/p/some-card/ask" : "/p/some-card/ask/partner";
    statuses.push((await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status);
  }
  expect(statuses.slice(0, 15)).toEqual(Array(15).fill(403));
  expect(statuses[15]).toBe(429);
});
