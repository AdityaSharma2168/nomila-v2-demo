/**
 * webhooks.outlook.ts — Microsoft Graph change notifications for Outlook (OUTLOOK_PUSH).
 *
 * POST /api/v1/webhooks/outlook            change notifications (basic: no resource data)
 * POST /api/v1/webhooks/outlook/lifecycle  lifecycle notifications (reauthorizationRequired, subscriptionRemoved, missed)
 *
 * Public: the only authentication is the per-subscription clientState (verified in constant time against the
 * stored hash — server/lib/integrations/outlookPush.ts). No message is read here. A verified notification
 * stamps "sync this connection" and a debounced worker runs the existing delta sync, so this answers inside
 * Graph's 3 s budget; a slow endpoint gets retried for 4 h and then throttled.
 *
 * Validation handshake: when a subscription is created Graph POSTs to BOTH URLs with ?validationToken=…; we
 * answer within 10 s with 200, text/plain and the decoded token (Express has already URL-decoded req.query).
 *
 * Responses: 202 when anything was accepted or only unknown subscriptions were named (a subscription deleted
 * on disconnect keeps sending until it expires — answering 4xx would only make Graph retry and throttle us);
 * 403 when every item named a known subscription with a missing or wrong clientState; 400 for a malformed body.
 *
 * Mounted with its own express.json (server/index.ts), not under /api/webhooks's express.raw.
 */

import { Router, type Request, type Response } from "express";
import { createLogger } from "../logger";
import { acceptNotifications, type GraphNotificationItem } from "../lib/integrations/outlookPush";

const logger = createLogger("webhooks/outlook");
const router = Router();

/** The subscription-validation handshake. Returns true when it answered. */
function answeredValidation(req: Request, res: Response): boolean {
  const token = req.query.validationToken;
  if (typeof token !== "string") return false;
  res.status(200).type("text/plain").send(token);
  return true;
}

function itemsOf(body: unknown): GraphNotificationItem[] | null {
  const value = (body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is GraphNotificationItem => !!v && typeof v === "object");
}

function handler(kind: "change" | "lifecycle") {
  return async (req: Request, res: Response): Promise<void> => {
    if (answeredValidation(req, res)) return;

    const items = itemsOf(req.body);
    if (!items) {
      res.status(400).end();
      return;
    }
    try {
      const outcome = await acceptNotifications(items, kind);
      if (outcome.rejected > 0) {
        logger.warn({ kind, ...outcome }, "Outlook webhook: clientState mismatch — notification(s) rejected");
      }
      if (outcome.accepted === 0 && outcome.rejected > 0) {
        res.status(403).end();
        return;
      }
      res.status(202).end();
    } catch (err: any) {
      // 5xx → Graph retries; recording is idempotent, so a retry is harmless.
      logger.error({ kind, error: err.message }, "Outlook webhook handler threw");
      res.status(500).end();
    }
  };
}

router.post("/", handler("change"));
router.post("/lifecycle", handler("lifecycle"));

export default router;
