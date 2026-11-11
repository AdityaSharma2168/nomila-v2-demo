/**
 * frontCopy — every word of the agent onboarding front (sign-in, the sport grid, "Is this you?", Mila's intro, "What Mila
 * already has"), approved in the prototypes (#900). Copy speaks to "you"; nothing names an athlete, sport, school or brand
 * (those arrive as data), and the word for Mila is "agent", never anything else.
 */
import type React from "react";
import type { Feather } from "@expo/vector-icons";
import { ONBOARDING_INTERESTS } from "../../../shared/onboardingInterests";

type IconName = React.ComponentProps<typeof Feather>["name"];

/** Each intro tile's glyph and one short line (the tiles themselves: shared/onboardingInterests.ts). */
const INTEREST_LOOK: Record<string, { icon: IconName; line: string }> = {
  brand: { icon: "star", line: "Your story, shaped and timed to your moments" },
  page: { icon: "globe", line: "One link for brands and fans, with Mila as your concierge" },
  create: { icon: "aperture", line: "Your camera roll into ads, posts and pitches" },
  deals: { icon: "briefcase", line: "Offers from email and DMs, found, weighed, negotiated" },
  bookings: { icon: "calendar", line: "Share your knowledge, we handle scheduling and payment" },
  picks: { icon: "shopping-bag", line: "Your shop. Earn from products and brands you love" },
  money: { icon: "dollar-sign", line: "Get paid, and see what you've earned." },
};

/** "A", "A and B", "A, B and C". */
export function joinWords(words: readonly string[]): string {
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export const FRONT_COPY = {
  signIn: {
    // The current tagline, kept.
    eyebrow: "The operating system for athletes",
    line: "Your brand is a media business.",
    sub: "Monetize your impact.",
    cta: "Get your agent",
    google: "Continue with Google",
    apple: "Continue with Apple",
    microsoft: "Continue with Microsoft",
    terms: "By continuing you agree to the terms and privacy policy.",
    useEmail: "Use email instead",
  },
  // Sign in with a 6-digit email code (design "Sign in with email", 12 Oct 2026).
  email: {
    eyebrow: "Sign in with email",
    title: "What’s your email?",
    sub: "We’ll send you a 6-digit code. No password.",
    label: "Email",
    placeholder: "you@example.com",
    send: "Send code",
    back: "Other ways to sign in",
  },
  code: {
    eyebrow: "Check your email",
    title: "Enter your code",
    /** "We sent it to {email}. It works for 10 minutes." — the address drawn bold between the two parts. */
    subBefore: "We sent it to ",
    subAfter: ". It works for 10 minutes.",
    field: "6-digit code",
    resendIn: (clock: string) => `Resend in ${clock}`,
    resend: "Resend code",
    change: "Use a different email",
    spam: "Can’t find it? Check spam or Promotions.",
  },
  /** One error line for every way in: white, with an alert icon (no red: DESIGN.md keeps colour for the score). */
  err: {
    invalid: "That doesn’t look like an email address.",
    sendFailed: "We couldn’t send the code. Check your connection and try again.",
    /** The service-wide cap on codes sent is reached (not in the design's table). */
    busy: "Lots of sign-ins right now. Try again in a few minutes.",
    /**
     * The wait comes from the server (the design's line reads "15 minutes"; a locked-out address waits up to a day, said
     * in hours). Apple is named only where it is offered.
     */
    tooMany: (minutes: number, apple: boolean) => {
      const hours = Math.ceil(minutes / 60);
      const wait = minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${hours} hour${hours === 1 ? "" : "s"}`;
      return `Too many codes for this email. Try again in ${wait}, or use Google${apple ? " or Apple" : ""}.`;
    },
    wrong: (n: number) => `That code isn’t right. ${n} ${n === 1 ? "try" : "tries"} left.`,
    expired: "That code has expired.",
    locked: "Too many wrong tries. Send a new code to keep going.",
    newCode: "Send a new code",
    /** A Google, Apple or Microsoft sign-in, or a code check, that did not go through (not in the design's table). */
    signInFailed: "That didn’t go through. Check your connection and try again.",
    /**
     * Google or Apple refused because the address already has a Nomila account made another way (Firebase
     * auth/account-exists-with-different-credential; not in the design's table). Offers the email code when it is on.
     */
    accountExists: (emailCode: boolean) => emailCode
      ? "You already have a Nomila account with this email. Sign in with a code sent to it instead."
      : "You already have a Nomila account with this email. Sign in the way you did before.",
    useCode: "Send me a code",
  },
  sport: {
    title: "What do you play?",
    lede: "Pick your main sport first, then any others.",
    main: "Main",
    other: "Other: type to search or add",
    otherLabel: "Search sports, or type another sport",
    add: (sport: string) => `Add "${sport}" as your sport`,
    remove: "Remove",
    // Mila's chat chips (components/onboarding/SportChips): the eight common sports, then the full list in a sheet.
    more: "More sports",
    otherShort: "Other",
    allTitle: "All sports",
    allFine: "Type to filter every sport. Not listed? Add it.",
    done: "Done",
    nameLabel: "What should we call you?",
    namePlaceholder: "Your name",
    go: "Continue",
    error: "That didn't save. Check your connection and try again.",
  },
  claim: {
    eyebrow: "Is this you?",
    yes: "That's me",
    no: "Not me",
    note: "Nomila found this public profile. Nothing is linked until you say so.",
    taken: "This profile already has an owner. Picking it sends it to our team.",
    of: (i: number, n: number) => `${i} of ${n}`,
    error: "We couldn't record that. Please try again.",
  },
  intro: {
    name: "Mila",
    role: "Your agent",
    lede: "I help you build your brand, and the business around it.",
    ask: "What are you most interested in?",
    askSub: "Pick any. We'll start there.",
    soon: "Soon",
    // Shown with the "Soon" tiles last (so Money sits before Picks). Display order only: the saved picks keep
    // ONBOARDING_INTERESTS's order (lib/onboardingFront.ts interestActions).
    interests: ONBOARDING_INTERESTS.map((i) => ({ ...i, ...INTEREST_LOOK[i.key] })).sort((a, b) => Number(a.soon) - Number(b.soon)),
    /** Under a picked "Soon" tile, above the button: nothing is promised as live. */
    soonLine: (labels: string[]) => `${joinWords(labels)} ${labels.length > 1 ? "open" : "opens"} soon. We'll tell you when it's ready.`,
    more: "How it works",
    howTitle: "How it works",
    howLead: "Mila, your agent, works 24/7 — while you train, compete and sleep.",
    how: [
      { icon: "link", line: "Connect your email and socials so Mila can learn more about you.", strong: false },
      { icon: "edit-3", line: "Mila prepares everything: replies, posts and pitches.", strong: false },
      { icon: "eye", line: "See or change anything Mila holds about you.", strong: false },
      { icon: "check-circle", line: "Nothing goes out until you tap.", strong: true },
    ] as Array<{ icon: IconName; line: string; strong: boolean }>,
    go: "Let's start",
    goPicked: (n: number) => `Let's start · ${n} picked`,
    close: "Close",
    error: "That didn't save. Try again.",
  },
  has: {
    line: "Here's what I already have about you.",
    looking: "I'm looking you up now, the way a good agent would. More arrives here as I find it.",
    right: "That's right",
    fix: "Fix",
    save: "Save",
    cancel: "Cancel",
    confirmed: "Confirmed",
    fixed: "Fixed",
    youSaid: "You told us",
    go: "Continue",
    editLabel: "Correct this",
    close: "Close",
    error: "That didn't save. Try again.",
    counter: (i: number, n: number) => `${i} / ${n}`,
  },
} as const;

/** The chip on a fact card: what kind of thing it is, in plain words (the fact's research topic, or its type). */
export function factKind(f: { type: string; topic: string | null }): string {
  if (f.type === "said") return "You told us";
  if (f.type === "measured") return "Your numbers";
  const t = f.topic ?? "";
  if (t === "identity" || t === "team" || t === "education" || t === "status") return "About you";
  if (t === "career" || t === "competition" || t === "achievement" || t === "stats") return "Results";
  if (t === "sponsor" || t === "business" || t === "commerce") return "Partners";
  if (t === "media" || t === "story" || t === "reputation" || t === "conversation") return "Press";
  if (t === "social" || t === "audience_growth" || t === "engagement" || t === "demographics") return "Audience";
  if (t === "cause") return "Causes";
  if (t === "upcoming") return "Coming up";
  return "Found";
}
