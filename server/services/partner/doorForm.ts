/**
 * partner/doorForm.ts — the NO-SCRIPT Partner form on her card (/p/:handle/partner), over the Partner door's own path.
 * It is where public Mila's partner tap lands (milaPort.ts → /p/:handle/partner?kind=…), and where anyone without
 * script files a request. Nothing new happens here: the form's fields go through parseDraftInput, createDraft and
 * sendForConfirmation exactly like the JSON door (routes/partnerPublic.ts), with the same spam controls:
 *
 *   honeypot + minimum fill time   answered like a success, nothing stored or sent
 *   drafts per visitor per day      the daily-salted IP hash counter (publicRateCounters)
 *   sends per email per athlete     inside sendForConfirmation
 *   the email confirm               the real gate: nothing reaches her until the visitor taps Send in that email
 *
 * Tenancy: the athlete is resolved from the HANDLE through the Partner door's published-card seam (publishedCard).
 * Copy is third person with her first name only.
 */
import { createLogger } from "../../logger";
import { take } from "../../lib/publicRateCounters";
import { PARTNER, partnerIntakeEnabled } from "./config";
import { KIND_MAP, isKind, type PartnerRequestKind } from "./kinds";
import { publishedCard } from "./publishedCard";
import { createDraft, parseDraftInput, sendForConfirmation } from "./requests";
import { visitorHash } from "./tokens";

const logger = createLogger("services/partner/doorForm");

/** The form's own field names (urlencoded strings), as render.ts draws them. */
export const DOOR_FORM_FIELDS = [
  "kind", "brand_name", "website", "idea", "goal", "budget", "timing_month", "agency", "client_brand",
  "topic", "format", "deadline", "contact_name", "contact_email", "website_confirm", "opened_at",
] as const;

export type DoorFormResult =
  | { status: "not_found" }
  | { status: "sent"; first: string; email: string }
  | { status: "invalid"; kind: PartnerRequestKind | null; error: string; field: string | null; values: Record<string, string> }
  | { status: "limited"; text: string };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The urlencoded form → the JSON door's body shape (parseDraftInput validates everything). */
export function formToDraftBody(f: Record<string, string>): Record<string, unknown> {
  const kind = f.kind;
  const press = isKind(kind) && KIND_MAP[kind].press;
  const base = { kind, brand_name: f.brand_name, website: f.website || null, contact_name: f.contact_name, contact_email: f.contact_email };
  if (press) return { ...base, topic: f.topic, format: f.format, deadline: f.deadline || null };
  return {
    ...base,
    idea: f.idea,
    goal: f.goal ? f.goal : null,
    budget: f.budget,
    timing: f.timing_month && MONTH.test(f.timing_month) ? { kind: "month", month: f.timing_month } : { kind: "flexible" },
    agency: f.agency === "on" || f.agency === "true",
    client_brand: f.client_brand || null,
  };
}

/** Only the form's own fields, as short strings (what the page may echo back into the form). */
export function formValues(body: unknown): Record<string, string> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of DOOR_FORM_FIELDS) {
    const v = b[k];
    if (typeof v === "string") out[k] = v.slice(0, 2_000);
  }
  return out;
}

export async function submitDoorForm(handle: string, body: unknown, ip: string | undefined, now: Date = new Date()): Promise<DoorFormResult> {
  if (!partnerIntakeEnabled()) return { status: "not_found" };
  const card = await publishedCard(handle);
  if (!card || !card.partnerOpen) return { status: "not_found" };
  const values = formValues(body);
  const kind = isKind(values.kind) ? values.kind : null;

  // Honeypot + minimum fill time: answer like a success, store nothing, send nothing.
  const openedAt = Number(values.opened_at);
  if ((values.website_confirm ?? "").trim() || (Number.isFinite(openedAt) && now.getTime() - openedAt < PARTNER.minFillMs)) {
    logger.info({ handle: card.handle }, "partner door form dropped by the spam check");
    return { status: "sent", first: card.firstName, email: values.contact_email ?? "" };
  }

  const parsed = parseDraftInput(formToDraftBody(values), card);
  if (!parsed.ok) return { status: "invalid", kind, error: parsed.error, field: parsed.field ?? null, values };

  if (!(await take(["draft-visitor", visitorHash(ip, now)], PARTNER.limits.draftsPerVisitorDay, "day", now))) {
    return { status: "limited", text: "Too many requests from here today. Please try again tomorrow." };
  }
  const { request } = await createDraft(card, parsed.input, now);
  const sent = await sendForConfirmation(request, { now });
  if (!sent.ok) return { status: "limited", text: sent.error };
  return { status: "sent", first: card.firstName, email: parsed.input.contactEmail };
}
