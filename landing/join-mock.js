/**
 * join-mock.js — a stand-in server for the join flow, LOCAL ONLY.
 *
 * index.html loads this module only when the page runs on localhost / 127.0.0.1 AND the URL carries ?mock=1, so a
 * deployed page never imports it (firebase.json also leaves it out of the landing deploy). It answers the same paths
 * the flow calls, with an obviously made-up athlete, so every screen can be seen and screenshotted without signing in.
 *
 * Params (all optional):
 *   screen=signin|sport|claim|team|connect|wait|score|bring|spot|in   jump straight to a screen
 *   stage=queued|running|done|failed|not_started|needs_more   what GET /waitlist/progress answers (default: running → done
 *                                     over ~8 polls); needs_more = the "real athlete?" check found nothing yet
 *   err=1                                 GET /waitlist/progress answers 500 every time (the back-off, then the calm note)
 *   nullgroup=1                           the score's Performance group could not be scored (value null, no bands)
 *   nobands=1                             the score carries no bands (an older server): the ring is one arc of the score's share of 850
 *   found=N                               how many findings the progress shows (default: grows by one per poll)
 *   claim=1                               POST /waitlist answers 409 "Is this you?" with two candidates
 *   ig=1                                  Instagram already connected
 *   noname=1                              the sign-in brought no name (the sport screen asks for one)
 *   promoted=1 | returning=1              GET /auth/me as a promoted / returning waitlisted athlete
 *   phase=search|instagram|merge|score    freeze the wait's live checklist at that step (research running)
 *   scorewait=1 | scorefail=1             research done, the score still computing / its scoring failed (no score)
 *   quick=1                               a quick score is ready (dev's signup_research v4): shown until the full score
 *                                         lands, then replaced in place; noemail=1 = the score email is off
 *   live=1 | livestep=N                   research.live: the runner's real stage, one per poll (or frozen at step N 0–5)
 *   handles=1 | lookup=<outcome>          "Is this you?" Instagram + YouTube handles; what confirming answers (found,
 *                                         not_business_account, rate_limited, …)
 *   donepoll=N                          the research finishes at the Nth poll (default 8; the score screen polls every 4s)
 *   hero=1                                she has her own hero photo (the share card draws it; a stock stand-in here)
 *   mila=1 | milafail=1                   Mila hosts the join flow (landing/mila-host.js; MILA_TF_WAITLIST); milafail=1
 *                                         makes every Mila turn fail, so the page falls back to today's screens
 *   total=N                             how many athletes are on the list (≤ 100: "One of the first 100 athletes")
 *   session=1                             (index.html) a returning visitor whose browser still has a session
 *   go=score                              (index.html) the score-ready email's link
 */

const FINDINGS = [
  { kind: 'about', text: 'Plays forward for State University women\'s soccer.', source: { label: 'statesports.example', url: 'https://example.com/roster' } },
  { kind: 'results', text: 'Named first-team all-conference in 2025.', source: { label: 'Conference site', url: 'https://example.com/awards' } },
  { kind: 'press', text: 'Featured in a campus paper profile on balancing pre-med with a starting role.', source: { label: 'The Daily Example', url: 'https://example.com/story' } },
  { kind: 'partners', text: 'Has posted with two local brands in the last year.', source: { label: 'Instagram', url: 'https://example.com/ig' } },
  { kind: 'audience', text: 'About 12,400 followers on Instagram, most of them in Texas.', source: { label: 'Instagram', url: 'https://example.com/ig' } },
];

const SCORE = {
  value: 612,
  groups: [
    { key: 'audience', label: 'Audience', value: 64 },
    { key: 'commercial', label: 'Commercial', value: 48 },
    { key: 'brand', label: 'Brand', value: 71 },
    { key: 'performance', label: 'Performance', value: 80 },
  ],
  // The ring's bands: each dimension's contribution (of 100), as the app's ring draws them (sum 72 ≈ 612 / 850).
  bands: [
    { key: 'audience_scale', contribution: 9.5 }, { key: 'engagement_quality', contribution: 8.6 },
    { key: 'commercial_proof', contribution: 6.2 }, { key: 'brand_fit', contribution: 9.1 },
    { key: 'narrative_power', contribution: 10.4 }, { key: 'cultural_relevance', contribution: 7.3 },
    { key: 'athletic_authority', contribution: 11.2 }, { key: 'momentum', contribution: 9.7 },
  ],
  confidence: 'medium',
  lines: [
    'Brands see a proven performer with a story people share.',
    'Your audience is engaged but mostly local for now.',
  ],
  raise: { text: 'Connect TikTok when it opens so your reach there counts too.', action: null },
};

// The one-call quick score (GET /waitlist/progress quickScore): the full score's shape, low confidence, with the
// stand-in Google links the landing must show with it (made up; no Search Suggestion in the mock).
const QUICK = {
  quick: true, value: 548, lowConfidence: true, confidence: 'low', raise: null,
  groups: [
    { key: 'audience', label: 'Audience', value: 52 }, { key: 'commercial', label: 'Commercial', value: 40 },
    { key: 'brand', label: 'Brand', value: 66 }, { key: 'performance', label: 'Performance', value: 78 },
  ],
  bands: [
    { key: 'audience_scale', contribution: 8.1 }, { key: 'engagement_quality', contribution: 7.4 },
    { key: 'commercial_proof', contribution: 5.2 }, { key: 'brand_fit', contribution: 8.0 },
    { key: 'narrative_power', contribution: 9.6 }, { key: 'cultural_relevance', contribution: 6.4 },
    { key: 'athletic_authority', contribution: 10.9 }, { key: 'momentum', contribution: 8.9 },
  ],
  lines: ['A strong season on the field, with regional coverage of your results.'],
  sources: [{ title: 'statesports.example', url: 'https://example.com/roster' }, { title: 'The Daily Example', url: 'https://example.com/story' }],
};

const CLAIMS = [
  { claimId: '00000000-0000-4000-8000-000000000001', candidate: { fullName: 'Jordan Lee', sport: 'Soccer', teamOrSchool: 'State University', classYear: 2028, cityOrCountry: 'Austin, TX', knownSocialHandles: { instagram: 'jordan.lee' }, claimability: 'open' } },
  { claimId: '00000000-0000-4000-8000-000000000002', candidate: { fullName: 'Jordan Lee', sport: 'Soccer', teamOrSchool: 'Riverside FC', classYear: null, cityOrCountry: 'Portland, OR', knownSocialHandles: {}, claimability: 'open' } },
];

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function createMock(params) {
  const p = (k) => params.get(k);
  let polls = 0;
  let joined = p('returning') === '1' || ['connect', 'wait', 'score', 'bring', 'spot'].includes(p('screen'));
  let igConnected = p('ig') === '1';
  let sport = joined ? 'soccer' : null;                // a sign-in's own post carries no sport; the sport step's does
  let claimAnswered = false;
  // ?handles=1: research found her Instagram and YouTube handles ("Is this you?"); lookup=<outcome> is what confirming answers.
  const handles = p('handles') === '1' ? [
    { platform: 'instagram', handle: 'jordan.lee', source: 'research', status: 'suggested' },
    { platform: 'youtube', handle: '@jordanleeplays', source: 'research', status: 'suggested' },
  ] : null;
  // total=N: how many are on the list (real numbers; the landing reads a small list differently); her place in it.
  const total = () => (p('total') != null ? Number(p('total')) : 1480);
  const pos = () => Math.max(1, Math.min(total(), Math.round(total() * (igConnected ? 0.13 : 0.14))));
  const user = {
    uid: 'mock-user', email: 'jordan@example.com',
    displayName: p('noname') === '1' ? '' : 'Jordan Lee',
    getIdToken: async () => 'mock-token',
  };

  function progress() {
    polls += 1;
    const stage = p('stage') || (polls >= (Number(p('donepoll')) || 8) ? 'done' : 'running');
    const found = p('found') != null ? Number(p('found')) : Math.min(FINDINGS.length, Math.max(0, polls - 1));
    const phase = p('phase');
    const done = stage === 'done' && !phase;
    const promoted = p('promoted') === '1';
    const scoreState = p('scorefail') === '1' ? 'failed' : p('scorewait') === '1' ? 'running' : 'done';
    const score = !done || scoreState !== 'done' ? null : p('nullgroup') === '1' ? { ...SCORE, groups: SCORE.groups.map((g) => g.key === 'performance' ? { ...g, value: null } : g), bands: SCORE.bands.filter((b) => b.key !== 'athletic_authority' && b.key !== 'momentum') } : { ...SCORE };
    if (score && p('nobands') === '1') delete score.bands;
    // The live checklist: frozen at ?phase=, else moving on with the polls; done ⇒ every step done (bar the score's own state).
    const order = ['search', 'instagram', 'merge', 'score'];
    const at = phase ? order.indexOf(phase) : done ? 4 : Math.min(3, Math.floor((polls - 1) / 2));
    const st = (i) => (i < at ? 'done' : i === at ? 'running' : 'pending');
    const steps = [{ key: 'web', status: st(0) }];
    if (igConnected) steps.push({ key: 'instagram', status: st(1) });
    steps.push({ key: 'merge', status: st(2), ...(at > 2 ? { count: FINDINGS.length } : {}) });
    steps.push({ key: 'score', status: done ? scoreState : st(3) });
    // ?quick=1: a signup_research v4 run with a ready quick score (dev only) — shown until the full score lands.
    const quickOn = p('quick') === '1' && stage !== 'queued' && stage !== 'needs_more';
    const quickScore = quickOn && !score ? { ...QUICK } : null;
    // ?live=1: the runner's real stage on a v4 run (research.live), one step per poll; livestep=N freezes it at step N.
    const LIVE = [{ stage: 'finding' }, { stage: 'reading', count: 4 }, { stage: 'reading', count: 11 }, { stage: 'pulling' }, { stage: 'checking', count: 18 }, { stage: 'scoring' }];
    const liveOn = p('live') === '1' && stage !== 'queued' && stage !== 'needs_more';
    const liveAt = p('livestep') != null ? Number(p('livestep')) : polls - 1;
    const live = !liveOn ? undefined : score ? { stage: 'final_ready', at: null } : done ? { stage: 'scoring', at: null } : { ...LIVE[Math.max(0, Math.min(LIVE.length - 1, liveAt))], at: new Date().toISOString() };
    // On a live run the checklist follows the same stage, as the server's rows do (finding/reading = web, pulling/
    // checking = merge, scoring = score).
    if (live && !done) {
      const row = { finding: 0, reading: 0, pulling: 2, checking: 2, scoring: 3 }[live.stage];
      const keyAt = ['web', 'instagram', 'merge', 'score'];
      steps.forEach((s) => { const i = keyAt.indexOf(s.key); s.status = i < row ? 'done' : i === row ? 'running' : 'pending'; if (s.key === 'merge' && s.status !== 'done') delete s.count; });
    }
    const scoreStage = quickOn ? {
      stage: score ? 'final' : 'quick', full: score ? 'ready' : done && scoreState === 'failed' ? 'failed' : 'processing',
      replacedQuick: !!score, quickAt: '2026-10-26T15:00:00.000Z', finalAt: score ? new Date().toISOString() : null,
    } : null;
    return {
      status: promoted ? 'active' : 'waitlisted',
      ...(quickScore ? { quickScore } : {}),
      ...(scoreStage ? { scoreStage } : {}),
      ...(handles ? { handles: handles.map((h) => ({ ...h })) } : {}),
      research: { state: phase ? 'running' : stage, queuedUntil: stage === 'queued' ? new Date(Date.now() + 864e5).toISOString() : null, readyEmail: stage === 'queued' || (quickOn && p('noemail') !== '1'), steps: stage === 'needs_more' ? [] : steps, ...(liveOn ? { live } : {}), ...(stage === 'needs_more' ? { reason: "I couldn't find any public page for this name in this sport yet." } : {}) },
      findings: stage === 'queued' || stage === 'needs_more' ? [] : FINDINGS.slice(0, done ? FINDINGS.length : p('found') != null ? found : 0),
      score,
      rank: promoted ? null : { position: pos(), total: total() },
      connected: igConnected ? ['instagram'] : [],
      referralCode: 'jordan7k2q',
      referrals: Number(p('referrals')) || 0,                   // ?referrals=3 previews the spot screen's count
      profile: { sport: 'soccer', team: 'State University' },
      heroPhoto: p('hero') === '1',
    };
  }

  async function fetchMock(path, { method = 'GET', body } = {}) {
    await new Promise((r) => setTimeout(r, 250));
    if (path === '/api/v1/auth/me') {
      if (p('promoted') === '1') return json(200, { firstName: 'Jordan', status: 'active', sport: 'soccer', school: 'State University' });
      if (!joined) return json(401, { error: 'No athlete account found for this token' });
      return json(200, { firstName: 'Jordan', status: 'waitlisted', sport, school: p('noteam') === '1' ? null : 'State University' });
    }
    if (path === '/api/v1/waitlist' && method === 'POST') {
      if (p('claim') === '1' && !claimAnswered && !(body && body.claim_session_id)) {
        return json(409, { error: 'confirmation_required', claimSessionId: '00000000-0000-4000-8000-0000000000aa', tier: 'candidate', claims: CLAIMS });
      }
      const returning = joined;
      joined = true; if (body && body.sport) sport = body.sport;
      return json(200, { ok: true, returning, promoted: false, profile: null });
    }
    if (path.startsWith('/api/v1/waitlist/handles/') && method === 'POST') {
      if (!handles) return json(404, { error: 'Not found' });                       // LEAN_SIGNUP_RESEARCH off
      const platform = path.split('/').pop();
      const h = handles.find((x) => x.platform === platform);
      if (!h) return json(404, { error: 'Not found' });
      h.status = body && body.action === 'reject' ? 'rejected' : 'confirmed';
      return json(200, { handles: handles.map((x) => ({ ...x })), ...(h.status === 'confirmed' ? { lookup: p('lookup') || 'found' } : {}) });
    }
    if (path.startsWith('/api/v1/identity/claims/')) { claimAnswered = true; return json(200, { outcome: 'pending_operator' }); }
    if (path === '/api/v1/waitlist/rank' && p('promoted') === '1') return json(404, { error: 'Not on the waitlist yet' });
    if (path === '/api/v1/waitlist/rank') return json(200, { rank: pos(), total: total(), socials: igConnected ? 1 : 0, connected: igConnected ? 1 : 0 });
    if (path === '/api/v1/waitlist/hero-photo') return p('hero') === '1' ? fetch('assets/v2/hero-1-960.webp') : json(404, { error: 'No photo yet' });
    if (path === '/api/v1/waitlist/progress') return p('err') === '1' ? json(500, { error: 'Could not read your progress.' }) : json(200, progress());
    if (path === '/api/v1/me/connections') return json(200, { connections: igConnected ? [{ platform: 'instagram', status: 'active', platform_username: 'jordan.lee' }] : [] });
    if (path === '/api/v1/me/connect/instagram') { igConnected = true; return json(200, { redirectUrl: null, mockConnected: true }); }
    // ?mila=1: Mila hosts the join flow (MILA_TF_WAITLIST, landing/mila-host.js); milafail=1: every turn fails (the page
    // falls back to today's screens). Her words here are made up, streamed the way the server streams them.
    if (path === '/api/v1/waitlist/mila') return json(200, { enabled: p('mila') === '1' });
    if (path === '/api/v1/waitlist/mila/turn' && method === 'POST') return milaTurn(body || {});
    return json(404, { error: 'Not found' });
  }

  const MILA_SAYS = {
    hello: "Hi Jordan, I'm Mila, your agent. Pick your sport below, then I'll look you up on the public web and work out your M.I.A. score: how brands see you.",
    research_started: "I'm on it. I'm finding you on the web now; the line below shows exactly what I'm doing. It takes a few minutes, and you keep your spot either way.",
    handles_found: 'I found two accounts that might be yours. Tap That’s me or Not me so your score uses the right ones.',
    score_quick: "Here's your quick score: 548 of 850, an early read from public results. Your full score is still being worked out and will replace it right here.",
    score_final: 'Your full score is in: 612 of 850, and it replaced the quick one. Connecting TikTok when it opens would raise it. Want to bring your team?',
    invite: "Thanks for bringing your team. Your card and your own link are below; teammates who join get their own score, and your spot doesn't depend on it.",
  };
  function milaTurn(b) {
    if (p('milafail') === '1') return json(503, { error: 'unavailable' });
    const asked = typeof b.message === 'string' ? b.message.toLowerCase() : '';
    const text = b.moment ? MILA_SAYS[b.moment] || '' : /score/.test(asked)
      ? 'Here it is again below.'
      : 'It usually takes a few minutes. You can stay here or come back later; I’ll keep working either way.';
    const cards = !b.moment && /score/.test(asked) ? [{ id: 'mock-card', kind: 'waitlist-card', title: 'score', payload: { card: 'score' }, links: [], runId: 'mock-run' }] : [];
    const enc = new TextEncoder();
    const words = text.split(/(?<= )/);
    const stream = new ReadableStream({
      async start(ctl) {
        for (const w of words) { await new Promise((r) => setTimeout(r, 35)); ctl.enqueue(enc.encode(`data: ${JSON.stringify({ token: w })}\n\n`)); }
        ctl.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, runId: 'mock-run', cards, status: 'completed', stopReason: null })}\n\n`));
        ctl.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  return { user, fetch: fetchMock, screen: p('screen') };
}
