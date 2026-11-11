/**
 * emailProvider.ts — whether transactional email is switched on, read per call from the environment.
 *
 * The one provider is Google Workspace's Gmail API (lib/gmailSender.ts). EMAIL_PROVIDER=gmail turns delivery on;
 * unset or any other value (e.g. "off") means nothing is delivered — sendEmail logs a "would send" line instead.
 *
 * Kept apart from lib/notify.ts on purpose: many suites jest.mock("lib/notify") with only sendEmail, and the
 * templates layer still has to answer "is a provider configured?" under those mocks.
 */
import { createLogger } from "../logger";

const logger = createLogger("notify");

export type EmailProvider = "gmail" | "off";

/** EMAIL_PROVIDER=gmail → "gmail"; unset or "off" → "off"; anything else → "off" with a warning. */
export function emailProvider(): EmailProvider {
  const v = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (v && v !== "gmail" && v !== "off") logger.warn({ value: v }, "unknown EMAIL_PROVIDER — email delivery is off");
  return v === "gmail" ? "gmail" : "off";
}

/**
 * Whether a real delivery channel is configured. Gmail is keyless (its readiness is the Workspace delegation, which
 * only a send can prove), so selecting it counts as configured.
 */
export function emailProviderConfigured(): boolean {
  return emailProvider() === "gmail";
}
