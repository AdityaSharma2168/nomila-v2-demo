/**
 * authEmailCode.ts — sign in with a 6-digit email code (design "Sign in with email", 12 Oct 2026). Mounted at
 * /api/v1/auth/email-code; every route answers 404 unless EMAIL_CODE_SIGNIN is exactly "true".
 *
 * POST /start  { email }
 *   202 { resendAfterSec }             a code was emailed. The answer is the same whether or not an account exists:
 *                                      nothing about accounts is read here, so nobody can probe for one.
 *   400 { error: "invalid_email" }
 *   429 { error: "too_soon", retryAfterSec }   a code went to this address less than a minute ago (it still works).
 *   429 { error: "too_many", retryAfterSec }   five codes this hour for this address; too many from this IP; a code
 *                                      for this address was locked recently (backoff 15 min / 1 h / 4 h after 1 / 2 / 3+
 *                                      locks in 24 h); or THIS IP locked three codes for it within 24 h (a day).
 *   503 { error: "busy" }               the service-wide cap (EMAIL_CODE.globalHour / globalDay) is reached: ALERT logged.
 *   503 { error: "email_unavailable" }  delivery is off or the secret is missing: refused LOUDLY, never "sent".
 *   503 { error: "send_failed" }        the Gmail send failed; the code is withdrawn (an earlier one keeps working).
 *
 * POST /verify  { email, code }
 *   200 { customToken }                the app signs in with signInWithCustomToken, exactly as Microsoft sign-in does,
 *                                      then calls /auth/signup as every other way in does (roles are set there).
 *   400 { error: "invalid_email" | "invalid_code" }
 *   400 { error: "wrong_code", triesLeft }
 *   410 { error: "expired" }           no live code for this address (expired, spent, or replaced by a newer one).
 *   423 { error: "locked" }            five wrong tries: this code is dead, a new one is needed.
 *   403 { error: "account_disabled" }
 *
 * On a match the Firebase user for the address is found, or created with emailVerified true, so the same email used
 * with Google before lands in that same account. An existing UNVERIFIED account is secured first (secureUnverifiedUser:
 * every provider unlinked, password replaced, sessions revoked). The code is spent only after the Firebase step. Per-IP limits: authLimiter (per instance) on both routes, plus a
 * fleet-wide hourly count of codes per IP from the table. Logs carry the address's domain only, never a code.
 */
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db";
import { emailSigninCodes } from "../../shared/schema";
import type { UserRecord } from "firebase-admin/auth";
import { firebaseAuth, forgetRevocationState } from "../lib/auth";
import { sendEmail } from "../lib/notify";
import { createLogger } from "../logger";
import {
  EMAIL_CODE, codeEmail, codeHmac, emailCodeSigninEnabled, emailCodeUnavailable, emailHmac, ipHmac, newCode, normEmail,
  reviewLoginCode, sameHmac, validEmail, wellFormedCode,
} from "../lib/emailCode";

const logger = createLogger("routes/authEmailCode");

/** The same per-IP anti-automation limit as the other unauthenticated auth routes (routes/auth.ts authLimiter). */
const newAuthLimiter = () => rateLimit({
  windowMs:        15 * 60 * 1000,
  limit:           30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: "too_many" },
});

const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1) || "?";
const secs = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));
const HOUR_MS = 60 * 60 * 1000;

type StartOutcome =
  | { kind: "ok"; id: string; code: string }
  | { kind: "too_soon" | "too_many" | "locked_out" | "backoff"; retryAfterSec: number }
  | { kind: "busy"; window: "hour" | "day" };

/**
 * Three codes locked (5 wrong tries) inside any 24 h span, the newest of them under 24 h ago ⇒ no new code until 24 h
 * after that newest one. Applied to the locks made from the CALLER's IP only (targeted). Returns the seconds to wait, or 0.
 */
function lockoutWait(lockedNewestFirst: Date[], now: Date): number {
  const n = EMAIL_CODE.lockoutLocks;
  for (let i = 0; i + n - 1 < lockedNewestFirst.length; i++) {
    const newest = lockedNewestFirst[i].getTime();
    if (now.getTime() - newest >= EMAIL_CODE.lockoutMs) break;   // newest first: every later one is older still
    if (newest - lockedNewestFirst[i + n - 1].getTime() <= EMAIL_CODE.lockoutMs) return secs(newest + EMAIL_CODE.lockoutMs - now.getTime());
  }
  return 0;
}

/**
 * Count and insert under one per-address transaction lock, so two quick taps cannot both pass the limits. The code
 * row goes in before the send: a send that fails deletes it again. The global caps are counted in the same
 * transaction but not under a global lock: two addresses at the very edge can overshoot by one each (a soft cap).
 */
async function issueCode(emailH: string, ipH: string, now: Date, fixedCode: string | null = null): Promise<StartOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('email_signin_codes'), hashtext(${emailH}))`);
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const dayAgo = new Date(now.getTime() - 24 * HOUR_MS);

    // Locks on this address in the last 48 h, newest first (locked_at is set by the 5th wrong try).
    const locks = await tx.select({ at: emailSigninCodes.locked_at, ip: emailSigninCodes.locked_ip_hmac }).from(emailSigninCodes)
      .where(and(eq(emailSigninCodes.email_hmac, emailH), gt(emailSigninCodes.locked_at, new Date(now.getTime() - 2 * EMAIL_CODE.lockoutMs))))
      .orderBy(desc(emailSigninCodes.locked_at));
    // Targeted: three locks guessed from THIS IP ⇒ this IP waits a day. A stranger's guesses never lock the owner's IP.
    const wait = lockoutWait(locks.filter((l) => l.ip === ipH).map((l) => l.at!), now);
    if (wait > 0) return { kind: "locked_out", retryAfterSec: wait };
    // Backoff for everyone on this address: 15 min after one lock in 24 h, 1 h after two, 4 h after three or more.
    const recentLocks = locks.filter((l) => now.getTime() - l.at!.getTime() < 24 * HOUR_MS);
    if (recentLocks.length) {
      const step = EMAIL_CODE.lockBackoffMs[Math.min(recentLocks.length, EMAIL_CODE.lockBackoffMs.length) - 1];
      const until = recentLocks[0].at!.getTime() + step;
      if (until > now.getTime()) return { kind: "backoff", retryAfterSec: secs(until - now.getTime()) };
    }

    const recent = await tx.select({ created_at: emailSigninCodes.created_at }).from(emailSigninCodes)
      .where(and(eq(emailSigninCodes.email_hmac, emailH), gt(emailSigninCodes.created_at, hourAgo)))
      .orderBy(desc(emailSigninCodes.created_at));
    const newest = recent[0]?.created_at;
    if (newest && now.getTime() - newest.getTime() < EMAIL_CODE.minGapMs) {
      return { kind: "too_soon", retryAfterSec: secs(newest.getTime() + EMAIL_CODE.minGapMs - now.getTime()) };
    }
    if (recent.length >= EMAIL_CODE.perEmailHour) {
      const oldest = recent[EMAIL_CODE.perEmailHour - 1].created_at;
      return { kind: "too_many", retryAfterSec: secs(oldest.getTime() + HOUR_MS - now.getTime()) };
    }
    const fromIp = await tx.select({ created_at: emailSigninCodes.created_at }).from(emailSigninCodes)
      .where(and(eq(emailSigninCodes.ip_hmac, ipH), gt(emailSigninCodes.created_at, hourAgo)))
      .orderBy(desc(emailSigninCodes.created_at)).limit(EMAIL_CODE.perIpHour);
    if (fromIp.length >= EMAIL_CODE.perIpHour) {
      const oldest = fromIp[EMAIL_CODE.perIpHour - 1].created_at;
      return { kind: "too_many", retryAfterSec: secs(oldest.getTime() + HOUR_MS - now.getTime()) };
    }
    const [sent] = await tx.select({
      hour: sql<number>`count(*) filter (where ${emailSigninCodes.created_at} > ${hourAgo})::int`,
      day:  sql<number>`count(*)::int`,
    }).from(emailSigninCodes).where(gt(emailSigninCodes.created_at, dayAgo));
    if ((sent?.hour ?? 0) >= EMAIL_CODE.globalHour) return { kind: "busy", window: "hour" };
    if ((sent?.day ?? 0) >= EMAIL_CODE.globalDay) return { kind: "busy", window: "day" };
    const code = fixedCode ?? newCode();   // fixedCode: the app-review login only (lib/emailCode reviewLoginCode)
    const [row] = await tx.insert(emailSigninCodes).values({
      email_hmac: emailH, code_hmac: codeHmac(emailH, code), ip_hmac: ipH,
      expires_at: new Date(now.getTime() + EMAIL_CODE.ttlMs), created_at: now,
    }).returning({ id: emailSigninCodes.id });
    return { kind: "ok", id: row.id, code };
  });
}

/** The Firebase user for a proven address: found, or created verified. */
async function firebaseUidFor(email: string): Promise<{ uid: string } | { disabled: true }> {
  let user;
  try {
    user = await firebaseAuth.getUserByEmail(email);
  } catch (err: any) {
    if (err?.code !== "auth/user-not-found") throw err;
    try {
      user = await firebaseAuth.createUser({ email, emailVerified: true });
      logger.info({ emailDomain: domainOf(email) }, "email code: created a verified Firebase user");
    } catch (createErr: any) {
      // Two verifies racing for a new address: the other one created it.
      if (createErr?.code !== "auth/email-already-exists") throw createErr;
      user = await firebaseAuth.getUserByEmail(email);
    }
  }
  if (user.disabled) return { disabled: true };
  if (!user.emailVerified) await secureUnverifiedUser(user, email);
  return { uid: user.uid };
}

/**
 * The code proves the mailbox; nothing else on an UNVERIFIED account with this address was ever proven. Anyone could
 * have created it and attached a way back in (a password, a phone number, another provider) before the owner arrived
 * (account pre-hijacking). So, before the owner is let in: every linked provider is unlinked, the password is replaced
 * with a random one nobody knows (unlinking "password" is not something the Admin API does reliably; an unknown
 * password is the same lock), the address is marked verified, and every existing session is revoked — always, with or
 * without a password. The same rule Firebase applies when a trusted provider proves an address held by an unverified
 * account. The code email says so (lib/emailCode PASSWORD_NOTICE).
 */
async function secureUnverifiedUser(user: UserRecord, email: string): Promise<void> {
  const unlink = Array.from(new Set(user.providerData.map((p) => p.providerId).filter((id) => id !== "password")));
  await firebaseAuth.updateUser(user.uid, {
    emailVerified: true,
    password: randomBytes(32).toString("base64url"),
    ...(unlink.length ? { providersToUnlink: unlink } : {}),
  });
  await firebaseAuth.revokeRefreshTokens(user.uid);
  forgetRevocationState(user.uid);
  logger.warn({ emailDomain: domainOf(email), unlinked: unlink, hadPassword: user.providerData.some((p) => p.providerId === "password") },
    "email code: secured an unverified Firebase user (providers unlinked, password replaced, sessions revoked)");
}

/**
 * The residual risk the lockout accepts: someone rotating IPs can keep an address on the 4 h backoff, because only
 * the per-IP lockout is a full day and each new IP starts clean. If it ever happens, it shows here: an ALERT when one
 * address has EMAIL_CODE.rotatingAlertLocks or more locks from two or more different IPs within 24 h. Logs the domain
 * and the counts only.
 */
async function alertIfRotatingLocks(emailH: string, email: string, now: Date): Promise<void> {
  const locks = await db.select({ ip: emailSigninCodes.locked_ip_hmac }).from(emailSigninCodes)
    .where(and(eq(emailSigninCodes.email_hmac, emailH), gt(emailSigninCodes.locked_at, new Date(now.getTime() - 24 * HOUR_MS))));
  const ips = new Set(locks.map((l) => l.ip ?? "?")).size;
  if (locks.length >= EMAIL_CODE.rotatingAlertLocks && ips >= 2) {
    logger.error({ emailDomain: domainOf(email), locks: locks.length, ips }, "ALERT email code: one address locked repeatedly from several IPs in 24 h (possible rotating-IP denial)");
  }
}

/** Delete codes older than EMAIL_CODE.keepMs. Run after every send and hourly by /api/internal/email-code-purge-cron. */
export async function purgeEmailSigninCodes(now: Date = new Date()): Promise<number> {
  const gone = await db.delete(emailSigninCodes).where(lt(emailSigninCodes.created_at, new Date(now.getTime() - EMAIL_CODE.keepMs)))
    .returning({ id: emailSigninCodes.id });
  return gone.length;
}

/** Express 4 does not catch a rejected handler: answer 500 with a stable code instead of hanging the request. */
const guarded = (name: string, fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response): void => {
  fn(req, res).catch((err: any) => {
    logger.error({ route: name, error: String(err?.message ?? err).slice(0, 200) }, "email code: route failed");
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  });
};

export function authEmailCodeRouter(): Router {
  const router = Router();
  const authLimiter = newAuthLimiter();

  router.use((_req, res, next) => {
    if (!emailCodeSigninEnabled()) { res.status(404).json({ error: "Not found" }); return; }
    next();
  });

  router.post("/start", authLimiter, guarded("start", async (req: Request, res: Response): Promise<void> => {
    const raw = (req.body as { email?: unknown } | undefined)?.email;
    if (!validEmail(raw)) { res.status(400).json({ error: "invalid_email" }); return; }
    const email = normEmail(raw);

    const unavailable = emailCodeUnavailable();
    if (unavailable) {
      logger.error({ reason: unavailable }, "ALERT email code sign-in is switched on but cannot send — refusing /start");
      res.status(503).json({ error: "email_unavailable" });
      return;
    }

    const now = new Date();
    const emailH = emailHmac(email);
    const reviewCode = reviewLoginCode(email);
    const outcome = await issueCode(emailH, ipHmac(req.ip), now, reviewCode);
    if (outcome.kind === "busy") {
      logger.error({ window: outcome.window, cap: outcome.window === "hour" ? EMAIL_CODE.globalHour : EMAIL_CODE.globalDay },
        "ALERT email code: the service-wide cap on codes sent is reached — refusing /start");
      res.status(503).json({ error: "busy" });
      return;
    }
    if (outcome.kind !== "ok") {
      logger.info({ emailDomain: domainOf(email), outcome: outcome.kind }, "email code: limited");
      // locked_out and backoff answer as too_many: the app says "too many codes for this email" with the wait.
      res.status(429).json({ error: outcome.kind === "too_soon" ? "too_soon" : "too_many", retryAfterSec: outcome.retryAfterSec });
      return;
    }

    // The app-review address: its fixed code is stored like any other and nothing is emailed (the reviewer has it).
    if (reviewCode) {
      logger.info({ emailDomain: domainOf(email) }, "email code: review login code issued (not emailed)");
      res.status(202).json({ resendAfterSec: secs(EMAIL_CODE.minGapMs) });
      return;
    }

    const mail = codeEmail(outcome.code);
    const sent = await sendEmail({ to: email, ...mail });
    if (!sent.sent) {
      await db.delete(emailSigninCodes).where(eq(emailSigninCodes.id, outcome.id));
      logger.error({ emailDomain: domainOf(email), skipped: !!sent.skipped, error: sent.error }, "email code: NOT sent — code withdrawn");
      res.status(503).json({ error: sent.skipped ? "email_unavailable" : "send_failed" });
      return;
    }

    // Housekeeping, never fatal (the hourly cron does it too): old codes are gone.
    void purgeEmailSigninCodes(now).catch((err: any) => logger.warn({ error: err.message }, "email code: purge failed"));

    logger.info({ emailDomain: domainOf(email) }, "email code: sent");
    res.status(202).json({ resendAfterSec: secs(EMAIL_CODE.minGapMs) });
  }));

  router.post("/verify", authLimiter, guarded("verify", async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { email?: unknown; code?: unknown };
    if (!validEmail(body.email)) { res.status(400).json({ error: "invalid_email" }); return; }
    const code = typeof body.code === "string" ? body.code.trim() : body.code;
    if (!wellFormedCode(code)) { res.status(400).json({ error: "invalid_code" }); return; }
    if (emailCodeUnavailable() === "no_secret") {
      logger.error("ALERT email code sign-in is switched on but EMAIL_CODE_SECRET is not set — refusing /verify");
      res.status(503).json({ error: "email_unavailable" });
      return;
    }
    const email = normEmail(body.email);
    const emailH = emailHmac(email);
    const now = new Date();

    // Only the newest code for the address counts; an older one is dead the moment a newer one exists.
    const [row] = await db.select().from(emailSigninCodes).where(eq(emailSigninCodes.email_hmac, emailH))
      .orderBy(desc(emailSigninCodes.created_at)).limit(1);
    if (!row || row.consumed_at || row.expires_at <= now) { res.status(410).json({ error: "expired" }); return; }
    if (row.attempts >= EMAIL_CODE.maxAttempts) { res.status(423).json({ error: "locked" }); return; }

    // Spend a try BEFORE comparing, atomically, so parallel guesses cannot exceed the limit.
    const [tried] = await db.update(emailSigninCodes).set({ attempts: sql`${emailSigninCodes.attempts} + 1` })
      .where(and(eq(emailSigninCodes.id, row.id), lt(emailSigninCodes.attempts, EMAIL_CODE.maxAttempts),
        isNull(emailSigninCodes.consumed_at), gt(emailSigninCodes.expires_at, now)))
      .returning({ attempts: emailSigninCodes.attempts });
    if (!tried) { res.status(423).json({ error: "locked" }); return; }

    if (!sameHmac(row.code_hmac, codeHmac(emailH, code))) {
      const triesLeft = EMAIL_CODE.maxAttempts - tried.attempts;
      if (triesLeft <= 0) {
        // This wrong try locked the code: record when and from where (the lockout and the backoff read both).
        await db.update(emailSigninCodes).set({ locked_at: now, locked_ip_hmac: ipHmac(req.ip) })
          .where(and(eq(emailSigninCodes.id, row.id), isNull(emailSigninCodes.locked_at)));
        await alertIfRotatingLocks(emailH, email, now).catch((err: any) => logger.warn({ error: err.message }, "email code: rotating-lock check failed"));
        res.status(423).json({ error: "locked" });
        return;
      }
      res.status(400).json({ error: "wrong_code", triesLeft });
      return;
    }

    // The right code. The Firebase step comes BEFORE the code is spent: if Firebase fails, the code still works (and
    // the try just used is given back), so a provider hiccup never costs the athlete her code.
    let customToken: string;
    try {
      const found = await firebaseUidFor(email);
      if ("disabled" in found) {
        logger.warn({ emailDomain: domainOf(email) }, "email code: Firebase user is disabled — refused");
        res.status(403).json({ error: "account_disabled" });
        return;
      }
      customToken = await firebaseAuth.createCustomToken(found.uid);
    } catch (err) {
      await db.update(emailSigninCodes).set({ attempts: sql`greatest(${emailSigninCodes.attempts} - 1, 0)` })
        .where(and(eq(emailSigninCodes.id, row.id), isNull(emailSigninCodes.consumed_at)));
      throw err;
    }

    // Single use, atomically: only the request that sets consumed_at gets the token.
    const [spent] = await db.update(emailSigninCodes).set({ consumed_at: now })
      .where(and(eq(emailSigninCodes.id, row.id), isNull(emailSigninCodes.consumed_at)))
      .returning({ id: emailSigninCodes.id });
    if (!spent) { res.status(410).json({ error: "expired" }); return; }
    logger.info({ emailDomain: domainOf(email) }, "email code: signed in");
    res.json({ customToken });
  }));

  return router;
}
