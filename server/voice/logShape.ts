/**
 * logShape.ts — what a voice route ANSWERED WITH, without saying what it said.
 *
 * Pure: no db, no model, no clock.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Two of the busiest voice routes (./scoreRoute, ./dealRoutes) logged NOTHING,
 * so a live session produced one "Voice token issued" line and then silence —
 * indistinguishable from a session where no tool fired at all. That ambiguity
 * cost a real debugging cycle: a missing route was read as a missing tool call,
 * because neither leaves a trace.
 *
 * So every voice route now logs which tool it served and which fields it
 * actually filled. That answers the two questions you have mid-call — did it
 * fire, and did it come back with anything — without ever answering the third.
 *
 * ── VALUES NEVER CROSS. That is the whole design ─────────────────────────────
 * A log line is a durable artifact that gets shipped, indexed and read by people
 * who are not looking at this athlete. What flows through these routes is a
 * mixture of the athlete's own words, brand-derived text and money. None of it
 * belongs in a log, and "just this once, for debugging" is how it gets there.
 *
 * `presentFields` therefore returns KEYS ONLY. The keys are ours — they are
 * declared in the wire interfaces in this directory, not read from any row — so
 * emitting them discloses our schema and nothing about anyone.
 *
 * The one deliberate exception is `deliverableKeys`, which logs the KEYS of
 * `offer.deliverables` ("reels", "stories"). Those look like data and are not:
 * they are members of the five-name allow-list in ../mila/deliverables, so a key
 * that appears there was chosen by us. The COUNTS beside them are values and are
 * never logged.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The keys of `v` that actually carry something, sorted for stable diffing.
 *
 * "Carries something" is deliberately stricter than `!== undefined`: a null
 * amount, an empty sportCategories array and an empty string all mean WE HAVE
 * NOTHING HERE, and a log that lists them as present answers the question
 * backwards. `false` counts as present — it is a real answer, not an absence.
 */
export function presentFields(v: unknown): string[] {
  if (!isRecord(v)) return [];
  return Object.entries(v)
    .filter(([, val]) => {
      if (val === null || val === undefined) return false;
      if (typeof val === "string") return val.length > 0;
      if (Array.isArray(val)) return val.length > 0;
      if (isRecord(val)) return Object.keys(val).length > 0;
      return true;
    })
    .map(([k]) => k)
    .sort();
}

/**
 * One deal's shape, flattened enough to read at a glance mid-call.
 *
 * `money` is pulled out because `moneyState` is the single field most worth
 * seeing live: it is the difference between "she spoke a figure" and "she
 * hedged", and it is an enum we own, so it is safe to log in full.
 */
export function dealShape(deal: unknown): Record<string, unknown> {
  if (!isRecord(deal)) return { deal: null };
  const offer = isRecord(deal.offer) ? deal.offer : null;
  const deliverables =
    offer && isRecord(offer.deliverables) ? offer.deliverables : null;

  return {
    fields: presentFields(deal),
    offer: presentFields(offer),
    // An enum we define. Not a value read off a row.
    money: typeof offer?.moneyState === "string" ? offer.moneyState : null,
    // Allow-listed names, never the counts. See the header.
    deliverableKeys: deliverables ? Object.keys(deliverables).sort() : [],
  };
}
