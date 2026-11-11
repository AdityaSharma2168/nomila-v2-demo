# The tagger is told who she is — `athlete_present` from a named subject

**Status: APPLIED in this PR (Mia-approved 22 Sep 2026, "as simple as possible").** Shared code:
`server/lib/visionTag.ts`, `server/lib/tagProfile.ts` (new), `server/services/mediaEnrichment.ts`,
`server/routes/media.ts`; and the Studio lane's `server/studio/enrich/videoTag.ts`,
`videoEnrichment.ts`. Written first as a proposal; kept as the record of what changed and why.

## The conviction (docs/probes/enrich-eval.md, grid-1, blind, both models)

Two uploads of a named male professional and a CGI clip holding his still answer
`athlete_present: true` at prominence 0.9. **Flash names him in its own description —
"Professional soccer player Sadio Mané mid-air …" — and still answers present.** The model knows
who it is looking at; the question never said who to look for. "Is the athlete clearly the subject"
with no athlete defined makes any athlete the athlete, and the mirror failure follows from the same
gap: four cells answer present on frames whose description names nobody (a ball on a logo, a ball
in a stadium, an abstract graphic, a pair of hands). Four real people/classes in the "possibly not
her" set: the two Mané uploads, a named female hurdler (e58f3a5a), and the CGI clip.

## The change — the minimum that changes the answer shape

**Two lines, both taggers** (`profileBlock`, from `full_name · sport` on the athlete row — no new
schema; `tagProfileFor` reads it once per athlete per process-minute. NOT the school column: it is
a projection fenced by the sourceGuard G5 allow-list, "never add without a design entry"; `team`
stays on the type, null, for a reader with a sanctioned source):

```
THE ATHLETE is <name>, a female athlete. Anyone else in the frame — a teammate,
an opponent, a famous player, a model, anyone — is ANOTHER PERSON, however prominent. Never write
her name in any field; say "the athlete".
```

**The question** — one phrase: `is the athlete clearly the subject` → `is THE ATHLETE clearly the
subject`.

**The answer** — the first key of the JSON shape:

```diff
-{"athlete_present":true|false,"athlete_prominence":0.0-1.0,...
+{"subject":"the_athlete|another_person|nobody","athlete_prominence":0.0-1.0,...
```

**The parse** (`applySubject`): `the_athlete` → `athlete_present: true`; `another_person` and
`nobody` → `false`; the ternary is stored beside it as `vision.subject`, so "another person" is
queryable later. An answer with no valid `subject` keeps the boolean it carries — older prompts,
or a model that ignored the key — so nothing downstream changes shape. Beats keep their own
`athlete_present` unchanged (video), the minimum.

Stated limits stand: no face matching, no lookalike handling, no config surface. A teammate who
looks like her is the model's call, as it was.

## What else in the prompt could shift — flagged

1. **Descriptions.** The model now knows her name. Without the "never write her name" sentence it
   would put it into `description` — text that is shown in prompts and on screen, and that would
   spread a real name across every row. The sentence is the one addition beyond the two lines and
   the key; it is there for that reason.
2. **`athlete_prominence` and `hero_suitability` on photos of other people.** Both are defined
   against "the athlete"; naming her means a hero shot of someone else is now a poor hero. Intended.
3. **`brands_visible`, `setting`, `attire`, `vibe`, safety flags.** No wording touched; no shift
   expected. The eval's repeat sample already shows these fields paraphrase between reads, so a
   string-level diff on a re-tag is not evidence of a shift.
4. **The eval's Pro-cell script** hashes the old `const PROMPT` block and will refuse to run until
   its copy is updated. Probe code, gitignored, expected.

## Acceptance, pre-registered (Adi runs; approval before any call)

`probe-out/enrich-fixes/retag-exhibits.ts` — in-process `tagAsset` / `tagVideo` with her profile,
**no row written**. Exhibits (9): `f608e704`, `65d290cf` (named male professional), `e58f3a5a`
(named woman), `943bfc9e` (CGI clip with his still), `267ededf` (hands, clip), `e64e900a`,
`7666e86d`, `cf5ba50e` (empty frames tagged present), `2da2c459` (hands, photo). Controls (4, she is
in them): `19cf70ad`, `382dc924` (photos), `2a7d49f0` (9 s clip), `f2338ddc` (4 s clip).

| cell                                     | kind               | est.                                                |
| ---------------------------------------- | ------------------ | --------------------------------------------------- |
| 6 photos (exhibits) + 2 (controls)       | Flash, inline JPEG | ≈ $0.001 each → $0.008                              |
| 943bfc9e 6 s, 267ededf 4 s, 7666e86d 4 s | Flash clip read    | ≈ $0.003 each → $0.009                              |
| 2a7d49f0 9 s, f2338ddc 4 s (controls)    | Flash clip read    | ≈ $0.006                                            |
| **total**                                | 13 cells           | **≈ $0.03, cap $0.10** (the script refuses past it) |

**Predictions:** 9/9 exhibits answer a non-`the_athlete` subject — the four named/male as
`another_person`, the five empty/hands as `nobody`; 4/4 controls answer `the_athlete`. Any
exhibit answering `the_athlete` is a miss to record, not to tune away.

## Carded follow-up, not this PR — the backfill

Every already-tagged row keeps its old answer until re-tagged. The in-lane subject guard
(`server/studio/agent/subject.ts`) stands as defense for those rows and is deleted when they are
gone. A backfill re-tags every stored top-level row with `vision` and no `vision.subject`:

|                                     | rows (test athlete, 22 Sep) | est.                 |
| ----------------------------------- | --------------------------- | -------------------- |
| photos                              | ≈ 382                       | ≈ $0.40              |
| clips (73 × ~4 s, 3 uploads ≤ 60 s) | 76                          | ≈ $0.35              |
| **test athlete**                    | 458                         | **≈ $0.75**          |
| all athletes                        | unknown — count first       | quote before running |

Mechanism: the photo lane's `reEmbed`-style escape hatch generalised to "re-tag where
`vision.subject` is absent"; the clip lane needs a predicate arm beside `beats IS NULL`. Both write
`vision` through `jsonb_set` as today. Separate PR, its own predictions, its own cap.
