/**
 * bookings/common.ts — small shared helpers: coded errors, the buyer label she sees, her first name, time and money
 * formatting for notices, and the buyer page URLs.
 */
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { athletes } from "../../../shared/schema";
import { publicBaseUrl } from "../../lib/baseUrls";
import { buyerTokenFor } from "./tokens";
import { BOOKINGS } from "./config";

export type CodedError = Error & { code: string; detail?: unknown };

export function coded(code: string, detail?: unknown): CodedError {
  const err = new Error(code) as CodedError;
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** "Jordan Park" → "Jordan P." — the buyer as she sees them. Never contact details. */
export function buyerLabel(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Buyer";
  const first = parts[0].slice(0, 40);
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}

/** Her first name from her profile (first_name, else the first word of full_name). Never hard-coded. */
export async function athleteFirstName(athleteId: string): Promise<{ first: string; email: string | null }> {
  const [a] = await db.select({ first: athletes.first_name, full: athletes.full_name, email: athletes.email })
    .from(athletes).where(eq(athletes.id, athleteId)).limit(1);
  const first = a?.first?.trim() || a?.full?.trim().split(/\s+/)[0] || "Your athlete";
  return { first, email: a?.email ?? null };
}

/** "$177.96" / "$150" — two decimals only when there are cents (the one currency today is USD). */
export function usd(cents: number): string {
  const whole = cents % 100 === 0;
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

/** "Thu 12 Oct, 4:00 PM EDT" in the reader's time zone (the buyer's, given at request). */
export function formatWhen(at: Date | null, tz: string | null): string {
  if (!at) return "a time to be confirmed";
  const zone = validZone(tz) ?? "UTC";
  return at.toLocaleString("en-US", {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: zone, timeZoneName: "short",
  });
}

export function validZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}

/** The buyer's private booking page, or null when the hash secret isn't configured (nothing can be linked). */
export function buyerPageUrl(bookingId: string, suffix = ""): string | null {
  try { return `${publicBaseUrl()}/b/${buyerTokenFor(bookingId)}${suffix}`; } catch { return null; }
}

export function supportVars(): { support: string } {
  return { support: BOOKINGS.supportEmail };
}
