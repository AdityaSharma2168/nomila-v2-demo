# Card for Mia — `athletes.sport` now has teeth, and it is free text from a signup form

**Status: written, NOT applied.** Raised from a live run (Adi, 22 Sep 2026): the test athlete's
row said `basketball`, her library is soccer by 403 rows to 32, the planner's brief-sport fallback
read the row, the sport demotion inverted, and the plan recapped a fictional basketball session —
$2.40, all i2v. The Studio lane has since changed its fallback (library majority before profile,
`studio/agent/library.ts` `briefSport`) and logs the resolved sport with its SOURCE and the share of
her footage that disagrees, warning above one half. That contains the damage inside the lane; the
column is still wrong, and other readers use it.

## Where the column comes from

- **Signup** — `server/routes/auth.ts` (`resolveIdentity` … `values: { …, sport: sportTrimmed }`):
  whatever she typed in the sport field, trimmed. No vocabulary, no normalisation ("Women's Soccer",
  "soccer", "Soccer (D1)" are three values).
- **Waitlist join** — `server/routes/waitlist.ts` (`coalesce(${sport}, ${athletes.sport})`): a
  later join keeps an earlier value; a typo at signup survives a correct waitlist entry.
- **Read-time override** — `server/routes/auth.ts` ~L294: with the `identity` context reader on,
  `/me` serves the research-derived sport instead of the row. So the row can be wrong while the app
  shows the right sport, which is exactly how a wrong row goes unnoticed.

Readers of the raw column (not exhaustive): `studio/brief.ts` (the generate REGISTER — every
untyped generate's setting is fitted to it; sportVocab.ts records the basketball-court soccer ad
this produced on 2026-09-09), `studio/agent/library.ts` (last-resort brief sport), the voice lane's
brand profile, pitches, deal drafts, the marketability snapshot.

## Proposed, smallest first

1. **Normalise on write** — pass the signup and waitlist values through the same
   `namesSport`-style allow-list the Studio lane uses (`studio/sportVocab.ts` mirrors the voice
   lane's `SPOKEN_SPORTS`; one of the two becomes the shared list), storing the canonical word and
   keeping the raw text in the identity blob. Blast radius: two write sites; every reader gets a
   cleaner value and no reader changes.
2. **Reconcile against evidence** — a nightly check (or the enrichment cron's tail) that compares
   the row's sport with the majority sport of the athlete's tagged library and flags a disagreement
   above one half to admin — the same number the Studio log now warns on, promoted from a log line
   to a queue. No automatic overwrite: the row is hers to correct.
3. **Serve the research sport back into the row** when the `identity` reader has one and the row
   is null or disagrees — the override exists at read time already; writing it once makes the
   other readers see it too. Needs the design entry the sourceGuard test asks for.

Not proposed: making the Studio lane's majority rule the source of truth for the column. A library
of generated soccer content for a basketball player would then rewrite her sport.
