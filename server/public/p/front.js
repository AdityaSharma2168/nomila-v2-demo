/* front.js — the public athlete page's card enhancements (/p/:handle). First-party, no dependencies, CSP script-src 'self'.
 *
 * The page works without this file: the cards are a native scroll-snap row and every tile is a link. This adds:
 *   - the chapter status line, dots and the name in the top bar as the cards move;
 *   - arrow buttons (desktop) and Left/Right keys on the card row;
 *   - Story tiles scroll the row to their chapter instead of jumping the page;
 *   - card videos play only while visible and only when reduced motion is off.
 * It exposes window.NomilaCard.goTo(chapterAnchorId) for the Mila widget (mila.js).
 */
(function () {
  "use strict";
  let track = document.getElementById("pc-track");
  if (!track) return;
  let hero = track.closest(".pc-hero");
  let cards = Array.prototype.slice.call(track.querySelectorAll(".pc-card"));
  let status = document.getElementById("pc-chap");
  let dots = hero ? Array.prototype.slice.call(hero.querySelectorAll(".pc-dots i")) : [];
  let prev = hero && hero.querySelector(".pc-arrow--prev");
  let next = hero && hero.querySelector(".pc-arrow--next");
  let reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  let current = 0;

  document.documentElement.classList.add("js");
  if (prev) prev.hidden = false;
  if (next) next.hidden = false;

  function indexNow() {
    let best = 0, bestDist = Infinity, left = track.scrollLeft;
    for (let i = 0; i < cards.length; i++) {
      let d = Math.abs(cards[i].offsetLeft - track.offsetLeft - left);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  function update() {
    let i = indexNow();
    if (i === current && status && status.getAttribute("data-init")) return;
    current = i;
    if (status) {
      status.setAttribute("data-init", "1");
      status.textContent = (cards[i].getAttribute("data-title") || "") + " · " + (i + 1) + " of " + cards.length;
    }
    dots.forEach(function (d, j) { d.classList.toggle("on", j === i); });
    if (hero) hero.classList.toggle("is-swiped", i > 0);
    if (prev) prev.disabled = i === 0;
    if (next) next.disabled = i === cards.length - 1;
    cards.forEach(function (c, j) { c.setAttribute("aria-current", j === i ? "true" : "false"); });
  }

  function goToIndex(i, focus) {
    i = Math.max(0, Math.min(cards.length - 1, i));
    let smooth = !(reduce && reduce.matches);
    track.scrollTo({ left: cards[i].offsetLeft - track.offsetLeft, behavior: smooth ? "smooth" : "auto" });
    if (focus) cards[i].focus({ preventScroll: true });
  }

  // Throttled with a timer, not rAF, so the status stays right even when frames are not being drawn.
  let pending = 0;
  track.addEventListener("scroll", function () {
    if (pending) return;
    pending = window.setTimeout(function () { pending = 0; update(); }, 60);
  }, { passive: true });
  track.addEventListener("scrollend", update);

  if (prev) prev.addEventListener("click", function () { goToIndex(current - 1); });
  if (next) next.addEventListener("click", function () { goToIndex(current + 1); });
  track.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") { e.preventDefault(); goToIndex(current + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); goToIndex(current - 1); }
    else if (e.key === "Home") { e.preventDefault(); goToIndex(0); }
    else if (e.key === "End") { e.preventDefault(); goToIndex(cards.length - 1); }
  });

  /** Scroll the row to a chapter by its anchor id ("ch-story"). Returns false when there is no such card. */
  function goTo(anchorId, opts) {
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].id === anchorId) {
        if (cards[i].tabIndex < 0) cards[i].tabIndex = -1;
        if (hero && hero.getBoundingClientRect().top < 0) hero.scrollIntoView({ block: "start" });
        goToIndex(i, !(opts && opts.noFocus));
        return true;
      }
    }
    return false;
  }
  cards.forEach(function (c) { c.tabIndex = -1; });

  // Story tiles (and any in-page chapter link) move the row instead of jumping the page.
  document.addEventListener("click", function (e) {
    let a = e.target.closest && e.target.closest('a[href^="#ch-"]');
    if (!a) return;
    if (goTo(a.getAttribute("href").slice(1))) e.preventDefault();
  });

  // Card videos: play only while on screen, never under reduced motion, pause when the tab is hidden.
  let vids = Array.prototype.slice.call(track.querySelectorAll("video"));
  if (vids.length && "IntersectionObserver" in window) {
    let io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        let v = en.target;
        if (en.isIntersecting && !(reduce && reduce.matches) && document.visibilityState === "visible") {
          let p = v.play(); if (p && p.catch) p.catch(function () {});
        } else { v.pause(); }
      });
    }, { root: track, threshold: 0.6 });
    vids.forEach(function (v) { io.observe(v); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState !== "visible") vids.forEach(function (v) { v.pause(); }); });
  }

  // Open on a chapter when the URL names one (#ch-…), e.g. from a door page's chapter link.
  if (location.hash && location.hash.indexOf("#ch-") === 0) goTo(location.hash.slice(1), { noFocus: true });
  update();

  window.NomilaCard = { goTo: goTo };
})();

/* The visitor's heart (the Front Door top bar): one like per visitor, tap again to take it back, never a count.
 * The visitor is a random token this page keeps in its own storage (no cookie, no account); the server stores only a
 * keyed hash of it. POST {endpoint} as JSON with X-Nomila-Like: 1 (the same CSRF rule as the page's other POSTs).
 * Without storage the heart still toggles for this visit, and nothing is sent. */
(function () {
  "use strict";
  let btn = document.getElementById("pc-like");
  if (!btn) return;
  let handle = btn.getAttribute("data-handle") || "";
  let endpoint = btn.getAttribute("data-endpoint");
  function store(key, val) {
    try {
      if (val === undefined) return window.localStorage.getItem(key);
      if (val === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, val);
    } catch (e) { /* private mode or blocked storage: this visit only */ }
    return null;
  }
  function visitorToken() {
    let t = store("nomila.visitor");
    if (t && /^[A-Za-z0-9_-]{16,64}$/.test(t)) return t;
    let bytes = new Uint8Array(16);
    if (!(window.crypto && window.crypto.getRandomValues)) return null;
    window.crypto.getRandomValues(bytes);
    t = btoa(String.fromCharCode.apply(null, Array.prototype.slice.call(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    store("nomila.visitor", t);
    return store("nomila.visitor") === t ? t : null;
  }
  let likedKey = "nomila.liked." + handle;
  function show(on) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-label", on ? "You like this page" : "Like this page");
  }
  show(store(likedKey) === "1");
  btn.hidden = false;
  let busy = false;
  btn.addEventListener("click", function () {
    if (busy) return;
    let next = btn.getAttribute("aria-pressed") !== "true";
    show(next);
    let token = visitorToken();
    if (!endpoint || !token) return;
    busy = true;
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Nomila-Like": "1" },
      body: JSON.stringify({ visitor: token, liked: next }),
      credentials: "omit",
    }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      store(likedKey, next ? "1" : null);
    }).catch(function () {
      show(!next); // it did not go through: put the heart back as it was
    }).then(function () { busy = false; });
  });
})();
