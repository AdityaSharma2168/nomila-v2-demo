/**
 * notify.ts — outbound notifications (email channel) + notification_log audit.
 *
 * The notification_log table records notifications, but nothing sent them before this.
 * This wires a real email channel for the "you're in" promotion message:
 *
 *   • Delivery is Google Workspace's Gmail API, sent as NOTIFY_FROM_EMAIL through keyless domain-wide
 *     delegation (lib/gmailSender.ts), switched on by EMAIL_PROVIDER=gmail.
 *   • With EMAIL_PROVIDER unset (or "off"), sendEmail() logs and no-ops — so promoting an athlete
 *     still works end-to-end (status flip + research + audit row) without delivering anything.
 *
 * Every promotion writes a notification_log row; `sent`/`sent_at` are only set on a
 * confirmed delivery.
 */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { notificationLog } from "../../shared/schema";
import { createLogger } from "../logger";
import { webAppUrl } from "./baseUrls";
import { getGmailSender } from "./gmailSender";
import { emailProvider } from "./emailProvider";

export { emailProvider, emailProviderConfigured, type EmailProvider } from "./emailProvider";

const logger = createLogger("notify");

const FROM_EMAIL     = process.env.NOTIFY_FROM_EMAIL?.trim() || "Nomila <hello@nomila.co>";
const APP_URL        = webAppUrl();

export interface SendEmailInput {
  to:      string;
  subject: string;
  html:    string;
  text?:   string;
  /** Reply-To header (e.g. a per-thread relay address, partners+<token>@<domain>). */
  replyTo?: string;
}

/** The recipient as a log line may show it: the domain only (an address is personal data). */
const logRecipient = (to: string): string => to.slice(to.lastIndexOf("@") + 1) || "?";

export interface SendEmailResult {
  sent:     boolean;
  skipped?: boolean; // provider not configured
  id?:      string;
  error?:   string;
}

/**
 * The dev verification harness's own sign-ups (signup-test+<anything>@nomila.co). Outside prod nothing is ever mailed
 * to them (6 Nov 2026: dev's cloud tick sent a real deletion-complete email to one). Prod is unchanged.
 */
export const TEST_SIGNUP_ADDRESS = /^signup-test\+[^@\s]*@nomila\.co$/i;
const PROD_SERVICE_NAME = "nomila-v2-prod";
const PROD_API_BASE_URL = "https://api.nomila.co";

/** The prod deployment: its Cloud Run service, or the prod API base URL. Anything else (dev, local, tests) is not. */
export function isProdDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.K_SERVICE?.trim() === PROD_SERVICE_NAME || env.API_BASE_URL?.trim().replace(/\/+$/, "") === PROD_API_BASE_URL;
}

/** Send a transactional email through Gmail, or no-op + log when email delivery is off. */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  if (!isProdDeployment() && TEST_SIGNUP_ADDRESS.test(input.to.trim())) {
    logger.info({ toDomain: logRecipient(input.to), subject: input.subject }, "skipped test address: not delivering outside prod");
    return { sent: false, skipped: true };
  }
  if (emailProvider() !== "gmail") {
    logger.warn(
      { toDomain: logRecipient(input.to), subject: input.subject },
      "would send email (EMAIL_PROVIDER is not gmail) — logging notification only, not delivering",
    );
    return { sent: false, skipped: true };
  }
  try {
    return await getGmailSender().send({ from: FROM_EMAIL, ...input });
  } catch (err: any) {
    logger.error({ toDomain: logRecipient(input.to), error: err.message }, "Gmail send threw");
    return { sent: false, error: err.message };
  }
}

export interface PromotionTarget {
  id:          string;
  full_name:   string | null;
  first_name?: string | null;
  email:       string | null;
}

/**
 * Notify a just-promoted athlete that they're in. Always writes a notification_log row
 * (audit), then best-effort delivers an email — flipping sent/sent_at only on success.
 * Never throws: a notification failure must not roll back the promotion.
 */
export async function notifyPromotion(athlete: PromotionTarget): Promise<{ logged: boolean; emailed: boolean }> {
  const firstName = athlete.first_name?.trim()
    || athlete.full_name?.split(" ")[0]?.trim()
    || "there";
  const title = "You're in — welcome to Nomila";
  const body  = `Hi ${firstName}, your spot just opened up. Your Nomila agent is live — `
    + `sign in to see your M.I.A. score and your first brand opportunities. ${APP_URL}`;

  // Audit row first — so the promotion is recorded even if the email channel is down.
  let logId: string | null = null;
  try {
    const [row] = await db
      .insert(notificationLog)
      .values({ athlete_id: athlete.id, type: "promotion", title, body, sent: false })
      .returning({ id: notificationLog.id });
    logId = row?.id ?? null;
  } catch (err: any) {
    logger.error({ athleteId: athlete.id, error: err.message }, "notification_log insert failed");
  }

  if (!athlete.email) {
    logger.warn({ athleteId: athlete.id }, "Promotion notify: athlete has no email on file — logged only");
    return { logged: !!logId, emailed: false };
  }

  const result = await sendEmail({
    to:      athlete.email,
    subject: title,
    html:    promotionHtml(firstName),
    text:    body,
  });

  if (result.sent && logId) {
    await db
      .update(notificationLog)
      .set({ sent: true, sent_at: new Date() })
      .where(eq(notificationLog.id, logId))
      .catch((err: any) => logger.error({ logId, error: err.message }, "notification_log sent-flag update failed"));
  }

  return { logged: !!logId, emailed: result.sent };
}

function promotionHtml(firstName: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;background:#0d0d0f;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:40px 24px;color:#fff;">
      <div style="font-weight:800;font-size:22px;letter-spacing:-0.5px;">nomila</div>
      <h1 style="font-size:28px;font-weight:800;margin:28px 0 8px;">You're in, ${escapeHtml(firstName)}.</h1>
      <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.72);margin:0 0 24px;">
        Your spot just opened up. Your Nomila agent is live — sign in to see your
        M.I.A. score and your first brand opportunities.
      </p>
      <a href="${APP_URL}" style="display:inline-block;background:#ec4899;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px;">
        Open Nomila
      </a>
      <p style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:32px;">
        You're receiving this because you joined the Nomila waitlist.
      </p>
    </div>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
