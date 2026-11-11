/**
 * public/outputGate.ts — the post-check every public Mila answer passes BEFORE a visitor sees it (design-public-card-v3
 * §4 "Output gate"; owner decisions 8 Oct). The prompt asks for the rules; this enforces them deterministically, so a
 * model that slips (or a visitor who talks it into slipping) still cannot put the words on the page.
 *
 * Blocked, in this order:
 *   impersonation       Mila writing AS the athlete ("I'm <First>", "<First> here", a sign-off, first-person claims of
 *                       the athlete's life: my sponsors, my training, DM me …)
 *   promise             saying what the athlete will do or agrees to, or a guarantee by anyone
 *   pronoun             a gendered pronoun (the athlete's pronouns are never assumed: Mila uses the first name)
 *   contact             an email, a phone number, a link, a street address, or an @handle not on the card
 *   claim               a health, performance or results claim about a product ("boosts recovery", "proven to")
 *   budget              a judgement about a budget (enough, too low, minimum, fair …)
 *   rate                a money amount that is not a price on the card, or a "her rate is" statement
 *   unsupported_number  any other number that is not on the card or in what Mila's tools returned this turn
 *                       (a date, a count, a score …) — the v1 "number not in the snapshot" check
 * A blocked answer is replaced by the fallback line; the draft is never shown or stored.
 *
 * Her own words QUOTED verbatim from the card ("…" / “…”) are exempt from the impersonation, pronoun and promise checks:
 * a pick's line or a quote is hers, and quoting it is the point. Everything else is checked.
 *
 * Nothing here names an athlete, sport, school, league or brand: the only variable is the first name from the snapshot.
 */
import type { PublicCardContent } from "../../../shared/publicCard";

export type GateReason = "empty" | "impersonation" | "promise" | "pronoun" | "contact" | "claim" | "budget" | "rate" | "unsupported_number";
export type GateVerdict = { ok: true; text: string } | { ok: false; reason: GateReason; text: string };

export interface GateInput {
  text: string;
  content: PublicCardContent;
  /** Whatever Mila's tools returned this turn (published times, prices …): their numbers are allowed. */
  toolResults: unknown[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.toLowerCase().replace(/[“”"‘’']/g, "").replace(/\s+/g, " ").trim();

/** The visitor sees this instead of a blocked answer. Third person, no promise, points at a door that is open. */
export function fallbackLine(content: PublicCardContent): string {
  const f = content.firstName;
  if (content.doors.partner) return `I can only share what's on ${f}'s card, and that isn't on it. You can send ${f} a request through Partner.`;
  return `I can only share what's on ${f}'s card, and that isn't on it.`;
}

/** Every piece of text on the published card (what quoting is checked against). */
function cardCorpus(c: PublicCardContent): string {
  const parts: string[] = [c.displayName, c.firstName, c.lastName];
  for (const ch of c.chapters) {
    parts.push(ch.title);
    for (const it of ch.items) parts.push(it.text ?? "", it.label ?? "", it.blurb ?? "");
  }
  for (const it of [...c.offers, ...c.picks]) parts.push(it.text ?? "", it.blurb ?? "", it.merchant ?? "");
  return norm(parts.join(" \n "));
}

/** Removes verbatim quotes of the card's own words, so they are not judged as Mila's prose. */
function withoutCardQuotes(text: string, corpus: string): string {
  return text.replace(/[“"]([^”"]{3,400})[”"]/g, (m, inner: string) => (corpus.includes(norm(inner)) ? " " : m));
}

const MONEY = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|thousand|million)?\b)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars|bucks|eur|gbp)\b)/gi;
const moneyValue = (s: string): number | null => {
  const m = s.toLowerCase().replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s?(k|m|thousand|million)?/);
  if (!m) return null;
  const mult = m[2] === "k" || m[2] === "thousand" ? 1e3 : m[2] === "m" || m[2] === "million" ? 1e6 : 1;
  return Math.round(Number(m[1]) * mult * 100);
};

/** Numbers that may appear: everything in the published content and in this turn's tool results, as written there. */
function allowedNumbers(c: PublicCardContent, toolResults: unknown[]): { nums: Set<string>; cents: Set<number> } {
  const nums = new Set<string>();
  const add = (s: string) => { for (const m of s.match(/\d+(?:\.\d+)?/g) ?? []) nums.add(String(Number(m))); };
  add(JSON.stringify(c));
  add(JSON.stringify(toolResults ?? []));
  const cents = new Set<number>();
  for (const it of [...c.offers, ...c.picks]) {
    if (it.totalCents != null) cents.add(it.totalCents);
    if (it.kind === "pick" && it.priceCents != null) cents.add(it.priceCents);
  }
  // Prices the tools formatted ("$177.96") are allowed as amounts too.
  for (const m of JSON.stringify(toolResults ?? []).match(MONEY) ?? []) { const v = moneyValue(m); if (v != null) cents.add(v); }
  // Stats are shown compacted ("12.4K"): allow the compact form's digits.
  for (const ch of c.chapters) for (const it of ch.items) if (it.value != null) {
    const v = it.value;
    add(Math.abs(v) >= 1e6 ? String(Math.round(v / 1e5) / 10) : Math.abs(v) >= 1e3 ? String(Math.round(v / 100) / 10) : String(Math.round(v)));
  }
  return { nums, cents };
}

export function gateAnswer(input: GateInput): GateVerdict {
  const c = input.content;
  const raw = (input.text ?? "").trim();
  const block = (reason: GateReason): GateVerdict => ({ ok: false, reason, text: fallbackLine(c) });
  if (!raw) return block("empty");

  const f = esc(c.firstName.trim());
  const corpus = cardCorpus(c);
  const prose = withoutCardQuotes(raw, corpus);

  // ── impersonation: Mila is never the athlete ─────────────────────────────────────────────────────────────────────
  const impersonation = [
    new RegExp(`\\b(i am|i'm|im|i’m|this is|it's|it’s|its me,?)\\s+${f}\\b(?!['’])`, "i"),
    new RegExp(`\\b${f}\\s+here\\b`, "i"),
    new RegExp(`\\bas ${f},?\\s+i\\b`, "i"),
    new RegExp(`(^|\\n)\\s*[-–—~]\\s*${f}\\s*[.!]?\\s*$`, "i"),
    new RegExp(`\\b(love|xo|xoxo|xx|cheers|best|thanks|talk soon),?\\s*${f}\\s*[.!]?\\s*$`, "i"),
    /\bmy (sponsors?|partners?|partnerships?|team|teammates|coach|training|career|fans|rates?|schedule|calendar|deals?|season|followers|card|picks|story)\b/i,
    /\bi (train|trained|compete|competed|race|raced|play|played|signed|partnered|personally use|use (this|it|them) (every|daily|before|after))\b/i,
    /\b(dm|message|text|email|call) me\b/i,
  ];
  if (impersonation.some((re) => re.test(prose))) return block("impersonation");

  // ── promises on her behalf (or anyone's) ─────────────────────────────────────────────────────────────────────────
  const promise = [
    new RegExp(`\\b${f}(?:'ll|’ll)\\b`, "i"),
    new RegExp(`\\b${f}\\s+(will|would love|would be (happy|glad|thrilled|excited|honored|honoured)|(is|'s|’s) (happy|glad|thrilled|excited|available|free|interested|keen|in)|agrees|accepts|promises|guarantees|can definitely|definitely|is going to|wants to|loves to)\\b`, "i"),
    /\b(i|we|nomila)\s+(promise|guarantee)\b/i,
    /\bguarantee(d|s)?\b/i,
    /\b(you'?re|you’re|you are) (booked|confirmed|approved|accepted|in)\b/i,
    /\b(i'?ll|i’ll|i will|we'?ll|we’ll|we will) (make sure|get back|confirm|book|arrange|set (it|this|that) up|lock|secure|pass (it|this) on and)\b/i,
  ];
  if (promise.some((re) => re.test(prose))) return block("promise");

  // ── pronouns: never assumed ──────────────────────────────────────────────────────────────────────────────────────
  if (/\b(he|she|him|her|his|hers|himself|herself)\b/i.test(prose)) return block("pronoun");

  // ── contact details ──────────────────────────────────────────────────────────────────────────────────────────────
  const handles = new Set(c.socials.map((s) => s.handle.toLowerCase().replace(/^@/, "")));
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(prose)) return block("contact");
  if (/(https?:\/\/|www\.)\S+/i.test(prose) || /\b[a-z0-9-]+\.(com|co|net|org|io|app|me|ly|gg|tv)\b/i.test(prose)) return block("contact");
  if (/(\+?\d[\d\s().-]{8,}\d)/.test(prose.replace(MONEY, " "))) return block("contact");
  if (/\b\d{1,5}\s+([a-z]+\s){0,3}(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b/i.test(prose)) return block("contact");
  for (const m of prose.match(/(^|\s)@([a-z0-9._]{2,30})/gi) ?? []) {
    if (!handles.has(m.trim().slice(1).replace(/[.]+$/, "").toLowerCase())) return block("contact");
  }

  // ── no health or performance claims (Shop mode, and anywhere else) ─────────────────────────────────────────────
  if (/\b(boosts?|improves?|enhances?|increases?|speeds? up|aids?|supports?|helps? with|maximi[sz]es?|optimi[sz]es?)\s+(your\s+|the\s+)?(recovery|performance|endurance|stamina|immunity|immune|energy|metabolism|strength|focus|sleep|hydration|muscles?|results|gains)\b/i.test(prose)
    || /\b(cures?|heals?|treats?|prevents?|clinically|scientifically|proven to|fda|weight loss|lose weight|burns? fat|detox|guaranteed results)\b/i.test(prose)) return block("claim");

  // ── budget neutrality ────────────────────────────────────────────────────────────────────────────────────────────
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.toLowerCase();
    if (/\bbudget/.test(s) && /\b(enough|too (low|high|small|little|much)|sufficient|insufficient|works?|fits?|in (the )?range|on the (low|high) side|minimum|realistic|competitive|fair|generous|reasonable|lowball|good|great|solid|tight|stretch)\b/.test(s)) return block("budget");
    if (/\b(minimum|floor|starting (rate|price|fee)|lowest (rate|price|fee))\b/.test(s) && !/\b(not on|can't|cannot|don't|do not|isn't|is not)\b/.test(s)) return block("budget");
  }

  // ── money: only the prices on the card ───────────────────────────────────────────────────────────────────────────
  const { nums, cents } = allowedNumbers(c, input.toolResults);
  if (new RegExp(`\\b(${f}(?:'s|’s)?|the|a typical|usual)\\s+(rate|rates|fee|fees|price for a (post|video|story|campaign))\\s+(is|are|starts?|would be|runs?)\\b`, "i").test(prose)) return block("rate");
  if (/\bper (post|video|story|reel|campaign|appearance|hour)\b/i.test(prose) && new RegExp(MONEY.source, "i").test(prose)) return block("rate");
  for (const m of prose.match(MONEY) ?? []) {
    const v = moneyValue(m);
    if (v == null || !cents.has(v)) return block("rate");
  }
  // An amount without a currency sign in a sentence about paying ("charges around 1k for a story") is a rate too.
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
    if (!/\b(charges?|charging|costs?|rates?|fees?|priced?|pays?|paid|earns?|asks? for|quote[sd]?)\b/i.test(sentence)) continue;
    for (const m of sentence.replace(MONEY, " ").match(/\b\d[\d,]*(?:\.\d+)?\s?(?:k|m|thousand|million|grand)?\b/gi) ?? []) {
      const v = moneyValue(m.replace(/grand/i, "k"));
      if (v != null && (/[a-z]/i.test(m) || v > 1000) && !cents.has(v)) return block("rate");
    }
  }

  // ── every other number must be on the card or in this turn's tool results ──────────────────────────────────────
  const rest = prose.replace(MONEY, " ");
  for (const m of rest.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    const n = Number(m.replace(/,/g, ""));
    if (Number.isInteger(n) && n >= 0 && n <= 10) continue; // "up to 3 times", "one of 2 sessions"
    if (!nums.has(String(n)) && !nums.has(m.replace(/,/g, ""))) return block("unsupported_number");
  }

  return { ok: true, text: raw };
}
