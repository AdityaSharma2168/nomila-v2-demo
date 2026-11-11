/**
 * mila-host.js — Mila hosts the join flow (MILA_TF_WAITLIST, dev only; docs/design/mila-hosted-waitlist.md).
 *
 * After sign-in the join flow becomes one conversation (#j-mila): Mila's words stream from POST
 * /api/v1/waitlist/mila/turn (her Mila session, on Mastra), and the EXISTING join cards are shown inside the conversation,
 * drawn and wired by the page's own code (index.html): the sport grid, "Is this you?", the team question, the research
 * status (the wait screen's status line and checklist), the handle rows, the score card and the invite card. Nothing is
 * redrawn: each card's own DOM is moved into a wrapper in the thread and moved back on the way out.
 *
 *   steps    stay the page's: index.html calls show(id) as it always does; while the host is on, show() hands the join
 *            screens to present(id) instead of opening them full screen. Every tap goes to the same endpoint as today.
 *   status   is the page's own (paintWait over GET /waitlist/progress every 4 s): the runner's real stage, never Mila's.
 *   moments  Mila speaks at hello · research_started · handles_found · score_quick · score_final · invite, and whenever
 *            the athlete types. One turn at a time.
 *   skip     "Just show me my score": remembered on this device; the host steps aside and today's route() takes over.
 *   fallback the server says disabled, or a Mila turn fails ⇒ the same, without remembering: today's screens.
 *
 * Plain browser ESM with no imports: the pure helpers are tested in scripts/landingMilaHost.test.ts.
 */

/** The join screens the conversation hosts (everything else — sign-in, spot, you're in — stays full screen). */
export const HOSTED = ['j-sport', 'j-claim', 'j-team', 'j-connect', 'j-wait', 'j-score', 'j-bring'];
/** The steps before research: their cards are dimmed once the next step shows (answered). */
const EARLY = ['j-sport', 'j-claim', 'j-team'];
/** show_waitlist_card's enum → the page's card. */
export const CARD_SCREEN = { sport: 'j-sport', is_this_you: 'j-claim', handles: 'handles', score: 'j-score', invite: 'j-bring' };

export const MILA_COPY = {
  agent: 'Your agent',
  typing: 'Typing…',
  skip: 'Just show me my score',
  placeholder: 'Ask Mila anything',
};

/** The device remembers "just show me my score" per sign-in. */
export const skipKey = (uid) => `nomila.join.milaSkip.${uid || ''}`;

/**
 * Pure: what the latest progress newly makes true, as moments, given what was already said. Real data only: the handle
 * rows waiting for her answer, the quick score, the full score.
 */
export function momentsFor(p, said) {
  const out = [];
  if (!p) return out;
  const asks = Array.isArray(p.handles) && p.handles.some((h) => h && h.status === 'suggested' && (h.platform === 'instagram' || h.platform === 'youtube'));
  if (asks && !said.has('handles_found')) out.push('handles_found');
  if (p.score && !said.has('score_final')) out.push('score_final');
  else if (!p.score && p.quickScore && !said.has('score_quick')) out.push('score_quick');
  return out;
}

/** Pure: the moment to resume with when she comes back to a conversation already under way. */
export function resumeMoment(p) {
  if (!p) return 'research_started';
  if (p.score) return 'score_final';
  if (p.quickScore) return 'score_quick';
  if (Array.isArray(p.handles) && p.handles.some((h) => h && h.status === 'suggested')) return 'handles_found';
  return 'research_started';
}

/** Pure: split an SSE buffer into its data events (parsed) and the unfinished rest. Comments and junk are skipped. */
export function parseSse(buffer) {
  const events = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop();
  for (const b of blocks) {
    const data = b.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { events.push(JSON.parse(data)); } catch { /* not ours */ }
  }
  return { events, rest };
}

/** Pure: a finished turn the page cannot build on ⇒ fall back to today's screens. */
export function shouldFallback(done) {
  return !done || done.status !== 'completed' || !!done.error;
}

/**
 * The controller. `env` is the page's own code: { $, S, api, show, route, openSport, openScore, openBring,
 * paintWait, paintView, viewOf, loadProgress, readJson, isMock }.
 */
export function createMilaHost(env) {
  const { $, S } = env;
  const H = { on: false, cards: new Map(), said: new Set(), queue: Promise.resolve(), poll: null, research: false, scoreShown: false };
  let busyTurns = 0;

  const thread = () => $('j-mila-thread');
  const scrollDown = () => {
    const sec = $('j-mila'), col = sec && sec.querySelector('.col');
    requestAnimationFrame(() => { [sec, col].forEach((el) => { if (el) el.scrollTop = el.scrollHeight; }); });
  };
  const status = (t) => { const el = $('j-mila-st'); if (el) el.textContent = t; };

  // ─── cards: the page's own DOM, moved into the thread and back ─────────────────────────────
  function wrap(key, dark, nodes, fromBody) {
    const w = document.createElement('div');
    w.className = 'jf mcard' + (dark ? ' dark' : '');
    w.dataset.card = key;
    const col = document.createElement('div'); col.className = 'col';
    const body = fromBody || Object.assign(document.createElement('div'), { className: 'body' });
    const moved = (fromBody ? [fromBody] : nodes).map((n) => ({ n, parent: n.parentNode, next: n.nextSibling }));
    col.append(body);
    if (!fromBody) nodes.forEach((n) => body.append(n));
    w.append(col);
    return { w, moved };
  }
  function place(key, make) {
    let c = H.cards.get(key);
    if (!c) { c = make(); H.cards.set(key, c); }
    c.w.classList.remove('answered');
    thread().append(c.w);                                   // (re)shown last, under Mila's words
    scrollDown();
    return c;
  }
  function answerEarly(except) {
    H.cards.forEach((c, k) => { if (EARLY.includes(k) && k !== except) c.w.classList.add('answered'); });
  }
  function presentSection(id) {
    const sec = $(id);
    const c = place(id, () => {
      const body = sec.querySelector('.col > .body');
      const extra = id === 'j-bring' ? $('j-imgv') : null;       // the save-image viewer goes with the invite card
      const made = wrap(id, sec.classList.contains('dark'), [], body);
      if (extra) { made.moved.push({ n: extra, parent: extra.parentNode, next: extra.nextSibling }); made.w.append(extra); }
      return made;
    });
    if (!EARLY.includes(id)) answerEarly(null); else answerEarly(id);
    return c;
  }
  function presentResearch() {
    place('research', () => wrap('research', false, [$('j-stat'), $('j-chk'), $('j-more')].filter(Boolean)));
    answerEarly(null);
  }
  function presentHandles() {
    place('handles', () => wrap('handles', false, [$('j-handles')]));
  }
  function restoreAll() {
    H.cards.forEach((c) => {
      for (let i = c.moved.length - 1; i >= 0; i--) {
        const { n, parent, next } = c.moved[i];
        if (parent) parent.insertBefore(n, next && next.parentNode === parent ? next : null);
      }
      c.w.remove();
    });
    H.cards.clear();
  }

  // ─── Mila's words ───────────────────────────────────────────────────────────────────────────
  function bubble(cls, text) {
    const b = document.createElement('p'); b.className = cls; if (text) b.textContent = text;
    thread().append(b); scrollDown();
    return b;
  }
  /** One Mila turn (a moment or her message), queued behind any running turn. Resolves to the `done` event or null. */
  function turn(body) {
    // Her words' place in the thread is taken now, so a card shown right after sits under them.
    const out = bubble('mb typing', '');
    const run = async () => {
      if (!H.on) { out.remove(); return null; }
      busyTurns++; status(MILA_COPY.typing);
      let text = '', done = null;
      try {
        const r = await env.api('/api/v1/waitlist/mila/turn', { method: 'POST', body });
        if (!r.ok || !r.body) throw new Error('turn ' + r.status);
        const reader = r.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          const parsed = parseSse(buf + dec.decode(value, { stream: true }));
          buf = parsed.rest;
          for (const ev of parsed.events) {
            if (typeof ev.token === 'string') { text += ev.token; out.classList.remove('typing'); out.textContent = text; scrollDown(); }
            if (ev.done) done = ev;
          }
        }
        if (buf.trim()) for (const ev of parseSse(buf + '\n\n').events) if (ev.done) done = ev;
      } catch { done = null; }
      busyTurns--; if (!busyTurns) status(MILA_COPY.agent);
      if (shouldFallback(done)) { out.remove(); fallBack(); return null; }
      if (!text.trim()) out.remove();
      for (const c of (done.cards || [])) if (c && c.kind === 'waitlist-card') showCard(c.payload && c.payload.card);
      return done;
    };
    H.queue = H.queue.then(run, run);
    return H.queue;
  }
  function say(moment) {
    if (H.said.has(moment)) return Promise.resolve(null);
    H.said.add(moment);
    return turn({ moment });
  }
  /** Mila asked for a card (show_waitlist_card): the page shows it with its own code, when it can. */
  function showCard(card) {
    const id = CARD_SCREEN[card];
    if (id === 'j-sport') env.openSport();
    else if (id === 'j-claim') { if (S.claim) presentSection('j-claim'); }
    else if (id === 'handles') { env.paintWait(); presentHandles(); }
    else if (id === 'j-score') env.openScore();
    else if (id === 'j-bring') env.openBring();
  }

  // ─── research: the page's own status, polled ────────────────────────────────────────────────
  function startResearch() {
    if (!H.research) { H.research = true; say('research_started'); }
    presentResearch();
    S.gaveUp = false;
    env.paintWait();
    tick();
  }
  async function tick() {
    clearTimeout(H.poll);
    if (!H.on) return;
    if (!document.hidden) {
      await env.loadProgress();
      if (!H.on) return;
      env.paintWait();
      const p = S.progress;
      for (const m of momentsFor(p, H.said)) {
        say(m);
        if (m === 'handles_found') presentHandles();
        if (m === 'score_quick' || m === 'score_final') {
          if (H.scoreShown && m === 'score_final') env.paintView(env.viewOf(p));      // the full score settles in place
          else await env.openScore();
        }
      }
      if (p && p.score && H.scoreShown) return;                   // the full score is on show: nothing more to watch
    }
    H.poll = setTimeout(tick, S.progressErrors ? Math.min(30000, 4000 * 2 ** S.progressErrors) : 4000);
  }

  // ─── the hand-over from show() ──────────────────────────────────────────────────────────────
  /** show(id) while hosting: the join screens become cards in the thread. Returns true when it took the screen. */
  function present(id) {
    if (!H.on || id === 'j-mila') return false;
    if (!HOSTED.includes(id)) { stop(); return false; }        // the spot, "you're in", home: the conversation ends there
    if (id === 'j-wait') { startResearch(); return true; }
    if (id === 'j-connect') {
      if (!H.research) { startResearch(); return true; }        // straight after joining: research, not the connect screen
      presentSection('j-connect'); return true;                 // asked for later ("Connect Instagram"): the card
    }
    if (id === 'j-score') { presentSection('j-score'); H.scoreShown = true; return true; }
    if (id === 'j-bring') { say('invite'); presentSection('j-bring'); return true; }
    presentSection(id);
    return true;
  }
  const hosting = (id) => H.on && H.cards.has(id);

  function open() {
    H.on = true;
    env.show('j-mila');
  }
  /** Leave the conversation: every card back to its own screen. */
  function stop() {
    if (!H.on) return;
    H.on = false;
    clearTimeout(H.poll);
    restoreAll();
    thread().innerHTML = '';
    H.said.clear(); H.research = false; H.scoreShown = false;
  }
  /** Mila could not answer: today's screens for the rest of this visit (never a loop back into a failing host). */
  function fallBack() { H.failed = true; stop(); env.route(); }

  /**
   * Called by route() once she is signed in and not yet let in. True when Mila is hosting (the route stops there).
   * Off (server flag, an error, the skip remembered on this device) ⇒ false and today's screens carry on.
   */
  async function maybeStart(me) {
    if (H.on) return true;
    if (H.failed) return false;
    const uid = S.user && S.user.uid;
    try { if (localStorage.getItem(skipKey(uid)) === '1') return false; } catch {}
    let enabled = false;
    try { const r = await env.api('/api/v1/waitlist/mila'); enabled = r.ok && (await env.readJson(r)).enabled === true; } catch {}
    if (!enabled) return false;
    open();
    if (!me || !me.sport) { say('hello'); env.openSport(); return true; }
    await env.loadProgress();
    const p = S.progress;
    // Back to a conversation already under way: Mila picks up from where her research is, under her words the cards.
    H.research = true;
    H.said.add(resumeMoment(p));
    if (p && p.quickScore) H.said.add('score_quick');
    if (p && Array.isArray(p.handles) && p.handles.some((h) => h && h.status === 'suggested')) H.said.add('handles_found');
    turn({ moment: resumeMoment(p) });
    presentResearch();
    env.paintWait();
    if (p && Array.isArray(p.handles) && p.handles.length) presentHandles();
    if (p && (p.score || p.quickScore)) { await env.openScore(); if (p.score) H.said.add('score_quick'); }
    tick();
    return true;
  }

  // ─── the composer and the skip ─────────────────────────────────────────────────────────────
  function bind() {
    const form = $('j-mila-form'), input = $('j-mila-in');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = (input.value || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
      if (!text || !H.on) return;
      input.value = '';
      bubble('ub', text);
      turn({ message: text });
    });
    $('j-mila-skip').addEventListener('click', () => {
      // "Show me my score" means past the connect step too: today's route() then opens the wait or the score.
      try { const uid = S.user && S.user.uid; localStorage.setItem(skipKey(uid), '1'); localStorage.setItem(`nomila.join.connect.${uid || ''}`, '1'); } catch {}
      fallBack();
    });
  }
  bind();

  return { maybeStart, present, hosting, stop, get on() { return H.on; } };
}
