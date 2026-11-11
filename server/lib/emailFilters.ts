/**
 * emailFilters.ts — the deterministic filter layer, applied before any LLM call.
 *
 * Two decisions live here, and they are not the same decision:
 *
 *   preFilterEmail     — is this worth looking at AT ALL? Runs at the door, on the
 *                        From and the Subject only, before a row is written.
 *   structuralNonDeal  — this is mail we keep, but is it a DEAL? Runs on the content
 *                        after the message is stored, and its verdict is receipted.
 *
 * What it deliberately does NOT own is knowledge about the SENDER. That lives in
 * senderProfile.ts, because preFilterEmail, structuralNonDeal, senderMemory and the
 * scorer all need the same facts and used to keep private copies of them.
 */

import {
  senderProfile,
  MASS_PR_AGGREGATOR_DOMAINS,
  BRAND_SENDER_PATTERNS,
  MEDIA_DOMAINS,
} from "./senderProfile";

// ─── Blocked subject patterns ─────────────────────────────────────────────────

export const BLOCKED_SUBJECT_PATTERNS: RegExp[] = [
  /your order/i, /order confirmation/i, /order #/i,
  /receipt for/i, /payment received/i, /invoice/i,
  /password reset/i, /verify your/i,
  /security alert/i, /sign.?in/i, /login/i,
  /unsubscribe/i, /weekly digest/i, /daily digest/i,
  /newsletter/i, /subscription/i,
  /shipping update/i, /delivery/i, /tracking/i,
  /account update/i, /account activity/i,
  /your .* is ready/i, /download your/i,
];

// Forwarded mail restarts a Gmail conversation with a new thread id, so it used
// to mint a second deal card for a pitch the athlete already had (or just a
// self-forward for filing). Match classic clients; preserved deal threads still
// accept Re: follow-ups via detectDeal and never hit this gate for new Fwd.
export const FORWARDED_SUBJECT_PATTERN = /^\s*(?:(?:\[?\s*)?(?:fwd?|fw)\s*\]?\s*:\s*)+/i;

/** True when the subject is a pure forward chain (possibly nested Fwd: Fwd: …). */
export function isForwardedSubject(subject: string): boolean {
  return FORWARDED_SUBJECT_PATTERN.test(subject ?? "");
}

// ─── NIL / athletics keywords that make a .edu email worth classifying ────────

const SCHOOL_NIL_SUBJECT_PATTERN =
  /\bNIL\b|name,?\s+image,?\s+likeness|nil\s+deal|nil\s+opportunity|nil\s+compliance|partnership|sponsorship|brand\s+deal|endorsement|ambassador|marketing\s+deal/i;

const SCHOOL_NIL_ATHLETICS_PATTERN =
  /athletics|athletic\s+department|compliance\s+office|sports\s+information/i;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreFilterResult {
  shouldProcess: boolean;
  reason:        string;
  confidence:    "high" | "medium" | "low";
  fastCategory?: "SCHOOL_NIL";  // When set, skip kimiInstant and use this category directly
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Structural non-deal detection (Stage 1, deterministic — NO LLM) ──────────
// The LLM classifier over-admits whole CLASSES of non-deal mail as deals:
// consumer promos, fintech referral spam, loyalty blasts, platform/SaaS pitches,
// agency onboarding ("let us represent you"), and paid-survey requests. These are
// NOT 1:1 brand deals — nomila-v2 must never surface them as opportunities. Unlike
// aggregators (separable by SENDER), these are separable by the STRUCTURE of the
// ask, so we detect them here with cheap rules before spending an LLM call.
//
// This is intentionally CONSERVATIVE about false positives: a real 1:1 deal that
// happens to mention "points" or "sign up" must still pass. detectDeal consults it
// between the pre-filter and the classifier, and files what it returns with a
// reversible receipt.

export type NonDealDisposition =
  | "consumer_promo"    // free-item / loyalty / "claim your free" B2C promo
  | "platform_pitch"    // SaaS / creator-platform / app pitch ("join our platform")
  | "agency_onboarding" // "let us represent you" / "join our roster" (no named brand)
  | "survey"            // paid survey / market research participation
  | "referral"          // "$N when you open/refer/switch" / "refer a friend"
  | "sweepstakes"       // "enter to win" / "chance to win" — a prize draw, not an offer
  | "team_admin"        // club/league logistics: schedules, rosters, scouting reports
  | "recruiting"        // jobs, internships, hourly gig work — employment, not a deal
  | "marketing_blast"   // sent from a brand's bulk-marketing infrastructure, not a person
  | "billing"           // an invoice, receipt, statement or payment notice with no ask — money owed, not an offer
  | "empty";            // no readable body at all — nothing to evaluate

interface NonDealRule {
  disposition: NonDealDisposition;
  pattern:     RegExp;
  reason:      string;
}

// Brands we can recognize by name — used ONLY to spare agency mail that names a
// specific brand campaign ("we have a Gatorade campaign for you" IS a deal, not
// onboarding). Lowercased; matched as a whole-word substring of the text.
const KNOWN_BRANDS: string[] = [
  "gatorade", "nike", "adidas", "puma", "reebok", "asics", "hoka",
  "under armour", "new balance", "on running", "lululemon", "gymshark",
  "vuori", "alo", "gorjana", "red bull", "celsius", "prime", "bodyarmor",
  "powerade", "stanley", "nobull", "athletic greens", "ag1", "hydro flask",
  "oakley", "muscle milk", "chipotle",
];

// "A specific named brand campaign is present" — true when the text names a brand
// we recognize, OR pairs a Capitalized token with a campaign/deal noun. Guards the
// agency-onboarding rule so genuine agency-brokered deals are not swallowed.
export function hasNamedBrandCampaign(text: string): boolean {
  const lower = text.toLowerCase();
  for (const b of KNOWN_BRANDS) {
    const re = new RegExp(`(^|[^a-z])${escapeRegExp(b)}([^a-z]|$)`, "i");
    if (re.test(lower)) return true;
  }
  // Generic: a Capitalized brand-ish token within ~40 chars of a deal noun,
  // e.g. "we have a Gatorade campaign", "the Vuori activation".
  if (/\b[A-Z][A-Za-z0-9&'.-]{1,}\b[^.\n]{0,40}\b(campaign|activation|sponsorship|endorsement|partnership proposal)\b/.test(text)) {
    return true;
  }
  return false;
}

// Ordered rule table. First match wins. Consumer/referral/platform/survey run
// unconditionally; agency_onboarding is gated on the named-brand exception below.
/**
 * Below this a message has no content to judge. Deliberately tiny: a legitimate human
 * reply mid-deal is short, and only TRUE emptiness is distinguishable from one.
 */
const MIN_READABLE_BODY = 25;

const NON_DEAL_RULES: NonDealRule[] = [
  // ── consumer promo / loyalty / free-item blasts ────────────────────────────
  { disposition: "consumer_promo", pattern: /\bclaim your (free|complimentary)\b/i,                     reason: "consumer promo: claim your free" },
  { disposition: "consumer_promo", pattern: /\bfree (product|sample|serum|gift|item|chips|drink|meal)\b/i, reason: "consumer promo: free item offer" },
  { disposition: "consumer_promo", pattern: /\bearn \d[\d,]*\s*k?\s*(points|miles|pts)\b/i,             reason: "loyalty promo: earn N points" },
  { disposition: "consumer_promo", pattern: /\b(loyalty|rewards) (points|program|status|members?)\b/i,  reason: "loyalty program blast" },
  { disposition: "consumer_promo", pattern: /\bcomplimentary\b[^.\n]{0,30}\bstatus\b/i,                 reason: "complimentary loyalty status" },
  { disposition: "consumer_promo", pattern: /\bsign up today\b/i,                                       reason: "consumer promo: sign up today" },
  { disposition: "consumer_promo", pattern: /\bdownload (the|our) app\b/i,                              reason: "consumer promo: download the app" },

  // ── fintech / referral incentives ──────────────────────────────────────────
  { disposition: "referral", pattern: /\$\s?\d[\d,]*\s*k?\s+when you\s+(open|refer|switch|sign\s?up|join|deposit)\b/i, reason: "referral incentive: $N when you open/refer" },
  { disposition: "referral", pattern: /\brefer a friend\b/i,                                            reason: "referral: refer a friend" },

  // Affiliate recruitment wearing gifting clothes: a free-product pitch whose P.S. carries
  // the actual ask — earn an N% commission on a creator storefront, join with a referral link.
  // The athlete's read is that this is a mass blast, and the commission-for-sales structure
  // is what makes it one.
  //
  // NARROW ON PURPOSE. Commission is NOT disqualifying by itself — Mila's own advice on
  // Vinaura was "negotiate flat fee + commission", and commission ON TOP of a fee is a real
  // deal. What is matched is commission as the ASK: an explicit percentage to earn, or a
  // referral link to join. A campaign quoting a fee alongside commission matches neither.
  { disposition: "referral", pattern: /\bearn\b[^.]{0,24}\b\d{1,2}\s?%\s*commission\b/i, reason: "affiliate: earn N% commission" },
  { disposition: "referral", pattern: /\breferral link\b/i,                              reason: "affiliate: referral link" },
  { disposition: "referral", pattern: /\b(join|enroll in|sign up for) (our|the|my) (referral|affiliate|ambassador) (program|network)\b/i, reason: "referral/affiliate recruitment" },
  { disposition: "referral", pattern: /\bopen (an?|your) (account|checking|savings|card)\b/i,           reason: "referral: open an account" },

  // ── platform / SaaS / app pitch ────────────────────────────────────────────
  { disposition: "platform_pitch", pattern: /\bjoin (our|the) platform\b/i,                             reason: "platform pitch: join our platform" },
  { disposition: "platform_pitch", pattern: /\bexclusive\b[^.\n]{0,40}\b(superfans?|super[-\s]?fans?|community|fanbase)\b/i, reason: "platform pitch: exclusive access for your community" },
  { disposition: "platform_pitch", pattern: /\bmonetize your (audience|following|fans|community|content)\b/i, reason: "platform pitch: monetize your audience" },
  { disposition: "platform_pitch", pattern: /\b(check out|try|introducing|sign up for|access|explore|hop on|get on) (our|the) (dashboard|platform|tool|app)\b/i, reason: "platform pitch: check out our tool" },
  { disposition: "platform_pitch", pattern: /\b(we|i)(?:'ve| have)? built (you|something)\b/i,          reason: "platform pitch: we built you something" },
  { disposition: "platform_pitch", pattern: /\b(join|check out|sign up for|invite you to)\b[^.\n]{0,30}\b[a-z0-9-]+\.io\b/i, reason: "platform pitch: bare <name>.io invite" },

  // ── paid survey / market research ──────────────────────────────────────────
  { disposition: "survey", pattern: /\b(compensated|paid) (survey|research|study)\b/i,                  reason: "paid survey/research" },
  { disposition: "survey", pattern: /\bparticipate in (our )?research\b/i,                              reason: "research participation" },
  { disposition: "survey", pattern: /\b(quick thought on|your (quick )?insight|share your (opinion|feedback))\b/i, reason: "survey: opinion/insight request" },

  // ── sweepstakes / prize draw ───────────────────────────────────────────────
  // A prize DRAW is not an offer to the athlete: there is nothing to negotiate and
  // nothing is being paid for her audience. Phrased tightly around enter/chance-to-win
  // so it cannot swallow a gifting offer, which never asks her to enter anything.
  { disposition: "sweepstakes", pattern: /\benter (for a chance )?to win\b/i,                           reason: "sweepstakes: enter to win" },
  { disposition: "sweepstakes", pattern: /\b(for a )?chance to win\b/i,                                 reason: "sweepstakes: chance to win" },
  { disposition: "sweepstakes", pattern: /\bwin \$\s?\d[\d,]*\b/i,                                      reason: "sweepstakes: win $N" },
  { disposition: "sweepstakes", pattern: /\b(sweepstakes|giveaway entry|prize draw|no purchase necessary)\b/i, reason: "sweepstakes: draw language" },

  // ── club / league / team administration ────────────────────────────────────
  // Her own club and league mail: schedules, rosters, kit sizes, scouting reports,
  // event photo galleries. Commercially inert, and it has no overlap with brand mail.
  { disposition: "team_admin", pattern: /\bscouting report\b/i,                                         reason: "team admin: scouting report" },
  { disposition: "team_admin", pattern: /\b(training|practice|game|match) (schedule|tonight|tomorrow)\b/i, reason: "team admin: training/match schedule" },
  { disposition: "team_admin", pattern: /\b(photo gallery|livestream)\b[^.\n]{0,40}\b(event|showcase|tournament|id camp)\b/i, reason: "team admin: event media" },
  { disposition: "team_admin", pattern: /\b(sizes|kit sizes|uniform sizes) needed\b/i,                   reason: "team admin: kit sizes" },
  { disposition: "team_admin", pattern: /\btalent id (event|camp)\b/i,                                  reason: "team admin: talent ID event" },

  // ── recruiting / gig work ──────────────────────────────────────────────────
  // Employment is not a brand deal. Keyed on hourly pay and interview language, which
  // a sponsorship never uses — a campaign pays a fee, not a wage.
  { disposition: "recruiting", pattern: /\$\s?\d[\d,]*(\.\d+)?\s*\/\s*(hr|hour)\b/i,                    reason: "recruiting: hourly rate" },
  { disposition: "recruiting", pattern: /\bper hour\b/i,                                                reason: "recruiting: per-hour pay" },
  { disposition: "recruiting", pattern: /\binterview (with|at|for)\b/i,                                 reason: "recruiting: interview invitation" },
  { disposition: "recruiting", pattern: /\b(apply|application) (for|to) (the )?(job|role|position|internship)\b/i, reason: "recruiting: job application" },
];

// ── billing / invoices / receipts / statements ────────────────────────────────
// A company's billing mail (an invoice, a receipt, an account statement, a remittance or payment advice) is money
// owed or paid for goods and services, not an offer to the athlete — even from a well-known brand, even with an
// amount on it. Judged on the subject's or the body's billing words AND the absence of any ask, so a real pitch that
// mentions invoicing ("we'll pay on invoice for two posts") still reaches the classifier. Deal-workflow senders
// (e-sign, payouts) are exempt: their mail carries an existing deal forward (the paperwork matcher). Remittance
// subjects are often terse: "<Company> Adv.<number>;<date>" ("Adv." = advice) carries no other billing word.
const BILLING_SUBJECT = /\b(invoices?|receipts?|remittances?|payment (advices?|notices?|notification|confirmation|reminder|summary)|adv\.\s?\d+|billing (statement|notice|summary)|(account|billing|monthly|card|bank|payment) statement|statement (of account|is (ready|available))|amount due|past due|bill is ready)\b/i;
const BILLING_BODY = /\b(goods and services supplied|as invoiced|remittance advice|payment advices?|settled the following items|invoice (number|no\.?|#)|amount due|balance due|statement of account)\b/i;
/** Any ask of the athlete: a role, a deliverable, a question about working together. */
const DEAL_ASK = /\b(collab(oration|orate)?|partner(ship)?s? with|campaign|sponsor(ship)?|ambassador|paid post|appearance|feature you|interview|would you (be|like)|are you (interested|open|available)|interested in working|work(ing)? with you|proposal|opportunity|your rates?|deliverables?|ugc|content creation)\b/i;

/**
 * True when a short line (a summarised "ask", a deliverable) is only invoice / settlement language — "Goods and
 * services supplied as invoiced" — with no ask of the athlete in it. Such a line describes money paid or owed, so it
 * never makes an offer or a reply she owes.
 */
export function isSettlementOnly(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  // Settlement words only — never a bare "invoice": "send your invoice after the post goes live" is a real ask on a deal.
  const settlement = BILLING_BODY.test(t) || /\b(settled|settlement of|remittance|bank transfer)\b/i.test(t);
  return settlement && !DEAL_ASK.test(t);
}

/**
 * A billing notice that says money was PAID TO the athlete (a remittance / payment advice settling her invoice), as
 * opposed to an invoice, receipt or statement she owes or got for a purchase. Those stay billing noise; this one is
 * payment paperwork on her deal with the payer (skills/paperwork). Never a deal-workflow sender (their own path).
 */
const PAID_TO_HER = /\b(remittances?|payment advices?|adv\.\s?\d+|settled the following items?|paid (to you|by bank transfer)|payment (has been )?(sent|issued|made|transferred) to you)\b/i;
export function isPaymentToAthlete(from: string, subject: string, body: string): boolean {
  if (senderProfile(from).workflow) return false;
  return isBillingNotice(from, subject, body) && PAID_TO_HER.test(`${subject ?? ""}\n${body ?? ""}`);
}

/**
 * The amount a payment notice states, in cents: the one labelled net / total / amount paid when there is one, else the
 * largest stated. Only currency-marked figures count ("USD 5,000.00", "$5,000.00", "5,000.00 USD"). Null when none.
 */
export function statedPaymentAmount(text: string): { amountCents: number; currency: string } | null {
  const t = String(text ?? "");
  // A PDF's table text pads the currency column ("USD        5,000.00"): spaces between, never a line break. A figure
  // before the currency is never the tail of a date or reference ("10/09/2026 USD 5,000.00" is 5,000, not 2,026).
  const RE = /(?:(USD|EUR|GBP|CAD|AUD|INR|\$|€|£)[ \t]{0,12}(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?))|(?:(?<![\d/.,-])(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)[ \t]{0,12}(USD|EUR|GBP|CAD|AUD|INR))/gi;
  const SYMBOL: Record<string, string> = { "$": "usd", "€": "eur", "£": "gbp" };
  const found: Array<{ cents: number; currency: string; labelled: boolean }> = [];
  for (const m of t.matchAll(RE)) {
    const cur = (m[1] ?? m[4] ?? "").toUpperCase();
    const num = Number((m[2] ?? m[3] ?? "").replace(/,/g, ""));
    if (!Number.isFinite(num) || num <= 0) continue;
    const before = t.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    found.push({
      cents: Math.round(num * 100),
      currency: SYMBOL[cur] ?? cur.toLowerCase(),
      labelled: /\b(net|total|amount( paid)?|payment amount|paid)\b[^\n]{0,30}$/i.test(before),
    });
  }
  if (!found.length) return null;
  const pick = found.filter((f) => f.labelled).sort((a, b) => b.cents - a.cents)[0] ?? [...found].sort((a, b) => b.cents - a.cents)[0];
  return { amountCents: pick.cents, currency: pick.currency };
}

/** True for billing mail with no ask (see BILLING_SUBJECT); never for a deal-workflow sender. */
export function isBillingNotice(from: string, subject: string, body: string): boolean {
  if (senderProfile(from).workflow) return false;
  if (!(BILLING_SUBJECT.test(subject ?? "") || BILLING_BODY.test(body ?? ""))) return false;
  return !DEAL_ASK.test(`${subject ?? ""}\n${body ?? ""}`);
}

// Agency-onboarding rules are checked separately so the named-brand exception
// can spare genuine agency-brokered deals.
const AGENCY_ONBOARDING_PATTERNS: RegExp[] = [
  /\brepresent you\b/i,
  /\bjoin our roster\b/i,
  /\bpro representation\b/i,
  /\bwork with (global )?brands (via|through|with) us\b/i,
  /\badd you to our (network|roster|talent pool)\b/i,
  /\b(sign|onboard) (you|with us) (to|onto) our (roster|agency|network)\b/i,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * structuralNonDeal — deterministic detection of non-deal email CLASSES.
 *
 * Returns a { disposition, reason } when the mail is a structurally-recognizable
 * non-deal (consumer promo, referral spam, platform pitch, agency onboarding,
 * paid survey, billing notice …), else null. NO LLM. `from` is accepted for future sender-aware
 * rules but current rules read subject + body only.
 */
export function structuralNonDeal(
  from: string,
  subject: string,
  body: string,
): { disposition: NonDealDisposition; reason: string } | null {
  const text = `${subject ?? ""}\n${body ?? ""}`;


  for (const rule of NON_DEAL_RULES) {
    if (rule.pattern.test(text)) {
      return { disposition: rule.disposition, reason: rule.reason };
    }
  }

  if (isBillingNotice(from, subject, body)) {
    return { disposition: "billing", reason: "billing: invoice, receipt, statement or payment notice with no ask" };
  }

  // Agency onboarding — but a specific named brand campaign flips it back to a
  // real deal ("we have a Gatorade campaign for you"), so bail out in that case.
  for (const pattern of AGENCY_ONBOARDING_PATTERNS) {
    if (pattern.test(text)) {
      if (hasNamedBrandCampaign(text)) return null;
      return { disposition: "agency_onboarding", reason: `agency onboarding: ${pattern.source}` };
    }
  }

  // ── Sender is a newsletter machine ──────────────────────────────────────────
  // After the content rules, so a Marriott sweepstakes still reports "sweepstakes" — the
  // more specific reason is the more useful receipt. What this adds is the mail no
  // content rule catches: "adidas EQT X FIFA World Cup 26", "Adizero Dropset Pro is ready
  // to race", "Come run with lululemon". Those read like brand opportunities to a
  // classifier and are simply advertising.
  if (senderProfile(from).bulkMarketing) {
    return {
      disposition: "marketing_blast",
      reason: `bulk-marketing sender: ${senderProfile(from).domain || from}`,
    };
  }

  // ── Nothing to evaluate ─────────────────────────────────────────────────────
  // Checked LAST, because a recognisable pattern above is more informative than "empty",
  // and many blasts carry their whole payload in the subject with no body at all.
  //
  // Judged on subject AND body — that is what the classifier itself reads, and an absent
  // body is far more often OUR failure than the sender's. Every empty message in this
  // inbox predates the extraction fix in #91; re-fetching from Gmail recovered a real
  // body for 71 of 72, Musugy's "Paid Musugy Collab" among them — the very message this
  // rule was first written against, and a genuine paid pitch. What could not be
  // recovered still includes "Paid Partnership with CARE", where the subject states the
  // offer and the body is gone for good. A subject is content; discarding one because
  // the body beside it went missing files mail on our own defect.
  //
  // The bar is EMPTY, not SHORT, and that distinction is the whole safety argument. A
  // one-line reply from someone on the brand's team mid-negotiation ("Sounds good, sending
  // the contract Monday") is legitimate and brief, and no length threshold separates it
  // from a content-free blast. Only genuine emptiness is safe to act on, so a
  // 100-character message still goes to the classifier where it belongs.
  //
  // Callers additionally gate this on !isPreservedThread, so a follow-up on a thread
  // already known to be a deal never reaches here at all.
  const readable = text.replace(/\s+/g, " ").trim();
  if (readable.length < MIN_READABLE_BODY) {
    return { disposition: "empty", reason: `nothing to evaluate (${readable.length} chars)` };
  }

  return null;
}

// ─── Main pre-filter ──────────────────────────────────────────────────────────

export function preFilterEmail(fromEmail: string, subject: string): PreFilterResult {
  const fromLower = fromEmail.toLowerCase();
  const sender    = senderProfile(fromEmail);

  // 1. School NIL — .edu plus NIL/athletics context bypasses every noise filter, because
  //    "confirm your NIL agreement" from athletics@stanford.edu must never be dropped.
  if (sender.school) {
    if (SCHOOL_NIL_SUBJECT_PATTERN.test(subject) || SCHOOL_NIL_ATHLETICS_PATTERN.test(fromLower)) {
      return {
        shouldProcess: true,
        reason:        "School NIL/athletics communication",
        confidence:    "high",
        fastCategory:  "SCHOOL_NIL",
      };
    }
    // General .edu — registrar, housing, dining.
    return { shouldProcess: false, reason: "School email — no NIL/athletics context", confidence: "high" };
  }

  // 1b. Deal paperwork — e-signature, payment / payout and scheduling providers (WORKFLOW_DOMAINS).
  //     Their mail carries a deal forward (a signature request, an executed contract, a payout), so
  //     it must reach the paperwork matcher. It used to be dropped right here: stripe.com,
  //     paypal.com and calendly.com sit in BLOCKED_DOMAINS too, and an e-sign "noreply@" address
  //     hit the local-part block, so "paid" and "signed" were never observed. It never mints a deal
  //     by itself (dealDetector's paperwork path).
  if (sender.workflow) {
    return { shouldProcess: true, reason: "Deal paperwork sender", confidence: "medium" };
  }

  // 2. Automated/transactional by SUBJECT, whoever sent it.
  for (const pattern of BLOCKED_SUBJECT_PATTERNS) {
    if (pattern.test(subject)) {
      return { shouldProcess: false, reason: `Blocked subject: ${pattern.source}`, confidence: "high" };
    }
  }
  // (Forwards are gated in detectDeal after thread lookup, so a dual-inbox deal thread
  // is not skewered by a self-forward.)

  // 3. Automated/transactional by SENDER.
  if (sender.blockedDomain) {
    return { shouldProcess: false, reason: `Blocked domain: ${sender.blockedDomain}`, confidence: "high" };
  }
  if (sender.blockedLocalPart) {
    return { shouldProcess: false, reason: `Blocked sender local-part: ${sender.blockedLocalPart}`, confidence: "high" };
  }

  // 4. Mass-PR aggregators, checked BEFORE the brand fast-track so that
  //    pr@kglowing.com is dropped rather than waved through by its local part.
  if (sender.aggregator) {
    return { shouldProcess: false, reason: `Mass-PR aggregator: ${sender.aggregator}`, confidence: "high" };
  }

  // 5. Signals worth a classification: a brand's outreach address, or a media outlet.
  if (sender.brandOutreach) {
    return { shouldProcess: true, reason: "Brand sender pattern", confidence: "high" };
  }
  if (sender.mediaOutlet) {
    return { shouldProcess: true, reason: `Media domain: ${sender.mediaOutlet}`, confidence: "high" };
  }

  // 6. Deal keywords in subject — fast-track to kimiInstant with higher confidence
  const dealKeywords: RegExp[] = [
    /partnership/i, /sponsorship/i, /collaboration/i, /collab/i,
    /brand deal/i, /opportunity/i, /campaign/i, /ambassador/i,
    /endorsement/i, /paid promotion/i, /gifting/i,
    /interview request/i, /feature/i, /cover story/i,
    /podcast/i, /appearance/i, /photoshoot/i,
  ];
  for (const kw of dealKeywords) {
    if (kw.test(subject)) {
      return { shouldProcess: true, reason: `Deal keyword: ${kw.source}`, confidence: "medium" };
    }
  }

  // 7. No explicit signal — pass to Kimi for classification
  return { shouldProcess: true, reason: "No explicit noise signal — Kimi classifies", confidence: "low" };
}
