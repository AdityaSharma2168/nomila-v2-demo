/* mila.js — the Mila web widget on the public athlete page (/p/:handle). First-party, no dependencies, CSP script-src 'self'.
 *
 * Tapping a tile opens a sheet with that door's intent and its FIRST WIDGET, rendered from the page's published data
 * (the inert JSON block #pc-data). Tapping Mila at the centre opens Ask. No model call happens here.
 *
 *   ask     greeting + fixed question chips (templates for chapters she published). A chip answers with that chapter's
 *           own published text and a "See the card" button; door chips switch intent.
 *   partner "What kind of request?" chips. The request flow needs the intake backend, so those kinds are shown in a
 *           visible "opens soon" state; "Something else" switches to Ask.
 *   book    her offers with all-in prices (display only; booking opens with the bookings PR).
 *   shop    the full-width grid of her picks → product card → "Buy on [Merchant]" through /go/:code (Paid link).
 *   create  a one-line "coming soon" sheet. follow: her linked profiles.
 *
 * The model connection (public Mila mode, PR 5) plugs in by setting
 *   window.NomilaMila.setTransport({ send(request) → Promise<reply>, act?(tap) → Promise<{ nextUrl }>, taps? })
 * where request = { handle, version, intent, text, history: [{ role: "visitor"|"mila", text }], pinnedPickId } and
 * reply = { text, chapterId?, widget? }. ask.js sets it (only while ASK_MILA_PUBLIC is on); until then the text box is
 * disabled with a visible "not yet" line. A reply's widget is a card from her published data: pick tiles, her
 * published times, or a prepared request. A request card sends NOTHING until the visitor taps its button, and the
 * button exists only when the transport says that tap is wired (taps.booking / taps.partner): no dead taps.
 *
 * Every value is set with textContent / attributes; nothing from data is ever parsed as HTML.
 */
(function () {
  "use strict";
  const dataEl = document.getElementById("pc-data");
  if (!dataEl) return;
  let D;
  try { D = JSON.parse(dataEl.textContent || "{}"); } catch (_e) { return; }
  const first = D.first || "";
  const reduce = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const doors = D.doors || [];
  // sheet state (declared before anything reads it)
  let transport = null;
  let sheetOpen = false;
  let opener = null;
  let intent = null;
  let history = [];
  let pinned = null;

  // ── tiny DOM helper ────────────────────────────────────────────────────────
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  // ── the avatar: muted inline loop, swapped by state, still under reduced motion, paused when hidden ──────────
  const STATE_SRC = { idle: D.mila.idle, searching: D.mila.searching || D.mila.idle, generating: D.mila.generating || D.mila.idle, writing: D.mila.writing || D.mila.idle };
  const STATE_LABEL = { idle: "Mila", searching: "Mila is searching", generating: "Mila is writing a reply", writing: "Mila is writing" };
  const avatars = []; // { video, wantPlay() }

  function canPlay() { return !reduce.matches && document.visibilityState === "visible"; }
  function sync(a) {
    if (a.wantPlay() && canPlay()) { const p = a.video.play(); if (p && p.catch) p.catch(function () {}); }
    else a.video.pause();
  }
  function syncAll() { avatars.forEach(sync); }
  function registerAvatar(video, wantPlay) {
    const a = { video: video, wantPlay: wantPlay, state: "idle" };
    avatars.push(a);
    sync(a);
    return a;
  }
  function setState(a, state) {
    if (!STATE_SRC[state] || a.state === state) return;
    a.state = state;
    a.video.setAttribute("src", STATE_SRC[state]); // a clean cut to the new loop, as in the app
    a.video.setAttribute("aria-label", STATE_LABEL[state]);
    sync(a);
  }
  document.addEventListener("visibilitychange", syncAll);
  if (reduce.addEventListener) reduce.addEventListener("change", syncAll);

  // the page's centre avatar plays while no sheet covers it
  const centre = document.querySelector(".pc-mila-v");
  if (centre) registerAvatar(centre, function () { return !sheetOpen; });

  // ── the sheet ──────────────────────────────────────────────────────────────

  const head = el("div", { class: "ml-head" });
  const log = el("div", { class: "ml-log", role: "log", "aria-live": "polite", "aria-relevant": "additions", tabindex: "-1" });
  const foot = el("div", { class: "ml-foot" });
  const panel = el("div", { class: "ml-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "ml-title" }, [head, log, foot]);
  const scrim = el("div", { class: "ml-scrim", onclick: close });
  const root = el("div", { class: "ml", hidden: true }, [scrim, panel]);
  document.body.appendChild(root);

  const sheetVideo = el("video", { class: "ml-av", poster: D.mila.poster, src: D.mila.idle, muted: true, loop: true, playsinline: true, preload: "metadata", "aria-label": "Mila" });
  sheetVideo.muted = true;
  const sheetAvatar = registerAvatar(sheetVideo, function () { return sheetOpen; });

  const TITLES = {
    ask: ["Ask Mila", "Nomila's assistant · answers from what " + first + " published"],
    partner: ["Partner", "Work with " + first + " · Mila helps"],
    book: ["Book", "Book time with " + first + " · all-in prices"],
    shop: ["Shop", first + "'s picks · paid links"],
    create: ["Create", ""],
    follow: ["Follow " + first, first + "'s linked profiles"],
  };

  function renderHead() {
    head.textContent = "";
    const t = TITLES[intent] || TITLES.ask;
    head.appendChild(el("button", { type: "button", class: "ml-back", onclick: close, "aria-label": "Back to the profile" }, [el("span", { "aria-hidden": "true", text: "‹ " }), "Profile"]));
    head.appendChild(el("div", { class: "ml-ttl" }, [el("h2", { id: "ml-title", text: t[0] }), t[1] ? el("p", { text: t[1] }) : null]));
    head.appendChild(sheetVideo);
  }

  function notYet(text) { return el("p", { class: "ml-notyet", text: text }); }

  function renderFoot() {
    foot.textContent = "";
    if (intent === "create" || intent === "follow") {
      foot.appendChild(el("button", { type: "button", class: "ml-btn ml-btn--wide", onclick: close, text: "Close" }));
      return;
    }
    const input = el("input", { class: "ml-input", type: "text", maxlength: "300", "aria-label": "Message Mila", autocomplete: "off" });
    const send = el("button", { type: "submit", class: "ml-send", text: "Send" });
    const form = el("form", { class: "ml-compose", onsubmit: function (e) { e.preventDefault(); typed(input); } }, [input, send]);
    if (!transport) {
      input.disabled = true;
      send.disabled = true;
      input.setAttribute("placeholder", "Typed questions open soon");
      input.setAttribute("aria-describedby", "ml-compose-note");
      foot.appendChild(form);
      foot.appendChild(el("p", { class: "ml-notyet", id: "ml-compose-note", text: "Typing to Mila opens soon. Tap a question or an option above." }));
    } else {
      input.setAttribute("placeholder", intent === "shop" ? "Ask Mila about this…" : "Message Mila…");
      foot.appendChild(form);
    }
  }

  // ── messages ────────────────────────────────────────────────────────────
  function add(node) { log.appendChild(node); log.scrollTop = log.scrollHeight; return node; }
  function says(who, text, extra) {
    history.push({ role: who, text: text });
    return add(el("div", { class: "ml-msg ml-msg--" + who }, [el("span", { class: "ml-sr", text: who === "mila" ? "Mila: " : "You: " }), el("p", { text: text })].concat(extra || [])));
  }
  function widget(kind, label, node) { return add(el("section", { class: "ml-w ml-w--" + kind, "aria-label": label }, [node])); }

  function chapter(id) { return (D.chapters || []).filter(function (c) { return c.id === id; })[0]; }

  function seeCard(c) {
    return el("button", { type: "button", class: "ml-btn", text: "See the " + c.title + " card", onclick: function () {
      close();
      if (window.NomilaCard) window.NomilaCard.goTo("ch-" + c.id);
    } });
  }

  // A fixed chip answers from the chapter's own published text. No model, no paraphrase.
  function answerChip(chip) {
    says("visitor", chip.label);
    const c = chapter(chip.chapterId);
    if (!c) return;
    const text = c.body || c.headline;
    says("mila", text, [el("small", { class: "ml-cite", text: "From " + first + "'s " + c.title + " card" + (c.source ? " · " + c.source : "") }), seeCard(c)]);
  }

  // ── first widgets (the registry) ─────────────────────────────────────────
  const DOOR_CHIPS = [["partner", "Partner"], ["book", "Book"], ["shop", "Shop"]];
  const WIDGETS = {
    ask: function () {
      says("mila", "Hi, I'm Mila, Nomila's assistant. Ask me anything about " + first + ", or pick a question.");
      const chips = el("div", { class: "ml-chips" });
      (D.askChips || []).forEach(function (q) {
        chips.appendChild(el("button", { type: "button", class: "ml-chip", text: q.label, onclick: function () { answerChip(q); } }));
      });
      if (doors.indexOf("partner") >= 0) chips.appendChild(el("button", { type: "button", class: "ml-chip", text: "Press or interview request", onclick: function () { switchTo("partner"); } }));
      widget("questions", "Suggested questions", chips);
      const go = el("div", { class: "ml-chips ml-chips--doors" });
      DOOR_CHIPS.forEach(function (d) {
        if (doors.indexOf(d[0]) >= 0) go.appendChild(el("button", { type: "button", class: "ml-chip ml-chip--door", text: d[1], onclick: function () { switchTo(d[0]); } }));
      });
      if (go.childNodes.length) widget("doors", "Other ways to connect", go);
    },
    partner: function () {
      const list = el("div", { class: "ml-chips ml-chips--stack", role: "group", "aria-labelledby": "ml-kinds" });
      (D.partnerKinds || []).forEach(function (k) {
        if (k.id === "other") {
          list.appendChild(el("button", { type: "button", class: "ml-chip", text: k.label, onclick: function () { switchTo("ask"); } }));
        } else if (canTap("partner")) {
          // Public Mila mode with the intake wired: the chip IS the visitor's tap into the intake for that kind.
          list.appendChild(tapButton(k.label, "partner", { kind: k.id }));
        } else {
          // Not yet: the request flow needs the intake backend (PR 6). Shown disabled, marked Soon, with the note below.
          list.appendChild(el("button", { type: "button", class: "ml-chip ml-chip--soon", disabled: true, "aria-describedby": "ml-partner-note" }, [k.label, el("span", { class: "ml-soon", text: "Soon" })]));
        }
      });
      widget("kinds", "What kind of request?", el("div", null, [el("h3", { class: "ml-step", id: "ml-kinds", text: "What kind of request?" }), list]));
      if (!canTap("partner")) add(el("p", { class: "ml-notyet", id: "ml-partner-note", text: "Requests to " + first + " open soon. Nothing can be sent yet." }));
    },
    book: function () {
      const offers = D.offers || [];
      const bookPath = typeof D.bookPath === "string" && D.bookPath.charAt(0) === "/" ? D.bookPath : null;
      if (!offers.length && !bookPath) { says("mila", first + " has no sessions open right now."); return; }
      const list = el("ul", { class: "ml-offers" });
      offers.forEach(function (o) {
        list.appendChild(el("li", { class: "ml-offer" }, [
          el("span", null, [el("b", { text: o.title }), el("small", { text: o.durationMin + " min · " + (o.format === "virtual" ? "Virtual" : "In person") + (o.note ? " · " + o.note : "") })]),
          el("span", { class: "ml-price", text: o.price }),
        ]));
      });
      if (offers.length) widget("offers", "Sessions and all-in prices", el("div", null, [el("h3", { class: "ml-step", text: "Sessions · all-in prices" }), list]));
      if (bookPath) {
        // Booking is on: the Book door page is the request flow, with her sessions and open times as they are now.
        add(el("a", { class: "ml-btn ml-btn--ink ml-btn--wide", href: bookPath, "data-ml-book": "1", text: "Pick a time" }));
        add(el("p", { class: "ml-fine", text: "Nothing is charged until " + first + " accepts." }));
        return;
      }
      add(notYet("Booking requests open soon. You can't pick a time yet."));
    },
    shop: function () {
      const picks = D.picks || [];
      if (!picks.length) { says("mila", first + " has no picks yet."); return; }
      const detail = el("div", { class: "ml-product", hidden: true, tabindex: "-1" });
      const grid = el("ul", { class: "ml-grid" });
      picks.forEach(function (p) {
        const tile = el("button", { type: "button", class: "ml-tile", "aria-label": p.title + ", " + p.merchant + ". Paid link.", onclick: function () {
          Array.prototype.forEach.call(grid.querySelectorAll(".ml-tile"), function (t) { t.setAttribute("aria-pressed", "false"); });
          tile.setAttribute("aria-pressed", "true");
          showProduct(detail, p);
        } }, [
          p.image && p.image.src ? el("img", { src: p.image.src, alt: "", loading: "lazy" }) : el("span", { class: "ml-tile-ph", "aria-hidden": "true" }),
          el("span", { class: "ml-paid", text: "Paid link" }),
          el("span", { class: "ml-tile-t", text: p.title }),
        ]);
        tile.setAttribute("aria-pressed", "false");
        grid.appendChild(el("li", null, [tile]));
      });
      const wrap = el("div", null, [el("p", { class: "ml-disc", text: "Paid links. " + first + " may earn a commission if you buy." }), grid, detail]);
      if (picks.some(function (p) { return p.amazon; })) wrap.appendChild(el("p", { class: "ml-fine", text: "As an Amazon Associate " + first + " earns from qualifying purchases." }));
      widget("picks", first + "'s picks", wrap);
    },
    create: function () {
      add(el("p", { class: "ml-one", text: "Create with " + first + " is coming soon" }));
    },
    follow: function () {
      const list = el("ul", { class: "ml-socials" });
      (D.socials || []).forEach(function (s) {
        list.appendChild(el("li", null, [el("a", { href: s.url, target: "_blank", rel: "noopener noreferrer me", class: "ml-social" }, [el("b", { text: s.network }), el("small", { text: "@" + s.handle })])]));
      });
      widget("socials", first + "'s linked profiles", list);
    },
  };

  function showProduct(detail, p) {
    detail.textContent = "";
    detail.hidden = false;
    detail.appendChild(el("span", { class: "ml-paid", text: "Paid link" }));
    detail.appendChild(el("b", { class: "ml-product-t", text: p.title }));
    detail.appendChild(el("small", { text: p.merchant + (p.price ? " · " + p.price : "") }));
    if (p.herWords) detail.appendChild(el("q", { text: p.herWords }));
    detail.appendChild(el("a", { class: "ml-btn ml-btn--ink", href: p.href, target: "_blank", rel: "noopener noreferrer sponsored", text: "Buy on " + p.merchant + " ↗" }));
    if (!transport) detail.appendChild(el("button", { type: "button", class: "ml-link ml-link--soon", disabled: true, text: "Ask Mila about this · soon" }));
    else detail.appendChild(el("button", { type: "button", class: "ml-link", text: "Ask Mila about this", onclick: function () { pinned = p; foot.querySelector("input") && foot.querySelector("input").focus(); } }));
    detail.focus({ preventScroll: true });
    detail.scrollIntoView({ block: "nearest", behavior: reduce.matches ? "auto" : "smooth" });
  }

  // ── reply cards (public Mila mode): built from her published data, never from the model's prose ─────────
  function pick(id) { return (D.picks || []).filter(function (p) { return p.id === id; })[0]; }
  function canTap(kind) { return !!(transport && transport.act && transport.taps && transport.taps[kind]); }
  function whenLabel(iso) {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  // The visitor's own tap: one request, then a link to continue on this site. Disabled while in flight and after.
  function tapButton(label, kind, body) {
    const b = el("button", { type: "button", class: "ml-btn ml-btn--ink", text: label });
    b.addEventListener("click", function () {
      b.disabled = true;
      Promise.resolve()
        .then(function () { return transport.act({ kind: kind, body: body }); })
        .then(function (r) {
          says("mila", kind === "booking" ? "Your request is ready. Continue to confirm it; nothing is sent to " + first + " before then." : "Your request is started. Continue to fill it in.", [
            el("a", { class: "ml-btn ml-btn--ink", href: r.nextUrl, text: "Continue" }),
          ]);
        })
        .catch(function () {
          b.disabled = false;
          says("mila", "That couldn't be started. The options above still work.");
        });
    });
    return b;
  }
  function replyCard(w) {
    if (!w || typeof w !== "object") return null;
    if (w.type === "picks") {
      const list = el("ul", { class: "ml-picked" });
      (w.ids || []).map(pick).filter(Boolean).forEach(function (p) {
        list.appendChild(el("li", { class: "ml-product" }, [
          el("span", { class: "ml-paid", text: "Paid link" }),
          el("b", { class: "ml-product-t", text: p.title }),
          el("small", { text: p.merchant + (p.price ? " · " + p.price : "") }),
          p.herWords ? el("q", { text: p.herWords }) : null,
          el("a", { class: "ml-btn ml-btn--ink", href: p.href, target: "_blank", rel: "noopener noreferrer sponsored", text: "Buy on " + p.merchant + " ↗" }),
        ]));
      });
      return list.childNodes.length ? el("section", { class: "ml-w ml-w--picks", "aria-label": first + "'s picks" }, [list]) : null;
    }
    if (w.type === "slots") {
      const times = el("ul", { class: "ml-chips ml-chips--stack" });
      (w.slots || []).forEach(function (s) {
        const label = whenLabel(s.startsAt) || s.label;
        times.appendChild(el("li", null, [canTap("booking")
          ? tapButton("Request " + label, "booking", { offerId: w.offerId, slotId: s.id })
          : el("span", { class: "ml-chip", text: label })]));
      });
      return el("section", { class: "ml-w ml-w--slots", "aria-label": "Published times for " + w.offerTitle }, [el("h3", { class: "ml-step", text: w.offerTitle + " · published times" }), times]);
    }
    if (w.type === "booking_request") {
      if (!canTap("booking")) return null;
      const when = w.slotId ? (w.slotLabel || "") : (w.times || []).map(whenLabel).join(" · ");
      return el("section", { class: "ml-w ml-w--request", "aria-label": "Booking request" }, [
        el("b", { text: w.offerTitle + (w.price ? " · " + w.price : "") }),
        when ? el("small", { text: when }) : null,
        w.note ? el("q", { text: w.note }) : null,
        tapButton(w.slotId ? "Request this time" : "Send these times", "booking", w.slotId ? { offerId: w.offerId, slotId: w.slotId, note: w.note } : { offerId: w.offerId, times: w.times, note: w.note }),
      ]);
    }
    if (w.type === "partner_request") {
      if (!canTap("partner")) return null;
      return el("section", { class: "ml-w ml-w--request", "aria-label": "Request to work with " + first }, [
        el("b", { text: w.label }),
        tapButton("Start this request", "partner", { kind: w.kind }),
      ]);
    }
    return null;
  }

  // ── typing (only with a transport: the public Mila mode PR) ──────────────
  function typed(input) {
    const text = (input.value || "").trim().slice(0, 300);
    if (!text || !transport) return;
    input.value = "";
    says("visitor", text);
    setState(sheetAvatar, "searching");
    const req = { handle: D.handle, version: D.version, intent: intent, text: text, history: history.slice(-20), pinnedPickId: pinned ? pinned.id : null };
    Promise.resolve()
      .then(function () { return transport.send(req); })
      .then(function (reply) {
        const c = reply && reply.chapterId ? chapter(reply.chapterId) : null;
        says("mila", (reply && reply.text) || "That's not on " + first + "'s card.", c ? [el("small", { class: "ml-cite", text: "From " + first + "'s " + c.title + " card" }), seeCard(c)] : []);
        const card = replyCard(reply && reply.widget);
        if (card) add(card);
      })
      .catch(function () { says("mila", "Mila can't answer right now. The options above still work."); })
      .then(function () { setState(sheetAvatar, "idle"); });
  }

  // ── open / close / switch ───────────────────────────────────────────────
  function renderIntent(next) {
    intent = WIDGETS[next] ? next : "ask";
    history = [];
    pinned = null;
    root.setAttribute("data-intent", intent);
    log.textContent = "";
    renderHead();
    WIDGETS[intent]();
    renderFoot();
  }
  function switchTo(next) { renderIntent(next); focusFirst(); }

  function focusables() {
    return Array.prototype.filter.call(panel.querySelectorAll("button, a[href], input, [tabindex]:not([tabindex='-1'])"), function (n) { return !n.disabled && n.offsetParent !== null; });
  }
  function focusFirst() { const f = focusables(); (f[1] || f[0] || panel).focus(); }

  function setInert(on) {
    Array.prototype.forEach.call(document.querySelectorAll("main.pc, footer.pc-foot, .pc-skip"), function (n) {
      if (on) n.setAttribute("inert", ""); else n.removeAttribute("inert");
    });
  }

  function open(next, from) {
    opener = from || document.activeElement;
    renderIntent(next);
    root.hidden = false;
    sheetOpen = true;
    document.documentElement.classList.add("ml-open");
    setInert(true);
    syncAll();
    track("open", intent);
    focusFirst();
  }
  function close() {
    if (!sheetOpen) return;
    sheetOpen = false;
    root.hidden = true;
    document.documentElement.classList.remove("ml-open");
    setInert(false);
    setState(sheetAvatar, "idle");
    syncAll();
    if (opener && opener.focus) opener.focus();
  }

  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  });

  // The doors: tiles and the centre avatar are links (the no-script path); with script they open the sheet.
  const SHEET = { partner: 1, book: 1, shop: 1, create: 1, ask: 1, follow: 1 };
  Array.prototype.forEach.call(document.querySelectorAll(".pc-grid [data-intent]"), function (a) {
    const it = a.getAttribute("data-intent");
    if (!SHEET[it]) return; // story tiles stay in-page links (front.js moves the cards)
    a.setAttribute("role", "button");
    a.setAttribute("aria-haspopup", "dialog");
    a.addEventListener("click", function (e) { e.preventDefault(); open(it, a); });
    a.addEventListener("keydown", function (e) { if (e.key === " ") { e.preventDefault(); open(it, a); } });
  });

  // Daily demand counters (design §12) are a later PR (public_card_days + POST /p/:handle/e). The hook is here.
  function track(/* event, detail */) {}

  window.NomilaMila = {
    open: open,
    close: close,
    /** The later public Mila mode plugs in here. Pass null to go back to "not yet". */
    setTransport: function (t) { transport = t && typeof t.send === "function" ? t : null; if (sheetOpen) renderFoot(); },
    /** True once a transport is set (typing is open). */
    hasTransport: function () { return !!transport; },
  };
})();
