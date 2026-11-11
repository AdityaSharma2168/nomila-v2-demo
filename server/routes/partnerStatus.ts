/**
 * partnerStatus.ts — the visitor's side of a request, with no account (noindex, no-store, no script; plain forms).
 *
 *   GET  /r/:token               the request and where it stands (the link alone). With the visitor check (below) also
 *                                the thread and a reply box; without it, "Show messages" sends a code.
 *   POST /r/:token/code          email a 6-digit code to the address the request came from (never a typed one)
 *   POST /r/:token/verify        { code } → the visitor check is remembered on this browser (30 days, /r and /requests)
 *   POST /r/:token/messages      { body } → through the relay (moderated; held messages show "being checked")
 *   GET  /requests               "Your requests": every request this address sent, newest first (needs the check)
 *   POST /requests/code          { email } → a code, if Nomila holds a request from that address (same answer either way)
 *   POST /requests/verify        { email, code } → the check, then the list
 *
 * Tenancy: a status token opens exactly one confirmed request; the visitor check opens only requests whose sender
 * address hashes to the checked one. Mounted only while PUBLIC_CARD and PARTNER_INTAKE are both "true".
 */
import { Router, type Request, type Response } from "express";
import { KIND_MAP, type PartnerRequestKind } from "../services/partner/kinds";
import { findByStatusToken, statusSteps } from "../services/partner/requests";
import { readPartnerThread, relayPartnerMessage } from "../services/partner/threads";
import { checkVisitorCode, emailHashOf, rememberVisitor, requestsForVisitor, sendVisitorCode, visitorEmailHash } from "../services/partner/visitor";
import { statusUrlFor } from "../services/partner/links";
import { esc, messagePage, sendPage } from "../services/partner/pages";
import type { PartnerRequest } from "../../shared/schema";

export const partnerStatusRouter = Router();
export const partnerRequestsRouter = Router();

const NOT_ACTIVE = ["This link isn't active", "Check that you opened the latest email from Nomila."] as const;

export function stepsHtml(row: PartnerRequest): string {
  return `<ul class="steps">${statusSteps(row).map((s) =>
    `<li class="${s.state}"><div class="row"><span>${esc(s.label)}</span>${s.at && s.state !== "todo" ? `<span class="mute">${esc(s.at)}</span>` : ""}</div></li>`).join("")}</ul>`;
}

export function headerHtml(row: PartnerRequest): string {
  return `<div class="card"><h2>Your request · ref ${esc(row.public_ref)}</h2>
<h1>${esc(KIND_MAP[row.kind as PartnerRequestKind].label)} · ${esc(row.brand_name)}</h1>
<p class="mute">To ${esc(row.display_name)} · ${esc(row.display_name)} reviews every request personally.</p>
${stepsHtml(row)}</div>`;
}

const FLASH: Record<string, string> = {
  sent: "Sent.",
  checking: "This message is being checked. It will be delivered if it passes.",
  blocked: "This message can't be delivered.",
  code: "We sent a 6-digit code to the email address this request came from.",
  badcode: "That code didn't work. Check the latest email, or ask for a new code.",
  limited: "Too many codes asked for. Please try again in an hour.",
};

async function threadHtml(row: PartnerRequest, token: string): Promise<string> {
  const msgs = await readPartnerThread(row, "visitor");
  const list = msgs.length ? msgs.map((m) => `<div class="msg"><p class="who">${esc(m.from === "athlete" ? row.display_name : "You")}</p>${
    m.state === "checking" ? `<p class="body held">This message is being checked.</p>` : `<p class="body">${esc(m.body ?? "")}</p>`}</div>`).join("")
    : `<p class="mute">No messages yet.</p>`;
  const closed = row.outcome === "declined";
  return `<div class="card"><h2>Messages</h2>${list}
${closed ? "" : `<form method="post" action="/r/${esc(encodeURIComponent(token))}/messages">
<label for="body">Write to ${esc(row.display_name)}</label>
<textarea id="body" name="body" rows="5" maxlength="2000" required></textarea>
<button class="btn" type="submit">Send</button></form>`}
<p class="mute">Messages go through Nomila and are checked. Your email and phone number stay private.</p></div>`;
}

function codeHtml(token: string, asked: boolean): string {
  return `<div class="card"><h2>Messages</h2>
<p>To read and write messages on this browser, confirm with a code sent to the email address this request came from.</p>
${asked ? `<form method="post" action="/r/${esc(encodeURIComponent(token))}/verify"><label for="code">6-digit code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
<button class="btn" type="submit">Show messages</button></form>` : ""}
<form method="post" action="/r/${esc(encodeURIComponent(token))}/code"><button class="btn ${asked ? "secondary" : ""}" type="submit">${asked ? "Send a new code" : "Show messages"}</button></form></div>`;
}

async function renderStatus(req: Request, res: Response, row: PartnerRequest): Promise<void> {
  const token = String(req.params.token);
  const checked = visitorEmailHash(req) === row.contact_email_hash;
  const flash = FLASH[String(req.query.m ?? "")];
  sendPage(res, `Your request to ${row.display_name}`,
    `${flash ? `<div class="card"><p>${esc(flash)}</p></div>` : ""}${headerHtml(row)}${checked ? await threadHtml(row, token) : codeHtml(token, req.query.m === "code" || req.query.m === "badcode")}`);
}

async function rowOr404(req: Request, res: Response): Promise<PartnerRequest | null> {
  const row = await findByStatusToken(req.params.token);
  if (!row) { messagePage(res, NOT_ACTIVE[0], NOT_ACTIVE[1], 404); return null; }
  return row;
}
const back = (res: Response, token: string, m: string) => res.redirect(303, `/r/${encodeURIComponent(token)}?m=${m}`);

partnerStatusRouter.get("/:token", async (req, res) => {
  const row = await rowOr404(req, res); if (!row) return;
  await renderStatus(req, res, row);
});

partnerStatusRouter.post("/:token/code", async (req, res) => {
  const row = await rowOr404(req, res); if (!row) return;
  if (!row.contact_email) { messagePage(res, "Messages are closed", "This request's contact details were removed after it closed.", 410); return; }
  const r = await sendVisitorCode(row.contact_email);
  back(res, req.params.token, r === "limited" ? "limited" : "code");
});

partnerStatusRouter.post("/:token/verify", async (req, res) => {
  const row = await rowOr404(req, res); if (!row) return;
  if (!(await checkVisitorCode(row.contact_email_hash, req.body?.code))) { back(res, req.params.token, "badcode"); return; }
  rememberVisitor(res, row.contact_email_hash);
  back(res, req.params.token, "ok");
});

partnerStatusRouter.post("/:token/messages", async (req, res) => {
  const row = await rowOr404(req, res); if (!row) return;
  if (visitorEmailHash(req) !== row.contact_email_hash) { back(res, req.params.token, "code"); return; }
  if (row.outcome === "declined") { back(res, req.params.token, "blocked"); return; }
  const r = await relayPartnerMessage(row, "visitor", req.body?.body);
  if (!r.ok) { messagePage(res, "Not sent", r.error, r.status); return; }
  back(res, req.params.token, r.duplicate ? "sent" : r.moderation === "clean" ? "sent" : r.moderation === "held" ? "checking" : "blocked");
});

// ─── "Your requests" ────────────────────────────────────────────────────────────────────────────────────────

function emailForm(flash?: string): string {
  return `<div class="card"><h1>Your requests</h1>${flash ? `<p>${esc(flash)}</p>` : ""}
<p>Enter the email address you sent your requests from. We'll email you a code.</p>
<form method="post" action="/requests/code"><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" maxlength="254" required>
<button class="btn" type="submit">Email me a code</button></form></div>`;
}

partnerRequestsRouter.get("/", async (req, res) => {
  const h = visitorEmailHash(req);
  if (!h) { sendPage(res, "Your requests", emailForm()); return; }
  const rows = await requestsForVisitor(h);
  const items = rows.map((r) => {
    const steps = statusSteps(r);
    const now = steps.find((s) => s.state === "now") ?? steps[steps.length - 1];
    return `<div class="msg"><div class="row"><a href="${esc(statusUrlFor(r))}">${esc(KIND_MAP[r.kind as PartnerRequestKind].label)} · ${esc(r.brand_name)} × ${esc(r.display_name)}</a>
<span class="mute">${esc(now.label)}</span></div><p class="mute">Sent ${esc(new Date(r.confirmed_at ?? r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }))} · ref ${esc(r.public_ref)}</p></div>`;
  }).join("");
  sendPage(res, "Your requests", `<div class="card"><h1>Your requests</h1>${items || `<p class="mute">No requests yet.</p>`}
<p class="mute">Updates by email.</p></div>`);
});

partnerRequestsRouter.post("/code", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().slice(0, 254) : "";
  if (!email.includes("@")) { sendPage(res, "Your requests", emailForm("Enter the email address you sent your requests from."), 400); return; }
  const r = await sendVisitorCode(email);
  if (r === "limited") { sendPage(res, "Your requests", emailForm(FLASH.limited), 429); return; }
  // The same answer whether or not Nomila holds a request from this address.
  sendPage(res, "Your requests", `<div class="card"><h1>Check your email</h1>
<p>If you've sent requests from ${esc(email)}, a 6-digit code is on its way.</p>
<form method="post" action="/requests/verify"><input type="hidden" name="email" value="${esc(email)}">
<label for="code">6-digit code</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
<button class="btn" type="submit">Show my requests</button></form></div>`);
});

partnerRequestsRouter.post("/verify", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email : "";
  const h = emailHashOf(email);
  if (!email || !(await checkVisitorCode(h, req.body?.code))) { sendPage(res, "Your requests", emailForm(FLASH.badcode), 400); return; }
  rememberVisitor(res, h);
  res.redirect(303, "/requests");
});
