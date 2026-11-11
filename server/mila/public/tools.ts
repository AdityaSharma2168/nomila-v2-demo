/**
 * public/tools.ts — public Mila mode's tools: a REPLACED allowlist, not an addition to the app's registry
 * (design-public-card-v3 §4 "The five tools"). On the public card Mila can see her PUBLISHED snapshot and the visitor's
 * own chat, and nothing else.
 *
 *   read_card(chapter?)                         the published snapshot: an overview, one chapter, her published
 *                                               offers (all-in prices) or her picks (her own words). Never the draft,
 *                                               the sources manifest, her switches, or any table.
 *   show_picks(ids?)                            pick tiles from the snapshot (Shop on only). Never a recommendation.
 *   list_published_slots(offer_id, from?, days?) READ-ONLY open times of ONE published offer, through the bookings
 *                                               port (Book on + port wired only). Nothing else about her day.
 *   request_booking(offer_id, slot_id | times)  PREPARES a request card. Writes nothing: only the visitor's own tap on
 *                                               the card (POST /p/:handle/ask/booking) creates the pending request.
 *   start_partner_request(kind)                 PREPARES the intake for a request kind (Partner on + port wired only);
 *                                               the visitor's tap (POST /p/:handle/ask/partner) opens it.
 *
 * Never available here: inbox, deals, rates and floors, private notes, M.I.A. internals, other athletes, her private
 * calendar, web search, and any send, accept or commit tool. publicTools.boundary.test.ts fails the build if the public
 * tool set ever holds a tool outside PUBLIC_TOOL_ALLOWLIST, or if this file reaches the database.
 *
 * Tenancy: every tool is a closure over ONE PublicTurnContext, whose athlete id and snapshot the server resolved from
 * the handle. No tool takes an athlete id, and ids the model passes (offer, pick, slot) are checked against that
 * athlete's published snapshot (and, for slots, her port answer) before anything is used.
 *
 * Nothing here names an athlete, sport, school, league or brand.
 */
import { z } from "zod";
import type { PublicCardContent, PublicItem } from "../../../shared/publicCard";
import type { MilaTool } from "../types";
import { PARTNER_REQUEST_KINDS, type PartnerRequestKind, type PublicMilaPorts, type PublicSlot } from "./ports";

/** THE allowlist. A public tool set may hold these names and no other (publicTools.boundary.test.ts). */
export const PUBLIC_TOOL_ALLOWLIST = ["read_card", "show_picks", "list_published_slots", "request_booking", "start_partner_request"] as const;
export type PublicToolName = (typeof PUBLIC_TOOL_ALLOWLIST)[number];

/** Structured cards a public answer may carry. Every id is from her published snapshot or the port's answer. */
export type PublicWidget =
  | { type: "picks"; ids: string[] }
  | { type: "slots"; offerId: string; offerTitle: string; slots: Array<{ id: string; startsAt: string; label: string }> }
  | { type: "booking_request"; offerId: string; offerTitle: string; price: string | null; slotId: string | null; slotLabel: string | null; times: string[] | null; note: string | null }
  | { type: "partner_request"; kind: PartnerRequestKind; label: string };

export interface PublicTurnContext {
  /** Resolved on the server from the handle. Never from the visitor or the model. */
  athleteId: string;
  /** Her PUBLISHED content (publicCardReader.read). */
  content: PublicCardContent;
  sessionId: string;
  /** The visitor's IANA time zone (validated), for slot labels. Null → UTC. */
  visitorTz: string | null;
  now: Date;
  ports: PublicMilaPorts;
  /** Filled by the tools during the turn. */
  widgets: PublicWidget[];
  /** The last chapter read_card returned (the answer's citation). */
  citedChapter: string | null;
}

const PARTNER_LABELS: Record<PartnerRequestKind, string> = {
  sponsorship: "Sponsorship or ambassador",
  content: "Social posts or content",
  endorsement: "Endorsement or product collab",
  appearance: "Appearance or event",
  press: "Interview, podcast or editorial",
  other: "Something else",
};

/** "$177.96" from minor units. */
export function money(minor: number | null | undefined, currency: string | null | undefined): string | null {
  if (minor == null || !Number.isFinite(minor)) return null;
  const cur = (currency ?? "usd").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${cur}`;
  }
}

const compact = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : Math.abs(n) >= 1_000 ? `${Math.round(n / 100) / 10}K` : String(Math.round(n));

/** A chapter item as Mila may read it: the words shown on the card and the public detail fields. No keys, no sources. */
function readItem(it: PublicItem): Record<string, unknown> | null {
  switch (it.kind) {
    case "stat":
      return it.value == null ? null : { kind: "stat", label: it.label ?? null, value: compact(it.value), asOf: it.asOf ?? null };
    case "media":
      return null; // a photo or video: nothing to say about it beyond that the chapter has media
    default:
      return it.text ? { kind: it.kind, text: it.text, ...(it.label ? { label: it.label } : {}), ...(it.since ? { since: it.since } : {}) } : null;
  }
}

const offerPublicId = (key: string) => (key.startsWith("offer:") ? key.slice("offer:".length) : null);

function slotLabel(iso: string, tz: string | null): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { timeZone: tz ?? "UTC", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Book is open on this snapshot, the bookings port is wired, AND bookings are on for this athlete (flag + pilot list).
 * Otherwise neither booking tool is declared, so Mila can never prepare a request card the visitor could only have
 * refused. Minors never have Book (doors are resolved at publish).
 */
const bookOpen = (ctx: PublicTurnContext) =>
  !!ctx.content.doors.book && ctx.content.offers.length > 0 && !!ctx.ports.bookings && ctx.ports.bookings.bookable(ctx.athleteId);
const shopOpen = (ctx: PublicTurnContext) => !!ctx.content.doors.shop && ctx.content.picks.length > 0;
const partnerOpen = (ctx: PublicTurnContext) => !!ctx.content.doors.partner && !!ctx.ports.partner;

function guard(ctx: PublicTurnContext, athleteId: string): void {
  // The loop passes the id it was given; the closure holds the id the server resolved. They are the same or nothing runs.
  if (athleteId !== ctx.athleteId) throw new Error("public tool called for another card");
}

/**
 * The tools for ONE public turn. Which of the five are declared depends only on her published doors and which ports are
 * wired, so the model cannot even name a door that is closed.
 */
export function buildPublicTools(ctx: PublicTurnContext): MilaTool[] {
  const c = ctx.content;
  const chapterKeys = c.chapters.map((ch) => ch.key) as string[];
  const tools: MilaTool[] = [];

  const readCard: MilaTool = {
    name: "read_card",
    description:
      "Read the athlete's PUBLISHED public card — the only source of facts you have. Without a chapter: an overview " +
      "(first name, chapter list, which doors are open, and the published score only if one is published). With a " +
      "chapter: that chapter's published lines. 'offers' = published sessions with all-in prices; 'picks' = products " +
      "with the athlete's own words. Cite the chapter you used.",
    argsSchema: z.object({
      chapter: z.enum(["overview", ...chapterKeys, "offers", "picks"] as [string, ...string[]]).optional().describe("Which part of the card to read."),
    }),
    async execute(athleteId, args: { chapter?: string }) {
      guard(ctx, athleteId);
      const which = args.chapter ?? "overview";
      if (which === "overview") {
        return {
          firstName: c.firstName,
          name: c.displayName,
          chapters: c.chapters.map((ch) => ({ chapter: ch.key, title: ch.title })),
          open: { partner: !!c.doors.partner, book: !!c.doors.book && c.offers.length > 0, shop: !!c.doors.shop && c.picks.length > 0 },
          // Only when she switched show_mia on, and then only the published number and band (owner decision 8 Oct).
          ...(c.mia ? { miaScore: { score: c.mia.score, band: c.mia.band } } : {}),
        };
      }
      if (which === "offers") {
        if (!c.doors.book) return { offers: [], note: "Booking is not open on this card." };
        return {
          offers: c.offers.filter((o) => o.totalCents != null).map((o) => ({
            offerId: o.key, title: o.text, durationMinutes: o.durationMinutes ?? null,
            format: o.locationMode === "in_person" ? "in person" : "virtual",
            // The ONE price a visitor pays (all-in, quoted at publish). Her own price and the fee split are not here.
            allInPrice: money(o.totalCents, o.currency),
          })),
        };
      }
      if (which === "picks") {
        if (!c.doors.shop) return { picks: [], note: "Shop is not open on this card." };
        return {
          picks: c.picks.map((p) => ({ pickId: p.key, title: p.text, merchant: p.merchant ?? null, listedPrice: money(p.priceCents, p.currency), athleteOwnWords: p.blurb ?? null, paidLink: true })),
        };
      }
      const ch = c.chapters.find((x) => x.key === which);
      if (!ch) return { error: "No such chapter on this card." };
      ctx.citedChapter = ch.key;
      return { chapter: ch.key, title: ch.title, lines: ch.items.map(readItem).filter(Boolean) };
    },
  };
  tools.push(readCard);

  if (shopOpen(ctx)) {
    tools.push({
      name: "show_picks",
      description:
        "Show product tiles from the athlete's published picks in the chat (each a paid link, with the athlete's own " +
        "words only). Pass pick ids from read_card('picks'); omit to show them all (up to 6). Never recommend a product yourself.",
      argsSchema: z.object({ ids: z.array(z.string()).optional().describe("Pick ids from read_card('picks').") }),
      async execute(athleteId, args: { ids?: string[] }) {
        guard(ctx, athleteId);
        const known = new Map(c.picks.map((p) => [p.key, p]));
        const ids = (args.ids?.length ? args.ids : c.picks.map((p) => p.key)).filter((id) => known.has(id)).slice(0, 6);
        if (!ids.length) return { error: "None of those are on the card." };
        ctx.widgets.push({ type: "picks", ids });
        return { shown: ids.map((id) => ({ pickId: id, title: known.get(id)!.text, athleteOwnWords: known.get(id)!.blurb ?? null, listedPrice: money(known.get(id)!.priceCents, known.get(id)!.currency) })) };
      },
    });
  }

  if (bookOpen(ctx)) {
    const offers = new Map(c.offers.filter((o) => o.totalCents != null && offerPublicId(o.key)).map((o) => [o.key, o]));
    const openSlots = async (offerKey: string, from: Date, days: number): Promise<PublicSlot[]> => {
      const slots = await ctx.ports.bookings!.listOpenSlots({ athleteId: ctx.athleteId, offerPublicId: offerPublicId(offerKey)!, from, days });
      // Defence in depth: only future, well-formed times, whatever the port answers.
      return slots.filter((s) => typeof s.id === "string" && !isNaN(Date.parse(s.startsAt)) && Date.parse(s.startsAt) > ctx.now.getTime()).slice(0, 12);
    };

    tools.push({
      name: "list_published_slots",
      description:
        "READ-ONLY. The open times the athlete PUBLISHED for one offer (offer id from read_card('offers')). Shows them " +
        "to the visitor as tappable times. These are the only times you may mention; never guess or discuss anything else about the athlete's schedule.",
      argsSchema: z.object({
        offer_id: z.string().describe("An offerId from read_card('offers')."),
        from: z.string().optional().describe("ISO date to start from (default today)."),
        days: z.number().int().optional().describe("How many days to look ahead, 1–14 (default 14)."),
      }),
      async execute(athleteId, args: { offer_id: string; from?: string; days?: number }) {
        guard(ctx, athleteId);
        const offer = offers.get(args.offer_id);
        if (!offer) return { error: "That offer is not on the card." };
        const fromMs = args.from && !isNaN(Date.parse(args.from)) ? Math.max(Date.parse(args.from), ctx.now.getTime()) : ctx.now.getTime();
        const days = Math.min(Math.max(args.days ?? 14, 1), 14);
        const slots = await openSlots(offer.key, new Date(fromMs), days);
        const shown = slots.map((s) => ({ id: s.id, startsAt: s.startsAt, label: slotLabel(s.startsAt, ctx.visitorTz) }));
        if (shown.length) ctx.widgets.push({ type: "slots", offerId: offer.key, offerTitle: offer.text ?? "", slots: shown });
        return { offer: offer.text, timeZone: ctx.visitorTz ?? "UTC", times: shown.map((s) => ({ slotId: s.id, when: s.label })), ...(shown.length ? {} : { note: "No published times in that window." }) };
      },
    });

    tools.push({
      name: "request_booking",
      description:
        "PREPARE a booking request card for the visitor to tap. It sends and saves nothing: the visitor's own tap on the " +
        "card sends the request, then they verify. Pass offer_id and EITHER a slot_id from list_published_slots OR 1–3 " +
        "ISO times the visitor suggested (only when the offer takes suggested times).",
      argsSchema: z.object({
        offer_id: z.string(),
        slot_id: z.string().optional(),
        times: z.array(z.string()).optional(),
        note: z.string().optional().describe("A short note from the visitor, in their words (optional)."),
      }),
      async execute(athleteId, args: { offer_id: string; slot_id?: string; times?: string[]; note?: string }) {
        guard(ctx, athleteId);
        const offer = offers.get(args.offer_id);
        if (!offer) return { error: "That offer is not on the card." };
        if (!!args.slot_id === !!(args.times && args.times.length)) return { error: "Pass exactly one of slot_id or times." };
        let slotId: string | null = null; let slotLbl: string | null = null; let times: string[] | null = null;
        if (args.slot_id) {
          // Re-read the published times: a slot id is usable only if it is open right now for THIS offer.
          const slot = (await openSlots(offer.key, ctx.now, 14)).find((s) => s.id === args.slot_id);
          if (!slot) return { error: "That time is not open. Show the published times again." };
          slotId = slot.id; slotLbl = slotLabel(slot.startsAt, ctx.visitorTz);
        } else {
          const t = (args.times ?? []).filter((x) => !isNaN(Date.parse(x)) && Date.parse(x) > ctx.now.getTime()).slice(0, 3);
          if (!t.length) return { error: "Suggested times must be in the future." };
          times = t.map((x) => new Date(x).toISOString());
        }
        const note = args.note ? args.note.replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
        ctx.widgets.push({ type: "booking_request", offerId: offer.key, offerTitle: offer.text ?? "", price: money(offer.totalCents, offer.currency), slotId, slotLabel: slotLbl, times, note });
        return { prepared: true, sent: false, tellVisitor: "Tap the request card to send it. Nothing is sent until you tap." };
      },
    });
  }

  if (partnerOpen(ctx)) {
    tools.push({
      name: "start_partner_request",
      description:
        "PREPARE the start of a request to work with the athlete, for the visitor to tap. It sends nothing. Pick the kind " +
        "that matches what the visitor wants.",
      argsSchema: z.object({ kind: z.enum(PARTNER_REQUEST_KINDS as unknown as [PartnerRequestKind, ...PartnerRequestKind[]]) }),
      async execute(athleteId, args: { kind: PartnerRequestKind }) {
        guard(ctx, athleteId);
        ctx.widgets.push({ type: "partner_request", kind: args.kind, label: PARTNER_LABELS[args.kind] });
        return { prepared: true, sent: false, tellVisitor: "Tap the card to start the request." };
      },
    });
  }

  assertPublicToolset(tools);
  return tools;
}

/** Throws when a tool set holds anything outside the allowlist. The loop calls it on every public turn. */
export function assertPublicToolset(tools: MilaTool[]): MilaTool[] {
  const allowed = new Set<string>(PUBLIC_TOOL_ALLOWLIST);
  const bad = tools.filter((t) => !allowed.has(t.name)).map((t) => t.name);
  if (bad.length) throw new Error(`public Mila mode: tools outside the allowlist: ${bad.join(", ")}`);
  return tools;
}
