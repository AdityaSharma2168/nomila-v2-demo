/**
 * notify/templates/render.ts — the ONE email template helper, shared by every track that sends a transactional email
 * (bookings today; the partner-intake track next). Generic on purpose: nothing here knows about bookings.
 *
 * A template is plain data: a subject, paragraphs, an optional button, an optional footer. `{{name}}` placeholders are
 * filled from the vars and HTML-escaped in the html part (never in the text part, which is plain text). A missing var
 * throws, so a template can never go out with a hole in it — the senders catch and log that, they never send a half
 * email. No markup is ever taken from vars: links come only through `button` / `link` fields and are escaped as
 * attributes.
 */
import { htmlEscape } from "../../../lib/securityHeaders";

export type TemplateVars = Record<string, string | number>;

export interface EmailTemplate {
  /** A stable name for logs ("booking.accepted"). Never shown to the recipient. */
  name:       string;
  subject:    string;
  paragraphs: string[];
  /** One call to action: the label and the var holding its URL. */
  button?:    { label: string; urlVar: string };
  /** A closing line under everything (e.g. the support line). */
  footer?:    string;
}

export interface RenderedEmail { subject: string; text: string; html: string }

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function fill(s: string, vars: TemplateVars, escape: boolean, template: string): string {
  return s.replace(PLACEHOLDER, (_m, key: string) => {
    if (!(key in vars)) throw new Error(`template ${template}: missing var "${key}"`);
    const v = String(vars[key]);
    return escape ? htmlEscape(v) : v;
  });
}

/** Render one template. Throws on a missing var (the caller logs and does not send). */
export function renderTemplate(t: EmailTemplate, vars: TemplateVars): RenderedEmail {
  const subject = fill(t.subject, vars, false, t.name).replace(/[\r\n]+/g, " ").trim();
  // A paragraph that is only an optional var left empty (e.g. a group line on a 1:1 booking) is left out entirely.
  const paras = t.paragraphs.map((p) => ({ text: fill(p, vars, false, t.name), html: fill(p, vars, true, t.name) })).filter((p) => p.text.trim() !== "");
  const url = t.button ? String(vars[t.button.urlVar] ?? "") : "";
  if (t.button && !url) throw new Error(`template ${t.name}: missing var "${t.button.urlVar}"`);
  const footer = t.footer ? { text: fill(t.footer, vars, false, t.name), html: fill(t.footer, vars, true, t.name) } : null;

  const text = [
    ...paras.map((p) => p.text),
    ...(t.button ? [`${t.button.label}: ${url}`] : []),
    ...(footer ? ["—", footer.text] : []),
  ].join("\n\n");
  const html = [
    ...paras.map((p) => `<p>${p.html}</p>`),
    ...(t.button ? [`<p><a href="${htmlEscape(url)}">${htmlEscape(t.button.label)}</a></p>`] : []),
    ...(footer ? [`<p style="color:#6B6B6B;font-size:12px">${footer.html}</p>`] : []),
  ].join("\n");
  return { subject, text, html };
}
