/*
 * book.js — the Book door's request flow (Bookings PR2, "Bookings, end to end"). Everything happens inside the door's
 * sheet (or the door page itself, opened directly): pick a session → a time → your details → the email code → review
 * and place the card hold, which hands off to the payment page and comes back to the private booking page /b/:token.
 *
 * Progressive: the server renders the plain list ("Booking requests open soon"); this script turns a row into a flow
 * only when the bookings API answers for that offer (BOOKINGS_ENABLED + the athlete on the pilot list). Same origin
 * only (the page CSP's connect-src 'self'); every value is written with textContent; no inline styles (CSP).
 * The access key the email code returns is kept in sessionStorage for this tab, under the key the /b/ page reads.
 *
 * Group sessions (0153): her price is PER PERSON. An open group lists each time with "N of M spots left" (full times
 * are shown as Full, not bookable) and confirms the spot as soon as the card hold goes through. A private group asks
 * "How many people?" (1..max) and re-prices the all-in total live from the quote endpoint; that exact total is what the
 * request sends as displayed_total_cents (the server refuses a stale one with PRICE_CHANGED).
 */
(function () {
  "use strict";
  var API = "/api/v1/book";

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "on") { for (var e in attrs.on) n.addEventListener(e, attrs.on[e]); }
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? "" : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function money(c, cur) { return (c / 100).toLocaleString("en-US", { style: "currency", currency: (cur || "usd").toUpperCase() }); }
  function when(iso) { return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); }
  function zone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; } }
  function req(method, path, body, access) {
    var h = { accept: "application/json" };
    if (body !== undefined) h["content-type"] = "application/json";
    if (access) h["x-booking-access"] = access;
    return fetch(API + path, { method: method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "omit" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); })
      .catch(function () { return { __status: 0, error: "Check your connection and try again." }; });
  }
  var PROBLEM = {
    required: "Required.", too_soon: "Pick a time further ahead.", too_far: "Pick a time sooner.", bad_time: "Pick a time.",
    duplicate: "Pick different times.", too_many: "Up to three times.", "check your email address": "Check your email address.",
    "a mobile number": "Add a mobile number.", "pick one of the times": "Pick a time.",
  };
  function problemText(p) { return PROBLEM[p] || (typeof p === "string" ? p.charAt(0).toUpperCase() + p.slice(1) + "." : "Check this."); }
  function isGroup(o) { return o.audience === "private_group" || o.audience === "open_group"; }
  function people(n) { return n + (n === 1 ? " person" : " people"); }
  /** "Group · $X per person" for a group; the all-in price for a 1:1. */
  function priceLabel(o) { return isGroup(o) ? "Group · " + money(o.quote.buyerTotalCents, o.quote.currency) + " per person" : money(o.quote.buyerTotalCents, o.quote.currency); }
  function spotsLabel(left, cap) { return left + " of " + cap + " spot" + (cap === 1 ? "" : "s") + " left"; }

  function mount(root) {
    var box = root.querySelector("[data-book]");
    if (!box || box.getAttribute("data-book-live")) return;
    var rows = box.querySelectorAll("[data-offer]");
    var handle = box.getAttribute("data-book-handle");
    var offers = {};
    var live = false;
    // Her offers as they are NOW (the page is a snapshot; a session she published since shows here too). When that
    // read isn't answered (bookings off for her, an older page), each published row is checked on its own instead.
    if (handle) {
      req("GET", "/cards/" + encodeURIComponent(handle) + "/offers").then(function (r) {
        if (r.__status === 200 && Array.isArray(r.offers)) {
          live = true;
          r.offers.forEach(function (o) { if (o && o.publicId && o.available !== false) offers[o.publicId] = o; });
          return start();
        }
        byRow();
      });
    } else byRow();
    function byRow() {
      if (!rows.length) return;
      var pending = rows.length;
      rows.forEach(function (row) {
        var id = row.getAttribute("data-offer");
        req("GET", "/offers/" + encodeURIComponent(id)).then(function (r) {
          if (r.offer && r.offer.available !== false) offers[id] = r.offer;
          if (--pending === 0) start();
        });
      });
    }

    var st = {};
    function start() {
      var ids = Object.keys(offers);
      if (!ids.length) {
        // Live and nothing open: say so (the published list may still name a session she has since paused).
        if (live && rows.length) { box.setAttribute("data-book-live", "1"); screen("No sessions are open right now. Check back soon.", []); }
        return; // bookings aren't open for this athlete: the plain list stays
      }
      box.setAttribute("data-book-live", "1");
      if (ids.length === 1) { st.offer = offers[ids[0]]; return times(); }
      chooser();
    }
    function screen(lede, kids) {
      box.textContent = "";
      if (lede) box.appendChild(el("p", { "class": "pc-lede", text: lede }));
      kids.forEach(function (k) { if (k) box.appendChild(k); });
      var f = box.querySelector("input,textarea,button"); if (f) f.focus({ preventScroll: true });
      if (box.parentNode && box.parentNode.scrollTop !== undefined) box.parentNode.scrollTop = 0;
    }
    function back(fn) { return el("button", { type: "button", "class": "pc-link-btn", text: "← Back", on: { click: fn } }); }
    function err() { return el("p", { "class": "pc-error", role: "alert" }); }

    // 1 — the session
    function chooser() {
      var list = el("ul", { "class": "pc-kinds" });
      Object.keys(offers).forEach(function (id) {
        var o = offers[id];
        list.appendChild(el("li", null, [el("button", { type: "button", "class": "pc-btn--wide pc-book-row", on: { click: function () { st.offer = o; times(); } } }, [
          el("span", null, [el("b", { text: o.title }), el("small", { text: o.durationMinutes + " min · " + (o.locationMode === "in_person" ? "In person" : "Video call") + (o.audience === "private_group" ? " · up to " + people(o.maxPeople) : o.audience === "open_group" ? " · " + o.maxPeople + " spots" : "") })]),
          el("span", { "class": "pc-price", text: priceLabel(o) }),
        ])]));
      });
      screen("Pick a session. All-in prices" + (Object.keys(offers).some(function (k) { return offers[k].audience === "open_group"; }) ? "." : ", nothing charged until " + firstName() + " accepts."), [list]);
    }
    function firstName() { return (st.offer || offers[Object.keys(offers)[0]]).athleteFirstName; }

    // 2 — the time (her open times, or up to three suggestions)
    function times() {
      var o = st.offer, e = err();
      if (o.schedulingMode === "slots") {
        if (!o.slots.length) return screen((o.fullSlots && o.fullSlots.length ? "Every time is full right now." : "No open times right now.") + " Check back soon.", [Object.keys(offers).length > 1 ? back(chooser) : null]);
        var list = el("div", { "class": "pc-times" });
        var rows = o.slots.map(function (s) { return { s: s, full: false }; })
          .concat((o.fullSlots || []).map(function (s) { return { s: s, full: true }; }))
          .sort(function (a, b) { return new Date(a.s.startsAt) - new Date(b.s.startsAt); });
        rows.forEach(function (r) {
          var s = r.s;
          if (o.audience !== "open_group") {
            list.appendChild(el("button", { type: "button", "class": "pc-btn--wide", text: when(s.startsAt), on: { click: function () { st.slot = s; st.proposed = null; details(); } } }));
            return;
          }
          // An open group: every time says how many spots are left; a full one is shown, not bookable.
          list.appendChild(el("button", { type: "button", "class": "pc-btn--wide" + (r.full ? " pc-full" : ""), disabled: r.full, "aria-disabled": r.full ? "true" : null,
            on: { click: function () { if (r.full) return; st.slot = s; st.proposed = null; details(); } } }, [
            el("span", { text: when(s.startsAt) }),
            el("small", { "class": "pc-spots", text: r.full ? "Full" : spotsLabel(s.spotsLeft, s.capacity) }),
          ]));
        });
        var lede = o.audience === "open_group"
          ? o.title + " · a group session, " + money(o.quote.buyerTotalCents, o.quote.currency) + " per person. Pick a time (your time zone)."
          : o.title + " · pick a time (your time zone).";
        return screen(lede, [list, Object.keys(offers).length > 1 ? back(chooser) : null]);
      }
      var inputs = [], wrap = el("div", { "class": "pc-form" });
      for (var i = 0; i < Math.min(o.maxProposedTimes || 3, 3); i++) {
        var inp = el("input", { type: "datetime-local", "aria-label": "Time option " + (i + 1) });
        inputs.push(inp);
        wrap.appendChild(el("label", null, [i === 0 ? "A time that works" : "Another option (optional)", inp]));
      }
      var note = el("textarea", { maxlength: "300", rows: "2", placeholder: "Anything about timing (optional)" });
      wrap.appendChild(el("label", null, ["Note", note]));
      wrap.appendChild(el("button", { type: "button", "class": "pc-btn", text: "Next", on: { click: function () {
        var picked = inputs.map(function (x) { return x.value; }).filter(Boolean).map(function (v) { return { start: new Date(v).toISOString(), tz: zone() }; });
        if (!picked.length) { e.textContent = "Suggest at least one time."; return; }
        st.slot = null; st.proposed = picked; st.note = note.value.trim(); details();
      } } }));
      wrap.appendChild(e);
      screen(o.title + " · suggest up to three times. " + o.athleteFirstName + " picks one.", [wrap, Object.keys(offers).length > 1 ? back(chooser) : null]);
    }

    // 3 — the details
    function details() {
      var o = st.offer, e = err();
      if (st.partyFor !== o.publicId) { st.party = 1; st.quote = o.quote; st.partyFor = o.publicId; }
      // A private group: "How many people?" (you + friends), and the all-in total for that many, live.
      var partyRow = null, totalLine = null;
      if (o.audience === "private_group") {
        var sel = el("select", { "aria-label": "How many people?" });
        for (var n = 1; n <= o.maxPeople; n++) {
          var opt = el("option", { value: String(n), text: n === 1 ? "Just me" : people(n) });
          if (n === st.party) opt.selected = true;
          sel.appendChild(opt);
        }
        totalLine = el("p", { "class": "pc-fine pc-total", "aria-live": "polite" });
        var showTotal = function () { totalLine.textContent = "All-in for " + people(st.party) + ": " + money(st.quote.buyerTotalCents, st.quote.currency) + "."; };
        showTotal();
        sel.addEventListener("change", function () {
          var want = Number(sel.value);
          totalLine.textContent = "Updating the total…";
          send.disabled = true;
          req("GET", "/offers/" + encodeURIComponent(o.publicId) + "/quote?party_size=" + want).then(function (r) {
            send.disabled = false;
            if (r.quote) { st.party = want; st.quote = r.quote; showTotal(); }
            else { sel.value = String(st.party); showTotal(); e.textContent = r.error || "Couldn't update the price. Try again."; }
          });
        });
        partyRow = el("label", null, ["How many people? (you and your friends)", sel]);
      }
      var f = {
        name: el("input", { autocomplete: "name", required: true }),
        email: el("input", { type: "email", autocomplete: "email", inputmode: "email", required: true }),
        phone: o.locationMode === "in_person" ? el("input", { type: "tel", autocomplete: "tel", inputmode: "tel", required: true }) : null,
        message: el("textarea", { rows: "3", maxlength: "1000", placeholder: "What would you like to work on? (optional)" }),
        adult: el("input", { type: "checkbox" }),
        parent: o.allowMinorAttendees ? el("input", { type: "checkbox" }) : null,
        child: o.allowMinorAttendees ? el("input", { autocomplete: "off" }) : null,
        terms: el("input", { type: "checkbox" }),
      };
      if (st.contact) { f.name.value = st.contact.name; f.email.value = st.contact.email; if (f.phone) f.phone.value = st.contact.phone || ""; f.message.value = st.contact.message || ""; }
      var childRow = f.child ? el("label", { hidden: true }, ["Your child's first name", f.child]) : null;
      if (f.parent) f.parent.addEventListener("change", function () { childRow.hidden = !f.parent.checked; });
      var send = el("button", { type: "button", "class": "pc-btn", text: "Email me a code" });
      var form = el("div", { "class": "pc-form" }, [
        partyRow, totalLine,
        el("label", null, ["Your name", f.name]),
        el("label", null, ["Email", f.email]),
        f.phone ? el("label", null, ["Mobile (to meet in person)", f.phone]) : null,
        el("label", null, ["Message to " + o.athleteFirstName, f.message]),
        el("label", { "class": "pc-check" }, [f.adult, " I'm 18 or older"]),
        f.parent ? el("label", { "class": "pc-check" }, [f.parent, " I'm a parent booking for my child (I'll be there)"]) : null,
        childRow,
        el("label", { "class": "pc-check" }, [f.terms, " I agree to the booking terms and " + o.athleteFirstName + "'s " + o.freeCancelHours + "-hour cancellation window"]),
        send, e,
      ]);
      send.addEventListener("click", function () {
        e.textContent = ""; send.disabled = true;
        st.contact = { name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone ? f.phone.value.trim() : "", message: f.message.value.trim() };
        var body = {
          buyer_name: st.contact.name, buyer_email: st.contact.email, buyer_timezone: zone(), message: st.contact.message,
          adult_attested: f.adult.checked || !!(f.parent && f.parent.checked), parent_booking: !!(f.parent && f.parent.checked),
          child_first_name: f.child ? f.child.value.trim() : undefined, agree_terms: f.terms.checked,
          displayed_total_cents: st.quote.buyerTotalCents,
        };
        if (o.audience === "private_group") body.party_size = st.party;
        if (st.contact.phone) body.buyer_phone = st.contact.phone;
        if (st.slot) body.slot_id = st.slot.id; else { body.proposed_times = st.proposed; body.proposed_note = st.note || undefined; }
        req("POST", "/offers/" + encodeURIComponent(o.publicId) + "/requests", body).then(function (r) {
          send.disabled = false;
          if (r.__status === 201 && r.token) { st.token = r.token; st.masked = r.maskedEmail; return code(); }
          if (r.code === "PRICE_CHANGED" && r.detail) {
            st.quote = r.detail;
            if (!r.detail.partySize || r.detail.partySize === 1) o.quote = r.detail;
            if (totalLine) totalLine.textContent = "All-in for " + people(st.party) + ": " + money(r.detail.buyerTotalCents, r.detail.currency) + ".";
            e.textContent = "The price changed to " + money(r.detail.buyerTotalCents, r.detail.currency) + ". Check and send again."; return;
          }
          if (r.code === "SLOT_TAKEN") { e.textContent = "That time was just booked."; return setTimeout(times, 900); }
          if (r.code === "SLOT_FULL") { e.textContent = "That session just filled up. Pick another time."; return setTimeout(times, 1200); }
          if (r.code === "ALREADY_BOOKED") { e.textContent = r.error || "You already have a spot in this session."; return; }
          if (r.code === "INVALID" && r.detail) { e.textContent = r.detail.map(function (d) { return problemText(d.problem); }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(" "); return; }
          e.textContent = r.error || "Something went wrong. Try again.";
        });
      });
      screen("Your details. " + o.athleteFirstName + " sees your first name and message, never your email" + (f.phone ? " or number" : "") + ".", [form, back(times)]);
    }

    // 4 — the email code
    function code() {
      var e = err();
      var input = el("input", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", "class": "pc-code", "aria-label": "6-digit code" });
      var ok = el("button", { type: "button", "class": "pc-btn", text: "Confirm" });
      var again = el("button", { type: "button", "class": "pc-link-btn", text: "Send a new code" });
      ok.addEventListener("click", function () {
        var v = (input.value || "").replace(/\D/g, "");
        if (v.length < 6) { e.textContent = "Enter the 6-digit code."; return; }
        ok.disabled = true; e.textContent = "";
        req("POST", "/b/" + encodeURIComponent(st.token) + "/email/verify", { code: v }).then(function (r) {
          ok.disabled = false;
          if (!r.access) { e.textContent = r.error || "That code didn't match."; return; }
          st.access = r.access;
          try { sessionStorage.setItem("nb-access:" + st.token, r.access); } catch (x) { /* the /b/ page asks for a code again */ }
          if (r.nextStep === "card") return review();
          location.href = "/b/" + encodeURIComponent(st.token); // ID check / phone: the private page carries on
        });
      });
      again.addEventListener("click", function () {
        again.disabled = true;
        req("POST", "/b/" + encodeURIComponent(st.token) + "/email/send").then(function (r) { again.disabled = false; e.textContent = r.__status < 400 ? "Sent." : (r.error || "Try again in a moment."); });
      });
      screen("We emailed a 6-digit code to " + (st.masked || "your email") + ". It confirms it's you.", [el("div", { "class": "pc-form" }, [input, ok, e]), again]);
    }

    // 5 — review and the hold
    function review() {
      var o = st.offer, q = st.quote || o.quote, e = err(), open = o.audience === "open_group";
      var hold = el("button", { type: "button", "class": "pc-btn", text: "Place a hold of " + money(q.buyerTotalCents, q.currency) });
      hold.addEventListener("click", function () {
        hold.disabled = true; e.textContent = "";
        req("POST", "/b/" + encodeURIComponent(st.token) + "/hold", {}, st.access).then(function (r) {
          if (r.url) { location.href = r.url; return; }
          if (r.alreadyHeld) { location.href = "/b/" + encodeURIComponent(st.token); return; }
          hold.disabled = false; e.textContent = r.error || "Couldn't open the payment page. Try again.";
        });
      });
      var whenLine = st.slot ? when(st.slot.startsAt) : st.proposed.map(function (t) { return when(t.start); }).join(" · or ");
      screen(null, [
        el("dl", { "class": "pc-sum" }, [
          el("dt", { text: "Session" }), el("dd", { text: o.title + " · " + o.durationMinutes + " min" }),
          el("dt", { text: "When" }), el("dd", { text: whenLine }),
          el("dt", { text: "With" }), el("dd", { text: o.athleteFirstName }),
          isGroup(o) ? el("dt", { text: "Group" }) : null,
          isGroup(o) ? el("dd", { text: open ? "Group session · 1 spot" : "Group session · " + people(st.party || 1) }) : null,
          el("dt", { text: "All-in" }), el("dd", { text: money(q.buyerTotalCents, q.currency) }),
        ]),
        el("p", { "class": "pc-fine", text: "Includes " + o.athleteFirstName + "'s " + money(q.priceCents, q.currency) + (isGroup(o) && (q.partySize || 1) > 1 ? " (" + money(q.unitPriceCents, q.currency) + " × " + q.partySize + ")" : "") + " and the " + money(q.serviceFeeCents, q.currency) + " Nomila service fee." }),
        el("p", { "class": "pc-lede", text: open
          ? "We'll place a hold on your card and charge it as soon as your spot is confirmed. If the session fills up first, the hold is released."
          : "We'll place a hold on your card. You're only charged if " + o.athleteFirstName + " accepts; if not, the hold is released." }),
        hold, e,
      ]);
    }
  }

  window.NomilaBook = { mount: mount };
  // The door page opened directly (no sheet): run on it.
  if (document.readyState !== "loading") mount(document); else document.addEventListener("DOMContentLoaded", function () { mount(document); });
})();
