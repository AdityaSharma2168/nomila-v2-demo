/**
 * envGuards.ts — production startup validation.
 *
 * Fail-fast on config that would boot the app in an unsafe/broken state (a missing app or API URL — there is no dev-host fallback anywhere,
 * see baseUrls.ts, so a missing URL in production must stop the boot, not point at
 * dev). Only WARN (never exit) on config that just degrades a feature — /health must stay up for Cloud Run's liveness probe, so a
 * missing Pub/Sub topic can't be allowed to take the whole service down.
 */

import { createLogger } from "../logger";

const logger = createLogger("envGuards");

export interface EnvHealth {
  gmailPush: "configured" | "missing";
}

export function checkEnv(): EnvHealth {
  const isProd      = process.env.NODE_ENV === "production";
  const webAppUrl   = process.env.WEB_APP_URL?.trim();
  const apiBaseUrl  = process.env.API_BASE_URL?.trim();
  const origins     = process.env.ALLOWED_ORIGINS?.trim();
  const pubsubTopic = process.env.GMAIL_PUBSUB_TOPIC?.trim();
  const pubsubSa    = process.env.PUBSUB_PUSH_SA?.trim();

  if (isProd) {
    const fatal: string[] = [];
    if (!webAppUrl) fatal.push("WEB_APP_URL must be set in production (no dev-host fallback)");
    if (!apiBaseUrl) fatal.push("API_BASE_URL must be set in production (no dev-host fallback)");
    if (fatal.length) {
      for (const m of fatal) logger.error({ event: "pipeline_failure", kind: "config" }, m);
      throw new Error(`Unsafe production config:\n- ${fatal.join("\n- ")}`);
    }

    // Degraded-but-up: log loudly, keep serving.
    if (!pubsubTopic) logger.error({ event: "pipeline_failure", kind: "config" }, "GMAIL_PUBSUB_TOPIC unset — realtime Gmail detection disabled (polling only)");
    if (!pubsubSa)    logger.error({ event: "pipeline_failure", kind: "config" }, "PUBSUB_PUSH_SA unset — the Gmail webhook is UNAUTHENTICATED");
    if (!origins)     logger.error({ event: "pipeline_failure", kind: "config" }, "ALLOWED_ORIGINS unset — CORS is using the development origin list");
  }

  return { gmailPush: pubsubTopic && pubsubSa ? "configured" : "missing" };
}
