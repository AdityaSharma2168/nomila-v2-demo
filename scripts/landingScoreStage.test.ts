/**
 * landingScoreStage.test.ts — the join flow's quick → full score view (landing/score-stage.js, painted by
 * landing/index.html). The module is plain browser ESM with no imports; it is loaded here as source in a sandbox.
 *
 *   S1 quick only: the quick score with its confidence, "still processing", and the email promise (or "appears here")
 *   S2 the full score replaces the quick one: the full card, and one line that says it replaced the quick score
 *   S3 identity disputed (the server sends no quickScore): nothing quick is shown, the page's own pending screen
 *   S4 flag off (no quickScore, no scoreStage): exactly the old behaviour — the full score with no note, or nothing
 *   S5 the full score failed: the quick score stays, with "I'll try again later"
 *   S6 the page uses the module (no second copy of the logic) and keeps the swap free of a redraw from empty
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "landing", "score-stage.js"), "utf8");
const mod = vm.runInNewContext(`${src.replace(/^export /gm, "")}\n;({ STAGE_COPY, quickOf, scoreViewOf, waitMailText })`) as {
  STAGE_COPY: Record<string, string>;
  quickOf: (p: unknown) => any;
  scoreViewOf: (p: unknown, o?: { swapped?: boolean; fullFailed?: boolean }) => any;
  waitMailText: (p: unknown) => string;
};
const { STAGE_COPY, scoreViewOf, waitMailText } = mod;

const FULL = { value: 612, confidence: "medium", lines: ["Brands see a proven performer."], groups: [], bands: [], raise: null };
const QUICK = { quick: true, value: 548, confidence: "low", lowConfidence: true, lines: ["A strong season."], groups: [], bands: [], raise: null, sources: [] };
const progress = (o: Record<string, unknown>) => ({ research: { state: "running", readyEmail: true, steps: [] }, findings: [], score: null, ...o });

test("S1: quick only — her quick score with its confidence, still processing, and we'll email her", () => {
  const v = scoreViewOf(progress({ quickScore: QUICK, scoreStage: { stage: "quick", full: "processing", replacedQuick: false, quickAt: "t", finalAt: null } }));
  expect(v).toMatchObject({ mode: "quick", card: QUICK, eyebrow: "Your preliminary score", title: "A first read from our scouting." });
  expect(v.card.confidence).toBe("low");
  expect(v.note).toBe("Your full score is still processing. I'll email you when it's done.");
  // No email from this deployment: no promise of one.
  const here = scoreViewOf(progress({ quickScore: QUICK, research: { state: "running", readyEmail: false, steps: [] } }));
  expect(here.note).toBe("Your full score is still processing. It appears here when it's done.");
  expect(waitMailText(progress({ quickScore: QUICK }))).toBe("Your preliminary score is ready. I'll email you when your full score is done, so you can keep going.");
});

test("S2: the full score replaces the quick one, and says so once", () => {
  const p = progress({ score: FULL, quickScore: QUICK, scoreStage: { stage: "final", full: "ready", replacedQuick: true, quickAt: "t", finalAt: "t2" } });
  expect(mod.quickOf(p)).toBeNull();                                                  // never both: the full score wins
  expect(scoreViewOf(p)).toMatchObject({ mode: "final", card: FULL, eyebrow: "Your marketability", note: "Your full score is ready. It replaces your preliminary score." });
  // Swapped on screen this visit (an older payload without replacedQuick): the same line.
  expect(scoreViewOf(progress({ score: FULL }), { swapped: true }).note).toBe(STAGE_COPY.replaced);
});

test("S3: identity disputed — the server sends no quick score, so nothing quick is shown", () => {
  const v = scoreViewOf(progress({ scoreStage: { stage: "none", full: "processing", replacedQuick: false, quickAt: null, finalAt: null } }));
  expect(v).toMatchObject({ mode: "none", card: null, note: null });
  expect(waitMailText(progress({}))).toBe("I'll email you when your score is ready, so you can keep going.");
});

test("S4: flag off — no quickScore and no scoreStage: the full score with no note, or nothing (as before)", () => {
  expect(scoreViewOf(progress({ score: FULL }))).toEqual({ mode: "final", card: FULL, eyebrow: "Your marketability", title: null, note: null });
  expect(scoreViewOf(progress({}))).toEqual({ mode: "none", card: null, eyebrow: "Your marketability", title: null, note: null });
  expect(scoreViewOf(null)).toMatchObject({ mode: "none" });
});

test("S5: the full score ended without one — the quick score stays, with try again later", () => {
  const v = scoreViewOf(progress({ quickScore: QUICK, scoreStage: { stage: "quick", full: "failed", replacedQuick: false, quickAt: "t", finalAt: null } }));
  expect(v).toMatchObject({ mode: "quick", card: QUICK, title: "A first read from our scouting.", note: "I couldn't finish your full score this time. I'll try again later." });
  expect(scoreViewOf(progress({ quickScore: QUICK }), { fullFailed: true }).note).toBe(STAGE_COPY.fullFailedBody);   // a server with no scoreStage
});

test("S6: the page paints from the module and settles the swap in place", () => {
  const html = fs.readFileSync(path.join(ROOT, "landing", "index.html"), "utf8");
  expect(html).toContain("import { STAGE_COPY, quickOf, scoreViewOf, waitMailText } from './score-stage.js';");
  expect(/function quickOf\(/.test(html)).toBe(false);                               // one copy of the rule
  expect(html).toContain(".jf .ringw.settle .seg{animation:none;stroke-dashoffset:0;}");
  // The update never replays the entrance: the bands tween from where they are (index.html paintScore).
  expect(html).toContain("const prev = opts.settle ? S.ringBands || [] : null;");
  // Its sources are our own source chips (the finding cards' .src), never Google's rendered suggestion HTML.
  expect(html).toContain('<div class="srcs" id="j-quick-src" role="list" aria-label="Sources"></div>');
  expect(html).toContain("const a = document.createElement('a'); a.className = 'src';");
  expect(html).not.toMatch(/searchSuggestion|attachShadow|sb-sugg/);
  // Copy rules: sentence case, no "AI-generated", never "quick" or "Google search" to the athlete (owner, 26 Oct 2026).
  for (const line of Object.values(STAGE_COPY)) {
    expect(line).not.toMatch(/AI[- ]generated/i);
    expect(line).not.toMatch(/quick|google search/i);
    expect(line[0]).toBe(line[0].toUpperCase());
  }
});
