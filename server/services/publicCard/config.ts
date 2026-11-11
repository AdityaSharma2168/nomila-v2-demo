/**
 * publicCard/config.ts — the public Nomi Card's flag and fixed numbers (design-public-card-v3 §10–§11, §16 Q1).
 *
 * PUBLIC_CARD gates everything: the service writes, the reader and (PR 2) her /me/public-card routes. It is read at call
 * time (not at import) so a test can flip it. Exactly "true" is on; anything else is off. Off in dev and prod
 * (gcp/cloud-run-*.yaml, pinned by publicCard.flag.test.ts).
 *
 * Nothing here names an athlete, sport, school, league or brand.
 */

/** One definition of the flag, shared with the page renderer (flag.ts). */
export { publicCardEnabled } from "./flag";

export const PUBLIC_CARD = {
  /** Q1: a handle can change once a month after she first picks it. */
  handleChangeDays: 30,
  /** Q1: an old handle redirects to her current one (and is closed to everyone else) for 90 days. */
  handleRedirectDays: 90,
  handleMin: 3,
  handleMax: 30,
} as const;

/**
 * Q1: words a handle may never be, because the app (or a planned public route) uses them at the root of the domain, or
 * because they would read as Nomila speaking. Lower-case; compared after normalisation.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // routes that exist or are planned at the root (§11, §16 Q1). The 1–2 letter ones are already below the minimum
  // length; they are listed so the rule survives a shorter minimum.
  "c", "p", "r", "go", "pay", "confirm", "deposit", "connect", "shopify", "requests", "hooks", "api", "health",
  "card", "cards", "deck", "decks", "share", "me", "app", "static", "assets", "public", "media", "m", "e",
  // legal and account pages
  "legal", "privacy", "terms", "tos", "cookies", "security", "login", "logout", "signin", "signup", "sign-in",
  "sign-up", "register", "auth", "oauth", "account", "accounts", "settings", "admin", "dashboard", "invite", "verify",
  "password", "reset",
  // the product's own words (doors, chapters, Mila)
  "nomila", "mila", "nomi", "nomi-card", "ask", "ask-mila", "partner", "partners", "book", "booking", "bookings",
  "shop", "picks", "create", "studio", "story", "highlights", "brand", "brands", "athlete", "athletes", "press",
  // generic site words
  "www", "mail", "email", "help", "support", "about", "contact", "blog", "news", "jobs", "careers", "team", "home",
  "explore", "search", "status", "pricing", "download", "docs", "webhook", "webhooks", "null", "undefined", "test",
]);
