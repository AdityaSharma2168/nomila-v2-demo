/**
 * lib/research/secrets.ts — the live credentials the research providers may have put into a
 * response or a request record, collected at runtime so every stored research payload passes
 * the Step 1a sanitize + leak-detection contract with them as exact-value secrets.
 *
 * The values are read from the process environment (and the service-account JSON, whose
 * private key is a credential too), handed ONLY to sanitizePayload / assertNoSecrets, and never
 * logged, persisted or returned to a caller that could log them. The collector itself logs
 * nothing.
 */

/** Environment variables whose values are research/provider credentials (by name, not by value). */
export const RESEARCH_SECRET_ENV_NAMES = [
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY", "ANTHROPIC_API_KEY",
  "YOUTUBE_DATA_API_KEY", "DISCOVERY_IG_TOKEN", "IG_PAGE_ACCESS_TOKEN", "OPENAI_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON", "LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY",
] as const;

/** Any other env var whose NAME says it is a credential is collected too (never its value in logs). */
const SECRET_NAME = /(API_KEY|_TOKEN|_SECRET|SECRET_KEY|PRIVATE_KEY|PASSWORD|ACCESS_KEY)$/i;
const MIN_LEN = 8;

export function collectResearchSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v.trim().length >= MIN_LEN) out.add(v.trim()); };
  for (const name of RESEARCH_SECRET_ENV_NAMES) add(env[name]);
  for (const [name, value] of Object.entries(env)) if (SECRET_NAME.test(name) && name !== "DATABASE_URL") add(value);
  // A service-account JSON carries a private key and a client email; the key is a secret, the JSON blob as a whole too.
  const sa = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (sa) {
    try { const j = JSON.parse(sa); add(j.private_key); add(j.private_key_id); if (typeof j.private_key === "string") for (const line of j.private_key.split("\n")) add(line); } catch { /* not JSON: the raw value is already collected */ }
  }
  return [...out];
}
