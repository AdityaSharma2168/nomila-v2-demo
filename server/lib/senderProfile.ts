/**
 * senderProfile — everything we know about a From address, in one place.
 *
 * This module answers "who is this?" and nothing else. It returns FACTS; the policy of
 * what to do with them stays with the callers — preFilterEmail decides what to drop at
 * the door, structuralNonDeal decides what to file with a receipt, senderMemory decides
 * what the athlete's own history says, and the scorer will decide how much a source is
 * worth. Each of those is a different decision, and they deserve to stay separate.
 *
 * WHY IT EXISTS. The same knowledge had grown three homes at three different times, and
 * the split cost us real bugs rather than just tidiness:
 *
 *   · preFilterEmail already dropped crevasse.ai and kglowing, while senderMemory
 *     independently learned to mute those same senders. 25 of the 46 messages memory was
 *     "catching" were mail that had never reached it. Neither subsystem could see the
 *     other, so the duplication was only discoverable by querying production.
 *   · senderMemory carried its own FREE_MAIL and WORKFLOW_DOMAINS sets, which existed
 *     because a mute must never swallow gmail-at-large or the e-signature provider that
 *     carries a contract to `signed`. Nothing else could consult that knowledge.
 *   · A new signal had no obvious home. "This sender is a newsletter machine" landed in
 *     emailFilters because that was convenient, becoming the third place to look.
 *
 * The test for anything added here: it must be a property of the SENDER, decidable from
 * the address alone, with no database and no message body. Subject and body rules belong
 * in emailFilters; learned history belongs in senderMemory.
 */

/**
 * Real platform / transactional domains. Matched against the PARSED DOMAIN by equality or
 * suffix, never as a substring, so "x.com" cannot match "maxx.com".
 */
export const BLOCKED_DOMAINS = [
  "google.com", "apple.com", "amazon.com", "paypal.com", "stripe.com",
  "microsoft.com", "netflix.com", "spotify.com", "uber.com", "lyft.com",
  "twitter.com", "x.com", "instagram.com", "facebook.com", "meta.com",
  "linkedin.com", "tiktok.com", "snapchat.com", "pinterest.com",
  "reddit.com", "discord.com", "slack.com",
  "mailchimp.com", "sendgrid.com", "constantcontact.com",
  "shopify.com", "squarespace.com", "wix.com",
  "dropbox.com", "zoom.us", "calendly.com",
  "substack.com", "beehiiv.com", "mailerlite.com",
];

/**
 * Transactional local parts. Matched against the LOCAL PART only — never the display
 * name, which is brand-controlled free text, so "Nike Athlete Support
 * <partnerships@nike.com>" is not dropped for containing the word "support".
 */
export const BLOCKED_LOCAL_PARTS = [
  "receipts", "orders", "shipping", "notifications", "alerts",
  "support", "help", "billing", "invoice",
];

export const BLOCKED_LOCAL_PREFIXES = ["noreply", "no-reply", "donotreply", "do-not-reply"];

/**
 * Mass-PR aggregators — high-volume creator-PR shops that blast near-identical
 * gifting/campaign offers to many creators.
 *
 * Structurally these read exactly like a genuine 1:1 gifting deal — a named brand, a
 * product or a fee, and a creator ask — so the classifier cannot separate them by wording
 * and oscillates on them (docs/plans/deal-classifier-precision.md). They ARE separable by
 * sender, which is the whole reason this list is worth keeping.
 *
 * Deliberately a SUBSTRING match against the full From, unlike the domain list above, so
 * "kglowing" covers every kglowing* domain. Extend as new aggregators surface.
 */
export const MASS_PR_AGGREGATOR_DOMAINS = [
  "crevasse.ai",   // "NEEDLY … Creator Campaign" / "Paid Wellness Opportunity" blasts
  "kglowing",      // K-beauty "free serum for 1 TikTok, apply via form" (all *kglowing* domains)
];

/** Addresses a brand uses to start a real conversation. A reason to CLASSIFY, not to drop. */
export const BRAND_SENDER_PATTERNS: RegExp[] = [
  /^pr@/i, /^press@/i, /^media@/i, /^partnerships@/i,
  /^collab@/i, /^collaborations@/i, /^sponsorship@/i,
  /^talent@/i, /^influencer@/i, /^creator@/i,
  /^brand@/i, /^marketing@/i,
];

export const MEDIA_DOMAINS: string[] = [
  "espn.com", "nbcsports.com", "foxsports.com", "cbssports.com",
  "si.com", "sportsillustrated.com", "bleacherreport.com",
  "theathletic.com", "sportingnews.com", "barstoolsports.com",
  "gq.com", "vogue.com", "esquire.com", "menshealth.com",
  "womenshealth.com", "cosmopolitan.com", "elle.com", "harpersbazaar.com",
  "forbes.com", "bloomberg.com", "businessinsider.com",
  "nytimes.com", "washingtonpost.com", "wsj.com", "usatoday.com",
  "complex.com", "hypebeast.com", "highsnobiety.com",
  "billboard.com", "rollingstone.com", "variety.com", "hollywoodreporter.com",
  "on3.com", "rivals.com", "247sports.com", "athletic.net",
];

/**
 * Free mail. Never usable as a DOMAIN-level signal about anybody: one junk sender on
 * gmail would otherwise tar every individual who mails from gmail — and individuals are
 * exactly who a small brand's founder is. Never a brand's identity either (brandDomainOf).
 */
export const FREE_MAIL = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com",
  "proton.me", "protonmail.com", "live.com", "msn.com",
  "googlemail.com", "me.com", "mac.com", "ymail.com", "gmx.com", "qq.com", "163.com", "naver.com",
]);

/**
 * Transactional workflow senders that carry a deal FORWARD.
 *
 * A deal does not stay on one domain. gorjana proposes from gorjana.com, the signature
 * request arrives from the e-sign provider, and the executed contract lands from
 * adobesign.com — a "Completed: <Brand>_Athlete_Endorsement_Release" notice.
 *
 * These domains carry mail for EVERY brand, so junk accumulates on them far faster than
 * on any single brand's domain. Judging the DOMAIN would eventually swallow contract
 * completion for every future deal, and the failure would be silent: deals that simply
 * never reach `signed`. Individual noisy addresses at such a provider are still fair game.
 */
/** The payments / payouts part of WORKFLOW_DOMAINS (paperwork matching reads it as a payment). */
export const PAYMENT_WORKFLOW_DOMAINS = new Set([
  "stripe.com", "billing.stripe.com", "paypal.com", "wise.com", "bill.com",
]);

export const WORKFLOW_DOMAINS = new Set([
  // e-signature
  "adobesign.com", "echosign.com", "docusign.net", "docusign.com", "hellosign.com",
  "dropboxsign.com", "pandadoc.com", "eversign.com", "signnow.com",
  // payments / payouts
  ...PAYMENT_WORKFLOW_DOMAINS,
  // scheduling used mid-deal
  "calendly.com",
]);

/** True when the domain, or a registrable parent of it, is a payments / payouts provider. */
export function isPaymentWorkflowDomain(domain: string): boolean {
  const parts = domain.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (PAYMENT_WORKFLOW_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Bulk-marketing infrastructure: the subdomain a brand sends its retail newsletters from.
 *
 * Real partnership outreach comes from a PERSON — a person at a small brand,
 * a person at a label. Retail advertising comes from the brand's own name on
 * a send-only subdomain: adidas@us-news.comms.adidas.com, marriottbonvoy@email-marriott.com,
 * chipotle@email.chipotle.com, stores@e.lululemon.com. The difference is structural rather
 * than linguistic, which is why no amount of prompt work fixes it: to a classifier,
 * "adidas" plus "FIFA World Cup 26" reads like a brand opportunity.
 */
const BULK_MARKETING_DOMAIN =
  /(^|\.)(email|e|mail|news|us-news|comms|mktg|marketing|info|reply|em|send)[-.]/i;

/**
 * Local parts that mean a human or a partnership team, never a newsletter. This is the
 * veto that keeps a brand's genuine outreach alive when it happens to be routed through
 * the same ESP.
 *
 * Bounded to whole segments on purpose: an unanchored match vetoes by accident, and did —
 * "chipotle" contains "hi", so chipotle@email.chipotle.com read as a human address and
 * escaped the rule. "pr" inside "press"/"express" is the same trap.
 */
const HUMAN_LOCAL_PART =
  /(^|[._-])(partner|partnerships|collab|collabs|creator|influencer|sponsor|brand|talent|pr|press|hello|hi|team|support)([._-]|$)/i;

/** A first.last address is a person, wherever it is sending from. */
const PERSON_LOCAL_PART = /^[a-z]+\.[a-z]+$/;

/**
 * Parse a From header into its parts.
 *
 * Only the address is ever used for a decision. The display name is brand-controlled free
 * text and must never gate a sender.
 */
export function parseFrom(fromEmail: string): { localPart: string; domain: string } {
  const angle = fromEmail.match(/<([^>]+)>/);
  const addr  = (angle ? angle[1] : (fromEmail.match(/([^\s<>]+@[^\s<>]+)/)?.[1] ?? fromEmail)).toLowerCase().trim();
  const at    = addr.lastIndexOf("@");
  if (at === -1) return { localPart: addr, domain: "" };
  return { localPart: addr.slice(0, at), domain: addr.slice(at + 1) };
}

/** The domain alone, or null when the header carries no address at all. */
export function domainOf(fromEmail: string | null | undefined): string | null {
  const { domain } = parseFrom(fromEmail ?? "");
  return domain || null;
}

/**
 * Domains that send mail FOR brands but are not the brand: email service providers,
 * creator platforms, and parent companies whose name is not the one on the deal.
 *
 * These must resolve to null rather than to a registrable parent, and that is the whole
 * point of keeping them separate from the prefix stripping below. `shared1.ccsend.com`
 * reduced to `ccsend.com` is Constant Contact's logo on a Payless deal — a confidently wrong
 * answer, which is worse than the blank one, because nobody looks twice at a logo that
 * rendered. A missing logo shows a monogram and invites a correction.
 */
export const NON_BRAND_SENDERS = new Set([
  "ccsend.com",           // Constant Contact
  "creator-hero.com",     // creator campaign platform
  "jellyotter.io",        // creator partnership platform (sends from partners.jellyotter.io)
  "collabs.io",           // creator collaboration platform (sends from mail.collabs.io)
  "msg-biz.online",       // bulk sending host (a Chevrolet campaign arrived through it)
  "umusic-online.com",    // Universal Music, sending for artists
  "armssoftware.com",     // athletics CRM, sends for universities
  "sendgrid.net", "mailchimpapp.net", "rsgsv.net", "mcsv.net",   // ESPs seen in the wild
  "hubspotemail.net", "klaviyomail.com", "sparkpostmail.com",
  "salesforce.com", "exacttarget.com", "mktomail.com",
]);

/**
 * Public suffixes that take two labels, so the registrable domain needs three.
 * Not the full PSL — that is a dependency and a download — just the ones a brand in this
 * inbox plausibly uses.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.nz", "co.za", "com.au", "com.br",
  "com.mx", "co.in", "com.sg", "co.kr", "com.tr", "com.cn",
]);

/**
 * Subdomains a brand sends mail FROM.
 *
 * Peeling only these, rather than trimming to two labels blindly, is what keeps
 * athletics.msstate.edu and athletics.pitt.edu intact — those ARE the identity, not a
 * sending host, and a blanket trim would destroy them to fix jellycat.
 */
const SENDING_PREFIXES = new Set([
  "e", "em", "email", "emails", "mail", "mailer", "news", "newsletter", "go", "g", "t",
  "link", "links", "info", "hello", "hi", "reply", "send", "sender", "mkt", "marketing",
  "click", "cta", "shared1", "shared", "notify", "notifications", "update", "updates",
  // Added 2026-09-02 from the hosts actually present in inbox_brands.
  "us", "usa", "fanmail", "partners", "corp", "goodmorning", "creatorlab", "mcmap",
]);

/**
 * The domain a brand's identity and homepage live on, peeled from a sending host.
 *
 * ONE implementation, used by both brand resolution and image lookup. It was two: this
 * logic was written first inside brandImage.candidateDomains, which is where the prefix
 * list comes from, and a second copy here would have drifted from it.
 */
export function registrableDomain(domain: string | null | undefined): string | null {
  const d = domain?.toLowerCase().trim().replace(/^www\./, "") ?? "";
  if (!d || !d.includes(".")) return null;

  const parts = d.split(".");
  // Three labels for a two-part public suffix, two otherwise. The earlier version fell back
  // to `slice(-2)` regardless, which turned creatorlab.campfire.co.uk into the bare suffix
  // "co.uk" and sent the image fetcher looking for a logo on a public suffix.
  const floor = TWO_LABEL_SUFFIXES.has(parts.slice(-2).join(".")) ? 3 : 2;
  while (parts.length > floor && SENDING_PREFIXES.has(parts[0])) parts.shift();
  return parts.join(".");
}

/**
 * The brand's own domain, or null when the sender is not the brand at all.
 *
 * Deliberately NOT applied to `domainOf`, which stays exact: the pre-filter, the blocked
 * list and the self-sender checks all reason about the address that actually sent the mail,
 * and collapsing subdomains there would let a blocked host through via a parent that is not.
 */
export function brandDomainOf(domain: string | null | undefined): string | null {
  const registrable = registrableDomain(domain);
  if (!registrable) return null;

  // A shared mailbox is never a brand's identity. Row "Finish Line" stored gmail.com as its
  // domain, so every later pitch from a gmail sender resolved to Finish Line by exact domain
  // match. Free-mail senders resolve by NAME, and no row is ever given such a domain.
  if (FREE_MAIL.has(registrable)) return null;
  // Nor is an e-sign / payment provider's: the paperwork carries the brand's NAME, never its domain.
  if (isWorkflowDomain(registrable)) return null;

  // Checked against every PARENT, not just the peeled host — the same walk isWorkflowDomain
  // does. Peeling is deliberately conservative, so an unrecognised prefix survives it:
  // `arms.mail.armssoftware.com` and `immersivegamebox.creator-hero.com` both peel to
  // themselves, and a check on the peeled value alone let them through as real brands. Any
  // host under a known ESP belongs to that ESP however deep it sits.
  if (isNonBrandSender(registrable)) return null;
  return registrable;
}

/** True when the host, or any parent of it, is a sending service or creator platform rather than a brand (NON_BRAND_SENDERS). */
export function isNonBrandSender(domain: string | null | undefined): boolean {
  const parts = String(domain ?? "").toLowerCase().trim().replace(/^www\./, "").split(".").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (NON_BRAND_SENDERS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/** True when the domain, or a registrable parent of it, carries deal workflow mail. */
export function isWorkflowDomain(domain: string): boolean {
  if (WORKFLOW_DOMAINS.has(domain)) return true;
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (WORKFLOW_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/** What we know about a sender. Every field is decidable from the address alone. */
export interface SenderProfile {
  /** The address as parsed — display name discarded. */
  localPart: string;
  domain:    string;
  /** Which blocked domain matched, if any. */
  blockedDomain:    string | null;
  /** Which transactional local part matched, if any. */
  blockedLocalPart: string | null;
  /** Which mass-PR aggregator matched, if any. */
  aggregator:       string | null;
  /** Which media outlet domain matched, if any. */
  mediaOutlet:      string | null;
  /** An address a brand uses to open a conversation (pr@, partnerships@ …). */
  brandOutreach: boolean;
  /** A brand's send-only newsletter plumbing, with no human behind it. */
  bulkMarketing: boolean;
  /** A person or a partnership team rather than a machine. */
  human:    boolean;
  freeMail: boolean;
  workflow: boolean;
  school:   boolean;
}

export function senderProfile(fromEmail: string | null | undefined): SenderProfile {
  const raw = (fromEmail ?? "").toLowerCase();
  const { localPart, domain } = parseFrom(fromEmail ?? "");

  const human =
    HUMAN_LOCAL_PART.test(localPart) || PERSON_LOCAL_PART.test(localPart);

  return {
    localPart,
    domain,
    blockedDomain:    BLOCKED_DOMAINS.find((b) => domain === b || domain.endsWith("." + b)) ?? null,
    blockedLocalPart: matchBlockedLocalPart(localPart),
    // Substring against the FULL header, which is what makes "kglowing" cover every
    // kglowing* domain. Deliberately broader than the domain lists above.
    aggregator:       MASS_PR_AGGREGATOR_DOMAINS.find((a) => raw.includes(a)) ?? null,
    mediaOutlet:      MEDIA_DOMAINS.find((m) => domain.includes(m)) ?? null,
    // Anchored patterns tested against the full lowercased header, preserving the
    // long-standing behaviour that a bare "pr@brand.com" fast-tracks while
    // "Brand PR <pr@brand.com>" does not.
    brandOutreach:    BRAND_SENDER_PATTERNS.some((p) => p.test(raw)),
    bulkMarketing:    BULK_MARKETING_DOMAIN.test(domain) && !human,
    human,
    freeMail:         FREE_MAIL.has(domain),
    workflow:         isWorkflowDomain(domain),
    school:           domain.endsWith(".edu"),
  };
}

function matchBlockedLocalPart(localPart: string): string | null {
  for (const p of BLOCKED_LOCAL_PREFIXES) if (localPart.startsWith(p)) return p;
  for (const p of BLOCKED_LOCAL_PARTS) {
    if (localPart === p) return p;
    // token followed by a separator — blocks support-team@ but not athlete-support@
    if (localPart.startsWith(p) && "._+-".includes(localPart.charAt(p.length))) return p;
  }
  return null;
}
