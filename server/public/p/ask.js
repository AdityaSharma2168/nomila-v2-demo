/* ask.js — public Mila mode's transport for the Mila sheet on /p/:handle (PR 5). First-party, no dependencies, CSP
 * script-src 'self' and connect-src 'self'.
 *
 * Loaded ONLY when ASK_MILA_PUBLIC is on and her published card has Ask Mila on (render.ts askMilaOn). It plugs into
 * mila.js through window.NomilaMila.setTransport, which is what opens the free-text box and "Ask Mila about this".
 *
 *   send(request)  POST <endpoint> { text, intent, sessionId, token, pinnedPickId, tz } → { text, chapterId, widget }
 *   act(tap)       the visitor's OWN tap on a prepared card: POST <endpoint>/booking or /partner → { nextUrl }
 *   taps           which taps exist (each only when its track is wired on the server)
 *
 * Same-origin JSON with the X-Nomila-Ask header and no credentials (the server refuses anything else). The chat's id
 * and token live in this page's memory only: nothing is stored in the browser, and closing the tab ends the chat.
 */
(function () {
  "use strict";
  const dataEl = document.getElementById("pc-data");
  if (!dataEl || !window.NomilaMila) return;
  let D;
  try { D = JSON.parse(dataEl.textContent || "{}"); } catch (_e) { return; }
  const ask = D.ask;
  if (!ask || typeof ask.endpoint !== "string" || ask.endpoint.charAt(0) !== "/" || ask.endpoint.charAt(1) === "/") return;

  let session = null; // { id, token }
  let tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_e) { tz = null; }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Nomila-Ask": "1" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j || {} }; });
    });
  }

  const INTENTS = { ask: 1, partner: 1, book: 1, shop: 1 };

  window.NomilaMila.setTransport({
    taps: { booking: !!ask.booking, partner: !!ask.partner },
    send: function (req) {
      return post(ask.endpoint, {
        text: req.text,
        intent: INTENTS[req.intent] ? req.intent : "ask",
        sessionId: session ? session.id : null,
        token: session ? session.token : null,
        pinnedPickId: req.pinnedPickId || null,
        tz: tz,
      }).then(function (res) {
        if (res.status === 400 && typeof res.body.error === "string") return { text: res.body.error };
        if (!res.ok || !res.body.reply) throw new Error("ask failed");
        const b = res.body;
        if (b.ended) session = null;
        else if (typeof b.sessionId === "string" && typeof b.token === "string") session = { id: b.sessionId, token: b.token };
        return { text: b.reply.text, chapterId: b.reply.chapterId || null, widget: b.reply.widget || null };
      });
    },
    act: function (tap) {
      const which = tap && tap.kind === "booking" ? "booking" : tap && tap.kind === "partner" ? "partner" : null;
      // A booking always comes from a chat; a partner request-kind chip may be tapped before anything was typed.
      if (!which || !ask[which] || (which === "booking" && !session)) return Promise.reject(new Error("not available"));
      const body = session ? { sessionId: session.id, token: session.token } : {};
      Object.keys(tap.body || {}).forEach(function (k) { body[k] = tap.body[k]; });
      return post(ask.endpoint + "/" + which, body).then(function (res) {
        const next = res.body && res.body.nextUrl;
        if (!res.ok || typeof next !== "string" || next.charAt(0) !== "/" || next.charAt(1) === "/") throw new Error("refused");
        return { nextUrl: next };
      });
    },
  });
})();
