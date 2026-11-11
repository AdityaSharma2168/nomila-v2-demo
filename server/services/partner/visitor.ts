/**
 * partner/visitor.ts — who the visitor is, without an account (design §7a "Your requests", open question 24).
 *
 * A 6-digit code is emailed to an address Nomila already holds for a request (never one typed in for the first time),
 * 15 minutes, 5 tries. Passing it sets a signed, expiring cookie naming the email HASH, scoped to /r and /requests only
 * (the card pages stay cookie-free), remembered 30 days. The cookie opens: the thread on /r/:token for a request sent
 * from that address, and the list of that address's requests on /requests. The status link alone shows the steps only.
 */
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Request, Response } from "express";
import { db } from "../../db";
import { partnerRequests, partnerVisitorCodes, type PartnerRequest } from "../../../shared/schema";
import { take } from "../../lib/publicRateCounters";
import { PARTNER_TEMPLATES } from "../notify/templates/partner";
import { PARTNER } from "./config";
import { sendPartnerEmail } from "./links";
import { codeHash, emailHash, newCode, normEmail, readVisitorCheck, signVisitorCheck } from "./tokens";

export const VISITOR_COOKIE = "nomila_rq";
const COOKIE_PATHS = ["/r", "/requests"] as const;

/** The email hash the browser proved, or null. */
export function visitorEmailHash(req: Request): string | null {
  const raw = String(req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${VISITOR_COOKIE}=`));
  return readVisitorCheck(raw ? decodeURIComponent(raw.slice(VISITOR_COOKIE.length + 1)) : undefined);
}

export function rememberVisitor(res: Response, emailH: string, now: number = Date.now()): void {
  const value = signVisitorCheck(emailH, now + PARTNER.visitorCheckTtlMs);
  for (const path of COOKIE_PATHS) {
    res.cookie(VISITOR_COOKIE, value, { path, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: PARTNER.visitorCheckTtlMs });
  }
}

/**
 * Email a code to `email` if Nomila holds at least one request from it. The caller answers the same way either way
 * (no enumeration). Limited per address per hour.
 */
export async function sendVisitorCode(email: string, now: Date = new Date()): Promise<"sent" | "none" | "limited"> {
  const h = emailHash(email);
  if (!(await take(["code", h], PARTNER.limits.codesPerEmailHour, "hour", now))) return "limited";
  const [any] = await db.select({ id: partnerRequests.id, to: partnerRequests.contact_email }).from(partnerRequests)
    .where(and(eq(partnerRequests.contact_email_hash, h), eq(partnerRequests.status, "confirmed"))).limit(1);
  if (!any?.to) return "none";
  const code = newCode();
  await db.insert(partnerVisitorCodes).values({ email_hash: h, code_hash: codeHash(h, code), expires_at: new Date(now.getTime() + PARTNER.codeTtlMs), created_at: now });
  // Sent to the address ON FILE for the request (the same address, normalised), never to free input.
  await sendPartnerEmail(any.to, PARTNER_TEMPLATES.visitorCode, { code });
  return "sent";
}

/** Check a code for an email hash; true once (the code is spent). */
export async function checkVisitorCode(emailH: string, code: unknown, now: Date = new Date()): Promise<boolean> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return false;
  const [row] = await db.select().from(partnerVisitorCodes)
    .where(and(eq(partnerVisitorCodes.email_hash, emailH), isNull(partnerVisitorCodes.used_at), gt(partnerVisitorCodes.expires_at, now)))
    .orderBy(desc(partnerVisitorCodes.created_at)).limit(1);
  if (!row || row.attempts >= PARTNER.codeMaxAttempts) return false;
  if (row.code_hash !== codeHash(emailH, code)) {
    await db.update(partnerVisitorCodes).set({ attempts: row.attempts + 1 }).where(eq(partnerVisitorCodes.id, row.id));
    return false;
  }
  await db.update(partnerVisitorCodes).set({ used_at: now }).where(eq(partnerVisitorCodes.id, row.id));
  return true;
}

/** Every confirmed request sent from this address, newest activity first (all athletes: it is the visitor's list). */
export async function requestsForVisitor(emailH: string): Promise<PartnerRequest[]> {
  return db.select().from(partnerRequests)
    .where(and(eq(partnerRequests.contact_email_hash, emailH), eq(partnerRequests.status, "confirmed")))
    .orderBy(desc(partnerRequests.updated_at));
}

export const emailHashOf = (email: string): string => emailHash(normEmail(email));
