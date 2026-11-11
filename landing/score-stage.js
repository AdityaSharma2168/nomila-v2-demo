/**
 * score-stage.js — which M.I.A. score the join flow shows, and the words around it, from GET /waitlist/progress.
 *
 * Dev only in practice: `quickScore` and `scoreStage` come only from a signup_research v3/v4 run (QUICK_SCORE_ONE_CALL,
 * LEAN_SIGNUP_RESEARCH; prod has both off), so on production every answer is mode "none" or "final" with no note — the
 * page behaves exactly as before.
 *
 *   quick   the quick score is ready and the full one is not: the quick score with its confidence, and a line that says
 *           the full score is still processing and that Mila will email her (when the email is on) — or, when the full
 *           score ended without one, that she'll try again later. The quick score stays on screen either way.
 *   final   the full score of record. When it replaced a quick score (on this screen, or on the run: scoreStage
 *           .replacedQuick) one quiet line says so.
 *   none    no score to show yet: the page's own "on its way" / "try again later" screen.
 *
 * Pure (no DOM): index.html paints it; scripts/landingScoreStage.test.ts tests it. Copy is fixed here, never a model's.
 */

export const STAGE_COPY = {
  // Athlete-facing words never say "quick" (owner, 26 Oct 2026): it is her PRELIMINARY score, "a first read from our
  // scouting". Code names (quickScore, mode "quick") stay internal.
  eyebrowQuick: 'Your preliminary score',
  eyebrowFull: 'Your marketability',
  processing: 'A first read from our scouting.',
  processingEmail: "Your full score is still processing. I'll email you when it's done.",
  processingHere: "Your full score is still processing. It appears here when it's done.",
  fullFailed: 'A first read from our scouting.',
  fullFailedBody: "I couldn't finish your full score this time. I'll try again later.",
  replaced: 'Your full score is ready. It replaces your preliminary score.',
  waitQuickButton: 'See my preliminary score',
  waitMailQuick: "Your preliminary score is ready. I'll email you when your full score is done, so you can keep going.",
  waitMail: "I'll email you when your score is ready, so you can keep going.",
};

/** The quick score to show, or null: only while the full score has not landed. */
export function quickOf(p) {
  return p && !p.score && p.quickScore ? p.quickScore : null;
}

/**
 * The score screen's view. `opts.swapped`: a quick score on this screen was just replaced by the full one;
 * `opts.fullFailed`: the checklist says the full score ended without one (for a server with no scoreStage).
 */
export function scoreViewOf(p, opts = {}) {
  const stage = p && p.scoreStage ? p.scoreStage : null;
  if (p && p.score) {
    const replaced = !!opts.swapped || !!(stage && stage.replacedQuick);
    return { mode: 'final', card: p.score, eyebrow: STAGE_COPY.eyebrowFull, title: null, note: replaced ? STAGE_COPY.replaced : null };
  }
  const quick = quickOf(p);
  if (quick) {
    const failed = stage ? stage.full === 'failed' : !!opts.fullFailed;
    const email = !!(p.research && p.research.readyEmail);
    return {
      mode: 'quick', card: quick, eyebrow: STAGE_COPY.eyebrowQuick,
      title: failed ? STAGE_COPY.fullFailed : STAGE_COPY.processing,
      note: failed ? STAGE_COPY.fullFailedBody : email ? STAGE_COPY.processingEmail : STAGE_COPY.processingHere,
    };
  }
  return { mode: 'none', card: null, eyebrow: STAGE_COPY.eyebrowFull, title: null, note: null };
}

/** The wait screen's email line (shown only when the email is on and no full score yet). */
export function waitMailText(p) {
  return quickOf(p) ? STAGE_COPY.waitMailQuick : STAGE_COPY.waitMail;
}
