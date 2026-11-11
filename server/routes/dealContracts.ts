/**
 * dealContracts — the athlete uploads a deal we never saw.
 *
 * WHY THIS EXISTS. Every deal in this system arrived by us reading her mail, so a deal
 * that never touched her inbox could not exist at all. Mia's adidas endorsement — signed,
 * five-figure, running 2023–2028 — was invisible to her own app for exactly that reason:
 * not missed by the detector, simply unreachable by it. She had no way to hand it over.
 *
 * THREE STEPS, DELIBERATELY. Mint a signed URL, extract, then create — rather than one
 * upload-and-go endpoint:
 *
 *   1. upload-url  the client PUTs bytes straight to GCS. A contract is the largest thing
 *                  she will ever send us and the least interesting to proxy; routing it
 *                  through Cloud Run buys nothing but memory pressure and a timeout.
 *   2. extract     reads the PDF and PROPOSES fields. Writes nothing. This is the step
 *                  that earns the row its provenance — a contract she reviewed is her
 *                  claim, not a model's guess, and the figure flows into her commercial
 *                  capital either way.
 *   3. create      writes the deal from what she confirmed.
 *
 * Step 2 can fail and step 3 still works: she types the fields herself. Extraction is an
 * accelerator, never a dependency.
 */

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../db";
import { deals, dealPeriods, dealInstallments, inboxMessages, inboxThreads, inboxBrands } from "../../shared/schema";
import { requireAuth } from "../lib/auth";
import { and, eq, isNull, sql } from "drizzle-orm";
import { containsPattern } from "../lib/likePattern";
import { threadOnDeal } from "../lib/dealAttachmentScope";
import {
  contractObjectPath,
  signedAttachmentUploadUrl,
  getAttachment,
  MAX_ATTACHMENT_BYTES,
} from "../lib/inboxAttachmentStore";
import { extractContract, promoteToDeal, contractToPeriodRows, inferDealType, coerce, type ContractExtract } from "../services/contractExtract";
import { resolveBrand } from "../lib/brandResolver";
import { scanContract } from "../services/contractBrandScan";
import { resolveMoneyForDeals } from "../services/dealValueStore";
import { adoptGroupForNewDeal } from "../skills/dealGrouping";
import { createLogger } from "../logger";
import { getMailboxAdapter, isMailboxError, withMailboxRetry } from "../lib/mailbox";
import { messageRefOf } from "../lib/mailbox/refs";
import { unavailableMessage } from "../services/liveConversation";
import { notifyPlanEvent } from "../agent/plan/triggers";

const router = Router();
const logger = createLogger("routes/deal-contracts");

/**
 * What a contract actually arrives as.
 *
 * PDF-only was never the real world: a contract reaches an athlete as a scan, a photo of a
 * page, or a Word file her agent sent. The model reads images natively, so a photograph is
 * a first-class input rather than a workaround — and a scanned PDF, which has no text layer
 * and used to fail with "no text in that PDF", now goes down the same path.
 */
const IMAGE_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif",
]);
const ALLOWED_TYPES = new Set<string>(["application/pdf", ...IMAGE_TYPES]);

/**
 * The deal taxonomy, mirroring the `deals_type_check` CHECK constraint in the database
 * (see `deals` in shared/schema.ts). Anything outside this list is rejected here with a 400
 * rather than travelling on to become a constraint violation and a generic 500.
 */
const ALLOWED_DEAL_TYPES = [
  "social_post",
  "appearance",
  "ambassador",
  "autograph",
  "licensing",
  "other",
] as const;

/**
 * An uploaded contract is an endorsement agreement, and in this taxonomy that is an
 * `ambassador` deal — there is no "endorsement" member, and inventing one is what kept
 * this endpoint from ever writing a row.
 */
const DEFAULT_DEAL_TYPE = "ambassador";

/**
 * Only ever touch objects under THIS athlete's contract prefix — the path we minted.
 * Mirrors the media upload check: the client tells us where it wrote, so the server must
 * not take its word for whose object that is.
 */
function ownsPath(athleteId: string, gcsPath: unknown): gcsPath is string {
  return typeof gcsPath === "string" && gcsPath.startsWith(`athletes/${athleteId}/contracts/`);
}

// Bounded, and a non-number is a refusal rather than a silent null. A client sending
// "20000" as a string used to yield a deal worth nothing; a negative or a 1e15 passed
// straight through into commercial capital and, via escrow, into what a brand is charged.
const MAX_AMOUNT = 50_000_000;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_AMOUNT ? v : null;
const day = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

/** A uuid, as the path params arrive. Local: deals.ts keeps its own and exports neither. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string): boolean => UUID_RE.test(v);

/** One period as SHE confirmed it on the review screen — dollars, not cents. */
export interface ConfirmedPeriod {
  label: string | null; starts_on: string | null; ends_on: string | null;
  cash: number | null; product: number | null; product_directed: number | null;
  conditional: boolean; condition: string | null; source_quote: string | null;
}

/**
 * The schedule off a request body, validated. Shared so the two write paths — creating a
 * deal and attaching terms to one — cannot disagree about what a period is.
 */
function readConfirmedPeriods(b: any): ConfirmedPeriod[] {
  return Array.isArray(b?.periods)
    ? b.periods.map((r: any) => ({
        label:            typeof r?.label === "string" ? r.label : null,
        starts_on:        day(r?.starts_on),
        ends_on:          day(r?.ends_on),
        cash:             num(r?.cash),
        product:          num(r?.product),
        product_directed: num(r?.product_directed),
        conditional:      r?.conditional === true,
        condition:        typeof r?.condition === "string" ? r.condition : null,
        source_quote:     typeof r?.source_quote === "string" ? r.source_quote : null,
      }))
    : [];
}

/**
 * What a deal says about itself RIGHT NOW, so the review screen can show what a
 * contract is about to change.
 *
 * Null when the deal has no schedule — a first contract replaces nothing, and a diff
 * against an absence is just the form itself.
 */
export interface CurrentTerms {
  cashCents:        number | null;
  productCents:     number | null;
  termStart:        string | null;
  termEnd:          string | null;
  periodCount:      number;
  installmentCount: number;
}

/**
 * The live figures for one deal, or null when it has none.
 *
 * Reads the resolver rather than deals.amount: that column is a snapshot written once
 * at detection and dealVoice already refuses to speak it, so diffing against it would
 * show her a change that had already happened months ago.
 */
async function currentTerms(dealId: string): Promise<CurrentTerms | null> {
  const [row] = await db
    .select({ term_start: deals.term_start, term_end: deals.term_end })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (!row) return null;

  const money = (await resolveMoneyForDeals([dealId])).get(dealId) ?? null;
  // Instalments hang off periods, so they are counted through the live ones rather than
  // guessed from the resolver's totals.
  const [{ n: instalments }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(dealInstallments)
    .innerJoin(dealPeriods, eq(dealPeriods.id, dealInstallments.period_id))
    .where(and(eq(dealPeriods.deal_id, dealId), isNull(dealPeriods.superseded_at)));
  const cur = money?.currentPeriod ?? null;
  const hasAnything = money != null || row.term_start != null || row.term_end != null;
  if (!hasAnything) return null;

  return {
    cashCents:        cur?.cash_cents ?? null,
    productCents:     cur?.product_cents ?? null,
    termStart:        row.term_start ?? null,
    termEnd:          row.term_end ?? null,
    periodCount:      money?.periodCount ?? 0,
    installmentCount: instalments,
  };
}

/**
 * The answer both extract entry points give.
 *
 * `readable` and `parsed` stay separate on purpose. We read the document but the
 * model's answer did not survive means marker-derived facts stand while every figure
 * is absent — collapsing the two let a dead model look like a contract stating no
 * money, and the athlete could save a signed deal worth null.
 */
function extractPayload(
  result: Awaited<ReturnType<typeof extractContract>>,
  current: CurrentTerms | null = null,
) {
  if (result.status === "unreadable") {
    // A scan with no text layer lands here. Not an error — she fills the form herself.
    return { readable: false, parsed: false, extract: null, suggested: null,
             dealType: null, dealTypeReason: null, reason: result.reason, current };
  }
  const parsed = result.status === "parsed";
  return {
    readable:  true,
    parsed,
    reason:    result.status === "unparsed" ? result.reason : null,
    extract:   result.extract,
    suggested: parsed ? promoteToDeal(result.extract) : null,
    // Proposed, never imposed. deal_type picks which rate the deal is benchmarked
    // against, and it now comes from the model's reading of the whole document rather
    // than from how long the term runs.
    dealType:  parsed ? inferDealType(result.extract) : null,
    // The model's one-sentence reason, shown beside the type so she can judge it.
    dealTypeReason: parsed ? result.extract.deal_type_reason : null,
    // What she is about to replace. Null on a deal with nothing to replace.
    current,
  };
}

/**
 * Write a confirmed schedule. Hers if she gave us any; the extract only when she
 * confirmed nothing. Never throws — a schedule we failed to write is a reduced deal,
 * not a lost one, and losing the contract she just reviewed because one period row was
 * malformed would be the worse outcome.
 */
async function writePeriods(
  dealId: string,
  confirmedPeriods: ConfirmedPeriod[],
  safeContract: ContractExtract | null,
): Promise<number> {
  let count = 0;
  try {
    const rows = confirmedPeriods.length
      ? confirmedPeriods.map((r, i) => ({
          seq: i + 1, label: r.label, starts_on: r.starts_on, ends_on: r.ends_on,
          cash_cents:             r.cash             == null ? null : Math.round(r.cash * 100),
          product_cents:          r.product          == null ? null : Math.round(r.product * 100),
          product_directed_cents: r.product_directed == null ? null : Math.round(r.product_directed * 100),
          guaranteed: !r.conditional, condition: r.condition, source_quote: r.source_quote,
          installments: [] as Array<{ seq: number; amount_cents: number | null; due_on: string | null; derived: boolean }>,
        }))
      : safeContract ? contractToPeriodRows(safeContract) : [];
    for (const r of rows) {
      const [row] = await db.insert(dealPeriods).values({
        deal_id: dealId, seq: r.seq, label: r.label,
        starts_on: r.starts_on, ends_on: r.ends_on,
        cash_cents: r.cash_cents, product_cents: r.product_cents,
        product_directed_cents: r.product_directed_cents,
        guaranteed: r.guaranteed, condition: r.condition, source_quote: r.source_quote,
      }).returning({ id: dealPeriods.id });
      count++;
      for (const inst of r.installments) {
        await db.insert(dealInstallments).values({
          period_id: row.id, seq: inst.seq, amount_cents: inst.amount_cents,
          due_on: inst.due_on, derived: inst.derived,
        });
      }
    }
  } catch (err: any) {
    logger.warn({ dealId, error: err.message?.slice(0, 160) }, "period write failed");
  }
  return count;
}

/**
 * The attachment at (messageId, index), only if it rides a thread on THIS athlete's
 * deal. One query, so a guessed messageId from another tenant cannot resolve.
 *
 * Deliberately not ownsPath: that gate is `athletes/<id>/contracts/`, and widening it to
 * cover the inbox tree would let a client name any object under her prefix. The path is
 * looked up here instead of being sent.
 *
 * "On this deal" (docs/design/brand-page-deals.md D3): the deal's own thread, a paperwork thread
 * matched to it (an e-sign "Completed" carries the signed PDF), or a thread of another deal in the
 * SAME opportunity (a pre-#777 e-sign pseudo-deal holds it). Every branch is hers: the message, the
 * thread and both deals are filtered by athlete.
 */
async function attachmentOnDeal(athleteId: string, dealId: string, messageId: string, index: number) {
  const [row] = await db
    .select({
      attachments:          inboxMessages.attachments,
      platform:             inboxMessages.platform,
      connected_account_id: inboxMessages.connected_account_id,
      external_message_id:  inboxMessages.external_message_id,
    })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxThreads.id, inboxMessages.thread_id))
    .where(and(
      eq(inboxMessages.id, messageId),
      eq(inboxMessages.athlete_id, athleteId),
      threadOnDeal(athleteId, dealId),
    ))
    .limit(1);
  const attachment = row?.attachments?.[index];
  return attachment ? { ...attachment, message: row! } : null;
}

/**
 * The bytes of an attachment on her deal: the rehosted object when there is one, else
 * read LIVE from the mailbox (mail ingested under MAILBOX_LIVE_READS is not rehosted).
 * Nothing is stored here — a contract is kept only when she saves it.
 */
async function attachmentBytes(
  attachment: NonNullable<Awaited<ReturnType<typeof attachmentOnDeal>>>,
): Promise<{ buf: Buffer | null; unavailable?: string }> {
  if (attachment.gcs_path) return { buf: await getAttachment(attachment.gcs_path) };
  const ref = attachment.attachment_ref ? messageRefOf(attachment.message) : null;
  const adapter = ref ? await getMailboxAdapter(ref.provider) : null;
  if (!ref || !adapter || !attachment.attachment_ref) return { buf: null };
  try {
    const got = await withMailboxRetry(() =>
      adapter.fetchAttachment(ref.accountId, ref.messageRef, attachment.attachment_ref!, { maxBytes: MAX_ATTACHMENT_BYTES }),
    );
    return got.kind === "bytes" ? { buf: got.bytes } : { buf: null, unavailable: "That file can't be downloaded from your mailbox" };
  } catch (err) {
    if (!isMailboxError(err)) throw err;
    return { buf: null, unavailable: unavailableMessage(err.kind, ref.provider) };
  }
}

// POST /api/v1/me/deals/contract/upload-url — mint a durable path + short-lived signed WRITE url.
// Body: { filename, contentType, bytes? }
router.post("/deals/contract/upload-url", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { filename, contentType, bytes } = req.body ?? {};
  const ct = String(contentType ?? "").split(";")[0].trim();

  if (!ALLOWED_TYPES.has(ct)) { res.status(415).json({ error: "Upload a PDF or a photo of the contract" }); return; }
  if (typeof bytes === "number" && bytes > MAX_ATTACHMENT_BYTES) {
    res.status(413).json({ error: `Too large — max ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB` });
    return;
  }

  try {
    const uploadId  = randomUUID();
    const gcsPath   = contractObjectPath(athleteId, uploadId, String(filename ?? "contract.pdf"));
    const uploadUrl = await signedAttachmentUploadUrl(gcsPath, ct);
    res.json({ uploadId, gcsPath, uploadUrl, contentType: ct });
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "contract upload-url mint failed");
    res.status(500).json({ error: "Failed to start upload" });
  }
});

// POST /api/v1/me/deals/contract/extract — read an uploaded PDF and propose the deal.
// Writes nothing. Body: { gcsPath }
router.post("/deals/contract/extract", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { gcsPath, dealId } = req.body ?? {};
  if (!ownsPath(athleteId, gcsPath)) { res.status(400).json({ error: "Invalid gcsPath" }); return; }

  // Optional, and only ever HERS. By this point she has said where the contract goes, so
  // the answer can carry what that deal holds today — which is the only way the review
  // screen can show her what a contract is about to change.
  let current: CurrentTerms | null = null;
  if (typeof dealId === "string" && isUuid(dealId)) {
    const [owned] = await db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
      .limit(1);
    if (owned) current = await currentTerms(dealId);
  }

  try {
    const buf = await getAttachment(gcsPath);
    if (!buf) { res.status(404).json({ error: "Upload not found" }); return; }

    // The path carries the extension we minted it with, which is how the extractor knows
    // whether it is holding a PDF or an image.
    const result = await extractContract(buf, gcsPath);
    res.json(extractPayload(result, current));
  } catch (err: any) {
    logger.error({ athleteId, error: err.message }, "contract extract failed");
    res.status(500).json({ error: "Could not read that contract" });
  }
});

// POST /api/v1/me/deals/contract — create the deal from what the athlete CONFIRMED.
// Body: { gcsPath?, filename?, bytes?, brandName, signed?, deal_type?, extract?,
//         periods?: [{ label, starts_on, ends_on, cash, product, product_directed, conditional }],
//         amount_cash?, amount_product?  ← legacy fallback when no periods are sent
/**
 * Shared by both contract-saving routes (a new deal, or terms onto an existing one).
 *
 * `exclusivity_confirmed`: her answer at review to "does this contract have an exclusivity clause?" — true · false ·
 * null (not sure). Only a confirmed `true` lets State treat the clause as a bound (athlete-state/1.3.0).
 * A `requestId` an older app still sends (the retired intelligence requests) is ignored: the contract saves to the deal
 * exactly as without one.
 */
async function readRequestLink(_athleteId: string, b: any): Promise<
  | { ok: true; requestId: string | null; exclusivityConfirmed: boolean | null }
  | { ok: false; status: number; error: string; field: string }
> {
  const requestId: string | null = null;
  if (b.exclusivity_confirmed !== undefined && b.exclusivity_confirmed !== null && typeof b.exclusivity_confirmed !== "boolean") {
    return { ok: false, status: 400, error: "exclusivity_confirmed must be true, false or null", field: "exclusivity_confirmed" };
  }
  return { ok: true, requestId, exclusivityConfirmed: typeof b.exclusivity_confirmed === "boolean" ? b.exclusivity_confirmed : null };
}

router.post("/deals/contract", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const b = req.body ?? {};
  const brandName = String(b.brandName ?? "").trim();
  if (!brandName) { res.status(400).json({ error: "Name the brand" }); return; }
  if (b.gcsPath != null && !ownsPath(athleteId, b.gcsPath)) {
    res.status(400).json({ error: "Invalid gcsPath" }); return;
  }

  // Her choice wins; otherwise read it off the contract; only then fall back.
  const dealType =
    b.deal_type != null ? String(b.deal_type)
    : b.extract      ? inferDealType(coerce(b.extract, ""))
    : DEFAULT_DEAL_TYPE;
  if (!(ALLOWED_DEAL_TYPES as readonly string[]).includes(dealType)) {
    res.status(400).json({
      error: `Unknown deal type "${dealType}" — use one of: ${ALLOWED_DEAL_TYPES.join(", ")}`,
    });
    return;
  }

  const link = await readRequestLink(athleteId, b);
  if (!link.ok) { res.status(link.status).json({ error: link.error, field: link.field }); return; }
  const { requestId, exclusivityConfirmed } = link;

  const badAmount = (v: unknown): boolean => v != null && num(v) == null;
  if (badAmount(b.amount_cash) || badAmount(b.amount_product)) {
    res.status(400).json({ error: `Amounts must be numbers between 0 and ${MAX_AMOUNT}` });
    return;
  }

  /**
   * The schedule SHE confirmed, which is what gets stored.
   *
   * Until now she edited a single "cash this year" box, that went to deals.amount, and the
   * MODEL's untouched schedule went to deal_periods — which is what the card and the detail
   * screen actually read. So the figure she corrected was the one discarded, and the one she
   * rejected was the one she saw. Two places held the money and she could only reach the
   * place nothing displayed.
   *
   * Now the schedule is the form. These rows are the rows that get written, and the promoted
   * deals.amount is DERIVED from them rather than typed separately — one source of truth,
   * so the two can no longer disagree.
   */
  const confirmedPeriods = readConfirmedPeriods(b);

  // Any figure that failed validation is a REJECTION, not a silent null — she typed
  // something and deserves to know it did not land.
  if (Array.isArray(b.periods)) {
    const bad = b.periods.findIndex((r: any) =>
      (r?.cash != null && num(r.cash) == null) ||
      (r?.product != null && num(r.product) == null));
    if (bad >= 0) {
      res.status(400).json({ error: `Check the figures in row ${bad + 1} — amounts must be between 0 and ${MAX_AMOUNT}` });
      return;
    }
  }

  // Derived from the schedule she confirmed, falling back to the flat fields for a caller
  // that sent none (an older client, or a deal entered by hand with no periods at all).
  // The CURRENT period is the one that answers "what is this worth" — see promoteToDeal.
  const guaranteedRows = confirmedPeriods.filter((r) => !r.conditional);
  const currentRow = (() => {
    const now = Date.now();
    const within = guaranteedRows.find((r) => {
      const a = r.starts_on ? Date.parse(`${r.starts_on}T00:00:00Z`) : NaN;
      const z = r.ends_on   ? Date.parse(`${r.ends_on}T00:00:00Z`)   : NaN;
      return !Number.isNaN(a) && !Number.isNaN(z) && now >= a && now < z + 86_400_000;
    });
    // No dated match: one guaranteed row is unambiguous, several are not.
    return within ?? (guaranteedRows.length === 1 ? guaranteedRows[0] : null);
  })();

  const cash    = confirmedPeriods.length ? (currentRow?.cash    ?? null) : num(b.amount_cash);
  const product = confirmedPeriods.length ? (currentRow?.product ?? null) : num(b.amount_product);
  // Same invariant dealDetector holds: amount is the TOTAL guaranteed value.
  const total   = cash == null && product == null ? null : (cash ?? 0) + (product ?? 0);


  // Validated once, used for both raw_data and the period rows.
  const safeContract = b.extract ? coerce(b.extract, "") : null;

  try {
    const brand = await resolveBrand({ domain: null, brandName });

    const [row] = await db.insert(deals).values({
      athlete_id:     athleteId,
      brand_name:     brandName,
      brand_id:       brand?.brand_id ?? null,
      deal_type:      dealType,
      amount:         total   == null ? null : String(total),
      amount_cash:    cash    == null ? null : String(cash),
      amount_product: product == null ? null : String(product),
      term_start:     day(b.term_start),
      term_end:       day(b.term_end),
      // She is telling us about a deal she already has. `accepted` is the signed state
      // capital counts; an unsigned draft is still being negotiated.
      status:         b.signed === true ? "accepted" : "negotiating",
      ...(b.signed === true ? { signed_at: new Date(), signed_source: "contract" } : {}),
      source:         "contract_upload",
      direction:      "inbound",
      detected_at:    new Date(),
      // The full extract lives here rather than being flattened into columns that would
      // misrepresent it — a cash SCHEDULE is not an amount, a conditional term end is not
      // a date, and exclusivity has no column at all. See contractExtract's header.
      raw_data: {
        origin:      "contract_upload",
        contract:    safeContract,
        // Checkpoint 1: her own confirmation at review, and the request this upload answers (if any).
        confirmed:   { exclusivity: exclusivityConfirmed, at: new Date().toISOString(), by: "athlete" },
        ...(requestId ? { origin_request: requestId } : {}),
        attachments: b.gcsPath
          ? [{
              filename:     String(b.filename ?? "contract.pdf"),
              content_type: "application/pdf",
              bytes:        num(b.bytes) ?? 0,
              gcs_path:     b.gcsPath,
              parsed:       b.extract != null,
            }]
          : [],
      },
    }).returning({ id: deals.id });
    // The plan step: a new deal is an event for the athlete's plan (a no-op unless AGENT_PLAN; never throws).
    notifyPlanEvent(athleteId, "you added a deal", null, "deal_signed");

    // Persist the SCHEDULE, not just the promoted figures. This is what makes the deal
    // answerable later — total, this year, average, remaining — without any surface having
    // to re-derive it from prose, and without a single stored number having to stand in for
    // answers that genuinely differ.
    let periodCount = 0;
    try {
      // Re-validate the extract SERVER-SIDE before any of it becomes a period.
      //
      // amount_cash/amount_product are bounds-checked above and land in `deals`, but the
      // extract was passed straight through to contractToPeriodRows, whose cents() is a
      // bare Math.round(d * 100) — no ceiling, no negative check, no type check. A caller
      // posting cash_schedule:[{amount: 1e12}] got a deal whose DERIVED value was a
      // trillion dollars, while the validated deals.amount said otherwise and every
      // surface preferred the period-derived figure.
      //
      // coerce() is the validation boundary where model output becomes data; a request
      // body is model output that took a detour through a client, and deserves the same
      // boundary. Passing "" as the source text simply means no source_quote survives
      // verification, which is the correct outcome for text we never read here.
      // Hers if she gave us any; the extract only when she confirmed nothing (a deal typed
      // by hand, or an older client). The model's schedule is never written over the top of
      // one she has edited.
      const rows = confirmedPeriods.length
        ? confirmedPeriods.map((r, i) => ({
            seq: i + 1,
            label: r.label,
            starts_on: r.starts_on,
            ends_on: r.ends_on,
            cash_cents:             r.cash             == null ? null : Math.round(r.cash * 100),
            product_cents:          r.product          == null ? null : Math.round(r.product * 100),
            product_directed_cents: r.product_directed == null ? null : Math.round(r.product_directed * 100),
            guaranteed: !r.conditional,
            condition: r.condition,
            source_quote: r.source_quote,
            installments: [] as Array<{ seq: number; amount_cents: number | null; due_on: string | null; derived: boolean }>,
          }))
        : safeContract ? contractToPeriodRows(safeContract) : [];
      for (const r of rows) {
        const [p] = await db.insert(dealPeriods).values({
          deal_id: row.id, seq: r.seq, label: r.label,
          starts_on: r.starts_on, ends_on: r.ends_on,
          cash_cents: r.cash_cents, product_cents: r.product_cents,
          product_directed_cents: r.product_directed_cents,
          guaranteed: r.guaranteed, condition: r.condition, source_quote: r.source_quote,
        }).returning({ id: dealPeriods.id });
        periodCount++;
        for (const inst of r.installments) {
          await db.insert(dealInstallments).values({
            period_id: p.id, seq: inst.seq, amount_cents: inst.amount_cents,
            due_on: inst.due_on, derived: inst.derived,
          });
        }
      }
    } catch (err: any) {
      // The deal itself is already saved and correct. A schedule we failed to write is a
      // reduced deal, not a lost one — and losing the upload she just completed because a
      // period row was malformed would be the worse outcome.
      logger.warn({ dealId: row.id, error: err.message?.slice(0, 160) }, "period write failed");
    }


    // Fold into the brand's existing group, so an uploaded contract joins the deal its
    // email threads already describe instead of appearing as a second gorjana.
    let groupId: string | null = null;
    try {
      groupId = await adoptGroupForNewDeal({
        dealId:    row.id,
        athleteId,
        brandId:   brand?.brand_id ?? null,
        dealType:  dealType,
      });
    } catch (err: any) {
      // Grouping is an enhancement; an ungrouped deal is today's normal behaviour.
      logger.warn({ dealId: row.id, error: err.message?.slice(0, 160) }, "grouping skipped");
    }

    // Research the brand exactly as the inbox path does. getOrResearchBrand is cache-first
    // by design — it returns a fresh, enriched brand without researching, inserts a minimal
    // row for a new one, and never researches an agency — so calling it IS the "do we
    // already have this brand" check. Without it an uploaded contract linked a bare brand
    // row while every detected deal got a logo, a tier and an audience summary.
    // Fire-and-forget: research must never delay or fail her save.
    // COUNTERPARTY IDENTITY PRECEDES COUNTERPARTY EVIDENCE: what this research writes (inbox_brands) is a brand profile
    // found by NAME, with no identity check. It is never attached to her request as evidence and never read by State.
    void import("../services/brandIntel.js")
      .then(({ getOrResearchBrand }) => getOrResearchBrand(brandName, brand?.brand_domain ?? null))
      .catch((err: any) => logger.warn({ brandName, err: err?.message }, "brand research threw"));

    logger.info({ athleteId, dealId: row.id, brandName, dealType, grouped: !!groupId }, "contract deal created");
    res.status(201).json({ id: row.id, brand_id: brand?.brand_id ?? null, deal_group_id: groupId, periods: periodCount });
  } catch (err: any) {
    // Say WHY. A generic message here is how a hard schema violation — deal_type
    // 'endorsement' against the deals_type_check CHECK — went unnoticed through every
    // upload attempt the feature ever had: the constraint name reached the logs and never
    // the client, so a permanent failure was indistinguishable from a transient one.
    const detail = String(err?.detail ?? err?.constraint ?? err?.message ?? "").slice(0, 200);
    logger.error({ athleteId, error: err?.message, constraint: err?.constraint }, "contract deal create failed");
    res.status(500).json({ error: "Could not save that deal", detail: detail || null });
  }
});

/**
 * POST /api/v1/me/deals/:id/contract/from-attachment
 * Body: { messageId, index }
 *
 * Read a contract that is ALREADY here.
 *
 * A contract usually arrives by email, not from her camera roll. gorjana's signed
 * agreement reached us on 15 Aug, went into the bucket, was parsed, and sat on the deal's
 * own thread — visible in the Attachments section, downloadable, and impossible to hand
 * to the extractor. The only way in was the + button, which mints a NEW deal, so taking
 * that route would have put gorjana on the Opportunities screen twice.
 *
 * Nothing is written here. This is the extract step of the same three-step flow, reached
 * from a file we already hold rather than one she just uploaded.
 */
router.post("/deals/:id/contract/from-attachment", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId = String(req.params.id);
  const messageId = String(req.body?.messageId ?? "");
  const index = Number(req.body?.index);

  if (!isUuid(dealId) || !isUuid(messageId) || !Number.isInteger(index) || index < 0) {
    res.status(404).json({ error: "Attachment not found" });
    return;
  }

  const attachment = await attachmentOnDeal(athleteId, dealId, messageId, index);
  if (!attachment) { res.status(404).json({ error: "Attachment not found" }); return; }

  try {
    const { buf, unavailable } = await attachmentBytes(attachment);
    if (!buf) { res.status(404).json({ error: unavailable ?? "That file is no longer stored" }); return; }

    // The stored path keeps the original extension, which is how the extractor knows
    // whether it is holding a PDF or a photograph of a page. A live file has only its name.
    const result = await extractContract(buf, attachment.gcs_path ?? attachment.filename);
    logger.info({ athleteId, dealId, filename: attachment.filename, status: result.status },
                "extracted a contract from an existing attachment");
    res.json({ ...extractPayload(result, await currentTerms(dealId)), filename: attachment.filename });
  } catch (err: any) {
    logger.error({ athleteId, dealId, error: err.message }, "attachment extract failed");
    res.status(500).json({ error: "Could not read that contract" });
  }
});

/**
 * POST /api/v1/me/deals/:id/contract
 * Body: { signed?, deal_type?, extract?, periods?, filename?, messageId?, index? }
 *
 * Put confirmed terms onto a deal that already exists.
 *
 * The sibling POST /deals/contract INSERTS, which is right for a brand we have never
 * seen and wrong for every deal we found in her mail. This is the same write against a
 * row that is already there.
 *
 * SUPERSEDE, NEVER DELETE. deal_periods carries superseded_at precisely because a
 * contract can be amended, and the schedule it replaces is evidence of what was agreed
 * before. Overwriting would also silently orphan any payment already reconciled against
 * an old period. The previous rows stay, stamped; livePeriods() ignores them.
 *
 * deals.source is NOT changed. It records how the deal was FOUND — inbox_scan stays true
 * however many contracts arrive afterwards — and rewriting it would lose the only record
 * that her mailbox, not she, surfaced this deal.
 */
router.post("/deals/:id/contract", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const dealId = String(req.params.id);
  const b = req.body ?? {};
  if (!isUuid(dealId)) { res.status(404).json({ error: "Deal not found" }); return; }
  const link = await readRequestLink(athleteId, b);
  if (!link.ok) { res.status(link.status).json({ error: link.error, field: link.field }); return; }

  // Her deal, or none. Re-checked here rather than trusted from the screen that called us.
  const [deal] = await db
    .select({ id: deals.id, raw_data: deals.raw_data, deal_type: deals.deal_type })
    .from(deals)
    .where(and(eq(deals.id, dealId), eq(deals.athlete_id, athleteId)))
    .limit(1);
  if (!deal) { res.status(404).json({ error: "Deal not found" }); return; }

  const safeContract = b.extract ? coerce(b.extract, "") : null;

  // Her choice wins; otherwise what the model read off the contract; otherwise leave the
  // type the deal already has rather than inventing one.
  const dealType =
    b.deal_type != null ? String(b.deal_type)
    : safeContract      ? inferDealType(safeContract)
    : deal.deal_type;
  if (dealType != null && !(ALLOWED_DEAL_TYPES as readonly string[]).includes(dealType)) {
    res.status(400).json({
      error: `Unknown deal type "${dealType}" — use one of: ${ALLOWED_DEAL_TYPES.join(", ")}`,
    });
    return;
  }

  const confirmedPeriods: ConfirmedPeriod[] = readConfirmedPeriods(b);
  const termStart = day(b.term_start);
  const termEnd   = day(b.term_end);

  try {
    // Stamp the old schedule before writing the new one, so a reader never sees both.
    const superseded = await db
      .update(dealPeriods)
      .set({ superseded_at: new Date() })
      .where(and(eq(dealPeriods.deal_id, dealId), isNull(dealPeriods.superseded_at)))
      .returning({ id: dealPeriods.id });

    const periodCount = await writePeriods(dealId, confirmedPeriods, safeContract);

    // The deal's own columns follow the schedule it now has.
    const currentRow = confirmedPeriods.find((r) => !r.conditional) ?? confirmedPeriods[0] ?? null;
    const cash    = currentRow?.cash    ?? null;
    const product = currentRow?.product ?? null;
    const total   = cash == null && product == null ? null : (cash ?? 0) + (product ?? 0);

    await db.update(deals).set({
      ...(dealType ? { deal_type: dealType } : {}),
      ...(b.signed === true ? {
        status: "accepted",
        // She saved a contract she marked signed: her confirmation (D1). An earlier Yes keeps its own time/source.
        signed_at:     sql`coalesce(${deals.signed_at}, now())`,
        signed_source: sql`coalesce(${deals.signed_source}, 'contract')`,
      } : {}),
      // HERS first. This wrote the model's dates outright, so a term she corrected on
      // the review screen was discarded — the same failure this file's header describes
      // having fixed for amounts, repeated for dates on the path added later.
      ...(termStart || safeContract?.term_start
            ? { term_start: termStart ?? safeContract!.term_start! } : {}),
      ...(termEnd || safeContract?.term_end
            ? { term_end: termEnd ?? safeContract!.term_end! } : {}),
      ...(total != null ? {
        amount:         String(total),
        amount_cash:    cash    == null ? null : String(cash),
        amount_product: product == null ? null : String(product),
      } : {}),
      // Merged, not replaced: raw_data already holds how the deal was detected, and that
      // history is the reason we can say where every figure came from.
      raw_data: {
        ...((deal.raw_data as Record<string, unknown>) ?? {}),
        contract: safeContract,
        contract_source: b.messageId ? { message_id: String(b.messageId), index: Number(b.index) } : null,
        contract_filename: b.filename ? String(b.filename) : null,
        // Without this a contract she UPLOADED and filed onto an existing deal was orphaned
        // in the bucket: nothing referenced it, so it appeared in no Attachments list and
        // could not be found again.
        contract_gcs_path: ownsPath(athleteId, b.gcsPath) ? b.gcsPath : null,
        // Checkpoint 1: her confirmation at review, and the request this upload answers (if any).
        confirmed: { exclusivity: link.exclusivityConfirmed, at: new Date().toISOString(), by: "athlete" },
        ...(link.requestId ? { origin_request: link.requestId } : {}),
      },
    }).where(eq(deals.id, dealId));

    logger.info({ athleteId, dealId, periodCount, superseded: superseded.length, dealType },
                "contract terms written onto an existing deal");
    res.json({ id: dealId, periods: periodCount, superseded: superseded.length });
  } catch (err: any) {
    logger.error({ athleteId, dealId, error: err.message }, "attaching contract terms failed");
    res.status(500).json({ error: "Could not save those terms" });
  }
});

/**
 * POST /api/v1/me/deals/contract/scan
 * Body: { gcsPath }
 *
 * Where does this contract probably belong? Answered WITHOUT a model.
 *
 * This sits between upload and extract, and exists so the screen that asks her can open
 * with the answer already in it. Pulling the text is well under a second of pdf.js (lib/pdfExtract, in a worker); searching it for
 * brands she already has is single-digit milliseconds. The real gorjana contract returns
 * one hit — gorjana, 17 mentions — and no false positives.
 *
 * The model does not run here. Extraction is the NEXT step and only happens once she has
 * confirmed the destination, so a contract she backs out of costs nothing.
 */
router.post("/deals/contract/scan", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const { gcsPath } = req.body ?? {};
  if (!ownsPath(athleteId, gcsPath)) { res.status(400).json({ error: "Invalid gcsPath" }); return; }

  try {
    const buf = await getAttachment(gcsPath);
    if (!buf) { res.status(404).json({ error: "Upload not found" }); return; }

    const scan = await scanContract(athleteId, buf);
    res.json(scan);
  } catch (err: any) {
    // Never a hard failure: not knowing where a contract goes is the normal case for a
    // brand she has never worked with, and she can always say so herself.
    logger.warn({ athleteId, error: err.message?.slice(0, 160) }, "contract scan failed");
    res.json({ readable: false, chars: 0, mentions: [], deals: [] });
  }
});

/**
 * GET /api/v1/me/brands/search?q=
 *
 * Brands SHE already works with, ranked against a query. Reads only — nothing here can
 * create a brand, which is the entire point.
 *
 * Ranking is trigram similarity on the normalised name, which is installed and does the
 * right thing on the shapes that matter: word_similarity("adidas", "adidas america") is
 * 1.0. It is a good enough SUGGESTION and a bad decision — across her 175 brands a 0.5
 * threshold pairs `ccsu edu` with `sjsu edu` and `care` with `lucy care` — so this ranks
 * candidates for her to choose between and never picks one.
 */
router.get("/brands/search", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const athleteId = req.athleteId!;
  const q = String(req.query.q ?? "").trim().slice(0, 120);

  try {
    // Only brands she has a deal with. The global table would make this a directory,
    // and the question is narrower: which of HER brands is this contract with.
    const rows = await db
      .selectDistinct({
        brand_id: inboxBrands.id,
        name:     inboxBrands.name,
        domain:   inboxBrands.domain,
        logo_url: inboxBrands.logo_url,
        score:    q
          ? sql<number>`greatest(
              word_similarity(${inboxBrands.normalized_name}, ${q}),
              word_similarity(${q}, ${inboxBrands.normalized_name})
            )`
          : sql<number>`0`,
      })
      .from(inboxBrands)
      .innerJoin(deals, eq(deals.brand_id, inboxBrands.id))
      .where(
        q
          ? and(
              eq(deals.athlete_id, athleteId),
              sql`(${inboxBrands.name} ilike ${containsPattern(q)}
                   or word_similarity(${inboxBrands.normalized_name}, ${q}) > 0.35
                   or word_similarity(${q}, ${inboxBrands.normalized_name}) > 0.35)`,
            )
          : eq(deals.athlete_id, athleteId),
      )
      .limit(200);

    // An exact substring beats a fuzzy score: typing 'adi' should surface adidas above
    // whatever trigram noise scores nearby.
    const needle = q.toLowerCase();
    const ranked = rows
      .map((r) => ({
        ...r,
        exact: needle && (r.name ?? "").toLowerCase().includes(needle) ? 1 : 0,
      }))
      .sort((a, b) => b.exact - a.exact || Number(b.score) - Number(a.score)
                      || (a.name ?? "").localeCompare(b.name ?? ""))
      .slice(0, 40);

    res.json({ brands: ranked });
  } catch (err: any) {
    logger.warn({ athleteId, error: err.message?.slice(0, 160) }, "brand search failed");
    res.json({ brands: [] });
  }
});

export default router;
