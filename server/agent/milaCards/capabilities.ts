/**
 * agent/milaCards/capabilities.ts — the Turn-on offer's capabilities, backed by the Welcome registry
 * (agent/welcome/registry.ts + mila_choices, #1165). The registry decides WHAT may be offered (optional, a switch,
 * available, the athlete's state and cooldown: welcome/turnOn.ts offerFor) and holds the consent a yes covers (its
 * words and version). This file only holds each offerable capability's CARD presentation (headline, line, the sheet's
 * three rows, glyph, scene): a capability with no presentation here is never offered as a card.
 *
 * Sheet rules (the page): three rows, always in this order — what it does · what you control · what can go wrong — each
 * a bold title plus one grey line; one raspberry button; "Not now" as text; "Don't offer this again" in the legal line.
 * The consent block on the sheet (what it reads, what always asks first) is the registry's own words, never the model's.
 * The card and sheet copy promise only what the capability's consent covers (post_ideas/1: newly tagged photos and
 * videos; nothing reads a schedule or calendar). The copy is not versioned; the consent block is, and is unchanged.
 *
 * Every built capability a card switches on has a presentation (5 Nov 2026), so with MILA_WELCOME on each one can be
 * offered in chat and turned on, paused or off in Me. Planned capabilities have none (nothing to turn on yet), nor do
 * the three built ones that are not switches: studio_posts (nothing to opt into), public_page (their own publish tap) and
 * get_paid (connecting payouts).
 */
import { capability as registryEntry } from "../welcome/registry";
import { consentWords } from "../welcome/turnOn";

export interface CardPresentation {
  /** The Welcome registry key. */
  key: string;
  /** A capability resting on a service shows its mark (LogoMark platform); else its glyph in a white tile. */
  platform: string | null;
  glyph: string | null;
  headline: string;
  line: string;
  /** The two short rows on the card: what it reads · what always asks first. */
  consentShort: [string, string];
  sheet: { purpose: string; rows: Array<{ icon: string; title: string; line: string }>; legal: string; button: string };
  /** Words for the atmosphere pick behind the glyph. */
  scene: string;
}

/** The second row of every sheet: the athlete's control, in the same words each time. */
const control = (line: string) => ({ icon: "lock", title: "You choose what Mila can do", line });
/** The third row of every sheet: what can go wrong. */
const watch = (line: string) => ({ icon: "eye", title: "Keep an eye on it", line });

/**
 * One presentation per built capability that a card switches on (registry: optional, optInTarget "choice", not planned;
 * capabilities.test.ts holds that list and these words to the card schema). Plain words, the post_ideas pattern: a
 * headline, one line, three rows, and the legal line on what turning it off leaves. The exact words are in the Prompt
 * Register (Mila & agent page, "Turn-on presentations").
 */
export const PRESENTATIONS: readonly CardPresentation[] = [
  {
    key: "post_ideas",
    platform: null,
    glyph: "camera",
    headline: "Post ideas from your camera roll",
    line: "Post ideas from the new photos and videos you share.",
    consentShort: ["Reads new photos and videos you share", "Always asks first: posting anything"],
    sheet: {
      purpose: "Post ideas from the new photos and videos you share.",
      rows: [
        { icon: "image", title: "Ideas from your own shots", line: "Mila looks at the new photos and videos you share with Nomila and suggests posts." },
        { icon: "lock", title: "You choose what Mila can do", line: "Nothing is posted without your tap. Turn it off any time in Me." },
        { icon: "eye", title: "Keep an eye on it", line: "Mila can get things wrong. Check each idea before you use it." },
      ],
      legal: "Ideas Mila already made stay yours if you turn this off.",
      button: "Turn on",
    },
    scene: "locker room game day",
  },
  {
    key: "draft_replies",
    platform: null,
    glyph: "edit-3",
    headline: "Draft replies to brands",
    line: "A first reply written for you when a brand deal arrives.",
    consentShort: ["Writes a reply when a deal arrives", "Always asks first: sending any reply"],
    sheet: {
      purpose: "A first reply written for you when a brand deal arrives on this account.",
      rows: [
        { icon: "edit-3", title: "A reply ready to check", line: "When a brand deal arrives on this account, Mila writes a first reply for you to read." },
        control("Nothing is sent without your tap. Turn it off any time in Me."),
        watch("Mila can get things wrong. Read each draft before you send it."),
      ],
      legal: "Drafts Mila already wrote stay yours if you turn this off.",
      button: "Turn on",
    },
    scene: "desk laptop morning light",
  },
  {
    // On by default (registry defaultOn, owner 10 Nov 2026): Me shows it switched on; this is its row and sheet there.
    key: "voice_send",
    platform: null,
    glyph: "mic",
    headline: "Send replies by voice",
    line: "Send ordinary replies by voice after Mila reads them back.",
    consentShort: ["Sends a reply when you say \"send it\"", "Money or a yes to an offer always needs your tap"],
    sheet: {
      purpose: "Send ordinary replies by voice after Mila reads them back.",
      rows: [
        { icon: "mic", title: "Say \"send it\"", line: "In a call, Mila reads a reply back to you. Say \"send it\" and it goes." },
        control("Money, a yes to an offer and bookings still need your tap. Turn it off any time in Me."),
        watch("Mila can mishear. Listen to the read-back before you say send."),
      ],
      legal: "Replies already sent stay sent if you turn this off.",
      button: "Turn on",
    },
    scene: "headphones on the team bus",
  },
  {
    key: "auto_archive",
    platform: null,
    glyph: "archive",
    headline: "Set aside deals that went quiet",
    line: "Deals nobody worked on for 45 days move out of your list, with Undo.",
    consentShort: ["Sets aside deals quiet for 45 days", "Undo any of them from your deals"],
    sheet: {
      purpose: "Deals nobody worked on for 45 days move out of your list, with Undo.",
      rows: [
        { icon: "archive", title: "A shorter list", line: "A deal with no activity for 45 days, that nobody worked on, moves out of your list." },
        control("Deals you work on, or where the brand answered your reply, are never set aside. Turn it off any time in Me."),
        watch("Mila can get things wrong. Each deal set aside shows under Set aside by Nomila, with Undo."),
      ],
      legal: "Deals already set aside stay set aside if you turn this off. Undo still works.",
      button: "Turn on",
    },
    scene: "quiet empty stadium seats",
  },
  {
    key: "moments_scan",
    platform: null,
    glyph: "star",
    headline: "Moments worth a post",
    line: "Mila checks public news about you each week for moments worth a post.",
    consentShort: ["Checks public news about you weekly", "Nothing is posted without your tap"],
    sheet: {
      purpose: "Mila checks public news about you each week for moments worth a post.",
      rows: [
        { icon: "star", title: "Your moments, found for you", line: "Each week Mila reads public news about you, like results and milestones, and flags ones worth a post." },
        control("Nothing is posted without your tap. Turn it off any time in Me."),
        watch("Mila can get things wrong. Check a moment is right before you post about it."),
      ],
      legal: "Moments Mila already found stay yours if you turn this off.",
      button: "Turn on",
    },
    scene: "stadium lights night",
  },
  {
    key: "pitch_deck",
    platform: null,
    glyph: "file-text",
    headline: "Pitch cards for brands",
    line: "A one-page pitch for a brand you want to work with, ready for you to check.",
    consentShort: ["Makes pitch drafts for you to check", "Always asks first: sharing it"],
    sheet: {
      purpose: "A one-page pitch for a brand you want to work with, ready for you to check.",
      rows: [
        { icon: "file-text", title: "A pitch for each brand", line: "Mila makes a pitch card for a brand you choose, from your research and your numbers." },
        control("Nothing is shared without your tap. Turn it off any time in Me."),
        watch("Mila can get things wrong. Read each pitch before you share it."),
      ],
      legal: "Pitches Mila already made stay yours if you turn this off.",
      button: "Turn on",
    },
    scene: "notebook desk coffee",
  },
  {
    key: "brand_book",
    platform: null,
    glyph: "book-open",
    headline: "Your brand book",
    line: "Your story and your numbers in one book, ready for you to check.",
    consentShort: ["Makes a brand book draft for you", "Always asks first: sharing it"],
    sheet: {
      purpose: "Your story and your numbers in one book, ready for you to check.",
      rows: [
        { icon: "book-open", title: "Your story in one place", line: "Mila makes a brand book from your research and your numbers, for brands who ask for one." },
        control("Nothing is shared without your tap. Turn it off any time in Me."),
        watch("Mila can get things wrong. Read every page before you share it."),
      ],
      legal: "A brand book Mila already made stays yours if you turn this off.",
      button: "Turn on",
    },
    scene: "magazine pages studio light",
  },
  {
    key: "plan_refresh",
    platform: null,
    glyph: "refresh-cw",
    headline: "Your plan, refreshed weekly",
    line: "Mila rebuilds your plan each week and before dated events.",
    consentShort: ["Rebuilds your plan each week", "Your goals stay yours to change"],
    sheet: {
      purpose: "Mila rebuilds your plan each week and before dated events.",
      rows: [
        { icon: "refresh-cw", title: "A plan that keeps up", line: "Each week, and before dated events, Mila rebuilds your plan from what changed." },
        control("Keep, change or drop any goal. Turn it off any time in Me."),
        watch("Mila can get things wrong. Check the plan still fits before you follow it."),
      ],
      legal: "Your plan as it is today stays yours if you turn this off.",
      button: "Turn on",
    },
    scene: "training track morning",
  },
  {
    key: "post_took_off",
    platform: null,
    glyph: "trending-up",
    headline: "Hear when a post takes off",
    line: "Mila messages you when a post does far better than your usual.",
    consentShort: ["Messages you when a post takes off", "Nothing is posted or sent for you"],
    sheet: {
      purpose: "Mila messages you when a post does far better than your usual.",
      rows: [
        { icon: "trending-up", title: "Know what worked", line: "When a post does far better than your usual, Mila tells you, so you can make more like it." },
        control("Mila only sends you a message. Nothing is posted for you. Turn it off any time in Me."),
        watch("Mila can get things wrong. Numbers come from your connected accounts and can be late."),
      ],
      legal: "Messages Mila already sent stay in your chats if you turn this off.",
      button: "Turn on",
    },
    scene: "crowd celebration arena",
  },
  {
    key: "profile_refresh",
    platform: null,
    glyph: "search",
    headline: "Research refreshed monthly",
    line: "Mila looks up new public sources about you about once a month.",
    consentShort: ["Looks for new sources about you monthly", "You can correct anything it finds"],
    sheet: {
      purpose: "Mila looks up new public sources about you about once a month.",
      rows: [
        { icon: "search", title: "Your record kept fresh", line: "About once a month, Mila looks for new public sources about you and adds what it finds." },
        control("Correct or hide anything in What Nomila knows. Turn it off any time in Me."),
        watch("Mila can get things wrong. Check that new facts about you look right."),
      ],
      legal: "What Mila already found stays in your record if you turn this off.",
      button: "Turn on",
    },
    scene: "library reading room",
  },
  {
    key: "bookings",
    platform: null,
    glyph: "calendar",
    headline: "Bookings for lessons and camps",
    line: "Booking requests from your page come to you. You accept or decline each one.",
    consentShort: ["Takes booking requests into your inbox", "Always asks first: accepting, charging"],
    sheet: {
      purpose: "Booking requests from your page come to you. You accept or decline each one.",
      rows: [
        { icon: "calendar", title: "Requests in one place", line: "Requests for lessons and camps from your public page come into your inbox for you to answer." },
        control("Nothing is accepted, declined or charged without your tap. Turn it off any time in Me."),
        watch("Mila can get things wrong. Check the date, time and price before you accept."),
      ],
      legal: "Bookings you already accepted stay booked if you turn this off.",
      button: "Turn on",
    },
    scene: "training camp field",
  },
];

export function presentation(key: string): CardPresentation | null {
  return PRESENTATIONS.find((p) => p.key === key) ?? null;
}

/** The sheet's consent block, from the registry (what the recorded consent version covers). */
export function sheetConsent(key: string): { reads: string[]; drafts: boolean; alwaysAsks: string[]; onRevoke: "stop_and_keep" | "stop_and_delete"; version: string } | null {
  const entry = registryEntry(key);
  if (!entry) return null;
  const w = consentWords(entry);
  return { reads: w.automatic, drafts: w.drafts, alwaysAsks: w.alwaysAsks, onRevoke: w.onRevoke, version: w.version };
}

/** The keys the model may pass: the registry keys that have a card presentation. */
export const CAPABILITY_KEYS = PRESENTATIONS.map((p) => p.key) as [string, ...string[]];

/**
 * offer_capability's `key` description (model-facing, Prompt Register "Mila card system v2 producers"): each key with
 * what it does, in the registry's own name and the card's own line, so the model matches the athlete's words to the
 * right key (6 Nov 2026: "refresh my research monthly" had picked plan_refresh from bare keys).
 */
export function capabilityKeyGuide(): string {
  const lines = PRESENTATIONS.map((p) => `${p.key}: ${registryEntry(p.key)?.name ?? p.headline}. ${p.line}`);
  return `The registry key of what they want. Match their words to what it does:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
