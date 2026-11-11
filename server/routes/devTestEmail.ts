/**
 * devTestEmail.ts — POST /api/internal/dev/test-email: send ONE test email through the real sendEmail, on DEV only.
 *
 * Why a route and not a local script: the Gmail channel signs a JWT AS the runtime service account (signJwt), and a
 * developer's own ADC does not hold roles/iam.serviceAccountTokenCreator on it. Cloud Run dev runs as that account, so
 * the one-off check of the Workspace delegation has to run there.
 *
 * Guards, all required:
 *   1. x-cron-secret matches INTERNAL_CRON_SECRET (same check as every /api/internal route) — else 401.
 *   2. The process is the DEV deployment — else 404 (the route does not exist anywhere else). Cloud Run dev runs with
 *      NODE_ENV=production, so NODE_ENV alone cannot tell dev from prod; the dev markers are the dev service name
 *      (K_SERVICE=nomila-v2) and the dev API host (API_BASE_URL=https://api-dev.nomila.co). A local process
 *      (NODE_ENV!==production, no K_SERVICE) is also allowed. Anything carrying a prod marker is refused.
 *   3. Body { to } is one plausible email address — else 400.
 *
 * Fixed subject + short plain body; nothing from the request reaches the content. Logs carry the recipient's domain only.
 */

import express, { type Request } from "express";
import { sendEmail } from "../lib/notify";
import { emailProvider } from "../lib/emailProvider";
import { createLogger } from "../logger";

const logger = createLogger("devTestEmail");

export const DEV_SERVICE_NAME = "nomila-v2";
export const DEV_API_BASE_URL = "https://api-dev.nomila.co";
const PROD_API_BASE_URL = "https://api.nomila.co";
export const TEST_EMAIL_SUBJECT = "Nomila test email (dev)";
export const TEST_EMAIL_TEXT =
  "This is a one-off test email from the Nomila dev server, sent to check transactional email delivery. No action is needed.";

/** True only on the dev Cloud Run service or a local (non-production, non-Cloud-Run) process. */
export function devTestEmailAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const service = env.K_SERVICE?.trim();
  const apiBase = env.API_BASE_URL?.trim().replace(/\/+$/, "");
  if (apiBase === PROD_API_BASE_URL) return false;
  if (service) return service === DEV_SERVICE_NAME && apiBase === DEV_API_BASE_URL; // Cloud Run: dev service only
  return env.NODE_ENV !== "production"; // local process
}

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function createDevTestEmailRouter(opts: { secretValid: (req: Request) => boolean }) {
  const router = express.Router();
  router.post("/api/internal/dev/test-email", express.json(), async (req, res) => {
    if (!opts.secretValid(req)) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (!devTestEmailAllowed()) { res.status(404).json({ error: "Not found" }); return; }
    const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    if (!EMAIL_RE.test(to) || to.length > 254) { res.status(400).json({ error: "body.to must be one email address" }); return; }

    const provider = emailProvider();
    const html = `<p>${TEST_EMAIL_TEXT}</p>`;
    const result = await sendEmail({ to, subject: TEST_EMAIL_SUBJECT, html, text: TEST_EMAIL_TEXT });
    logger.info({ provider, toDomain: to.slice(to.lastIndexOf("@") + 1), sent: result.sent, error: result.error }, "dev test email");
    res.status(result.sent ? 200 : 502).json({ provider, ...result });
  });
  return router;
}
