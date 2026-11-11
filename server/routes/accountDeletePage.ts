/**
 * accountDeletePage.ts — the public "delete your account" web page (Google Play: "a web link resource where users can
 * request app account deletion", for the Data safety form), on the API host at /account/delete.
 *
 * The smaller safe option: a REQUEST FORM, never a delete. Anyone can reach this page, so nothing here can close or
 * erase an account. It tells people how to delete in the app (Settings › Account › Delete account, which runs the real
 * flow behind sign-in) and, for someone without the app, takes their sign-in email and passes the request to
 * hello@nomila.co, with Reply-To set to that address. A person at Nomila then writes to them from hello@nomila.co to
 * check it's really them before running the deletion. The page says exactly that.
 *
 * No script; plain HTML posting back to this origin; every value escaped; the hosted-form CSP (script-src 'none',
 * form-action 'self'), no-store, noindex. Rate-limited per IP; a filled honeypot field is answered like a success
 * and sends nothing.
 */
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { htmlEscape, setHostedFormCsp } from "../lib/securityHeaders";
import { sendEmail } from "../lib/notify";
import { createLogger } from "../logger";

const logger = createLogger("routes/accountDeletePage");

export const DELETION_REQUESTS_TO = "hello@nomila.co";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#F3F3F1;color:#0E0E0E;font-family:Outfit,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
.brand{font-weight:900;letter-spacing:4px;text-transform:uppercase;font-size:13px;margin:0 0 20px}
.card{background:#fff;border:1px solid #E4E4E2;border-radius:16px;padding:20px;margin:0 0 12px}
h1{font-size:26px;line-height:1.05;font-weight:900;text-transform:uppercase;letter-spacing:-.5px;margin:0 0 12px}
h2{font-size:11px;letter-spacing:1.3px;text-transform:uppercase;color:#6B6B6B;margin:0 0 10px;font-weight:800}
p,li{font-size:15px;line-height:1.5;color:#3A3A3A;margin:0 0 10px}
ul{padding-left:18px;margin:0 0 4px}
.mute{color:#6B6B6B;font-size:13px}
label{display:block;font-size:13px;font-weight:700;margin:0 0 6px}
input[type=email]{width:100%;font:inherit;font-size:16px;padding:12px 16px;border:1.5px solid #0E0E0E;border-radius:999px;background:#fff;margin:0 0 12px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.btn{display:block;width:100%;height:48px;border:0;border-radius:999px;background:#C8325A;color:#fff;font:inherit;font-weight:800;font-size:13px;letter-spacing:1px;text-transform:uppercase;cursor:pointer}
.err{background:#FEF2F2;color:#7f1d1d;border-radius:16px;padding:12px 14px;font-size:14px;margin:0 0 12px}
a{color:#0E0E0E;font-weight:700}
`;

function sendPage(res: Response, title: string, body: string, status = 200): void {
  setHostedFormCsp(res);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${htmlEscape(title)}</title><style>${CSS}</style></head><body><main><p class="brand">Nomila</p>${body}</main></body></html>`);
}

function formPage(res: Response, opts: { email?: string; error?: string } = {}, status = 200): void {
  sendPage(res, "Delete your Nomila account", `
<h1>Delete your Nomila account</h1>
<div class="card">
  <h2>In the app</h2>
  <p>Open Nomila, then go to <b>Settings › Account › Delete account</b>. Your account closes as soon as you confirm, and your data is erased within 24 hours.</p>
</div>
<div class="card">
  <h2>What gets erased</h2>
  <ul>
    <li>Your profile, goals, deals, chats with Mila, photos, videos, contracts and Studio work.</li>
    <li>Your sign-in, and Nomila's access to the accounts you connected (Gmail, YouTube, Outlook, Instagram, TikTok).</li>
  </ul>
  <h2 style="margin-top:14px">What we keep</h2>
  <ul>
    <li>A record of money that moved through Nomila (amount, date and payment reference, with nothing that names you), for tax and accounting.</li>
    <li>Backups hold a copy for up to 7 days, then it's gone.</li>
  </ul>
</div>
<div class="card">
  <h2>No app? Ask us here</h2>
  ${opts.error ? `<div class="err" role="alert">${htmlEscape(opts.error)}</div>` : ""}
  <form method="post" action="/account/delete">
    <label for="email">The email you sign in to Nomila with</label>
    <input id="email" name="email" type="email" autocomplete="email" required maxlength="254" value="${htmlEscape(opts.email ?? "")}">
    <div class="hp" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
    <button class="btn" type="submit">Ask to delete my account</button>
  </form>
  <p class="mute" style="margin-top:12px">This form doesn't delete anything by itself. We'll write to you from ${DELETION_REQUESTS_TO} to check it's really you, then delete your account and tell you when it's done.</p>
</div>`, status);
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => formPage(res, { error: "Too many requests from here. Try again in a few minutes, or write to hello@nomila.co." }, 429),
});

// A cap across every sender too, so a spread of addresses can't flood hello@nomila.co (the email only ever goes to us).
const allLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: false, legacyHeaders: false,
  keyGenerator: () => "all",
  handler: (_req, res) => formPage(res, { error: "We're getting a lot of requests right now. Try again later, or write to hello@nomila.co." }, 429),
});

const router = Router();

router.get("/delete", (_req: Request, res: Response) => formPage(res));

router.post("/delete", limiter, allLimiter, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as { email?: unknown; website?: unknown };
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const received = () => sendPage(res, "Request received", `
<h1>We got your request</h1>
<div class="card">
  <p>We'll write to you from ${DELETION_REQUESTS_TO} to check it's really you. Nothing is deleted until you reply.</p>
  <p>Once it's confirmed, we delete your account and email you when it's done.</p>
  <p class="mute">If you still have the app, you can also delete right away in Settings › Account › Delete account.</p>
</div>`);

  // A bot filled the hidden field: answer like a success, send nothing.
  if (typeof body.website === "string" && body.website.trim()) { received(); return; }
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    formPage(res, { email, error: "Enter the email you sign in to Nomila with." }, 400);
    return;
  }
  const result = await sendEmail({
    to: DELETION_REQUESTS_TO,
    replyTo: email,
    subject: "Account deletion request (web form)",
    text: [
      "Someone asked to delete a Nomila account through the public web page (/account/delete).",
      `Sign-in email given: ${email}`,
      "Before deleting: reply from hello@nomila.co to that address and confirm it's them. Then run the deletion for the account with that sign-in email (the same flow as in-app delete).",
    ].join("\n\n"),
    html: `<p>Someone asked to delete a Nomila account through the public web page (/account/delete).</p>
<p><b>Sign-in email given:</b> ${htmlEscape(email)}</p>
<p>Before deleting: reply from hello@nomila.co to that address and confirm it's them. Then run the deletion for the account with that sign-in email (the same flow as in-app delete).</p>`,
  });
  if (!result.sent) {
    logger.warn({ skipped: !!result.skipped, error: result.error }, "account deletion request: email to the team not sent");
    formPage(res, { email, error: `We couldn't send your request just now. Please write to ${DELETION_REQUESTS_TO} from the email you sign in with.` }, 503);
    return;
  }
  received();
});

export default router;
