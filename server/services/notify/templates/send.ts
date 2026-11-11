/**
 * notify/templates/send.ts — render a template and send it through the existing email channel (lib/notify sendEmail —
 * the Gmail API, switched on by EMAIL_PROVIDER=gmail). Never throws: a notice that cannot go out is logged, and the
 * action that triggered it still stands.
 *
 * With no provider configured (EMAIL_PROVIDER unset or "off" — production today, and tests unless
 * they set it) it logs a "would send" line with the template name only (never the address or the body) and
 * returns { sent: false, skipped }.
 */
import { sendEmail } from "../../../lib/notify";
import { emailProviderConfigured } from "../../../lib/emailProvider";
import { createLogger } from "../../../logger";
import { renderTemplate, type EmailTemplate, type TemplateVars } from "./render";

const logger = createLogger("notify/templates");

export interface TemplateSendResult { sent: boolean; skipped?: boolean; error?: string }

export { emailProviderConfigured };

export async function sendTemplate(to: string | null | undefined, t: EmailTemplate, vars: TemplateVars, opts: { replyTo?: string | null } = {}): Promise<TemplateSendResult> {
  if (!to) { logger.warn({ template: t.name }, "no recipient address — notice not sent"); return { sent: false, error: "no recipient" }; }
  let rendered;
  try { rendered = renderTemplate(t, vars); }
  catch (err: any) { logger.error({ template: t.name, error: err.message }, "template render failed — notice not sent"); return { sent: false, error: "render failed" }; }
  if (!emailProviderConfigured()) {
    logger.info({ template: t.name }, "would send email (no email provider configured) — not delivered");
    return { sent: false, skipped: true };
  }
  try {
    const r = await sendEmail({ to, ...rendered, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) });
    return r.sent ? { sent: true } : { sent: false, ...(r.skipped ? { skipped: true } : {}), ...(r.error ? { error: r.error } : {}) };
  } catch (err: any) {
    logger.error({ template: t.name, error: err.message }, "email send threw — notice not sent");
    return { sent: false, error: err.message };
  }
}
