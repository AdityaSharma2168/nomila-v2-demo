/**
 * agent/reads/prompts.ts — every word the model reads about Mila's read tools: each tool's description and its
 * argument notes. Registered verbatim in the Prompt Register ("Mila read tools", PR body) and in the generated
 * catalogue (docs/catalogue/catalogue.json).
 */

export const MEDIA_SEARCH_DESCRIPTION =
  "Search the athlete's own photo and video library (their posts, uploads and Studio output) by what is in the picture, and return the best matches with what Nomila already saw in each: a description, the shot type, the brands visible, whether it is brand safe, whether they are in it, the quality, the curator's keep-or-edit note, and for a clip its shot count and what is said. " +
  "Use when: they ask which photo or clip to use for a brand, a post or a pitch; they want to find something they already have (\"the one from the final\", \"my clip at the beach\"). " +
  "Don't use: to add new photos from their phone (check_camera_roll); for how posts performed (posts_performance). " +
  "They cannot see the results from this call: describe a pick by what is in it and when it was posted, never by its id. Never say a photo was posted, sent or changed.";

export const MEDIA_SEARCH_ARGS = {
  query: "What to look for, in plain words: the moment, the setting, the look or the use (\"celebrating with the team\", \"clean portrait for a skincare brand\").",
  type: "photo, video or any (default any).",
  posted_after: "Only things posted or uploaded on or after this day (YYYY-MM-DD).",
  posted_before: "Only things posted or uploaded on or before this day (YYYY-MM-DD).",
  brand: "Only shots where this brand is visible.",
  brand_safe_only: "true: leave out anything not marked brand safe. Use it when the pick is for a brand.",
  has_people: "true: someone is in the shot; false: nobody is (a product or place shot).",
  limit: "How many to return (1–8, default 5).",
  detail: "concise (default) or detailed (adds the setting, the vibe, the curator's reason and a clip's first shots).",
} as const;

export const POSTS_PERFORMANCE_DESCRIPTION =
  "How the athlete's own posts and accounts are doing, from their connected accounts: recent posts with their likes, comments, reach, saves, shares and views, each against their usual on that platform; each account's followers and engagement now against the start of the window; and what works for them (the patterns their posts show, each marked as leading or an early sign). " +
  "Use when: they ask how a post or their recent posts did, whether they are growing, or what is working. " +
  "Don't use: for another athlete's numbers (never available); for what to post next (answer from this, CONTEXT and the plan). " +
  "Numbers are only what the accounts reported: never round them up or estimate a missing one. With no connected account there is nothing to read: say so and offer the connection.";

export const POSTS_PERFORMANCE_ARGS = {
  view: "overview (default: the accounts, the latest posts and the top patterns), recent_posts, accounts or what_works.",
  days: "The window in days (7–90, default 30).",
  limit: "How many posts (1–10, default 5).",
  detail: "concise (default) or detailed (adds each post's caption start and the account's top audience).",
} as const;

export const MONEY_SUMMARY_DESCRIPTION =
  "The athlete's money in Nomila, read only: what they earned (paid out to them, and paid by a brand directly) this month and this year, what is coming (held on the platform until delivery or confirmation), deposits brands put down, refunds, and whether their payout account is set up. Each line has the brand or booking it came from. " +
  "Use when: they ask how much they have earned, what they are owed, when they get paid, or whether a payment came in. " +
  "Don't use: to pay, invoice, refund or move money (nothing moves from chat); for what a deal is worth before it is signed (deals_get). " +
  "Amounts are exactly as recorded; never add money that is not on record.";

export const MONEY_SUMMARY_ARGS = {
  period: "this_month or this_year (default): which paid lines are listed. The totals for both are always given.",
  limit: "How many lines per list (1–10, default 3).",
  detail: "concise (default) or detailed (adds the holds and refunds lists).",
} as const;

export const WHATS_NEXT_DESCRIPTION =
  "One dated list of what is coming up for the athlete: brand deliverables due, calls and meetings on their deals, booked sessions, this week's plan actions with their due dates, dated events, and what is waiting on them (a deal or booking to answer, a payout account to set up), soonest first, plus anything overdue. " +
  "Use when: they ask what is due, what is on this week, what they have coming up, or what to do first. " +
  "Don't use: for one deal's detail (deals_get) or one booking's (bookings_get); to change a date or a plan (the goal tools). " +
  "Only dates on record: never invent a deadline.";

export const WHATS_NEXT_ARGS = {
  days: "How far ahead, in days (1–60, default 7).",
  limit: "How many items (1–15, default 8).",
  detail: "concise (default) or detailed (adds what each deal waits on and why, and each deliverable's format and progress).",
} as const;
