/**
 * baseUrls.ts — the public hostnames the server hands out, read from the environment only.
 *
 * WHY THIS EXISTS: six OAuth integrations, the notification emails, the OAuth-callback
 * redirects and the payment pages each used to carry their own fallback to a dev host
 * (the raw Cloud Run URL or nomila-dev.web.app). With a second environment, a missing
 * variable in production would have sent OAuth callbacks, share links and payment
 * returns to dev — silently, because everything still "worked". There is no dev-host
 * fallback here on purpose.
 *
 *   production   — a missing value is fatal at startup (envGuards.checkEnv()). These
 *                  getters return "" in the window between import and that check so a
 *                  module-level constant never throws before the guard can explain.
 *   development  — a missing value warns once and uses the local server, so a laptop
 *                  without .env talks to itself, never to Cloud Run. setup-dev-env.sh
 *                  writes both variables.
 *
 * Read lazily (functions, not constants) so tests and scripts can set the environment
 * before first use.
 */

import { createLogger } from "../logger";

const logger = createLogger("baseUrls");

const isProduction = () => process.env.NODE_ENV === "production";
const warned = new Set<string>();

function read(name: string, devDefault: string): string {
  const value = process.env[name]?.trim();
  if (value) return value.replace(/\/+$/, "");
  if (isProduction()) return "";
  if (!warned.has(name)) {
    warned.add(name);
    logger.warn(
      { event: "config", name, devDefault },
      `${name} is unset — using ${devDefault}. Development only; production refuses to start without it.`,
    );
  }
  return devDefault;
}

/** Where this API is reachable from the outside: OAuth redirect URIs are built on it. */
export const apiBaseUrl = (): string => read("API_BASE_URL", "http://localhost:8080");

/** The web app: OAuth callbacks and notification emails send people back here. */
export const webAppUrl = (): string => read("WEB_APP_URL", "http://localhost:8081");

/**
 * Public pages the API itself serves (payment and deposit pages). Defaults to the API
 * base — a derived default, not a dev-host fallback — so it only needs setting when the
 * public pages sit behind a different host than the API.
 */
export const publicBaseUrl = (): string => process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") || apiBaseUrl();
