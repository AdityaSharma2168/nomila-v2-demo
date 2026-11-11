/**
 * meRates.test.ts — GET/PUT /me/rates over HTTP, against PGlite (auth mocked: the athlete is the token's). Her own rows
 * only; an invalid write is a 400 with the problems and writes nothing. No provider is reachable from this route.
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
jest.mock("../lib/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.athleteId = (globalThis as any).__TEST_ATHLETE_ID; next(); },
}));

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { athletes } from "../../shared/schema";
import { db, initTestDb, closeTestDb, seedAthlete } from "../testUtils/pgliteDb";
import meRatesRouter from "./meRates";

let server: Server;
let base: string;
let her = "";

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: res.status === 404 ? null : await res.json() };
}

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete();
  (globalThis as any).__TEST_ATHLETE_ID = her;
  const app = express();
  app.use(express.json());
  app.use("/api/v1/me", meRatesRouter);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/me`;
});
afterAll(async () => { server.close(); await closeTestDb(); });

it("GET lists every rate type; PUT writes her minimum; a bad row is a 400 with its problem", async () => {
  const got = await api("GET", "/rates");
  expect(got.status).toBe(200);
  expect(got.body.rows).toHaveLength(17);
  expect(got.body.bookings_enabled).toBe(false);

  const put = await api("PUT", "/rates", { minimums: { ig_reel: 400 } });
  expect(put.status).toBe(200);
  expect(put.body.rows.find((r: any) => r.rate_type === "ig_reel").minimum).toEqual({ value: 400, source: "set" });

  const bad = await api("PUT", "/rates", { minimums: { ig_post: "lots" } });
  expect(bad.status).toBe(400);
  expect(bad.body.problems).toEqual([{ rate_type: "ig_post", field: "minimum", problem: "a dollar amount above zero" }]);
});
