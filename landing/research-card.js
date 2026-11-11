/**
 * research-card.js — the join flow's wait screen ("the research card"): the live status line and the "Is this you?"
 * rows for the handles research found. Pure (no DOM): index.html paints it; scripts/landingResearchCard.test.ts tests it.
 * Copy is fixed here, never a model's.
 *
 * Dev only in practice (LEAN_SIGNUP_RESEARCH; prod has it off):
 *   research.live   GET /waitlist/progress, signup_research v4 runs only: the runner's REAL stage (server
 *                   waitlistProgress liveStatusFrom). Absent ⇒ liveLineOf returns null and the page keeps its own
 *                   state-based line. Nothing here is timed or scripted.
 *   handles         [{ platform: instagram|youtube, handle, source: signup|you|research, status: suggested|confirmed|
 *                   rejected }] (server/agent/research/publicPlatform.ts waitlistHandles) — [] with the flag off ⇒
 *                   nothing is shown. Answered with POST /api/v1/waitlist/handles/:platform { action: confirm|reject,
 *                   handle } → { handles, lookup?, measured? } (actOnWaitlistHandle); 404 with the flag off.
 */

/** The live stage → a 1–3 word line (a count only when the server sent one). */
export function liveLineOf(live) {
  if (!live || typeof live.stage !== 'string') return null;
  const n = Number.isFinite(live.count) ? Math.max(0, Math.round(live.count)) : null;
  switch (live.stage) {
    case 'finding': return 'Finding you';
    case 'reading': return n ? `Reading ${n} page${n === 1 ? '' : 's'}` : 'Reading your pages';
    case 'pulling': return 'Pulling facts';
    case 'checking': return n ? `Checking ${n} fact${n === 1 ? '' : 's'}` : 'Checking facts';
    case 'scoring': return 'Scoring';
    case 'quick_ready': return 'Preliminary score ready';
    case 'final_ready': return 'Score ready';
    default: return null;
  }
}

/** The status card's second line: what is ready, from the score stage (never a guess about what comes next). */
export function liveSubOf(p) {
  if (p && p.score) return 'Your full score is ready.';
  if (p && p.quickScore) return 'Your preliminary score is ready. Your full score is still processing.';
  return '';
}

/** The checklist row that a live stage belongs to (its sub-line shows the live words; no other row rotates text). */
export function liveRowOf(live) {
  if (!live) return null;
  if (live.stage === 'finding' || live.stage === 'reading') return 'web';
  if (live.stage === 'pulling' || live.stage === 'checking') return 'merge';
  if (live.stage === 'scoring') return 'score';
  return null;
}

const PLATFORMS = { instagram: 'Instagram', youtube: 'YouTube' };
const SOURCE = { research: 'Found on the web', signup: 'You told us', you: 'You told us' };

/** The rows to show: Instagram / YouTube handles that are suggested or confirmed (a rejected one is gone). */
export function handleRowsOf(handles) {
  if (!Array.isArray(handles)) return [];
  return handles
    .filter((h) => h && PLATFORMS[h.platform] && typeof h.handle === 'string' && h.handle.trim() && (h.status === 'suggested' || h.status === 'confirmed'))
    .map((h) => ({
      platform: h.platform, service: PLATFORMS[h.platform],
      handle: h.handle.trim().replace(/^@?/, '@'),
      raw: h.handle.trim(),
      source: SOURCE[h.source] || '',
      status: h.status,
      ask: h.status === 'suggested',
    }));
}

export const HANDLE_COPY = {
  title: 'Is this you?',
  lede: 'I found these accounts. Tell me which are yours.',
  confirm: "That's me",
  reject: 'Not me',
  confirmed: 'Yours',
  saveFailed: "That didn't save. Try again in a moment.",
  notBusiness: 'To share your Instagram numbers, switch it to a professional account (Business or Creator) in Instagram settings.',
  later: "Thanks. I couldn't read this account just now. I'll try again later.",
};

/** The one plain line after she confirms, from the server's lookup outcome; null when there is nothing to say. */
export function lookupNoteOf(lookup) {
  if (!lookup || lookup === 'found' || lookup === 'connected') return null;
  if (lookup === 'not_business_account') return HANDLE_COPY.notBusiness;
  return HANDLE_COPY.later;
}
