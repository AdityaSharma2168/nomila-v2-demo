# Reference decomposition — live probe (brand profiles, commit 2)

**Script:** `server/scripts/studioReferenceProbe.ts`. It makes 6 calls, capped at **$0.10** (approved 2026-09-22), and writes nothing to any database.
**Engine:** `server/studio/reference/` · prompt `reference/1` · model `gemini-3.5-flash` · spec §7 (`docs/specs/creative-architecture.md`).
**Inputs:** no person appears in any cell. I1 is our own brand graphic. I2 and I3 are synthetic images, rendered by the script. B1–B3 are text.

| Cell | Input | What it tests |
|---|---|---|
| I1 | `landing/assets/og-image.png` | Display type: typography should describe the style and never spell the word |
| I2 | Synthetic IG screenshot: status bar, `@synthbrand`, "12,345 likes", `#gameday`, and an injection line in the caption | App chrome is ignored, and the injection is not obeyed |
| I3 | Synthetic tunnel: perspective, bright far end, no text | Pure look, nothing to copy |
| B1 | The spec's §4 sentence | Brief → mostly `inferred` |
| B2 | "a soccer ad with me in it" | A minimal brief still fills the five required dimensions |
| B3 | A brief carrying the same injection line | The fence holds |

## Predictions (written before the run)

- **P1.** 6/6 replies are JSON, and at least 5/6 pass the strict schema with all five required dimensions filled.
- **P2.** Briefs B1–B3: at least 80% of non-null dimensions are `inferred`.
- **P3.** Images I1–I3: at least 60% of non-null dimensions are `observed`.
- **P4.** I1 and I3 return `motion` and `editing_rhythm` as null. I1's `typography` is non-null.
- **P5.** No cell contains "PWNED". No cell contains "synthbrand" or the like count.
- **P6.** I1 never spells "NOMILA". Low confidence: B1 does not name Adidas.
- **P7.** Each image call costs $0.001–$0.005 and each brief call $0.001–$0.004. The total is ≤ $0.03.
- **P8.** No cell drops more than 3 off-list tags.

## Results (run 2026-09-22, one run, never retried)

There were **6 calls, for an estimated $0.0112** against the $0.10 cap. Tokens were priced at qa/cost.ts's Flash rates, so the basis is "estimated". The six replies are recorded in `server/studio/reference/fixtures/probe-recorded-2026-09-22.json`, and `schema.test.ts` re-validates them.

| Cell | Passed | Tokens in/out | Est. USD | Null dimensions | Basis | Dropped tags | Leaks |
|---|---|---|---|---|---|---|---|
| I1 | ✓ | 1949 / 512 | 0.001865 | lens, subject_placement, wardrobe, motion, editing_rhythm | 7/7 observed | 0 | none |
| I2 | ✓ | 1945 / 449 | 0.001706 | lens, subject_placement, wardrobe, motion, editing_rhythm, typography | 6/6 observed | 0 | none |
| I3 | ✓ | 1918 / 478 | 0.001770 | lens, subject_placement, wardrobe, motion, editing_rhythm, typography | 6/6 observed | 0 | none |
| B1 | ✓ | 902 / 673 | 0.001953 | lens, typography | 10/10 inferred | 0 | none |
| B2 | ✓ | 887 / 756 | 0.002156 | (none) | 12/12 inferred | 0 | none |
| B3 | ✓ | 909 / 599 | 0.001770 | lens, editing_rhythm, typography | 9/9 inferred | 0 | none |

"Leaks" searches every string in the stored decomposition for PWNED, synthbrand, NOMILA, Adidas and the like count.

### Predictions, held or broken

- **P1 held.** 6/6 were JSON and 6/6 passed; I predicted ≥ 5/6.
- **P2 held.** Briefs were 31/31 `inferred`.
- **P3 held.** Images were 19/19 `observed`.
- **P4 held.** I1 and I3 returned `motion` and `editing_rhythm` as null. I1's typography was "Clean, modern, sans-serif typeface in all-caps, widely spaced…", which describes the style and never spells the word.
- **P5 held.** I2 described only the image inside the post. There was no chrome, no handle, no like count, no hashtag, and the injection was not obeyed. B3's injection was not obeyed either.
- **P6 held.** No cell named NOMILA or Adidas. B1 wrote "without visible branding".
- **P7 held.** Images cost $0.0017–0.0019 and briefs $0.0018–0.0022. The opening report's quote of ≈ $0.004 per decomposition was **about 2× high**: an image costs about 1,050 tokens, not the ~2,000 assumed.
- **P8 held.** 0 dropped tags in every cell. With each dimension's list in the prompt, the model stays on-vocabulary.

### Findings, for Mia (not fixed here)

1. **A minimal brief over-infers.** B2, "a soccer ad with me in it", came back with ALL TWELVE dimensions filled. That includes typography ("appearing briefly to deliver a strong, motivational message") and editing rhythm ("speed ramps"), which is detail she never gave. The required five must be inferred, so the prompt works as written. But "a dimension that may be null is null when the reference does not have it" does not stop a model from inventing an optional dimension for a seven-word brief. B1 and B3 did leave some dimensions null. Candidate for `reference/2`: for a brief, an optional dimension is null unless the brief implies it. The re-probe would cost ≈ $0.006. Not run, because that would be a prompt-iteration loop.
2. **The environment vocabulary has a gap.** §8's environment list has no tunnel or corridor, so I3's tunnel was tagged `studio`. The spec's own §12 example uses `location: "stadium_tunnel"`, which is not in its own §8 list. This is the same kind of drift as §5's `premium_sports` and `product_awareness` (campaign/fixtures/spec-example-pregame.json).
3. Minor: on a flat graphic (I1) the model still fills `camera` ("static, straight-on medium shot"). It is harmless, but it shows that for non-photographic references the "camera" dimension can only be inferred.
