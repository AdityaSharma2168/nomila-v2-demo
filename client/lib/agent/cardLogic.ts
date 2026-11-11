/**
 * cardLogic — the pure rules behind the agent cards (no React): which cards the client can draw, what each approval verb's
 * button says, how a fact's type is marked, how money and progress read. Unit-tested on their own.
 *
 * Copy is generic within Nomila's world and speaks to the athlete as "you"; nothing names an athlete, sport or brand.
 */
import type { AnyChatCard, AnyCardKind, ApprovalVerb, FactType, ProgressCardPayload } from "./types";
import { CHAT_CARD_KINDS, PROPOSED_CARD_KINDS } from "./types";

const KNOWN = new Set<string>([...CHAT_CARD_KINDS, ...PROPOSED_CARD_KINDS]);

/** Field-presence reading of the wire: keep only cards the client knows how to draw, with the fields it needs. */
export function drawableCards(cards: unknown): AnyChatCard[] {
  if (!Array.isArray(cards)) return [];
  return cards.filter(
    (c): c is AnyChatCard =>
      !!c && typeof c === "object" && typeof (c as any).id === "string" && KNOWN.has((c as any).kind) && !!(c as any).payload,
  );
}

export function isKnownKind(kind: string): kind is AnyCardKind {
  return KNOWN.has(kind);
}

/**
 * What the approve button says, what the card's eyebrow says, and what the card says once it has gone. A verb may
 * override the decline button, the declined line and the safety line (save_memory: nothing goes OUT, it is kept).
 */
export const VERB_COPY: Record<ApprovalVerb, { approve: string; eyebrow: string; done: string; decline?: string; declined?: string; safety?: string; error?: string }> = {
  save_memory:     { approve: "Save",          eyebrow: "Want me to save that?", done: "Saved. You can see it in What Nomila knows.", decline: "Not now", declined: "Not saved.", safety: "Nothing is saved until you tap Save.", error: "That didn't save. Try again." },
  send_message:    { approve: "Send",          eyebrow: "Ready to send",       done: "Sent." },
  post:            { approve: "Post",          eyebrow: "Ready to post",       done: "Posted." },
  publish:         { approve: "Publish",       eyebrow: "Ready to publish",    done: "Published." },
  deal_response:   { approve: "Send",          eyebrow: "Your response",       done: "Response sent." },
  payment:         { approve: "Confirm",       eyebrow: "Payment",             done: "Confirmed." },
  calendar_invite: { approve: "Send invite",   eyebrow: "Calendar invite",     done: "Invite sent." },
  other_act:       { approve: "Approve",       eyebrow: "Needs your OK",       done: "Done." },
};

export const ACTION_COPY = {
  edit: "Edit",
  decline: "Decline",
  save: "Save",
  cancel: "Cancel",
  declined: "Declined. Nothing was sent.",
  safety: "Nothing goes out until you tap.",
  error: "That didn't go through. Nothing was sent. Try again.",
  // A reopened chat's card whose row failed or expired: the deal reply card's own words for the same two states.
  failed: "It didn't go through. Nothing was sent.",
  expired: "This draft expired. Ask Mila for a fresh one.",
  editLabel: "Edit the draft",
} as const;

/** The type mark on a fact: a word and a shape, never colour alone. */
export const FACT_MARK: Record<FactType, { word: string; shape: "solid" | "outline" | "rule" | "dashed" }> = {
  measured: { word: "Measured",    shape: "solid" },
  found:    { word: "Found",       shape: "outline" },
  said:     { word: "You said",    shape: "rule" },
  made:     { word: "Mila's read", shape: "dashed" },
};

/** Money in minor units → "$1,200" / "€80.50". Unknown currencies fall back to the code. */
export function formatMoney(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  const whole = Number.isInteger(major);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${currency.toUpperCase()} ${major.toFixed(whole ? 0 : 2)}`;
  }
}

/** 0–1 for the bar. A finished run is full; a failed one keeps where it stopped. */
export function progressFraction(p: Pick<ProgressCardPayload, "step" | "of" | "state">): number {
  if (p.state === "done") return 1;
  const of = Math.max(1, p.of);
  const step = Math.min(Math.max(0, p.step), of);
  // A running step is half-way through itself: step 2 of 4 running → 37.5%, never 50% (that step isn't done yet).
  return p.state === "running" ? (step - 0.5) / of : step / of;
}

export function progressLine(p: Pick<ProgressCardPayload, "step" | "of" | "label" | "state">): string {
  if (p.state === "done") return "Done";
  if (p.state === "failed") return `Stopped at step ${p.step} of ${p.of} · ${p.label}`;
  return `Step ${p.step} of ${p.of} · ${p.label}`;
}

/** The ready card's kind word. */
export const READY_KIND: Record<string, string> = {
  deck: "Deck",
  post_kit: "Post kit",
  page: "Page",
  visual: "Visual",
  brief: "Brief",
  draft: "Draft",
  other: "Ready",
};

/** A generic glyph per service id (lowercase match on the id). Unknown services get a link glyph. */
export function serviceGlyph(connectorId: string): string {
  const id = connectorId.toLowerCase();
  if (id.includes("instagram")) return "instagram";
  if (id.includes("youtube")) return "youtube";
  if (id.includes("mail") || id.includes("outlook") || id.includes("inbox")) return "mail";
  if (id.includes("calendar")) return "calendar";
  if (id.includes("drive") || id.includes("storage") || id.includes("files") || id.includes("dropbox")) return "folder";
  if (id.includes("stripe") || id.includes("pay")) return "credit-card";
  if (id.includes("shop")) return "shopping-bag";
  if (id.includes("twitter") || id.includes("x-")) return "twitter";
  return "link-2";
}

/** A host name for a source chip with no label ("example.org"). */
export function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, "") : url;
}

/** A connector id in words for a button ("instagram" → "Instagram"); unknown ids are title-cased, never guessed at. */
export function connectorName(id: string): string {
  const known: Record<string, string> = {
    instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", gmail: "Gmail", outlook: "Outlook", x: "X", twitter: "X",
    google_calendar: "Google Calendar", stripe: "Stripe", shopify: "Shopify",
  };
  return known[id.toLowerCase()] ?? id.replace(/[_-]+/g, " ").replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}
