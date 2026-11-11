/**
 * signupScoreEmail.test.ts — the waitlist's "your M.I.A. score is ready" email (signup_research v2, score_email step),
 * through the real template helper and the real sender; the Gmail API is a double (never reached).
 *
 *   E1 v2 is the default signup_research: the email step runs after the score, once per run
 *   E2 a ready score + a waitlisted athlete + EMAIL_PROVIDER=gmail ⇒ one email through the existing sender, her first
 *      name, the waitlist link, no score number in it
 *   E3 EMAIL_PROVIDER off (prod today) ⇒ nothing is sent (logged only), the step still finishes
 *   E4 no ready score (withheld, failed), already promoted, or no address ⇒ no email
 *   E5 outside production with no LANDING_URL ⇒ no email (dev mail never links to the prod landing); production
 *      defaults to nomila.co
 *   E6 a score still in flight ⇒ the step retries later (throws) and sends once the score lands; gives up quietly
 *      after SCORE_EMAIL_ATTEMPTS
 *   E7 readyEmailFrom: true only when the email will be (or was) sent
 *   E8 after a quick score she was shown (v3/v4): "your full M.I.A. score is ready"; no quick score shown ⇒ the original
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const gmailSend = jest.fn(async () => ({ sent: true, id: "m-1" }));
jest.mock("../../lib/gmailSender", () => ({ getGmailSender: () => ({ send: (...a: unknown[]) => (gmailSend as any)(...a) }) }));
jest.mock("../../services/miaPreview/preview", () => ({ getMiaPreview: jest.fn(), readMiaPreview: jest.fn() }));
jest.setTimeout(120_000);

import { closeTestDb, initTestDb, seedAthlete } from "../../testUtils/pgliteDb";
import { getDefinition } from "../../workflow/registry";
import { SCORE_EMAIL_ATTEMPTS, SCORE_EMAIL_STEP } from "./signupResearchWorkflow";
import { readyEmailFrom } from "./waitlistProgress";
import { readMiaPreview } from "../../services/miaPreview/preview";

const env = process.env;
const ctx = (athleteId: string, mia: Record<string, unknown> | undefined, attempt = 1) => ({ runId: "wf-1", athleteId, runInput: {}, outputs: mia ? { mia_preview: mia } : {}, attempt }) as any;
const READY = { status: "ready", computed: "evaluated", score: 512, preliminary: true };

beforeAll(async () => { await initTestDb(); });
afterAll(async () => { process.env = env; await closeTestDb(); });
beforeEach(() => { process.env = { ...env, EMAIL_PROVIDER: "gmail", LANDING_URL: "https://landing.example.com" }; gmailSend.mockClear(); });

test("E1: v2 is the default signup_research; the email follows the score", () => {
  expect(getDefinition("signup_research").version).toBe(2);
  expect(getDefinition("signup_research").steps.map((s) => `${s.ordinal}:${s.name}`)).toEqual(["0:research_a", "0:research_b", "1:research_merge", "2:mia_preview", "3:score_email"]);
  expect(getDefinition("signup_research", 1).steps.map((s) => s.name)).not.toContain("score_email");   // v1 runs keep v1
});

test("E2: a ready score for a waitlisted athlete sends one email through the existing sender", async () => {
  const id = await seedAthlete("Avery Example", { status: "waitlisted", email: "avery@example.com", first_name: "Avery" } as any);
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, READY))).toEqual({ sent: true });
  expect(gmailSend).toHaveBeenCalledTimes(1);
  const msg = (gmailSend.mock.calls[0] as any)[0];
  expect(msg).toMatchObject({ to: "avery@example.com", subject: "Your M.I.A. score is ready" });
  expect(msg.text).toContain("Hi Avery,");
  expect(msg.text).toContain("https://landing.example.com/?go=score");             // the landing opens her score once she signs in
  expect(msg.text).not.toContain("512");                                                         // the score is shown only on her page
});

test("E3: EMAIL_PROVIDER off ⇒ nothing is sent, the step still finishes", async () => {
  process.env.EMAIL_PROVIDER = "off";
  const id = await seedAthlete("Off Example", { status: "waitlisted", email: "off@example.com" } as any);
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, READY))).toEqual({ sent: false, skipped: true, reason: "email_off" });
  delete process.env.EMAIL_PROVIDER;
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, READY))).toMatchObject({ sent: false, skipped: true });
  expect(gmailSend).not.toHaveBeenCalled();
});

test("E4: no ready score, promoted, or no address ⇒ no email", async () => {
  const id = await seedAthlete("Edge Example", { status: "waitlisted", email: "edge@example.com" } as any);
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, { status: "withheld_identity", score: null }))).toEqual({ sent: false, reason: "no_score" });
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, { status: "failed", error: "x" }))).toEqual({ sent: false, reason: "no_score" });
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, undefined))).toEqual({ sent: false, reason: "no_score" });
  const promoted = await seedAthlete("Promoted Example", { status: "active", email: "p@example.com" } as any);
  expect(await SCORE_EMAIL_STEP.run!(ctx(promoted, READY))).toEqual({ sent: false, reason: "not_waitlisted" });
  const noEmail = await seedAthlete("No Email", { status: "waitlisted" } as any);
  expect(await SCORE_EMAIL_STEP.run!(ctx(noEmail, READY))).toEqual({ sent: false, reason: "no_email" });
  expect(gmailSend).not.toHaveBeenCalled();
});

test("E5: outside production with no LANDING_URL nothing is sent; production defaults to nomila.co", async () => {
  delete process.env.LANDING_URL;
  process.env.API_BASE_URL = "https://api-dev.nomila.co";
  const id = await seedAthlete("Dev Example", { status: "waitlisted", email: "dev@example.com" } as any);
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, READY))).toEqual({ sent: false, skipped: true, reason: "no_landing_url" });
  expect(gmailSend).not.toHaveBeenCalled();
  process.env.API_BASE_URL = "https://api.nomila.co";
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, READY))).toEqual({ sent: true });
  expect((gmailSend.mock.calls[0] as any)[0].text).toContain("https://nomila.co/?go=score");
});

test("E6: a score still in flight is looked up again later, and the email goes once it lands", async () => {
  const id = await seedAthlete("Slow Score", { status: "waitlisted", email: "slow@example.com", first_name: "Slow" } as any);
  const inFlight = { status: "not_assessed", computed: "in_flight", score: null };
  (readMiaPreview as jest.Mock).mockResolvedValue({ status: "not_assessed", score: null });
  await expect(SCORE_EMAIL_STEP.run!(ctx(id, inFlight, 1))).rejects.toThrow(/still being computed/);   // the runner retries it
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, inFlight, SCORE_EMAIL_ATTEMPTS))).toEqual({ sent: false, reason: "score_not_ready" });
  expect(gmailSend).not.toHaveBeenCalled();
  (readMiaPreview as jest.Mock).mockResolvedValue({ status: "ready", score: 480 });
  expect(await SCORE_EMAIL_STEP.run!(ctx(id, inFlight, 2))).toEqual({ sent: true });
  expect(gmailSend).toHaveBeenCalledTimes(1);
  expect(SCORE_EMAIL_STEP.retry).toMatchObject({ maxAttempts: SCORE_EMAIL_ATTEMPTS });
});

test("E7: readyEmail is true only when the email will be (or was) sent", () => {
  const run = { process: "signup_research", definition_version: 2, status: "running" };
  const me = { email: "a@example.com", status: "waitlisted" };
  expect(readyEmailFrom(run, [], me, true)).toBe(true);
  expect(readyEmailFrom(run, [{ step: "score_email", status: "done", output: { sent: true } }], me, true)).toBe(true);
  expect(readyEmailFrom(run, [{ step: "score_email", status: "done", output: { sent: false, reason: "no_score" } }], me, true)).toBe(false);
  expect(readyEmailFrom(run, [], me, false)).toBe(false);                                       // delivery off / no landing link
  expect(readyEmailFrom({ ...run, definition_version: 1 }, [], me, true)).toBe(false);          // no email step
  expect(readyEmailFrom({ ...run, status: "canceled" }, [], me, true)).toBe(false);
  expect(readyEmailFrom({ ...run, process: "agent_onboarding" }, [], me, true)).toBe(false);
  expect(readyEmailFrom(run, [], { ...me, email: null }, true)).toBe(false);
  expect(readyEmailFrom(run, [], { ...me, status: "active" }, true)).toBe(false);
  expect(readyEmailFrom(null, [], me, true)).toBe(false);
});

test("E8: after a quick score she saw (v3/v4), the email says her FULL score is ready; otherwise unchanged", async () => {
  const QUICK = { status: "ready", score: 455, confidence: "low", low_confidence: true, reasons: ["A quick read."], dimensions: [] };
  const withQuick = (athleteId: string, quick: unknown) => ({ ...ctx(athleteId, READY), outputs: { mia_preview: READY, quick_score: quick } });
  const id = await seedAthlete("Quick Then Full", { status: "waitlisted", email: "qf@example.com", first_name: "Quinn" } as any);
  expect(await SCORE_EMAIL_STEP.run!(withQuick(id, QUICK))).toEqual({ sent: true, template: "full_score_ready" });
  const msg = (gmailSend.mock.calls[0] as any)[0];
  expect(msg).toMatchObject({ to: "qf@example.com", subject: "Your full M.I.A. score is ready" });
  expect(msg.text).toContain("Hi Quinn,");
  expect(msg.text).toContain("It replaces the preliminary score you saw when you joined.");
  expect(`${msg.subject} ${msg.text} ${msg.html ?? ""}`).not.toMatch(/quick/i);
  expect(msg.text).toContain("https://landing.example.com/?go=score");
  expect(msg.text).not.toContain("455");
  expect(msg.text).not.toContain("512");

  // No quick score shown (a fallback, the step off, or no step): the original email, word for word.
  gmailSend.mockClear();
  for (const q of [{ status: "fallback", reason: "parse" }, { status: "off", reason: "flag_off" }, undefined]) {
    expect(await SCORE_EMAIL_STEP.run!(withQuick(id, q))).toEqual({ sent: true });
  }
  expect(gmailSend.mock.calls.map((c: any) => c[0].subject)).toEqual(Array(3).fill("Your M.I.A. score is ready"));
});
