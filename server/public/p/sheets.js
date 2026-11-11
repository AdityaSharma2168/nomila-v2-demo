/*
 * sheets.js — the public page's doors open in a slide-up sheet (front door v2.1, engine page only).
 *
 * The no-script door pages (/p/:handle/partner · /book · /shop) stay the single source of each door: this file fetches
 * the door's own page and shows its content in the sheet, so a visitor without script (or a failed fetch) simply follows
 * the link to the same page. The Partner form posts through the sheet and shows the server's own answer (check your
 * email, or what to fix). Picks keep their paid /go/ links, which open the merchant in a new tab and count the click.
 * Served from 'self' under the page's strict CSP: no inline script or style anywhere.
 */
(function () {
  "use strict";
  var sheet = document.getElementById("fd-sheet");
  if (!sheet || !window.fetch || !window.DOMParser) return;
  var panel = sheet.querySelector(".fd-panel");
  var body = document.getElementById("fd-sheet-body");
  var title = document.getElementById("fd-sheet-title");
  var doors = document.querySelectorAll("a[data-sheet]");
  var DOOR_RE = /^\/p\/[^/]+\/(partner|book|shop)(?:[/?#]|$)/;
  var lastFocus = null;
  var openDoor = null;
  var pushed = false;

  function sameOriginDoor(href) {
    try {
      var u = new URL(href, location.href);
      return u.origin === location.origin && DOOR_RE.test(u.pathname) ? u : null;
    } catch (e) { return null; }
  }
  function doorOf(u) { var m = DOOR_RE.exec(u.pathname); return m ? m[1] : null; }

  function show(html) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var main = doc.querySelector("main.pc-door") || doc.querySelector("main") || doc.body;
    var h1 = main.querySelector("h1");
    title.textContent = h1 ? h1.textContent : "";
    if (h1) h1.parentNode.removeChild(h1);
    var drop = main.querySelectorAll(".pc-back, script, style, link");
    for (var i = 0; i < drop.length; i++) drop[i].parentNode.removeChild(drop[i]);
    body.textContent = "";
    while (main.firstChild) body.appendChild(document.adoptNode(main.firstChild));
    body.scrollTop = 0;
    // The Book door turns its list into the request flow (book.js), all inside this sheet.
    if (window.NomilaBook && body.querySelector("[data-book]")) window.NomilaBook.mount(body);
    var first = body.querySelector("input:not([type=hidden]):not([tabindex='-1']),textarea,select,a[href],button:not([disabled])");
    (first || panel).focus({ preventScroll: true });
  }

  function load(url, init) {
    body.innerHTML = '<p class="fd-sheet-load">Loading…</p>';
    return fetch(url.href || url, Object.assign({ credentials: "same-origin", headers: { Accept: "text/html" } }, init || {}))
      .then(function (r) {
        var type = r.headers.get("content-type") || "";
        if (type.indexOf("text/html") === -1) throw new Error("not html");
        return r.text();
      })
      .then(show)
      .catch(function () { location.href = url.href || url; });
  }

  function open(u) {
    var door = doorOf(u);
    if (!door) return;
    lastFocus = document.activeElement;
    openDoor = door;
    sheet.hidden = false;
    sheet.classList.add("opening");
    document.body.classList.add("fd-locked");
    requestAnimationFrame(function () { requestAnimationFrame(function () { sheet.classList.remove("opening"); }); });
    if (location.hash !== "#" + door) { history.pushState({ fdSheet: door }, "", "#" + door); pushed = true; }
    load(u);
  }

  function hide() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    panel.style.transform = "";
    document.body.classList.remove("fd-locked");
    body.textContent = "";
    openDoor = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  function close() {
    if (pushed && history.state && history.state.fdSheet) { pushed = false; history.back(); return; }
    if (openDoor && location.hash === "#" + openDoor) history.replaceState(null, "", location.pathname + location.search);
    hide();
  }

  for (var d = 0; d < doors.length; d++) {
    doors[d].addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button > 0) return;
      var u = sameOriginDoor(this.getAttribute("href"));
      if (!u) return;
      e.preventDefault();
      open(u);
    });
  }

  sheet.addEventListener("click", function (e) {
    if (e.target.closest("[data-close]")) { e.preventDefault(); close(); return; }
    var a = e.target.closest("a[href]");
    if (!a || !body.contains(a) || a.target === "_blank") return;
    var u = sameOriginDoor(a.getAttribute("href"));
    if (u) { e.preventDefault(); load(u); }
  });

  body.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var u = sameOriginDoor(form.getAttribute("action") || location.href);
    if (!u || (form.method || "get").toLowerCase() !== "post") return;
    e.preventDefault();
    var btn = form.querySelector("[type=submit]");
    if (btn) btn.disabled = true;
    load(u, { method: "POST", body: new URLSearchParams(new FormData(form)) });
  });

  document.addEventListener("keydown", function (e) {
    if (sheet.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    var f = panel.querySelectorAll("a[href],button:not([disabled]),input:not([type=hidden]):not([tabindex='-1']),textarea,select,[tabindex='0']");
    if (!f.length) return;
    var firstEl = f[0], lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  });

  window.addEventListener("popstate", function () { pushed = false; hide(); });

  // Swipe down on the grab bar or the header to close.
  var startY = null;
  function grabStart(e) { startY = e.clientY; }
  function grabMove(e) {
    if (startY === null) return;
    var dy = Math.max(0, e.clientY - startY);
    panel.style.transform = "translateY(" + dy + "px)";
  }
  function grabEnd(e) {
    if (startY === null) return;
    var dy = e.clientY - startY;
    startY = null;
    if (dy > 90) close(); else panel.style.transform = "";
  }
  var grips = sheet.querySelectorAll("[data-grab], .fd-sheet-head");
  for (var g = 0; g < grips.length; g++) {
    grips[g].addEventListener("pointerdown", grabStart);
  }
  window.addEventListener("pointermove", grabMove);
  window.addEventListener("pointerup", grabEnd);
  window.addEventListener("pointercancel", grabEnd);

  // A shared link to a door (/p/handle#partner) opens on that door.
  var h = location.hash.slice(1);
  if (h === "partner" || h === "book" || h === "shop") {
    for (var k = 0; k < doors.length; k++) {
      if (doors[k].getAttribute("data-door") === h) {
        var u0 = sameOriginDoor(doors[k].getAttribute("href"));
        if (u0) { history.replaceState({ fdSheet: h }, "", location.href); pushed = false; open(u0); }
        break;
      }
    }
  }
})();
