# Generate defects — the two the identity probe found, and what fixing them measured

Run 2026-09-15. Everything here is from live `gemini-3-pro-image` calls through `studio/router`, on
athlete `3811cedd`'s own library. Total spend on this document: **$2.72** (16 identity-probe images
$2.1504, 4 fix-probe images $0.5376, ~$0.04 of flash calls for the text check).

## D-1 · "a post-format social visual" drew the interface

`buildPrompt`'s generate arm opened with `Generate a single photorealistic image - a
${job.deliverable}-format social visual for an athlete`. The model read "social visual" literally.

**Before — the no-reference arm, 4 of 4:**

| cell             | what came back                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| base0.portrait.1 | a framed Instagram post card: avatar, `maya_soccer23`, heart/comment/share icons, "Another day at the office. #collegeathlete #soccerlife #goldenhour"                                                                                               |
| base0.portrait.2 | a second post card, blurred "Instagram" header bar above it, `mia_soccer_`, "Golden hour sessions. #collegesoccer #training"                                                                                                                         |
| base0.action.1   | the photograph with a feed overlay: avatar, `@Soccercaptain14`, "OCT 26 · 8:45 PM", a Follow button                                                                                                                                                  |
| base0.action.2   | **a whole iPhone**, bezel and all, with an Instagram post on its screen: `@Maya_Soccer`, "1,234 likes", "Can't stop, won't stop. ⚽ #collegeathlete #soccerlife #bicyclekick", "View all 87 comments", and an invented "UNIVERSITY OF OREGON" jersey |

The four reference-conditioned arms (base1, bound3) never did it — a likeness anchors the model to
"photograph". So the defect was worst exactly where she has attached nothing, which is the common
case for a first generate.

**After — the same four cells on this branch's prompt, 4 of 4 clean:**

| cell              | text check             | what came back                                                                        |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| fixed0.portrait.1 | pass                   | a photograph. Carries a film-print black border — a stylistic frame, not an interface |
| fixed0.portrait.2 | pass                   | a photograph, no border                                                               |
| fixed0.action.1   | unknown (see below)    | a photograph, blank kit, no lettering                                                 |
| fixed0.action.2   | pass, reads "10", "13" | a photograph; squad numbers on kit, correctly not names                               |

**Zero handles, zero captions, zero UI chrome, zero invented wordmarks.** The deliverable word was
dropped rather than reworded: `aspectFor` already pins the canvas (4:5 post, 9:16 story, 1:1 ad),
which is where format belongs.

## D-2 · an unrequested real surname on the kit

| cell              | arm                                 | what it printed                    |
| ----------------- | ----------------------------------- | ---------------------------------- |
| base1.action.1    | production, 1 reference             | **"McLAUGHLIN"** across the jersey |
| noangle1.action.2 | 1 reference, angle sentence deleted | **"McLAUGHLIN"** again, plus "14"  |

Same surname twice, from the same single reference photograph, and it is in no prompt: the probe's
athlete half is synthetic and an athlete's real name never reaches a prompt at all. Zero of the two
three-reference cells did it. Whether the model is associating that reference with a public figure
or reaching for a stock "athlete name" is not answerable from two samples — either way an NIL
product rendering one athlete in another athlete's name is a rights problem.

Two layers ship: the `TEXT AND NAMES` line in the generate prompt (the request), and `qa/text.ts`
(the check on the pixels).

## The text check, measured before it was made GATING

All 16 identity-probe images, each scored against the direction it was generated from. $0.0311.

|                                               | check said FAIL | check said PASS |
| --------------------------------------------- | --------------- | --------------- |
| **carries an unrequested name or handle** (6) | **6**           | 0               |
| **clean** (10)                                | 0               | **10**          |

Recall 6/6, specificity 10/10, 0 unknown. Against `marks`' 27% specificity on its own corpus, the
difference is what each check has to get right to fire: marks must decide whether a ~20px logo
_changed_ between two frames; this fires only on a string the model says it read clearly, says is a
person's name, and that shares no word with her request.

The true negatives include images with legible lettering that must NOT fail — `adidas`,
`Continental`, `Flow` on a sleeve (bound3.action.1) and `7`, `FOOTBALL` on a kit (base1.action.2).
Brand and venue wordmarks are `marks`' question, not this one.

⚠️ **n=16 on one athlete and two sentences.** Re-measure when the corpus grows; if precision drops,
demote it to `advisoryChecks` beside marks rather than tuning it until it memorises this set.

## Two intermittent failure modes, both recorded rather than papered over

1. **Answer shape.** One fix-probe cell came back as a bare array instead of `{"texts": […]}` and
   scored `unknown`. That instability is already documented for detection answers
   (`vision.ts detectionList`), so the parse uses that helper and takes both shapes. Pinned in
   `text.test.ts`.
2. **Timeout.** `fixed0.action.1` timed out twice at the 45s `STUDIO_QA_VISION_TIMEOUT_MS` on a
   crowded night-stadium frame, and recorded `unknown` — the designed behaviour, and the reason
   `unknown` is never folded into a pass. Not raised here: the timeout is shared by every QA check
   and moving it for one is how a stage's latency budget drifts.

## What this does NOT fix

- **Identity on generates is still unmeasured in product.** `runGenerateQa` records identity as
  `unknown`, because comparing an output against the athlete's own `person` references is R0.b.
- **The native-edit prompt has no TEXT AND NAMES line.** A full-frame edit re-renders the kit and can
  write on it exactly as a generate can; the check covers it, the request does not. The compile tier
  is where that sentence belongs, and that is R2's file.
