/**
 * partner/requests.ts — a request from her public profile, from the visitor's first tap to her board.
 *
 *   draft     createDraft(): the request card the visitor filled (commercial kinds) or the short press form. Status
 *             drafting; a random draft token is returned ONCE (the page keeps it in memory) and only its hash is stored.
 *   send      sendForConfirmation(): status awaiting_email and ONE transactional email with the confirm link. Nothing
 *             reaches her yet.
 *   confirm   confirmRequest(): the visitor opened the link and tapped Send. The request becomes a deal (source
 *             'public_profile', direction 'inbound', status 'detected', the kind's DealCategory + deal_type) with its
 *             thread on the opportunity (platform 'nomila', the request as the first inbound message), placed by
 *             placeNewDeal. Full brand research starts HERE, never before. The visitor gets the status page link.
 *   expire    expireUnconfirmed(): anything still unconfirmed 72h after it was drafted is expired.
 *
 * Spam controls: a honeypot field and a minimum fill time (silently dropped), database-backed limits per visitor (a
 * daily-salted IP hash) and per email per athlete per week, free-text fields refused when they carry contact details or
 * links (the relay's moderation check: "[First] replies here"), and the email-domain vs website match marker. The email
 * confirm is the main gate.
 *
 * Tenancy: every public call resolves the athlete from the HANDLE through the published card seam; a draft token only
 * ever opens the draft it was minted for, for that athlete.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../../db";
import { deals, inboxMessages, inboxThreads, partnerRequests, type PartnerRequest } from "../../../shared/schema";
import { getPartnerSettings } from "./settings";
import { createLogger } from "../../logger";
import { brandDomainOf } from "../../lib/senderProfile";
import { resolveBrand } from "../../lib/brandResolver";
import { brandIdentityGateEnabled } from "../../lib/brandIdentity";
import { inboxBodyFingerprint } from "../../lib/inboxBodyFingerprint";
import { placeNewDeal } from "../../skills/opportunities";
import { QUALIFICATION_VERSION } from "../../skills/dealQualification";
import { moderateMessage } from "../relay/moderation";
import { PARTNER_TEMPLATES, usd } from "../notify/templates/partner";
import { PARTNER } from "./config";
import { BUDGETS, GOALS, KIND_MAP, PRESS_FORMATS, PRESS_FORMAT_MEDIA_KIND, isKind, type Budget, type Goal, type PartnerRequestKind, type PressFormat } from "./kinds";
import type { PublishedCardFacts } from "./publishedCard";
import type { FitPreview } from "./fit";
import { confirmUrl, sendPartnerEmail, statusUrlFor } from "./links";
import { take } from "../../lib/publicRateCounters";
import { websiteDomain } from "./siteRead";
import { deriveToken, emailHash, normEmail, publicRef, randomToken, sealValid, sha256 } from "./tokens";

const logger = createLogger("services/partner/requests");

/** Where the request lands in the existing vocabularies (thread classification + deal_type). */
export const NOMILA_PLATFORM = "nomila";

// ─── Input ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type Timing =
  | { kind: "month"; month: string }           // "2026-11"
  | { kind: "range"; from: string; to: string } // "2026-11-01" … "2026-12-15"
  | { kind: "flexible" };

export interface CommercialBrief {
  goal: Goal | null;
  idea: string;
  timing: Timing;
  budget: Budget;
  agency: boolean;
  client_brand: string | null;
}
export interface PressBrief {
  topic: string;
  format: PressFormat;
  deadline: string | null; // YYYY-MM-DD
}
export type Brief = ({ type: "commercial" } & CommercialBrief) | ({ type: "press" } & PressBrief);

export interface DraftInput {
  kind: PartnerRequestKind;
  website: string | null;
  domain: string | null;
  brandName: string;
  brief: Brief;
  contactName: string;
  contactEmail: string;
  fit: FitPreview | null;
}

export type ParseResult = { ok: true; input: DraftInput } | { ok: false; status: 400; error: string; field?: string };

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : null;
};
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function parseTiming(v: any): Timing | null {
  if (v == null || v?.kind === "flexible") return { kind: "flexible" };
  if (v?.kind === "month" && typeof v.month === "string" && MONTH.test(v.month)) return { kind: "month", month: v.month };
  if (v?.kind === "range" && ISO_DATE.test(v.from ?? "") && ISO_DATE.test(v.to ?? "") && v.from <= v.to) return { kind: "range", from: v.from, to: v.to };
  return null;
}

/** "[First] replies here": free text may not carry contact details, payment asks or links. */
function clean(field: string, value: string | null): { field: string } | null {
  return value && moderateMessage(value).state !== "clean" ? { field } : null;
}

/** A name may look like a domain ("Brand.io"), but never carries an address, a number, a handle or a scam. */
function nameCarriesContact(name: string): boolean {
  const v = moderateMessage(name);
  return v.state === "blocked" || v.reasons.some((r) => r !== "link");
}

/** Validate a draft against the kind's form. The fit preview is accepted only with its server seal, for THIS card. */
export function parseDraftInput(body: any, card: PublishedCardFacts): ParseResult {
  const bad = (error: string, field?: string): ParseResult => ({ ok: false, status: 400, error, ...(field ? { field } : {}) });
  if (!isKind(body?.kind)) return bad("choose what kind of request this is", "kind");
  const kind: PartnerRequestKind = body.kind;
  const press = KIND_MAP[kind].press;

  const contactName = str(body.contact_name, 120);
  if (!contactName) return bad("add your name", "contact_name");
  const email = typeof body.contact_email === "string" ? normEmail(body.contact_email) : "";
  if (!EMAIL.test(email) || email.length > 254) return bad("add a work email we can reach you at", "contact_email");
  const brandName = str(body.brand_name, 120);
  if (!brandName) return bad(press ? "add the outlet's name" : "add your brand's name", "brand_name");

  const rawSite = typeof body.website === "string" && body.website.trim() ? body.website : null;
  const domain = rawSite ? websiteDomain(rawSite) : null;
  if (rawSite && !domain) return bad("that doesn't look like a website", "website");
  if (!press && !domain) return bad("add your brand's website", "website");

  let brief: Brief;
  if (press) {
    const topic = str(body.topic, 600);
    if (!topic) return bad("add what the piece is about", "topic");
    if (!(PRESS_FORMATS as readonly string[]).includes(body.format)) return bad("choose a format", "format");
    const deadline = body.deadline == null || body.deadline === "" ? null : (ISO_DATE.test(String(body.deadline)) ? String(body.deadline) : undefined);
    if (deadline === undefined) return bad("that deadline isn't a date", "deadline");
    brief = { type: "press", topic, format: body.format, deadline };
  } else {
    const idea = str(body.idea, 1_500);
    if (!idea || idea.length < 10) return bad("say a little about the idea", "idea");
    const goal = body.goal == null ? null : (GOALS as readonly string[]).includes(body.goal) ? (body.goal as Goal) : undefined;
    if (goal === undefined) return bad("choose a goal", "goal");
    const timing = parseTiming(body.timing);
    if (!timing) return bad("that timing isn't a month or a date range", "timing");
    const budget = typeof body.budget === "string" && body.budget in BUDGETS ? (body.budget as Budget) : null;
    if (!budget) return bad("choose a budget range, or not sure", "budget");
    const agency = body.agency === true;
    const clientBrand = agency ? str(body.client_brand, 120) : null;
    brief = { type: "commercial", goal, idea, timing, budget, agency, client_brand: clientBrand };
  }

  const dirty = clean("idea", brief.type === "commercial" ? brief.idea : null)
    ?? clean("topic", brief.type === "press" ? brief.topic : null)
    ?? (nameCarriesContact(contactName) ? { field: "contact_name" } : null)
    ?? (nameCarriesContact(brandName) ? { field: "brand_name" } : null)
    ?? (brief.type === "commercial" && brief.client_brand && nameCarriesContact(brief.client_brand) ? { field: "client_brand" } : null);
  if (dirty) return bad(`please leave out contact details, payment details and links — ${card.firstName} replies to you here`, dirty.field);

  let fit: FitPreview | null = null;
  if (!press && body.fit?.preview) {
    const p = body.fit.preview;
    if (p?.domain !== domain || p?.version !== card.version || !sealValid({ athleteId: card.athleteId, preview: p }, body.fit.seal)) {
      return bad("the first read is out of date; ask for it again", "fit");
    }
    fit = p as FitPreview;
  }
  return { ok: true, input: { kind, website: rawSite ? String(rawSite).trim().slice(0, 300) : null, domain, brandName, brief, contactName, contactEmail: email, fit } };
}

// ─── Draft ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SeriousOfferAvailability { available: boolean; amountCents: number | null }

/** Her Serious offer setting as a visitor may see it (never shown on the public card; only at the hold step). */
export async function seriousOfferFor(athleteId: string, kind: PartnerRequestKind): Promise<SeriousOfferAvailability> {
  if (KIND_MAP[kind].press) return { available: false, amountCents: null };
  const s = await getPartnerSettings(athleteId);
  return s.serious_offer_enabled ? { available: true, amountCents: s.serious_offer_cents } : { available: false, amountCents: null };
}

export async function createDraft(card: PublishedCardFacts, input: DraftInput, now: Date = new Date()): Promise<{
  request: PartnerRequest; draftToken: string;
}> {
  const draftToken = randomToken();
  const emailDomain = brandDomainOf(input.contactEmail.slice(input.contactEmail.lastIndexOf("@") + 1));
  const match = !!(emailDomain && input.domain && emailDomain === input.domain);
  // A ref collision (6 chars, 32 symbols) is retried; the unique index is the arbiter.
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await db.insert(partnerRequests).values({
        athlete_id: card.athleteId, public_ref: publicRef(), kind: input.kind, status: "drafting",
        snapshot_version: card.version, website: input.website, domain: input.domain, brand_name: input.brandName,
        display_name: card.firstName, site_meta: null, fit_preview: input.fit, brief: input.brief,
        contact_name: input.contactName, contact_email: input.contactEmail, contact_email_hash: emailHash(input.contactEmail),
        email_domain_match: match, draft_token_hash: sha256(draftToken), token_nonce: randomToken(16),
        expires_at: new Date(now.getTime() + PARTNER.unconfirmedTtlMs), created_at: now, updated_at: now,
      }).returning();
      return { request: row, draftToken };
    } catch (err: any) {
      if (attempt < 3 && /partner_requests_public_ref_uq/.test(String(err?.message ?? err?.cause?.message ?? ""))) continue;
      throw err;
    }
  }
}

/** The draft this token opens, for this card's athlete, still unconfirmed and unexpired. */
export async function openDraft(card: PublishedCardFacts, id: unknown, draftToken: unknown, now: Date = new Date()): Promise<PartnerRequest | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || typeof draftToken !== "string" || !draftToken) return null;
  const [row] = await db.select().from(partnerRequests).where(and(
    eq(partnerRequests.id, id), eq(partnerRequests.athlete_id, card.athleteId), eq(partnerRequests.draft_token_hash, sha256(draftToken)),
    inArray(partnerRequests.status, ["drafting", "awaiting_email"]),
  )).limit(1);
  if (!row || new Date(row.expires_at).getTime() <= now.getTime()) return null;
  return row;
}

// ─── Send (email confirm) ──────────────────────────────────────────────────────────────────────────────────────

export type SendResult = { ok: true; status: "awaiting_email" } | { ok: false; status: 429; error: string };

/**
 * Ask the visitor to confirm by email. At most PARTNER.limits.sendsPerEmailAthleteWeek per email per athlete per week
 * (re-sending the same request counts too). `holdCents` names a placed Serious offer hold in the email.
 */
export async function sendForConfirmation(row: PartnerRequest, opts: { holdCents?: number | null; now?: Date } = {}): Promise<SendResult> {
  const now = opts.now ?? new Date();
  if (!(await take(["send", row.athlete_id, row.contact_email_hash], PARTNER.limits.sendsPerEmailAthleteWeek, "week", now))) {
    return { ok: false, status: 429, error: `You've sent ${row.display_name} several requests this week. Please wait for a reply.` };
  }
  const token = deriveToken("confirm", row.id, row.token_nonce);
  await db.update(partnerRequests).set({ status: "awaiting_email", confirm_token_hash: sha256(token), sent_at: now, updated_at: now })
    .where(eq(partnerRequests.id, row.id));
  if (row.contact_email) {
    const vars = { first: row.display_name, ref: row.public_ref, link: confirmUrl(token) };
    await sendPartnerEmail(row.contact_email, opts.holdCents ? PARTNER_TEMPLATES.confirmWithHold : PARTNER_TEMPLATES.confirm,
      opts.holdCents ? { ...vars, hold: usd(opts.holdCents) } : vars);
  }
  return { ok: true, status: "awaiting_email" };
}

/**
 * The Serious-offer hold was placed (Stripe webhook): the visitor's "Add $X hold · send" tap also asks them to confirm
 * by email. Only while the request is still a draft; the confirm email names the hold.
 */
export async function sendHeldRequestForConfirmation(requestId: string, holdCents: number | null, now: Date = new Date()): Promise<void> {
  const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.id, requestId)).limit(1);
  if (!row || row.status !== "drafting" || new Date(row.expires_at).getTime() <= now.getTime()) return;
  const r = await sendForConfirmation(row, { holdCents, now });
  if (!r.ok) logger.warn({ requestId }, "held request not sent: weekly limit — the hold is released when the request expires");
}

// ─── Confirm (lands on her board) ──────────────────────────────────────────────────────────────────────────────

export type ConfirmLookup = { row: PartnerRequest; state: "ready" | "already" | "expired" } | null;

export async function findByConfirmToken(token: unknown, now: Date = new Date()): Promise<ConfirmLookup> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.confirm_token_hash, sha256(token))).limit(1);
  if (!row) return null;
  if (row.status === "confirmed") return { row, state: "already" };
  if (row.status !== "awaiting_email" || new Date(row.expires_at).getTime() <= now.getTime()) return { row, state: "expired" };
  return { row, state: "ready" };
}

/** The request as her thread's first message: plain lines Nomila composed from the form (no visitor markup). */
export function requestMessageBody(row: Pick<PartnerRequest, "kind" | "brand_name" | "domain" | "brief" | "fit_preview" | "contact_name">): string {
  const b = row.brief as Brief;
  const k = KIND_MAP[row.kind as PartnerRequestKind];
  const lines: string[] = [`${k.label} request from ${row.brand_name}${row.domain ? ` (${row.domain})` : ""}, sent from your public card.`];
  if (b.type === "press") {
    lines.push(`Format: ${b.format}`, `About: ${b.topic}`);
    if (b.deadline) lines.push(`Deadline: ${b.deadline}`);
  } else {
    if (b.goal) lines.push(`Goal: ${b.goal.replace(/_/g, " ")}`);
    lines.push(`Idea: ${b.idea}`);
    lines.push(`Timing: ${b.timing.kind === "flexible" ? "flexible" : b.timing.kind === "month" ? b.timing.month : `${b.timing.from} to ${b.timing.to}`}`);
    lines.push(`Budget: ${BUDGETS[b.budget].label}`);
    if (b.agency) lines.push(`Sent by an agency${b.client_brand ? ` for ${b.client_brand}` : ""}.`);
  }
  const fit = row.fit_preview as FitPreview | null;
  if (fit?.lines?.length) lines.push("", fit.label, ...fit.lines.map((l) => `· ${l.text}`));
  if (row.contact_name) lines.push("", `From ${row.contact_name}. Replies go through Nomila; their email stays private.`);
  return lines.join("\n");
}

/** The one-line ask on her card (the board's `ask`). */
export function askLine(row: Pick<PartnerRequest, "kind" | "brief">): string {
  const b = row.brief as Brief;
  return (b.type === "press" ? b.topic : b.idea).slice(0, 160);
}

/**
 * The visitor tapped Send on the confirm page. Idempotent: a second tap on a confirmed request returns it as is.
 * Returns the status token (derived, not stored) for the redirect.
 */
export async function confirmRequest(row: PartnerRequest, now: Date = new Date()): Promise<{ request: PartnerRequest; statusToken: string; dealId: string }> {
  const statusToken = deriveToken("status", row.id, row.token_nonce);
  if (row.status === "confirmed" && row.deal_id) return { request: row, statusToken, dealId: row.deal_id };

  const k = KIND_MAP[row.kind as PartnerRequestKind];
  const b = row.brief as Brief;
  // Brand resolution is a DB lookup / insert only (same name or same domain, else a new row). For an agency request
  // the advertiser is the client brand when named; research waits for the identity gate below.
  const advertiserName = b.type === "commercial" && b.agency && b.client_brand ? b.client_brand : row.brand_name;
  const brand = await resolveBrand({ domain: b.type === "commercial" && b.agency && b.client_brand ? null : row.domain, brandName: advertiserName });
  const brandId = brand?.brand_id ?? null;
  const subject = `${k.label} · ${row.brand_name}`;
  const body = requestMessageBody(row);

  const result = await db.transaction(async (tx) => {
    // Re-read under lock: two taps race to one deal.
    const [fresh] = await tx.select().from(partnerRequests).where(eq(partnerRequests.id, row.id)).for("update").limit(1);
    if (!fresh) throw new Error("request vanished");
    if (fresh.status === "confirmed" && fresh.deal_id) return { request: fresh, dealId: fresh.deal_id, threadId: fresh.inbox_thread_id, created: false };
    if (fresh.status !== "awaiting_email") throw Object.assign(new Error("not confirmable"), { code: "NOT_CONFIRMABLE" });

    const [deal] = await tx.insert(deals).values({
      athlete_id: fresh.athlete_id, brand_id: brandId, brand_name: advertiserName, deal_type: k.dealType, status: "detected",
      detected_at: now, source: "public_profile", direction: "inbound",
      raw_data: {
        partner_request_id: fresh.id, kind: fresh.kind, summary: askLine(fresh), contact_name: fresh.contact_name,
        contact_email: fresh.contact_email, deadline: b.type === "press" ? b.deadline : (b.timing.kind === "range" ? b.timing.to : null),
        deliverables: [],
      },
    }).returning({ id: deals.id });

    const qualification = k.press ? "needs_terms" : (b.type === "commercial" && b.budget !== "not_sure" ? "workable" : "needs_terms");
    const [thread] = await tx.insert(inboxThreads).values({
      athlete_id: fresh.athlete_id, brand_id: brandId, subject, last_message_at: now, message_count: 1, status: "deal_detected",
      deal_id: deal.id, external_thread_id: `nomila:partner:${fresh.id}`,
      classification: {
        category: k.category, ...(k.press && b.type === "press" ? { media_kind: PRESS_FORMAT_MEDIA_KIND[b.format] } : {}),
        is_deal: true, confidence: 1, source: "public_profile", partner_request_kind: fresh.kind,
        brand_name: advertiserName, brand_domain: fresh.domain, advertiser: advertiserName,
        agency_name: b.type === "commercial" && b.agency && b.client_brand ? fresh.brand_name : null,
        via_agency: b.type === "commercial" && b.agency,
        channel: b.type === "commercial" && b.agency ? "agency" : "direct",
        qualification, qualification_version: QUALIFICATION_VERSION,
        qualification_reason: k.press ? "A press request sent from your public card." : "A request sent from your public card, confirmed by email.",
        summary: askLine(fresh),
      },
      summary: askLine(fresh),
      conversation_state: { key_details: { ask: askLine(fresh), awaiting_response_from: "athlete" } },
    }).returning({ id: inboxThreads.id });

    await tx.insert(inboxMessages).values({
      thread_id: thread.id, athlete_id: fresh.athlete_id, sender_email: fresh.contact_email, sender_name: fresh.contact_name,
      direction: "inbound", subject, body, body_sha256: inboxBodyFingerprint(body), received_at: now,
      external_message_id: `nomila:${fresh.id}:request`, platform: NOMILA_PLATFORM, moderation: "clean",
    });

    const [updated] = await tx.update(partnerRequests).set({
      status: "confirmed", confirmed_at: now, deal_id: deal.id, inbox_thread_id: thread.id,
      status_token_hash: sha256(statusToken), reply_token_hash: sha256(deriveToken("reply", fresh.id, fresh.token_nonce)),
      updated_at: now,
    }).where(eq(partnerRequests.id, fresh.id)).returning();
    return { request: updated, dealId: deal.id, threadId: thread.id, created: true };
  });

  if (result.created && result.threadId) {
    // Never throws; a separate engagement from her other threads with this brand (no model call on a form submission).
    await placeNewDeal({ athleteId: result.request.athlete_id, dealId: result.dealId, threadId: result.threadId, brandId, forceNew: true });
    await startBrandResearch(brand, advertiserName);
    if (result.request.contact_email) {
      await sendPartnerEmail(result.request.contact_email, PARTNER_TEMPLATES.received, { first: result.request.display_name, ref: result.request.public_ref, link: statusUrlFor(result.request) });
    }
    logger.info({ athleteId: result.request.athlete_id, requestId: result.request.id, dealId: result.dealId, kind: result.request.kind }, "partner request confirmed — landed on her board");
  }
  return { request: result.request, statusToken, dealId: result.dealId };
}

/** Full brand research, only after a confirmed contact (design §6: the cost and abuse control). The research runs on its own. */
async function startBrandResearch(brand: Awaited<ReturnType<typeof resolveBrand>>, name: string): Promise<void> {
  const target = brandIdentityGateEnabled()
    ? (brand && !brand.unresolved && brand.brand_domain ? { name: brand.brand_name, domain: brand.brand_domain } : null)
    : { name, domain: brand?.brand_domain ?? null };
  if (!target) return;
  try {
    const { getOrResearchBrand } = await import("../brandIntel.js");
    void getOrResearchBrand(target.name ?? "", target.domain).catch((err: any) => logger.warn({ error: err?.message }, "brand research after partner request failed"));
  } catch (err: any) { logger.warn({ error: err?.message }, "brand research not started"); }
}

// ─── Expiry ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Unconfirmed requests past their 72h: expired. Their holds are released by the payments sweep (same clock). */
export async function expireUnconfirmed(now: Date = new Date()): Promise<number> {
  const rows = await db.update(partnerRequests).set({ status: "expired", updated_at: now })
    .where(and(inArray(partnerRequests.status, ["drafting", "awaiting_email"]), lt(partnerRequests.expires_at, now)))
    .returning({ id: partnerRequests.id });
  return rows.length;
}

// ─── The visitor's status page ─────────────────────────────────────────────────────────────────────────────────

/** The confirmed request behind a status-page token, or null (unknown, or never confirmed). */
export async function findByStatusToken(token: unknown): Promise<PartnerRequest | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const [row] = await db.select().from(partnerRequests).where(eq(partnerRequests.status_token_hash, sha256(token))).limit(1);
  return row && row.status === "confirmed" ? row : null;
}

export interface StatusStep { label: string; state: "done" | "now" | "todo"; at: string | null }

const day = (d: Date | string | null): string | null =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;

/**
 * The page's steps (design §6): Received → [First] is reviewing (the day only) → [First] replied, or "[First] has
 * passed on this one" (only after her Decline tap), or agreed.
 */
export function statusSteps(row: PartnerRequest): StatusStep[] {
  const first = row.display_name;
  const steps: StatusStep[] = [{ label: "Received", state: "done", at: day(row.confirmed_at) }];
  const seen = !!row.brief_seen_at;
  const replied = !!row.first_reply_at;
  if (row.outcome === "declined") {
    steps.push({ label: `${first} has passed on this one. Thank you for thinking of ${first}.`, state: "now", at: day(row.decided_at) });
    return steps;
  }
  steps.push({ label: `${first} is reviewing`, state: seen ? (replied || row.outcome ? "done" : "now") : "todo", at: day(row.brief_seen_at) });
  if (row.outcome === "agreed") {
    steps.push({ label: `${first} replied`, state: "done", at: day(row.first_reply_at) });
    steps.push({ label: `${first} agreed`, state: "now", at: day(row.decided_at) });
  } else {
    steps.push({ label: `${first} replied`, state: replied ? "now" : "todo", at: day(row.first_reply_at) });
  }
  if (!seen && !replied && steps[1].state === "todo") steps[0].state = "now";
  return steps;
}
