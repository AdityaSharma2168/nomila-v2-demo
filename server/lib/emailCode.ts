/**
 * emailCode.ts — the rules and the crypto behind "sign in with a 6-digit email code" (design "Sign in with email",
 * 12 Oct 2026; routes in server/routes/authEmailCode.ts).
 *
 *   switch     EMAIL_CODE_SIGNIN, exactly "true" (on in the dev Cloud Run yaml, off in prod).
 *   secret     EMAIL_CODE_SECRET (Secret Manager, mounted in the dev yaml only). Every stored value is HMAC-SHA256 under
 *              it, domain-separated by purpose. There is NO fallback key: without the secret the feature is unavailable.
 *   ready      the switch is on, the secret is set and email delivery is on (EMAIL_PROVIDER=gmail). Only then does the
 *              app offer "Use email instead" (GET /public/onboarding-front emailSignIn) and does /start send anything.
 *   a code     6 digits from crypto.randomInt, 10 minutes, 5 tries, spent once; only the newest code for an email works.
 *
 * Never logs or returns a code, a secret or a full address.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { emailProvider } from "./emailProvider";

export const EMAIL_CODE = {
  /** How long a code works. */
  ttlMs:            10 * 60 * 1000,
  /** Tries per code (the right one included). */
  maxAttempts:      5,
  /** Per email: one code a minute … */
  minGapMs:         60 * 1000,
  /** … and five an hour. */
  perEmailHour:     5,
  /** Per IP, across every instance (express-rate-limit counts per instance only). */
  perIpHour:        30,
  /** Codes sent by the whole service, well under the Gmail sender's daily cap (GMAIL_DAILY_CAP, 1500): an ALERT past either. */
  globalHour:       300,
  globalDay:        1000,
  /**
   * Targeted lockout: when codes for an address were locked (5 wrong tries) this many times within lockoutMs by
   * guesses from ONE IP, that IP gets no new code for that address until lockoutMs after the last lock. Keyed on the
   * guesser's IP so a stranger can't lock the owner out for a day.
   */
  lockoutLocks:     3,
  lockoutMs:        24 * 60 * 60 * 1000,
  /**
   * Per-address backoff after locks (any IP), counted over the last 24 h, from the newest lock: after one lock the
   * next code waits 15 minutes, after two an hour, after three or more four hours. The most a stranger can impose.
   */
  lockBackoffMs:    [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000] as readonly number[],
  /** ALERT when one address has this many locks from two or more different IPs within 24 h (rotating-IP denial). */
  rotatingAlertLocks: 3,
  /** Rows are purged after two days (the lockout looks back 48 h for three locks inside one 24 h span). */
  keepMs:           48 * 60 * 60 * 1000,
} as const;

export const emailCodeSigninEnabled = (): boolean => process.env.EMAIL_CODE_SIGNIN === "true";
const secret = (): string | null => process.env.EMAIL_CODE_SECRET?.trim() || null;

export type EmailCodeUnavailable = "off" | "no_secret" | "no_delivery";

/** Why the email code cannot be offered right now, or null when it can. */
export function emailCodeUnavailable(): EmailCodeUnavailable | null {
  if (!emailCodeSigninEnabled()) return "off";
  if (!secret()) return "no_secret";
  if (emailProvider() !== "gmail") return "no_delivery";
  return null;
}

/** The address as it is compared and sent to: trimmed and lower-cased. */
export const normEmail = (e: string): string => e.trim().toLowerCase();

/** A plausible address: one @, a dotted domain, no spaces, at most 254 characters. Not RFC 5322; delivery is the proof. */
export function validEmail(e: unknown): e is string {
  if (typeof e !== "string") return false;
  const v = e.trim();
  return v.length <= 254 && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
}

function hmac(purpose: string, value: string): string {
  const key = secret();
  if (!key) throw new Error("EMAIL_CODE_SECRET is not set");
  return createHmac("sha256", key).update(`email-code|${purpose}|${value}`, "utf8").digest("hex");
}

export const emailHmac = (email: string): string => hmac("email", normEmail(email));
export const ipHmac = (ip: string | undefined): string => hmac("ip", ip ?? "unknown");
/** Bound to the email, so a code row can never be checked against another address. */
export const codeHmac = (emailH: string, code: string): string => hmac("code", `${emailH}|${code}`);

export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");
export const wellFormedCode = (c: unknown): c is string => typeof c === "string" && /^\d{6}$/.test(c);

/**
 * App-review login: ONE address (REVIEW_LOGIN_EMAIL) whose code is fixed (REVIEW_LOGIN_CODE, Secret Manager), so a
 * store / platform reviewer (TikTok, Google) can sign in without our mailbox. Only /start changes: it stores this code
 * instead of a random one and emails nothing. /verify is untouched (once per /start, 5 tries, 10 minutes, every limit).
 * Off unless both are set and the code is 6 digits. Every other address is unaffected. Remove once the review is done.
 */
export function reviewLoginCode(email: string): string | null {
  const addr = process.env.REVIEW_LOGIN_EMAIL?.trim().toLowerCase();
  const code = process.env.REVIEW_LOGIN_CODE?.trim();
  if (!addr || !wellFormedCode(code)) return null;
  return normEmail(email) === addr ? code : null;
}

/** Constant-time comparison of two hex HMACs. */
export function sameHmac(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * An address that already has an UNVERIFIED Nomila password account loses that password on its first code sign-in
 * (routes/authEmailCode.ts secureUnverifiedUser: anyone could have set it). Said in every code email.
 */
export const PASSWORD_NOTICE = "If this email has a Nomila password that was never confirmed, signing in with a code replaces the password on this account.";

/** The email itself: the code in the subject so it shows in the notification (design copy, verbatim, plus the password notice). */
export function codeEmail(code: string): { subject: string; text: string; html: string } {
  const text = `Your Nomila sign-in code is ${code}. It works for 10 minutes. `
    + "If you didn’t ask for it, ignore this email; nobody can sign in without the code. "
    + "Nomila will never ask you for this code. "
    + `${PASSWORD_NOTICE}`;
  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#0E0E0E;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:40px 24px;color:#FFFFFF;">
      <div style="font-weight:900;font-size:13px;letter-spacing:0.34em;">NOMILA</div>
      <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.92);margin:28px 0 12px;">Your Nomila sign-in code is</p>
      <div style="font-size:36px;font-weight:800;letter-spacing:0.12em;margin:0 0 12px;">${code}</div>
      <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.92);margin:0 0 24px;">It works for 10 minutes.</p>
      <p style="font-size:13px;line-height:1.5;color:rgba(255,255,255,0.6);margin:0;">
        If you didn’t ask for it, ignore this email; nobody can sign in without the code.
        Nomila will never ask you for this code.
      </p>
      <p style="font-size:13px;line-height:1.5;color:rgba(255,255,255,0.6);margin:12px 0 0;">${PASSWORD_NOTICE}</p>
    </div>
  </body>
</html>`;
  return { subject: `${code} is your Nomila code`, text, html };
}
