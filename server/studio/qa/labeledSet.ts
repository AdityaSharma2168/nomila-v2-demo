/**
 * studio/qa/labeledSet — the calibration corpus for creative QA, and the ONE place its labels live.
 *
 * PR Q's acceptance is a confusion matrix over Adi-verdicted outputs. This is that set, transcribed
 * from `studio-sweep-results.md` (2026-09-09 15:52–16:13) and
 * `docs/probes/2026-09-09-model-native-probe.md` (same evening). Ids are 8-char prefixes exactly as
 * both documents record them; `studioQaFixtures.ts` resolves them to rows under ONE athlete.
 *
 * ─── ⚠️  A SWEEP VERDICT IS NOT A QA EXPECTATION. THIS IS THE TRAP. ─────────────────────────────
 *
 * The sweep's vocabulary is CLEAN / ARTIFACT / PARTIAL / FAILED and it grades THE WHOLE IMAGE as a
 * deliverable. Creative QA asks four narrow questions. The two do not map, in BOTH directions:
 *
 *   ARTIFACT is usually NOT a QA positive. 1.2, 1.3a, 1.4, 4.2 and 4.3 are all verdicted ARTIFACT,
 *     and in every one of them the defect Adi saw is the COMPOSITE RIM or its inversion halo — a
 *     geometric artifact of crop-and-paste that the full-frame path does not produce at all (probe
 *     Q5: "Path B shows no rim"). Scoring those as "identity/marks/anatomy should flag" would grade
 *     every check against a defect class it is not looking for, and the only way to pass would be to
 *     memorize five images.
 *
 *   CLEAN is sometimes a QA POSITIVE. 2.4b is Adi's cleanest design result — and the adidas mark
 *     REPLACED the Nike swoosh rather than joining it, which nobody asked for. The sweep says so
 *     itself. A mark integrity check that flags 2.4b is RIGHT; counting that as a false positive
 *     would train the check to ignore exactly the thing PR Q exists to catch.
 *
 * So each entry carries two independent things:
 *
 *   `verdict`  — Adi's, transcribed verbatim in his vocabulary. Never edit these to fit a result.
 *   `expect`   — per-check, DERIVED BY ME from his written note, and marked as such. This is a
 *                hypothesis about what each check should say, and it is the thing a validation run
 *                is allowed to argue with. If a check disagrees with an `expect` and the image
 *                supports the check, the ENTRY is what changes — with a note — not the threshold.
 *
 * `expect: "unknown"` is a first-class answer and is EXCLUDED from the confusion matrix rather than
 * scored as a pass. Nobody looked at 4.1's hands; pretending otherwise manufactures a true negative.
 *
 * ─── PROVENANCE, BECAUSE TWO PATHS ARE MIXED HERE ──────────────────────────────────────────────
 *
 * Sweep rows ran the MASKED composite; probe q1/q2/q3 and q5-*-B ran FULL-FRAME direct; q5-*-A ran
 * masked. That matters for calibration and is not cosmetic:
 *
 *   - A masked output's face is preserved BY CONSTRUCTION when the face is outside every region
 *     (probe Q5: patch excess 0.000, "not near zero"). Those are free, structurally-guaranteed
 *     TRUE NEGATIVES for identity — the strongest label in the set, because no human judgement is
 *     involved. 2.4a is the exception that proves it: the whole subject came back regenerated.
 *   - A full-frame output has NO such guarantee anywhere. Every full-frame negative is a human
 *     verdict, and is only as good as one look at one picture.
 *
 * ─── THIS SET IS SMALL AND IT IS ABOUT TO DOUBLE ───────────────────────────────────────────────
 *
 * Sweep #2 (roadmap PR N, tomorrow, ~$3–4, Adi-verdicted) reruns the sweep's prompts through the
 * native path and "doubles Q's labeled calibration set for free". So a threshold fitted hard to
 * TODAY's counts is fitted to the smaller half of the eventual corpus. Thresholds calibrated here
 * are provisional by construction; the recalibration against sweep #2 is expected, not a failure.
 */

/** Adi's own vocabulary, from the sweep's header. Transcribed, never inferred. */
export type SweepVerdict = "CLEAN" | "ARTIFACT" | "PARTIAL" | "FAILED";

/**
 * What a check SHOULD say about this image.
 *
 *   "pass"    — the check must not fire.
 *   "flag"    — the check must fire. This is a defect of that check's own class.
 *   "unknown" — nobody assessed it. Excluded from scoring; never counted as a pass.
 */
export type Expectation = "pass" | "flag" | "unknown";

export interface LabeledOutput {
  /** Sweep section or probe cell — how a human finds it in the source document. */
  cell: string;
  /** 8-char id prefix as printed in the documents. Resolved under the athlete, never trusted raw. */
  outputId?: string;
  /** A file already on disk, relative to the fixture root. Probe cells live here, not in the DB. */
  outputFile?: string;
  /** The frame this edit was performed on — the chain root for every comparison. */
  sourceId?: string;
  sourceFile?: string;
  /** The instruction, verbatim. Q.4 compares against exactly this. */
  prompt: string;
  /** Which path produced it. See PROVENANCE above — it decides how much a negative is worth. */
  path: "masked" | "full-frame";
  /** Adi's, verbatim in his vocabulary. Null where he did not verdict the cell. */
  verdict: SweepVerdict | null;
  /** MINE, derived from his written note. Arguable — see the header. */
  expect: {
    identity: Expectation;
    marks: Expectation;
    anatomy: Expectation;
    adherence: Expectation;
  };
  /** Why `expect` reads the way it does — quoting his note where one exists. */
  note: string;
}

/**
 * Section 1–5 of the sweep. ALL MASKED.
 *
 * Note how few of these are QA positives: thirteen edits, and the checks should fire on four of
 * them (1.5a anatomy, 2.2 adherence, 2.3 anatomy, 2.4a identity, 3.1 marks) plus the unasked mark
 * replacement in 2.4b. Everything else Adi disliked, he disliked for the rim.
 */
export const SWEEP_OUTPUTS: LabeledOutput[] = [
  {
    cell: "1.1",
    outputId: "bc2ac090",
    sourceId: "afc78262",
    prompt: "change the color of the jersey to purple",
    path: "masked",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: 'Adi: "worked". "Jersey purple, STANFORD text and number 8 intact, armband and shorts untouched. The only test in the sweep with no noted defect." Marks explicitly survived — the strongest mark-integrity negative in the sweep.',
  },
  {
    cell: "1.2",
    outputId: "ce8cb00a",
    sourceId: "a81be2c0",
    prompt: "make the sports bra white",
    path: "masked",
    verdict: "ARTIFACT",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "ARTIFACT, but the defect is the composite rim — geometric, not a QA class. Face outside the region, so identity is preserved by construction. Scored as an all-pass negative deliberately.",
  },
  {
    cell: "1.3a",
    outputId: "e6d47117",
    sourceId: "afc78262",
    prompt: "change the socks to yellow",
    path: "masked",
    verdict: "ARTIFACT",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: 'Adi: "still weird black line" — the rim, on the small source. Q4 later measured this arm as the masked path\'s weak one. Not a creative-QA defect.',
  },
  {
    cell: "1.3b",
    outputId: "a025b2f3",
    sourceId: "5581e882",
    prompt: "change the socks to yellow",
    path: "masked",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "Same prompt as 1.3a on the 4000px source. CLEAN.",
  },
  {
    cell: "1.4",
    outputId: "1119e624",
    sourceId: "afc78262",
    prompt: "make the cleats black",
    path: "masked",
    verdict: "ARTIFACT",
    expect: {
      identity: "pass",
      marks: "unknown",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "Rim again. Marks `unknown`: the cleats carry Nike swooshes and the note does not say whether they survived the recolor, so scoring it either way would be inventing a label.",
  },
  {
    cell: "1.5a",
    outputId: "bc3b3f07",
    sourceId: "3b9be374",
    prompt: "make the jacket pink",
    path: "masked",
    verdict: "FAILED",
    expect: {
      identity: "pass",
      marks: "unknown",
      anatomy: "flag",
      adherence: "flag",
    },
    note: 'THE ANATOMY ANCHOR. Adi: "did not work, tweaked tf out and added another hand lmao." Three hands — "anatomical corruption inside the mask". Adherence also flags: it came back MAROON, not pink. Identity passes: the face is outside a 1840x2364 jacket region.',
  },
  {
    cell: "1.5b",
    outputId: "9f05887f",
    sourceId: "3b9be374",
    prompt: "recolor the jacket to be black",
    path: "masked",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "The control for 1.5a, and the most valuable negative in the set: BYTE-IDENTICAL mask (maskBytes 5537), same geometry, same source, opposite outcome. An anatomy check that fires on 1.5a must NOT fire here, and nothing geometric can tell them apart. Adidas three stripes preserved, hands correct.",
  },
  {
    cell: "2.1",
    outputId: "89641759",
    sourceId: "afc78262",
    prompt: "put a number 10 on the jersey",
    path: "masked",
    verdict: "ARTIFACT",
    expect: {
      identity: "pass",
      marks: "unknown",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "Quality degradation inside the patch. The sweep groups it with 2.3 as the same class as the three hands, but the note does not describe a mark or an anatomy defect specifically — marks left `unknown` rather than guessed.",
  },
  {
    cell: "2.2",
    outputId: "583812d8",
    sourceId: "afc78262",
    prompt: "add a nike swoosh to the shorts",
    path: "masked",
    verdict: "FAILED",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "flag",
    },
    note: 'THE ADHERENCE ANCHOR. Adi: "didn\'t work at all." "No swoosh appears in the output. Every guard passed, the mask was used, nothing was flagged — the model simply did not add the mark." Marks PASS: nothing was damaged, the edit just never happened. This is the case that separates Q.4 from Q.2.',
  },
  {
    cell: "2.3",
    outputId: "58926c24",
    sourceId: "afc78262",
    prompt: "put a sponsor patch on the sleeve",
    path: "masked",
    verdict: "FAILED",
    expect: {
      identity: "pass",
      marks: "unknown",
      anatomy: "unknown",
      adherence: "flag",
    },
    note: 'Adi: FAILED, and the overreach guard fired at 0.505 against a cap of 0.505 — one rounding from silence. "2.3\'s sleeve distortion" is grouped with 1.5a in the sweep as the same class of defect. ⚠️ ANATOMY WAS "flag" HERE AND IS NOW "unknown" — RELABELLED 2026-09-09 after the acceptance run, and this is a LABEL correction, not a softened check. The acceptance had anatomy answer "2 hands, 2 arms, 2 legs on 1 figure; nothing implausible", which is CORRECT: a distorted sleeve is GARMENT GEOMETRY, not anatomy. Her limbs are fine; the fabric is not. The sweep groups 2.3 with the three-hands case because both are "corruption inside the patch", but qa/anatomy.ts asks a narrower question — how many limbs, are they possible — and cloth deformation is outside it by design. Scoring it as an anatomy miss would have graded the check against a defect class it does not look for, which is the same trap the ARTIFACT rows in this file are annotated for. Garment-geometry detection is a check nobody has built and this corpus has exactly one example of; it is named here so it is not lost. Adherence stays "flag": no patch appeared, and that IS in scope.',
  },
  {
    cell: "2.4a",
    outputId: "684531fd",
    sourceId: "517ed082",
    prompt: "add an adidas logo to the jersey",
    path: "masked",
    verdict: "FAILED",
    expect: {
      identity: "unknown",
      marks: "unknown",
      anatomy: "unknown",
      adherence: "flag",
    },
    note: 'Adi: "didnt work for first image, and caused distortion." "The whole subject reads as regenerated rather than edited — her face is smoothed and altered, and the shoulder/sleeve panel is distorted." ⚠️ IDENTITY WAS "flag" HERE AND IS NOW "unknown" — MEASURED, NOT REVISED BY OPINION. The header rule says a check may argue with an `expect` when the image supports it, and here the IMAGE supports it decisively: source and output are both 1056x1408, and the mean-absolute pixel difference over the head region is EXACTLY 0.000 while the whole frame differs by 4.245. This is a masked edit on a 521x542 jersey region, so the composite pasted her original face back byte-for-byte — the face in this output IS the source\'s face, and no face-based metric can call it altered because it is not altered. What Adi saw is the sleeve/shoulder distortion the same note records, plus the impression of a regenerated jersey. Adherence still flags: the adidas logo did not appear. CONSEQUENCE: THE CORPUS HAS NO IDENTITY POSITIVE AT ALL. 2.4a was the only candidate anywhere in the sweep, the probe or the roadmap, and it is disqualified. Q.1 therefore cannot be calibrated against anything today — see qa/identity.ts. The first real identity failures will come from sweep #2, which runs every prompt through the full-frame path where nothing is preserved by construction.',
  },
  {
    cell: "2.4b",
    outputId: "f4500d5a",
    sourceId: "afc78262",
    prompt: "add an adidas logo to the jersey",
    path: "masked",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "flag",
      anatomy: "pass",
      adherence: "pass",
    },
    note: 'THE CLEAN-BUT-SHOULD-FLAG CASE. Adi: "second image worked cleanly" and the sweep calls it the cleanest design result. AND: "The adidas logo replaced the Nike swoosh rather than being added alongside it. That was not asked for — the prompt says add, not replace." A mark integrity check MUST fire here. Counting that as a false positive would teach Q.2 to ignore mark substitution, which is the NIL case.',
  },
  {
    cell: "3.1",
    outputId: "63f8717a",
    sourceId: "afc78262",
    prompt: "make the jersey red and the shorts black",
    path: "masked",
    verdict: "FAILED",
    expect: {
      identity: "pass",
      marks: "flag",
      anatomy: "pass",
      adherence: "flag",
    },
    note: 'THE MARK-DESTRUCTION ANCHOR. Adi: "nope didnt work at all. more line slop (thats showing) as well." "The STANFORD wordmark and the number 8 were stripped from the jersey — visible content destroyed, not just a failed recolor." Adherence flags too: neither garment recoloured. Hardest case in the set — the wordmark is ~40px on a 1008px frame.',
  },
  {
    cell: "3.1b",
    outputId: "f60837fb",
    sourceId: "afc78262",
    prompt: "make the jersey red and the shorts black",
    path: "masked",
    verdict: null,
    expect: {
      identity: "unknown",
      marks: "unknown",
      anatomy: "unknown",
      adherence: "unknown",
    },
    note: 'Second multi-target run, labels as full directives rather than bare values. The sweep says "Not separately reported" — Adi did not verdict it. Carried for provenance and EXCLUDED from every matrix.',
  },
  {
    cell: "4.1",
    outputId: "87c09f06",
    sourceId: "afc78262",
    prompt: "put me in a packed stadium",
    path: "masked",
    verdict: "ARTIFACT",
    expect: {
      identity: "pass",
      marks: "unknown",
      anatomy: "unknown",
      adherence: "pass",
    },
    note: "WORKED, ARTIFACT. Background scope, preserve-inside — so the subject is composited from the original and identity holds by construction. Anatomy `unknown`: nobody assessed hands here.",
  },
  {
    cell: "4.2",
    outputId: "512c695b",
    sourceId: "a81be2c0",
    prompt: "change the background to a beach at sunset",
    path: "masked",
    verdict: "ARTIFACT",
    expect: {
      identity: "pass",
      marks: "unknown",
      anatomy: "unknown",
      adherence: "pass",
    },
    note: "The green halo. Probe Q2 established it is the composite inversion band, NOT a background-replacement defect — and it did not reproduce full-frame. Geometric, not a QA class.",
  },
  {
    cell: "4.3",
    outputId: "33d2b830",
    sourceId: "5581e882",
    prompt: "change the background to a plain studio backdrop",
    path: "masked",
    verdict: "ARTIFACT",
    expect: {
      identity: "pass",
      marks: "unknown",
      anatomy: "unknown",
      adherence: "pass",
    },
    note: "Border artifact, uninvestigated, on a downscaled frame with featherPx 120. Composite geometry again.",
  },
  {
    cell: "5.1",
    outputId: "6c49f879",
    sourceId: "a81be2c0",
    prompt: "remove the ball",
    path: "masked",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN. Ran no_noun on a rectangle — one of the two cleanest object results in the sweep.",
  },
  {
    cell: "5.2",
    outputId: "f8c3987b",
    sourceId: "a81be2c0",
    prompt: "change the ball to a black one",
    path: "masked",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN. Same rectangle path as 5.1.",
  },
];

/**
 * PR-0's probe cells. Already on disk in `probe-out/` — no DB, no GCS, no spend to assemble.
 *
 * "All nine verdicted cells came back CLEAN — Q1's six, Q2's one, Q3's two." That is the entire
 * clean side of the full-frame arm, and it is the only place identity has full-frame negatives at
 * all. Q4's eight cells were NOT verdicted visually and are deliberately absent.
 */
export const PROBE_OUTPUTS: LabeledOutput[] = [
  {
    cell: "q1-a",
    outputFile: "probe/q1-a.png",
    sourceId: "afc78262",
    prompt:
      "add the soccer ball from the second image, place it between her cleats",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN. Reframed to square (46.4% aspect delta) — a frame-continuity change, explicitly NOT a defect per the probe. BOLYN legible on the ball.",
  },
  {
    cell: "q1-b",
    outputFile: "probe/q1-b.png",
    sourceId: "afc78262",
    prompt: "place this ball at her feet",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN. Square reframe.",
  },
  {
    cell: "q1-c",
    outputFile: "probe/q1-c.png",
    sourceId: "afc78262",
    prompt:
      "put the soccer ball from the second image on the grass beside her right foot",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN. Square reframe.",
  },
  {
    cell: "q1-d",
    outputFile: "probe/q1-d.png",
    sourceId: "afc78262",
    prompt: "add a soccer ball at her feet",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN, and named in the brief as a Q.1 calibration negative. No reference image; aspect held to 0.5%. Frame excess 2.7/4.5/4.0 against a ~1.3 resample floor.",
  },
  {
    cell: "q1-e-control",
    outputFile: "probe/q1-e-control.png",
    sourceId: "afc78262",
    prompt: "place the water bottle from the second image on top of her head",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN, and named in the brief as a Q.1 calibration negative. The positive control — bottle on her head, Gatorade G legible. Aspect held to 1.8%.",
  },
  {
    cell: "q1-a-ratio",
    outputFile: "probe/q1-a-ratio.png",
    sourceId: "afc78262",
    prompt:
      "add the soccer ball from the second image, place it between her cleats",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN with aspectRatio pinned 2:3. The probe flags one open number: mid-left patch excess 14.8 on the advertising boards, aspect held — 'worth one look when verdicting'. Adi verdicted it CLEAN anyway.",
  },
  {
    cell: "q2-a",
    outputFile: "probe/q2-a.png",
    sourceId: "a81be2c0",
    prompt:
      "change the background to a beach at sunset, keep the person exactly as-is",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN, and named in the brief as a Q.1 calibration negative. THE HARDEST IDENTITY NEGATIVE IN THE SET: the entire background is replaced, so any whole-image embedding distance will be enormous while identity is held perfectly. This single row is what disqualifies a naive whole-frame embedding for Q.1. Also note the goal net vanished unasked — a removal no check here is scoped to catch.",
  },
  {
    cell: "q3-a",
    outputFile: "probe/q3-a.png",
    sourceId: "afc78262",
    prompt: "make the jersey red and the shorts black",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "CLEAN — the full-frame counterpart to sweep 3.1, which FAILED masked on the same prompt. 'STANFORD, number 8, Nike swoosh, green armband all survive legibly.' A marks check must pass here and flag on 3.1, from the same instruction.",
  },
  {
    cell: "q3-b",
    outputFile: "probe/q3-b.png",
    sourceId: "afc78262",
    prompt: "make the jersey red and add an adidas logo",
    path: "full-frame",
    verdict: "CLEAN",
    expect: {
      identity: "pass",
      marks: "flag",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "THE BRAND-CONFLICT ANCHOR, and the roadmap names it as such. Correct adidas mark on the chest — and 'the cleats and socks still carry Nike swooshes'. The probe: 'Mixed-brand output is a live NIL brand-safety case and belongs in PR Q\\'s logo-integrity check.' Q.2(c) MUST fire here even though Adi verdicted the image CLEAN.",
  },
];

/**
 * Q5's head-to-head. Eight cells, two paths, and the source of the invented-mark evidence.
 *
 * NOT separately Adi-verdicted as CLEAN/FAILED — the probe reports them as observations. The
 * `expect` values below come from the probe's own written findings and from the stacked zoom
 * (`q5-shorts-zoom-stacked.jpg`), which shows more than the prose recorded: q5-p1-B-r2 carries an
 * invented Nike swoosh AND three invented adidas-style stripes on the same garment.
 *
 * The four path-A cells are the structurally-guaranteed negatives described in the header: patch
 * excess 0.000 on every window of every run, face outside every region.
 */
export const Q5_OUTPUTS: LabeledOutput[] = [
  {
    cell: "q5-p1-A-r1",
    outputFile: "q5/q5-p1-A-r1.jpg",
    sourceId: "afc78262",
    prompt: "make the shorts black and green",
    path: "masked",
    verdict: null,
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "Masked. Patch excess 0.000 on all three windows — pixel identity outside the region, by construction. 'Path A preserves the Stanford tree logo in its original red.' Structural true negative for identity AND marks.",
  },
  {
    cell: "q5-p1-A-r2",
    outputFile: "q5/q5-p1-A-r2.jpg",
    sourceId: "afc78262",
    prompt: "make the shorts black and green",
    path: "masked",
    verdict: null,
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "As r1. Excess 0.000.",
  },
  {
    cell: "q5-p2-A-r1",
    outputFile: "q5/q5-p2-A-r1.jpg",
    sourceId: "afc78262",
    prompt: "make the socks blue and green",
    path: "masked",
    verdict: null,
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "Masked, 2 regions. Excess 0.000. Striped both socks.",
  },
  {
    cell: "q5-p2-A-r2",
    outputFile: "q5/q5-p2-A-r2.jpg",
    sourceId: "afc78262",
    prompt: "make the socks blue and green",
    path: "masked",
    verdict: null,
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "unknown",
    },
    note: "Masked. Excess 0.000. Adherence `unknown`, not `flag`: it read 'blue and green socks' as one colour PER SOCK where r1 striped both. The probe calls that model variance inside the crop, not a failure — and it is genuinely ambiguous whether the instruction was disobeyed. Left unscored rather than guessed.",
  },
  {
    cell: "q5-p1-B-r1",
    outputFile: "q5/q5-p1-B-r1.png",
    sourceId: "afc78262",
    prompt:
      "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.",
    path: "full-frame",
    verdict: null,
    expect: {
      identity: "pass",
      marks: "flag",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "THE INVENTED-MARK ANCHOR the brief names. Probe: path B 'renders it white-on-green and adds a green Nike swoosh that the source does not have'. The stacked zoom confirms: the Stanford tree is redrawn at ~3x source size with a white outline it never had, and a large swoosh appears on the right leg. Source has no swoosh on the shorts.",
  },
  {
    cell: "q5-p1-B-r2",
    outputFile: "q5/q5-p1-B-r2.png",
    sourceId: "afc78262",
    prompt:
      "make the shorts black and green. Keep everything else exactly as-is — change only the shorts.",
    path: "full-frame",
    verdict: null,
    expect: {
      identity: "pass",
      marks: "flag",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "The second invented-mark anchor, and RICHER than the prose records: the stacked zoom shows BOTH an invented Nike swoosh AND three invented green adidas-style stripes on the same garment. That is Q.2(b) and Q.2(c) firing on one image — an invented mark and a brand conflict the source never had.",
  },
  {
    cell: "q5-p2-B-r1",
    outputFile: "q5/q5-p2-B-r1.png",
    sourceId: "afc78262",
    prompt:
      "make the socks blue and green. Keep everything else exactly as-is — change only the socks.",
    path: "full-frame",
    verdict: null,
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "Full-frame, and the counter-example that stops Q.2 from simply flagging every full-frame output: 'on the socks the reverse holds — path B preserves the white Nike swoosh cleanly.' Same path, same frame, marks intact. If Q.2 fires here it is keying on the path, not on the marks.",
  },
  {
    cell: "q5-p2-B-r2",
    outputFile: "q5/q5-p2-B-r2.png",
    sourceId: "afc78262",
    prompt:
      "make the socks blue and green. Keep everything else exactly as-is — change only the socks.",
    path: "full-frame",
    verdict: null,
    expect: {
      identity: "pass",
      marks: "pass",
      anatomy: "pass",
      adherence: "pass",
    },
    note: "As r1. Marks preserved on the full-frame path.",
  },
];

export const LABELED_SET: LabeledOutput[] = [
  ...SWEEP_OUTPUTS,
  ...PROBE_OUTPUTS,
  ...Q5_OUTPUTS,
];

/**
 * Every distinct source frame the corpus compares against.
 *
 * These are `media_assets.id` prefixes — the sweep's `src` column. NOT the same id space as the
 * sweep's output column, which holds `generation_jobs.id`; see `studioQaFixtures.resolveShortId`.
 *
 * `f757678b` is deliberately ABSENT. The probe memo names its small frame by that id, but it is the
 * GCS OBJECT name (`uploads/f757678b-….png`), and the asset it belongs to is `afc78262` — verified
 * byte-identical (sha256 666654bfc8b5…, 2,511,706 bytes, one row). So the probe's frame and the
 * sweep's workhorse are ONE picture, and every q1/q3/q5 cell above points at `afc78262` accordingly.
 */
export const SOURCE_IDS = [
  "afc78262", // Stanford kit, 1008x1476 — the sweep's workhorse AND the probe's small frame
  "a81be2c0", // 6000x4000, orientation 8 — sweep 4.2's green-halo case
  "5581e882", // 4000x6000 — Q4's strong arm
  "3b9be374", // 4000x6000 — 1.5a/1.5b's jacket
  "517ed082", // 1056x1408 — 2.4a's mint CarMax jersey. THE identity anchor's source.
] as const;

/** Rows a check is actually scored on: an `unknown` for that check is excluded, never counted. */
export function scorable(
  set: LabeledOutput[],
  check: keyof LabeledOutput["expect"],
): LabeledOutput[] {
  return set.filter((o) => o.expect[check] !== "unknown");
}

/**
 * OTHER PHOTOGRAPHS OF THE SAME ATHLETE — the boundary the identity threshold has to clear.
 *
 * ─── WHY THIS EXISTS, AND WHY THE CORPUS ABOVE CANNOT ANSWER IT ────────────────────────────────
 *
 * Every identity label above is "one source frame versus something derived from that same frame".
 * That teaches a distance metric only where the CLEAN floor sits. It says nothing about the
 * question a threshold actually has to answer, which is:
 *
 *     is this the same person, or a regenerated face wearing her features?
 *
 * A threshold fitted only to derived pairs would sit just above photographic noise, and the first
 * legitimate edit that moves her head a few degrees would read as an identity failure. The
 * discriminating quantity is SAME PERSON, DIFFERENT PHOTOGRAPH — different day, pose, lighting,
 * camera, expression — because a working metric must call that the same person while calling 2.4a's
 * smoothed regeneration a different one. If those two overlap, no threshold exists at any value and
 * the check ships as a logged number.
 *
 * ─── THREE TIERS, AND THE ORDER THEY MUST COME OUT IN ──────────────────────────────────────────
 *
 *   1. same frame, clean edit    every CLEAN row above vs its own source           — the floor
 *   2. same person, other photo  these, pairwise: 9 photos = 36 pairs              — THE BOUNDARY
 *   3. same frame, regenerated   517ed082 vs 2.4a's output                         — must exceed 2
 *
 * A usable threshold sits strictly between tier 2's ceiling and tier 3's floor. Report the margin as
 * a gap between those two numbers, never as "2.4a scored X" — a single number against a single
 * anchor is not separation, and with exactly one tier-3 anchor in existence it is the honest limit
 * of what this corpus can support.
 *
 * ─── SELECTION, SO THE NEXT PERSON CAN REPRODUCE IT ────────────────────────────────────────────
 *
 * Measured 2026-09-09 against her library: 15 non-generated assets carry pixels, and these are every
 * one where `metadata.vision.athlete_present` is true with `athlete_prominence >= 0.5` and
 * `media_type = IMAGE` — the tags `lib/visionTag.ts` already wrote. The six excluded rows are three
 * screenshots/text graphics with `athlete_present: false` and three where she is incidental
 * (prominence 0.15–0.30). No new tagging, no model call, no generation: $0.00.
 *
 * `afc78262` and `517ed082` appear here AND as sources above. That is the point — 517ed082 is 2.4a's
 * own source, so tier 2 and tier 3 share an endpoint and the comparison is against the same face.
 */
export interface IdentityReference {
  assetId: string;
  /** From `metadata.vision`, as written by lib/visionTag.ts. Not re-derived here. */
  shotType: "portrait" | "action" | "lifestyle";
  prominence: number;
  note: string;
}

export const IDENTITY_REFERENCES: IdentityReference[] = [
  {
    assetId: "e58f3a5a",
    shotType: "portrait",
    prominence: 1.0,
    note: "2800x1866. Highest prominence portrait in the library.",
  },
  {
    assetId: "25499d98",
    shotType: "portrait",
    prominence: 0.95,
    note: "6000x4000.",
  },
  {
    assetId: "b2d6edcd",
    shotType: "portrait",
    prominence: 0.95,
    note: "4000x6000.",
  },
  {
    assetId: "517ed082",
    shotType: "portrait",
    prominence: 0.95,
    note: "1056x1408. ALSO 2.4a's source — the shared endpoint between tier 2 and tier 3.",
  },
  {
    assetId: "afc78262",
    shotType: "portrait",
    prominence: 0.95,
    note: "1008x1476. ALSO the sweep's workhorse source and the probe's small frame.",
  },
  {
    assetId: "5581e882",
    shotType: "action",
    prominence: 1.0,
    note: "4000x6000. Action pose — the hardest same-person pair, and the most informative.",
  },
  {
    assetId: "3b9be374",
    shotType: "lifestyle",
    prominence: 0.95,
    note: "4000x6000. ALSO 1.5a/1.5b's source.",
  },
  {
    assetId: "77146781",
    shotType: "lifestyle",
    prominence: 0.9,
    note: "6000x4000.",
  },
  {
    assetId: "a81be2c0",
    shotType: "action",
    prominence: 0.7,
    note: "6000x4000, orientation 8. ALSO sweep 4.2's source. Lowest prominence kept — she is smaller in frame, which stresses face detection rather than the embedding.",
  },
];
