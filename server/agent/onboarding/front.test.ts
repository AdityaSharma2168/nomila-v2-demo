/**
 * front.test.ts — the onboarding front's public read (GET /api/v1/public/onboarding-front), with the library and the
 * signer injected (no database, no storage reached):
 *   F1 AGENT_ONBOARDING off ⇒ { agentOnboarding: false }, no photos, the library never read
 *   F2 on ⇒ the library's sign-in photos (capped), cached for FRONT_CACHE_MS
 *   F3 the library failing (not there yet, storage down) ⇒ still on, no photos (the app draws the dark ground)
 *   F4 emailSignIn: true only with EMAIL_CODE_SIGNIN on, EMAIL_CODE_SECRET set and email delivery on; read per request
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FRONT_CACHE_MS, MAX_SIGNIN_PHOTOS, onboardingFrontRouter, resetFrontCache, type FrontDeps } from "./front";

let server: Server | null = null;
let base = "";
let clock = 1_000_000;
const reads = jest.fn<Promise<Array<{ id: string; url: string }>>, [number]>();
const deps: FrontDeps = { signinPhotos: (n) => reads(n), now: () => clock };

beforeAll(async () => {
  const app = express();
  app.use("/api/v1/public", onboardingFrontRouter(deps));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server?.close(r)); });
const EMAIL_KEYS = ["EMAIL_CODE_SIGNIN", "EMAIL_CODE_SECRET", "EMAIL_PROVIDER"] as const;
const savedEmail = Object.fromEntries(EMAIL_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => { resetFrontCache(); reads.mockReset(); delete process.env.AGENT_ONBOARDING; for (const k of EMAIL_KEYS) delete process.env[k]; });
afterAll(() => { for (const k of EMAIL_KEYS) { if (savedEmail[k] === undefined) delete process.env[k]; else process.env[k] = savedEmail[k]; } });

const get = async () => (await fetch(`${base}/api/v1/public/onboarding-front`)).json();

test("F1: with AGENT_ONBOARDING off the front is off and the library is never read", async () => {
  expect(await get()).toEqual({ agentOnboarding: false, signinPhotos: [], emailSignIn: false });
  process.env.AGENT_ONBOARDING = "false";
  expect(await get()).toEqual({ agentOnboarding: false, signinPhotos: [], emailSignIn: false });
  expect(reads).not.toHaveBeenCalled();
});

test("F2: on, the sign-in photos come back capped, and one answer is reused for a while", async () => {
  process.env.AGENT_ONBOARDING = "true";
  const many = Array.from({ length: MAX_SIGNIN_PHOTOS + 3 }, (_, i) => ({ id: `p${i}`, url: `https://storage.example/p${i}.webp?sig` }));
  reads.mockResolvedValue(many);
  const a = await get();
  expect(a.agentOnboarding).toBe(true);
  expect(a.signinPhotos).toHaveLength(MAX_SIGNIN_PHOTOS);
  expect(reads).toHaveBeenCalledWith(MAX_SIGNIN_PHOTOS);
  await get();
  expect(reads).toHaveBeenCalledTimes(1);
  clock += FRONT_CACHE_MS + 1;
  await get();
  expect(reads).toHaveBeenCalledTimes(2);
});

test("F3: the library failing keeps the front on with no photos", async () => {
  process.env.AGENT_ONBOARDING = "true";
  reads.mockRejectedValue(new Error('relation "atmosphere_library" does not exist'));
  expect(await get()).toEqual({ agentOnboarding: true, signinPhotos: [], emailSignIn: false });
});

test("F4: emailSignIn needs the switch, the secret and email delivery, follows them per request, and never shows with the front off", async () => {
  reads.mockResolvedValue([]);
  process.env.EMAIL_CODE_SIGNIN = "true"; process.env.EMAIL_CODE_SECRET = "test-secret"; process.env.EMAIL_PROVIDER = "gmail";
  expect((await get()).emailSignIn).toBe(false);   // AGENT_ONBOARDING off
  process.env.AGENT_ONBOARDING = "true";
  expect((await get()).emailSignIn).toBe(true);
  process.env.EMAIL_PROVIDER = "off";               // cached photos, but the switch is read again
  expect((await get()).emailSignIn).toBe(false);
  process.env.EMAIL_PROVIDER = "gmail"; delete process.env.EMAIL_CODE_SECRET;
  expect((await get()).emailSignIn).toBe(false);
  process.env.EMAIL_CODE_SECRET = "test-secret"; process.env.EMAIL_CODE_SIGNIN = "TRUE";
  expect((await get()).emailSignIn).toBe(false);
});

