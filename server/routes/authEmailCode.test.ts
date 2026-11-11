/**
 * authEmailCode.test.ts — sign in with a 6-digit email code, end to end over the routes on a PGlite database. The Gmail
 * sender (lib/notify sendEmail) and Firebase Admin are mocked: nothing here reaches a provider.
 *
 *   E1  the switch: 404 unless EMAIL_CODE_SIGNIN is exactly "true"; the yamls pin it on in dev and prod (each with
 *       its own secret mounted: EMAIL_CODE_SECRET / EMAIL_CODE_SECRET_PROD)
 *   E2  /start refuses LOUDLY (503) when it cannot send: delivery off, the secret missing, or the send failing — and
 *       never leaves a code behind
 *   E3  a code: emailed with the code in the subject, stored only as HMACs, signs a NEW address in as a verified
 *       Firebase user, and works once
 *   E4  the same address used with Google before lands in that same Firebase user; /start answers the same either way
 *   E5  5 tries: wrong codes count down, the fifth locks the code, even the right code is refused after that
 *   E6  expiry (10 minutes) and "only the newest code works"
 *   E7  limits: one code a minute and five an hour per address, a fleet-wide count per IP; old rows are purged
 *   E8  Firebase edge cases: a disabled user is refused; an UNVERIFIED account (password, phone, Microsoft, or nothing
 *       at all) has every provider unlinked, its password replaced and its sessions revoked (pre-hijack); a Firebase
 *       failure does not spend the code
 *   E9  abuse: three locked codes in 24 h => no new code for 24 h; the service-wide hourly / daily caps (ALERT, 503)
 *   E10 the app-review login: one address, a fixed code, nothing emailed; every other address and every limit unchanged
 */
jest.mock("../db", () => require("../testUtils/pgliteDb"));
const mockLogError = jest.fn();
jest.mock("../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: (...a: unknown[]) => mockLogError(...a), debug: () => {} }), logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
const sendEmail = jest.fn();
jest.mock("../lib/notify", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
const fb = {
  getUserByEmail:      jest.fn(),
  createUser:          jest.fn(),
  updateUser:          jest.fn(),
  revokeRefreshTokens: jest.fn(),
  createCustomToken:   jest.fn(),
};
const forgetRevocationState = jest.fn();
jest.mock("../lib/auth", () => ({ firebaseAuth: new Proxy({}, { get: (_t, k: string) => (fb as any)[k] }), forgetRevocationState: (u: string) => forgetRevocationState(u) }));
jest.setTimeout(180_000);

import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { eq } from "drizzle-orm";
import { db, initTestDb, closeTestDb } from "../testUtils/pgliteDb";
import { emailSigninCodes } from "../../shared/schema";
import { authEmailCodeRouter, purgeEmailSigninCodes } from "./authEmailCode";
import { trustProxyHops } from "../lib/trustProxy";
import { EMAIL_CODE, PASSWORD_NOTICE, emailHmac, ipHmac } from "../lib/emailCode";

let server: Server; let base = "";
const KEYS = ["EMAIL_CODE_SIGNIN", "EMAIL_CODE_SECRET", "EMAIL_PROVIDER", "REVIEW_LOGIN_EMAIL", "REVIEW_LOGIN_CODE"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let ipSeq = 0;
let ip = "";

const post = async (path: string, body: unknown, from = ip) => {
  // As Cloud Run's front end forwards it: a value the client wrote, then the address it saw (the app trusts one hop).
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.9.9.9, ${from}` }, body: JSON.stringify(body) });
  const txt = await r.text();
  let json: any = {}; try { json = JSON.parse(txt); } catch { /* not json */ }
  return { status: r.status, json };
};
const start = (email: string, from?: string) => post("/start", { email }, from);
const verify = (email: string, code: string) => post("/verify", { email, code });
/** The code from the last email's subject ("482913 is your Nomila code"). */
const lastCode = (): string => {
  const subject: string = sendEmail.mock.calls.at(-1)![0].subject;
  expect(subject).toMatch(/^\d{6} is your Nomila code$/);
  return subject.slice(0, 6);
};
const rowsFor = (email: string) => db.select().from(emailSigninCodes).where(eq(emailSigninCodes.email_hmac, emailHmac(email)));
/** Move every code for an address back in time (so the minute gap, the hour window or the expiry has passed). */
const age = async (email: string, ms: number) => {
  for (const r of await rowsFor(email)) {
    await db.update(emailSigninCodes).set({ created_at: new Date(r.created_at.getTime() - ms), expires_at: new Date(r.expires_at.getTime() - ms) }).where(eq(emailSigninCodes.id, r.id));
  }
};
const notFound = () => Object.assign(new Error("no user"), { code: "auth/user-not-found" });
const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

beforeAll(async () => {
  await initTestDb();
  // Trust exactly what server/index.ts trusts (lib/trustProxy.ts: one hop, Cloud Run's front end).
  const app = express(); app.set("trust proxy", trustProxyHops()); app.use(express.json()); app.use("/", authEmailCodeRouter());
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await new Promise<void>((r) => server.close(() => r())); await closeTestDb();
});
beforeEach(() => {
  process.env.EMAIL_CODE_SIGNIN = "true"; process.env.EMAIL_CODE_SECRET = "test-only-email-code-secret"; process.env.EMAIL_PROVIDER = "gmail";
  delete process.env.REVIEW_LOGIN_EMAIL; delete process.env.REVIEW_LOGIN_CODE;
  ip = `203.0.113.${++ipSeq}`;   // each test its own IP, so the per-instance limiter never leaks between tests
  sendEmail.mockReset().mockResolvedValue({ sent: true, id: "m1" });
  for (const f of Object.values(fb)) f.mockReset();
  fb.getUserByEmail.mockRejectedValue(notFound());
  fb.createUser.mockImplementation(async ({ email }: { email: string }) => ({ uid: `new:${email}`, email, emailVerified: true, disabled: false, providerData: [] }));
  fb.createCustomToken.mockImplementation(async (uid: string) => `token-for:${uid}`);
  forgetRevocationState.mockReset();
});
afterEach(async () => { await db.delete(emailSigninCodes); });   // each test starts with no codes (the global caps count them all)

describe("E1 the switch", () => {
  it("answers 404 on both routes unless EMAIL_CODE_SIGNIN is exactly \"true\"", async () => {
    for (const v of [undefined, "false", "TRUE", "1"]) {
      if (v === undefined) delete process.env.EMAIL_CODE_SIGNIN; else process.env.EMAIL_CODE_SIGNIN = v;
      expect((await start("a@example.com")).status).toBe(404);
      expect((await verify("a@example.com", "123456")).status).toBe(404);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  const envOf = (file: string) => parse(readFileSync(join(__dirname, "..", "..", "gcp", file), "utf8")).spec.template.spec.containers[0].env as Array<{ name: string; value?: string; valueFrom?: unknown }>;
  it("dev and prod pin it on, each with its own EMAIL_CODE_SECRET from Secret Manager (prod: EMAIL_CODE_SECRET_PROD)", () => {
    const dev = envOf("cloud-run-dev.yaml"); const prod = envOf("cloud-run-prod.yaml");
    expect(dev.filter((e) => e.name === "EMAIL_CODE_SIGNIN")).toEqual([{ name: "EMAIL_CODE_SIGNIN", value: "true" }]);
    expect(dev.filter((e) => e.name === "EMAIL_CODE_SECRET")).toEqual([{ name: "EMAIL_CODE_SECRET", valueFrom: { secretKeyRef: { name: "EMAIL_CODE_SECRET", key: "latest" } } }]);
    expect(prod.filter((e) => e.name === "EMAIL_CODE_SIGNIN")).toEqual([{ name: "EMAIL_CODE_SIGNIN", value: "true" }]);
    expect(prod.filter((e) => e.name === "EMAIL_CODE_SECRET")).toEqual([{ name: "EMAIL_CODE_SECRET", valueFrom: { secretKeyRef: { name: "EMAIL_CODE_SECRET_PROD", key: "latest" } } }]);
    expect(prod.filter((e) => e.name === "EMAIL_PROVIDER")).toEqual([{ name: "EMAIL_PROVIDER", value: "gmail" }]);   // the code needs delivery
  });
});

describe("E2 never says sent when nothing was sent", () => {
  it("delivery off ⇒ 503 email_unavailable, no email attempted, no code stored", async () => {
    process.env.EMAIL_PROVIDER = "off";
    expect(await start("off@example.com")).toEqual({ status: 503, json: { error: "email_unavailable" } });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await rowsFor("off@example.com")).toEqual([]);
  });

  it("no EMAIL_CODE_SECRET ⇒ 503 on both routes (there is no fallback key)", async () => {
    delete process.env.EMAIL_CODE_SECRET;
    expect(await start("nokey@example.com")).toEqual({ status: 503, json: { error: "email_unavailable" } });
    expect((await verify("nokey@example.com", "123456")).status).toBe(503);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a failed send ⇒ 503 send_failed and the code is withdrawn; a skipped send ⇒ email_unavailable", async () => {
    sendEmail.mockResolvedValueOnce({ sent: false, error: "unauthorized_client" });
    expect(await start("fail@example.com")).toEqual({ status: 503, json: { error: "send_failed" } });
    expect(await rowsFor("fail@example.com")).toEqual([]);
    sendEmail.mockResolvedValueOnce({ sent: false, skipped: true });
    expect(await start("fail@example.com")).toEqual({ status: 503, json: { error: "email_unavailable" } });
    expect(await rowsFor("fail@example.com")).toEqual([]);
  });

  it("an address that is not one ⇒ 400 invalid_email, nothing sent", async () => {
    for (const bad of ["", "jordan.lee@gmail", "no-at.example.com", "a b@example.com", 42, null]) {
      expect(await post("/start", { email: bad })).toEqual({ status: 400, json: { error: "invalid_email" } });
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("E3 a code", () => {
  it("is emailed with the code in the subject, stored only as HMACs, signs a new address in verified, and works once", async () => {
    const r = await start("  Jordan.Lee@Example.com ");
    expect(r).toEqual({ status: 202, json: { resendAfterSec: 60 } });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    const code = lastCode();
    expect(mail.to).toBe("jordan.lee@example.com");
    expect(mail.text).toContain(`Your Nomila sign-in code is ${code}. It works for 10 minutes.`);
    expect(mail.html).toContain(code);
    expect(mail.text).toContain(PASSWORD_NOTICE); expect(mail.html).toContain(PASSWORD_NOTICE);
    expect(PASSWORD_NOTICE).toContain("signing in with a code replaces the password on this account");

    const rows = await rowsFor("jordan.lee@example.com");
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain("jordan"); expect(stored).not.toContain("example.com"); expect(stored).not.toContain(code); expect(stored).not.toContain(ip);
    expect(rows[0]).toMatchObject({ attempts: 0, consumed_at: null, ip_hmac: ipHmac(ip) });
    expect(rows[0].expires_at.getTime() - rows[0].created_at.getTime()).toBe(EMAIL_CODE.ttlMs);

    const v = await verify("JORDAN.LEE@example.com", ` ${code} `);
    expect(v).toEqual({ status: 200, json: { customToken: "token-for:new:jordan.lee@example.com" } });
    expect(fb.createUser).toHaveBeenCalledWith({ email: "jordan.lee@example.com", emailVerified: true });
    expect(fb.createCustomToken).toHaveBeenCalledWith("new:jordan.lee@example.com");   // no roles claim: /signup sets it
    expect(fb.createCustomToken.mock.calls[0]).toHaveLength(1);

    expect(await verify("jordan.lee@example.com", code)).toEqual({ status: 410, json: { error: "expired" } });
    expect(fb.createCustomToken).toHaveBeenCalledTimes(1);
  });

  it("a code that is not 6 digits is refused without spending a try", async () => {
    await start("shape@example.com");
    for (const bad of ["12345", "1234567", "abcdef", 123456]) {
      expect(await verify("shape@example.com", bad as any)).toEqual({ status: 400, json: { error: "invalid_code" } });
    }
    expect((await rowsFor("shape@example.com"))[0].attempts).toBe(0);
  });
});

describe("E4 one account per email", () => {
  it("an address used with Google before signs into that same Firebase user", async () => {
    fb.getUserByEmail.mockResolvedValue({ uid: "google-uid-1", email: "g@example.com", emailVerified: true, disabled: false, providerData: [{ providerId: "google.com" }] });
    await start("g@example.com");
    expect(await verify("g@example.com", lastCode())).toEqual({ status: 200, json: { customToken: "token-for:google-uid-1" } });
    expect(fb.createUser).not.toHaveBeenCalled();
    expect(fb.updateUser).not.toHaveBeenCalled();
  });

  it("/start answers the same for a known and an unknown address and never looks the account up", async () => {
    fb.getUserByEmail.mockImplementation(async (e: string) => {
      if (e === "known@example.com") return { uid: "k", emailVerified: true, disabled: false, providerData: [] };
      throw notFound();
    });
    const known = await start("known@example.com");
    const unknown = await start("unknown@example.com");
    expect(known).toEqual(unknown);
    expect(fb.getUserByEmail).not.toHaveBeenCalled();
  });
});

describe("E5 five tries", () => {
  it("counts down, locks on the fifth wrong try, and then refuses even the right code", async () => {
    await start("tries@example.com");
    const code = lastCode(); const wrong = wrongOf(code);
    for (const left of [4, 3, 2, 1]) expect(await verify("tries@example.com", wrong)).toEqual({ status: 400, json: { error: "wrong_code", triesLeft: left } });
    expect(await verify("tries@example.com", wrong)).toEqual({ status: 423, json: { error: "locked" } });
    expect(await verify("tries@example.com", code)).toEqual({ status: 423, json: { error: "locked" } });
    expect(fb.createCustomToken).not.toHaveBeenCalled();
  });

  it("parallel guesses cannot spend more than five tries", async () => {
    await start("burst@example.com");
    const code = lastCode();
    const guesses = Array.from({ length: 12 }, (_, i) => wrongOf(String((Number(code) + i) % 1_000_000).padStart(6, "0")));
    await Promise.all(guesses.map((g) => verify("burst@example.com", g)));
    expect((await rowsFor("burst@example.com"))[0].attempts).toBe(EMAIL_CODE.maxAttempts);
  });
});

describe("E6 expiry and the newest code", () => {
  it("a code older than 10 minutes is expired", async () => {
    await start("late@example.com");
    const code = lastCode();
    await age("late@example.com", EMAIL_CODE.ttlMs + 1000);
    expect(await verify("late@example.com", code)).toEqual({ status: 410, json: { error: "expired" } });
  });

  it("no code at all ⇒ expired (send a new one)", async () => {
    expect(await verify("never@example.com", "123456")).toEqual({ status: 410, json: { error: "expired" } });
  });

  it("a newer code replaces the older one", async () => {
    await start("two@example.com");
    const first = lastCode();
    await age("two@example.com", 2 * 60 * 1000);   // past the one-a-minute gap, still inside 10 minutes
    await start("two@example.com");
    const second = lastCode();
    if (first !== second) expect((await verify("two@example.com", first)).json.error).toBe("wrong_code");
    expect((await verify("two@example.com", second)).status).toBe(200);
  });
});

describe("E7 limits", () => {
  it("one code a minute per address: the second ask is 429 too_soon and the first code still works", async () => {
    await start("gap@example.com");
    const code = lastCode();
    const again = await start("gap@example.com");
    expect(again.status).toBe(429); expect(again.json.error).toBe("too_soon");
    expect(again.json.retryAfterSec).toBeGreaterThan(0); expect(again.json.retryAfterSec).toBeLessThanOrEqual(60);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await verify("gap@example.com", code)).status).toBe(200);
  });

  it("five codes an hour per address: the sixth is 429 too_many with the wait until one ages out", async () => {
    for (let i = 0; i < 5; i++) { expect((await start("hour@example.com")).status).toBe(202); await age("hour@example.com", 2 * 60 * 1000); }
    const r = await start("hour@example.com");
    expect(r.status).toBe(429); expect(r.json.error).toBe("too_many");
    // the oldest of the five was made 10 minutes ago ⇒ about 50 minutes to wait
    expect(r.json.retryAfterSec).toBeGreaterThan(49 * 60); expect(r.json.retryAfterSec).toBeLessThanOrEqual(50 * 60);
    expect(sendEmail).toHaveBeenCalledTimes(5);
  });

  it("per IP across every instance: once this IP has had its codes for the hour, a new address is refused too", async () => {
    const now = Date.now();
    await db.insert(emailSigninCodes).values(Array.from({ length: EMAIL_CODE.perIpHour }, (_, i) => ({
      email_hmac: emailHmac(`other${i}@example.com`), code_hmac: "00", ip_hmac: ipHmac(ip),
      created_at: new Date(now - 5 * 60 * 1000), expires_at: new Date(now + 5 * 60 * 1000),
    })));
    const r = await start("fresh@example.com");
    expect(r.status).toBe(429); expect(r.json.error).toBe("too_many");
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await start("fresh@example.com", "198.51.100.7")).status).toBe(202);
  });

  it("rows past the keep window (two days) are purged after a send and by the cron's purge; younger ones stay", async () => {
    expect(EMAIL_CODE.keepMs).toBe(48 * 3600 * 1000);
    const old = new Date(Date.now() - EMAIL_CODE.keepMs - 60_000);
    const young = new Date(Date.now() - EMAIL_CODE.keepMs + 3600_000);
    await db.insert(emailSigninCodes).values({ email_hmac: emailHmac("old@example.com"), code_hmac: "00", ip_hmac: "00", created_at: old, expires_at: old });
    await start("purge@example.com");
    await new Promise((r) => setTimeout(r, 200));
    expect(await rowsFor("old@example.com")).toEqual([]);
    await db.insert(emailSigninCodes).values([
      { email_hmac: emailHmac("old2@example.com"), code_hmac: "00", ip_hmac: "00", created_at: old, expires_at: old },
      { email_hmac: emailHmac("young@example.com"), code_hmac: "00", ip_hmac: "00", created_at: young, expires_at: young },
    ]);
    expect(await purgeEmailSigninCodes()).toBe(1);
    expect(await rowsFor("young@example.com")).toHaveLength(1);
  });

  it("the purge cron is declared in provision-schedulers.sh and served by index.ts", () => {
    const root = join(__dirname, "..", "..");
    expect(readFileSync(join(root, "scripts", "provision-schedulers.sh"), "utf8")).toContain('"email-code-purge-cron|35 * * * *|/api/internal/email-code-purge-cron|60s"');
    expect(readFileSync(join(root, "server", "index.ts"), "utf8")).toContain('app.post("/api/internal/email-code-purge-cron"');
  });
});

describe("E8 Firebase edge cases", () => {
  it("a disabled Firebase user is refused (403) and gets no token", async () => {
    fb.getUserByEmail.mockResolvedValue({ uid: "off-uid", emailVerified: true, disabled: true, providerData: [] });
    await start("disabled@example.com");
    expect(await verify("disabled@example.com", lastCode())).toEqual({ status: 403, json: { error: "account_disabled" } });
    expect(fb.createCustomToken).not.toHaveBeenCalled();
  });

  const securedWith = async (uid: string, providerData: Array<{ providerId: string }>, email: string) => {
    fb.getUserByEmail.mockResolvedValue({ uid, emailVerified: false, disabled: false, providerData });
    await start(email);
    expect((await verify(email, lastCode())).json).toEqual({ customToken: `token-for:${uid}` });
    expect(fb.updateUser).toHaveBeenCalledTimes(1);
    const [who, update] = fb.updateUser.mock.calls[0];
    expect(who).toBe(uid);
    expect(update.emailVerified).toBe(true);
    expect(typeof update.password).toBe("string"); expect(update.password.length).toBeGreaterThanOrEqual(32);
    expect(fb.revokeRefreshTokens).toHaveBeenCalledWith(uid);
    expect(forgetRevocationState).toHaveBeenCalledWith(uid);
    // the token is minted only after the account is secured
    expect(fb.revokeRefreshTokens.mock.invocationCallOrder[0]).toBeLessThan(fb.createCustomToken.mock.invocationCallOrder[0]);
    return update;
  };

  it("unverified, password + phone: the phone is unlinked, the password replaced, sessions revoked", async () => {
    const u = await securedWith("pw-phone", [{ providerId: "password" }, { providerId: "phone" }], "pwphone@example.com");
    expect(u.providersToUnlink).toEqual(["phone"]);
  });

  it("unverified, microsoft.com and no password: Microsoft is unlinked, a random password set, sessions revoked", async () => {
    const u = await securedWith("ms-linked", [{ providerId: "microsoft.com" }], "ms@example.com");
    expect(u.providersToUnlink).toEqual(["microsoft.com"]);
  });

  it("unverified, no provider at all: still verified, a random password set, and sessions ALWAYS revoked", async () => {
    const u = await securedWith("bare", [], "bare@example.com");
    expect(u.providersToUnlink).toBeUndefined();
  });

  it("unverified, password only: the password is replaced (nothing else to unlink)", async () => {
    const u = await securedWith("pw-only", [{ providerId: "password" }], "pw@example.com");
    expect(u.providersToUnlink).toBeUndefined();
  });

  it("a verified account is left exactly as it is", async () => {
    fb.getUserByEmail.mockResolvedValue({ uid: "ok-uid", emailVerified: true, disabled: false, providerData: [{ providerId: "google.com" }, { providerId: "phone" }] });
    await start("verified@example.com");
    expect((await verify("verified@example.com", lastCode())).status).toBe(200);
    expect(fb.updateUser).not.toHaveBeenCalled(); expect(fb.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it("two verifies racing to create the same new user both land in it", async () => {
    fb.createUser.mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "auth/email-already-exists" }));
    fb.getUserByEmail.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ uid: "raced", emailVerified: true, disabled: false, providerData: [] });
    await start("race@example.com");
    expect((await verify("race@example.com", lastCode())).json).toEqual({ customToken: "token-for:raced" });
  });

  it("a Firebase failure answers 500 and does NOT spend the code (nor the try): the same code works after", async () => {
    fb.getUserByEmail.mockRejectedValueOnce(new Error("network"));
    await start("boom@example.com");
    const code = lastCode();
    expect(await verify("boom@example.com", code)).toEqual({ status: 500, json: { error: "server_error" } });
    expect((await rowsFor("boom@example.com"))[0]).toMatchObject({ consumed_at: null, attempts: 0 });
    fb.createCustomToken.mockRejectedValueOnce(new Error("iam"));
    expect((await verify("boom@example.com", code)).status).toBe(500);
    expect((await rowsFor("boom@example.com"))[0]).toMatchObject({ consumed_at: null, attempts: 0 });
    expect(await verify("boom@example.com", code)).toEqual({ status: 200, json: { customToken: "token-for:new:boom@example.com" } });
    expect((await rowsFor("boom@example.com"))[0].consumed_at).not.toBeNull();
  });
});

describe("E9 abuse limits", () => {
  const H = 3600_000;
  /** A code for `email` locked `agoMs` ago by guesses from `guesserIp`. */
  const lockedRow = (email: string, agoMs: number, guesserIp: string) => {
    const at = new Date(Date.now() - agoMs);
    return { email_hmac: emailHmac(email), code_hmac: "00", ip_hmac: ipHmac("203.0.113.250"), attempts: EMAIL_CODE.maxAttempts,
      created_at: new Date(at.getTime() - 60_000), expires_at: new Date(at.getTime() + EMAIL_CODE.ttlMs), locked_at: at, locked_ip_hmac: ipHmac(guesserIp) };
  };
  const STRANGER = "198.51.100.66";

  it("the 5th wrong try records when and from which IP the code was locked", async () => {
    await start("rec@example.com");
    const wrong = wrongOf(lastCode());
    for (let i = 0; i < EMAIL_CODE.maxAttempts; i++) await verify("rec@example.com", wrong);
    const [row] = await rowsFor("rec@example.com");
    expect(row.locked_at).not.toBeNull();
    expect(row.locked_ip_hmac).toBe(ipHmac(ip));
  });

  const alerts = () => mockLogError.mock.calls.filter((c) => String(c[1]).includes("possible rotating-IP denial"));
  const lockOneMore = async (email: string) => {
    await start(email);
    const wrong = wrongOf(lastCode());
    for (let i = 0; i < EMAIL_CODE.maxAttempts; i++) await verify(email, wrong);
  };

  it("ALERT when one address reaches 3 locks from 2+ different IPs in 24 h (the accepted rotating-IP risk), domain and counts only", async () => {
    mockLogError.mockClear();
    await db.insert(emailSigninCodes).values([lockedRow("rot@example.com", 5 * H, STRANGER), lockedRow("rot@example.com", 6 * H, "192.0.2.1")]);
    await lockOneMore("rot@example.com");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0][0]).toEqual({ emailDomain: "example.com", locks: 3, ips: 3 });
    expect(JSON.stringify(alerts()[0])).not.toContain("rot@");
  });

  it("no ALERT for three locks from ONE IP (the targeted lockout handles it), or for locks older than 24 h", async () => {
    mockLogError.mockClear();
    await db.insert(emailSigninCodes).values([lockedRow("one@example.com", 5 * H, ip), lockedRow("one@example.com", 6 * H, ip)]);
    await lockOneMore("one@example.com");
    await db.insert(emailSigninCodes).values([lockedRow("old2@example.com", 25 * H, STRANGER), lockedRow("old2@example.com", 26 * H, "192.0.2.1")]);
    await lockOneMore("old2@example.com");
    expect(alerts()).toHaveLength(0);
  });

  it("targeted: three locks guessed from ONE IP within 24 h => that IP gets no code for a day; the owner's IP only backs off", async () => {
    await db.insert(emailSigninCodes).values([lockedRow("lock@example.com", 5 * H, STRANGER), lockedRow("lock@example.com", 6 * H, STRANGER), lockedRow("lock@example.com", 7 * H, STRANGER)]);
    const fromStranger = await start("lock@example.com", STRANGER);
    expect(fromStranger.status).toBe(429); expect(fromStranger.json.error).toBe("too_many");
    expect(fromStranger.json.retryAfterSec).toBeGreaterThan(18.9 * 3600); expect(fromStranger.json.retryAfterSec).toBeLessThanOrEqual(19 * 3600);
    // the owner, from her own IP: three locks in 24 h => the 4 h backoff from the newest (5 h ago) is over
    expect((await start("lock@example.com")).status).toBe(202);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("backoff for everyone on the address: 15 min after one lock, 1 h after two, 4 h after three or more", async () => {
    const waitFor = async (email: string) => { const r = await start(email); return r.status === 202 ? 0 : (expect(r.json.error).toBe("too_many"), r.json.retryAfterSec as number); };
    await db.insert(emailSigninCodes).values([lockedRow("b1@example.com", 5 * 60_000, STRANGER)]);
    const w1 = await waitFor("b1@example.com"); expect(w1).toBeGreaterThan(9 * 60); expect(w1).toBeLessThanOrEqual(10 * 60);
    await db.insert(emailSigninCodes).values([lockedRow("b1b@example.com", 20 * 60_000, STRANGER)]);
    expect(await waitFor("b1b@example.com")).toBe(0);
    await db.insert(emailSigninCodes).values([lockedRow("b2@example.com", 30 * 60_000, STRANGER), lockedRow("b2@example.com", 3 * H, "192.0.2.1")]);
    const w2 = await waitFor("b2@example.com"); expect(w2).toBeGreaterThan(29 * 60); expect(w2).toBeLessThanOrEqual(30 * 60);
    await db.insert(emailSigninCodes).values([lockedRow("b3@example.com", 2 * H, STRANGER), lockedRow("b3@example.com", 3 * H, "192.0.2.1"), lockedRow("b3@example.com", 4 * H, "192.0.2.2")]);
    const w3 = await waitFor("b3@example.com"); expect(w3).toBeGreaterThan(1.9 * 3600); expect(w3).toBeLessThanOrEqual(2 * 3600);
  });

  it("locks older than 24 h no longer back off; three from one IP spread over more than 24 h do not lock it out", async () => {
    await db.insert(emailSigninCodes).values([lockedRow("old@example.com", 25 * H, STRANGER), lockedRow("old@example.com", 26 * H, STRANGER), lockedRow("old@example.com", 27 * H, STRANGER)]);
    expect((await start("old@example.com", STRANGER)).status).toBe(202);
    await db.insert(emailSigninCodes).values([lockedRow("spread@example.com", 5 * H, STRANGER), lockedRow("spread@example.com", 20 * H, STRANGER), lockedRow("spread@example.com", 30 * H, STRANGER)]);
    expect((await start("spread@example.com", STRANGER)).status).toBe(202);   // 2 in 24 h: the 1 h backoff from 5 h ago is over
  });

  const filler = (n: number, agoMs: number) => Array.from({ length: n }, (_, i) => ({
    email_hmac: emailHmac(`f${agoMs}-${i}@example.com`), code_hmac: "00", ip_hmac: ipHmac(`192.0.2.${i % 250}`),
    created_at: new Date(Date.now() - agoMs), expires_at: new Date(Date.now() - agoMs + EMAIL_CODE.ttlMs),
  }));

  it("the service-wide hourly cap: 503 busy (an ALERT), nothing sent, no code stored", async () => {
    expect([EMAIL_CODE.globalHour, EMAIL_CODE.globalDay]).toEqual([300, 1000]);
    await db.insert(emailSigninCodes).values(filler(EMAIL_CODE.globalHour, 10 * 60_000));
    expect(await start("cap@example.com")).toEqual({ status: 503, json: { error: "busy" } });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await rowsFor("cap@example.com")).toEqual([]);
  });

  it("the service-wide daily cap counts the last 24 h", async () => {
    await db.insert(emailSigninCodes).values(filler(EMAIL_CODE.globalDay, 5 * H));
    expect(await start("day@example.com")).toEqual({ status: 503, json: { error: "busy" } });
    await db.delete(emailSigninCodes);
    await db.insert(emailSigninCodes).values(filler(EMAIL_CODE.globalDay, 25 * H));   // older than a day: not counted
    expect((await start("day@example.com")).status).toBe(202);
  });
});

describe("E10 the app-review login", () => {
  const REVIEWER = "tester@nomila.co";
  const on = () => { process.env.REVIEW_LOGIN_EMAIL = REVIEWER; process.env.REVIEW_LOGIN_CODE = "418093"; };
  const existing = () => fb.getUserByEmail.mockResolvedValue({ uid: "tester-uid", email: REVIEWER, emailVerified: true, disabled: false, providerData: [{ providerId: "password" }] });

  it("signs the review address into its existing account with the fixed code, emailing nothing, and leaves the account alone", async () => {
    on(); existing();
    expect((await start(" Tester@Nomila.co ")).status).toBe(202);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await verify(REVIEWER, "418093")).toEqual({ status: 200, json: { customToken: "token-for:tester-uid" } });
    expect(fb.updateUser).not.toHaveBeenCalled();
    expect(fb.createUser).not.toHaveBeenCalled();
  });

  it("the fixed code is still single-use, still needs /start first, and still locks after 5 wrong tries", async () => {
    on(); existing();
    expect((await verify(REVIEWER, "418093")).status).toBe(410);          // no /start yet: no live code
    await start(REVIEWER);
    expect((await verify(REVIEWER, "418093")).status).toBe(200);
    expect((await verify(REVIEWER, "418093")).status).toBe(410);          // spent
    await age(REVIEWER, EMAIL_CODE.minGapMs);
    await start(REVIEWER);
    for (let i = 0; i < EMAIL_CODE.maxAttempts; i++) await verify(REVIEWER, "000001");
    expect((await verify(REVIEWER, "418093")).status).toBe(423);          // locked: even the right code
  });

  it("still keeps the minute gap per address", async () => {
    on();
    expect((await start(REVIEWER)).status).toBe(202);
    expect((await start(REVIEWER)).json.error).toBe("too_soon");
  });

  it("every other address still gets a random code by email, and the fixed code does not work for it", async () => {
    on();
    await start("someone@example.com");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const code = lastCode();
    if (code !== "418093") expect((await verify("someone@example.com", "418093")).json.error).toBe("wrong_code");
    expect((await verify("someone@example.com", code)).status).toBe(200);
  });

  it("off unless both settings are present and the code is 6 digits: then the review address is emailed like anyone", async () => {
    for (const [addr, code] of [[REVIEWER, undefined], [undefined, "418093"], [REVIEWER, "12345"], [REVIEWER, "abcdef"]] as const) {
      if (addr) process.env.REVIEW_LOGIN_EMAIL = addr; else delete process.env.REVIEW_LOGIN_EMAIL;
      if (code) process.env.REVIEW_LOGIN_CODE = code; else delete process.env.REVIEW_LOGIN_CODE;
      sendEmail.mockClear(); await db.delete(emailSigninCodes);
      expect((await start(REVIEWER)).status).toBe(202);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    }
  });

  it("prod wires it to tester@nomila.co with the code from Secret Manager REVIEW_LOGIN_CODE_PROD", () => {
    const prod = parse(readFileSync(join(__dirname, "..", "..", "gcp", "cloud-run-prod.yaml"), "utf8")).spec.template.spec.containers[0].env as Array<{ name: string }>;
    expect(prod.filter((e) => e.name === "REVIEW_LOGIN_EMAIL")).toEqual([{ name: "REVIEW_LOGIN_EMAIL", value: "tester@nomila.co" }]);
    expect(prod.filter((e) => e.name === "REVIEW_LOGIN_CODE")).toEqual([{ name: "REVIEW_LOGIN_CODE", valueFrom: { secretKeyRef: { name: "REVIEW_LOGIN_CODE_PROD", key: "latest" } } }]);
  });
});
