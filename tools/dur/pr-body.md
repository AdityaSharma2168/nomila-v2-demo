`media_assets.duration_seconds` is an `integer`, and it was only ever populated when the OS upload
picker sent one. So most video rows had **no duration at all** — anything that did not arrive
through the picker (Studio output, a stitch, an Instagram top-performer mp4) was `NULL`, and
`video/materialize.ts` fell back to charging those clips at `bytes ÷ output-bitrate`, which
under-counts by whatever the source bitrate happens to be: a 200 MB upload at 3 Mbps is 555 s of
video counted as 100. And the fraction that *did* arrive was thrown away, because the client sends
`asset.duration / 1000` and the column could hold nothing else.

This adds the column that can hold it, and three probes that fill it.

## Why a second column rather than widening `duration_seconds`

The obvious fix is `ALTER COLUMN duration_seconds TYPE double precision`. It was rejected, and not
on taste:

1. **The drift gate is name-only.** `checkSchemaDrift.ts` reads `information_schema.columns` and
   compares table and column NAMES — it never looks at a type. An `ALTER` that failed to apply
   anywhere would pass the deploy gate clean, and the new code would then write fractions into an
   `int4` column where Postgres rounds them. Wrong data, no signal, gate green. A missing **additive**
   column has the opposite failure mode, and it is precisely the one that gate exists to catch.
2. **`int4 → float8` is a full table rewrite** under `ACCESS EXCLUSIVE`, on the hottest table in the
   app, inside a deploy. Adding a nullable column with no default is catalog-only in PG 11+.
3. **It is unguardable** — there is no `ALTER COLUMN … TYPE IF …`, so an in-place widen needs a DO
   block to be re-runnable. `ADD COLUMN IF NOT EXISTS` is idempotent by its own existence test.
4. **Rollback.** Additive rollback is a no-op; rolling back a widen is a second rewrite that destroys
   the fractions on the way.

`double precision`, not `numeric`: drizzle maps `numeric` to a **JS string** (that is `deals.amount`)
and every reader here does arithmetic on the value.

## One provenance per column

| Column | Means | Written by |
|---|---|---|
| `duration_seconds` (int) | what the picker **asserted**, rounded | unchanged by this PR |
| `duration_seconds_precise` (float8) | what ffprobe **measured** | upload probe · stitch write-back · poster-cron rider |

Neither is backfilled from the other — a rounded integer is not evidence about a fraction.
"Measured beats asserted" is honoured on the **read** side: `resolveClips` returns
`duration_seconds_precise ?? duration_seconds`, and `GET /media` serves both keys so the client can
tell them apart.

## Where the measurement comes from

No backfill script: the probeable backlog was **8 rows / 15 MB**, which the riders drain on their own.

- **Upload** — ffprobe range-reads the container header over the signed URL; it does not download the
  clip. **Fails open**, deliberately the opposite of the image branch beside it: a photo that cannot
  be straightened is *refused* because storing it is the bug that code prevents, whereas a clip whose
  length cannot be read is a perfectly good clip missing a number.
- **Stitch** — free. `publishStitchOutput` was already handed the exact figure and rounded it away.
- **Poster cron** — nearly free, on a URL it already signs. Runs *first and isolated* so a probe
  failure never costs the poster, and **omits** the key on failure so a cron pass can never erase a
  value the upload probe got right.

## `NULL` is a real answer

It means **not measured**, never zero, and `GET /media` serves `null` rather than substituting the
integer — that is what lets a client distinguish "measured 5.0" from "asserted 5, never measured".

**~208 Instagram video rows stay NULL permanently**: `rehostAthleteMedia.pixelFor` stores the poster
thumbnail for IG `VIDEO`/`REELS`, so `gcs_path` holds a JPEG and there are no video bytes on our side
to probe. Because NULL survives, **both memory guards stay exactly as load-bearing as before** —
`effectiveSeconds`'s estimate at the door and `assertProbedTimelineFits`'s ffprobe pass in the runner.
0058 makes the guess *rarer*, not impossible.

## Migration safety

Additive, one self-guarded statement, the shape `0044_social_substrate` already used on this table.
No DO block (there is no DROP+ADD pair for 0056's race to exploit), no transaction control, no data
movement. The `.sql`, the `db-migrate.sh` step-3 line and the `schema.ts` declaration ship in **one
commit** — half of them merged alone is what the hard drift gate reds, and the push helper checks all
three are present before it will push.

`server/studio/mediaDuration.migration.test.ts` is the revert check. Beyond fresh-DB / existing-DB /
rollback, two pins worth keeping:

- the column's **`attnum` must not move** — a re-run that dropped and re-added it would destroy the
  values in it;
- **`pg_class.relfilenode` must not move** — mechanical proof the table is never rewritten. It reds
  even on a rewrite that leaves every catalog column identical, which is what makes it a real guard
  against someone later "simplifying" this into an in-place widen.

## Found in review, on this branch

`probeDurationSeconds` is the one probe handed a URL rather than a local path, and a signed GCS URL
carries its credential in the query string. The first version redacted the input and then
concatenated `err.stderr` — which reads as correct and is not, because **ffprobe echoes its input
back in stderr**, and both callers log that message. Redaction now runs over the whole assembled
message and *before* truncation (slicing first would leave the front half of a signature behind).
Never reached production.

## Known-benign residue

`studio/jobs.ts` `recordGeneratedAsset` still hands a raw float to the integer column, and Postgres's
`float8 → int4` cast rounds **half to even** while `Math.round` in `publishStitchOutput` rounds **half
up** — so at an exact `.5` tie the two writers disagree (12.5 → 12 one way, 13 the other). Left alone:
moot for every precision reader, invisible in `fmtDur`, and out of this card. Written down in
`docs/probes/video-v8-duration-precision.md` so nobody reads it as a bug.

## Testing

Full suite green. Four new suites, and every behavioural claim above has a revert check that was
shown red by name against a mutation of the code it guards — including the two orderings in the
poster rider (a probe failure cannot cost the poster; a failed probe cannot erase a good value) and
the `resolveClips` preference (reverting it charges 8 for a clip that is really 8.033, which errs in
the direction that lets an over-long timeline look legal).

`affiliationSync`'s "year-only from/to" went red in one full run here. **It reproduces on clean
`main` at `2ab0cf5` — 2 of 5 isolated runs, same test, same assertion (`ended_on` null instead of
`"2026-09-11"`), with none of this diff present.** That is the evidence it is not this PR; it is also
an assertion failure rather than a hook timeout (so not contention) and the as-of date is an injected
constant, `const AT = new Date("2026-09-11T00:00:00Z")` (so not the clock).

This branch then ran it green 5 times isolated, and that is **not** evidence the branch fixes
anything — at the observed rate five greens in a row is ~8% likely, and a column on `media_assets`
has no mechanism by which it could touch affiliations. Recorded as *still flaky, happened not to
fire*, so nobody later reads a 5/5 as a repair.

## Scope

Server-side only. No client rendering, no deploy config, no flag defaults. The one shared-schema
change is the single additive column, which Adi approved explicitly.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01YYJhA2hDo7jh3vgqEChwif
