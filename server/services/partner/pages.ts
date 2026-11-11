/**
 * partner/pages.ts — the visitor's server-rendered pages (confirm, status page, "Your requests"). No script at all:
 * plain HTML forms that POST back to this origin, every value HTML-escaped here, served with the hosted-form CSP
 * (script-src 'none', form-action 'self'), no-store, no referrer and noindex. They work with script off by design.
 * Look B (DESIGN.md): ink on paper, one blue, sharp corners, Outfit.
 */
import type { Response } from "express";
import { htmlEscape, setHostedFormCsp } from "../../lib/securityHeaders";

export const esc = htmlEscape;

const CSS = `
*{box-sizing:border-box}body{margin:0;background:#F3F3F1;color:#0E0E0E;font-family:Outfit,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}
.brand{font-weight:900;letter-spacing:1px;text-transform:uppercase;font-size:16px;margin:0 0 20px}
.card{background:#fff;border:1px solid #E4E4E2;padding:24px 20px;margin:0 0 16px}
h1{font-size:24px;line-height:1.2;font-weight:800;margin:0 0 12px}
h2{font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#6B6B6B;margin:0 0 12px;font-weight:700}
p{font-size:15px;line-height:1.55;color:#3A3A3A;margin:0 0 12px}
.mute{color:#6B6B6B;font-size:13px}
.btn{display:inline-block;background:#2D6BFF;color:#fff;border:0;font:inherit;font-weight:700;font-size:15px;padding:14px 22px;cursor:pointer;text-decoration:none}
.btn.secondary{background:#0E0E0E}
.steps{list-style:none;padding:0;margin:0}
.steps li{padding:8px 0;border-bottom:1px solid #E4E4E2;font-size:15px;color:#9A9A98}
.steps li.done{color:#0E0E0E}.steps li.now{color:#2D6BFF;font-weight:700}
.msg{border-top:1px solid #E4E4E2;padding:12px 0}.msg .who{font-weight:700;font-size:13px;margin:0 0 4px}
.msg .body{white-space:pre-wrap;font-size:15px;line-height:1.5;color:#3A3A3A}
.held{color:#6B6B6B;font-style:italic}
textarea,input[type=email],input[type=text]{width:100%;font:inherit;font-size:15px;padding:12px;border:1px solid #9A9A98;background:#fff;margin:0 0 12px;border-radius:0}
label{display:block;font-size:13px;font-weight:700;margin:0 0 6px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
a{color:#2D6BFF}
`;

/** Send a full page. `status` defaults to 200. */
export function sendPage(res: Response, title: string, body: string, status = 200): void {
  setHostedFormCsp(res);
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.status(status).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main><p class="brand">Nomila</p>${body}</main></body></html>`);
}

export function messagePage(res: Response, title: string, text: string, status = 200): void {
  sendPage(res, title, `<div class="card"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`, status);
}
