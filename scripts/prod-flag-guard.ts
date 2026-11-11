/**
 * scripts/prod-flag-guard.ts — a production deploy never switches a guarded feature flag ON.
 *
 * WHY: deploy-prod.yml applies gcp/cloud-run-prod.yaml with `gcloud run services replace`, so the YAML is the whole
 * service config. The kill switch for a new feature is a fast env flip on the live service
 * (`gcloud run services update nomila-v2-prod --update-env-vars FLAG=false`, docs/release/new-research-and-mila-on-tf.md).
 * Without this guard the NEXT promotion would silently switch that feature back on from the YAML.
 *
 * THE RULE: for each flag in GUARDED_FLAGS, if the YAML says "true" and the live service does not, the deploy stops
 * before the backup, the migration and the deploy. A guarded flag is switched ON in production only by the owner's
 * explicit `--update-env-vars FLAG=true` (the release checklist), and the YAML is set to "true" afterwards to match.
 * Switching a flag OFF through the YAML is always allowed (the safe direction).
 *
 * Usage (deploy-prod.yml):
 *   gcloud run services describe nomila-v2-prod --region=us-central1 --format=json > live.json
 *   npx tsx scripts/prod-flag-guard.ts gcp/cloud-run-prod.yaml live.json
 * Exit 0: nothing guarded would turn on. Exit 1: the refusal names each flag (names and values only, never secrets).
 *
 * ALSO (Mastra-only PR 2, Nov 2026): the YAML must carry every env entry in REQUIRED_ENV, by name (a plain value or a
 * Secret Manager reference). Mila always runs on Mastra now, and a Mastra turn signs an athlete pass with
 * NOMILA_MCP_PASS_KEY (engine/tools/pass.ts issueAthletePass): a service without it fails every chat turn. The check
 * runs only here, at deploy time (deploy-prod.yml), never in PR CI, so it blocks promoting main to production until
 * the prod YAML gains the key in its own release, without failing any PR.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** The flags a deploy may never switch on. Add each new release flag here when it lands in the prod YAML. */
export const GUARDED_FLAGS = [
  "LEAN_SIGNUP_RESEARCH",
  "QUICK_SCORE_ONE_CALL",
  // NOMILA_MCP_ENABLED left with the /mcp server (Mastra-only PR 3): nothing reads it; the prod YAML's "false" is inert.
  // MILA_TF_CHAT left this list with the engine switch (Mastra-only PR 2): nothing reads it any more.
  "MILA_TF_WAITLIST",
  // Mila starts the conversation (agent/proactive). Guarded directly since P1 (5 Nov 2026): it used to be guarded only
  // through its MILA_TF_CHAT coupling, which P1 removed (it needs only its own flag).
  "MILA_PROACTIVE",
  "MILA_CHAT_V2",
  "MILA_READ_TOOLS",
  "MILA_CARDS_V2",
  // The Welcome capability choices (server/agent/welcome): on in dev only (owner, 6 Nov 2026); off in prod until the
  // owner switches it on there, deliberately, never by a deploy.
  "MILA_WELCOME",
  // On in dev only (owner, 2 Nov 2026, never-on decisions): prod switches them on deliberately, never by a deploy.
  "DEALS_PARTITION_FLASH",
  "VOICE_GRANT_ENFORCE",
  // One Mila for voice (server/voice/oneMila, 10 Nov 2026): the worker's session and tool proxy. On in dev only; prod
  // switches it on deliberately, after the phone test, never by a deploy.
  "MILA_VOICE_ONE",
  // Outlook sending (4 Nov 2026): on only after Mail.Send is requested and the Azure checklist is done.
  "OUTLOOK_SEND",
  // "Ready for you" (content engine step 2, 10 Nov 2026): the queue routes and the learning loop's auto "posted" mark
  // (agent/ready/config.ts). Dev first; prod only by the owner's explicit switch.
  "CONTENT_READY_QUEUE",
  // Game-day signals (content engine step 2c, 10 Nov 2026): the after-game wake-up and typed one-time questions
  // (agent/events/config.ts). Dev first, once the app can answer a typed question; prod only by the owner's switch.
  "GAME_DAY_SIGNALS",
] as const;

type EnvVar = { name?: string; value?: string };

/** The first container's plain env values (secret references are skipped: they are never flags). */
export function envValues(service: unknown): Map<string, string> {
  const env = ((service as any)?.spec?.template?.spec?.containers?.[0]?.env ?? []) as EnvVar[];
  const out = new Map<string, string>();
  for (const e of env) if (e?.name && typeof e.value === "string") out.set(e.name, e.value);
  return out;
}

/**
 * Guarded flags that take a VALUE rather than true/false: the safe values a deploy may always ship (unset is safe too).
 * Any other value is refused unless the live service already has exactly it. None today: MILA_ENGINE and
 * MILA_MASTRA_ATHLETES were the two, and they went with the engine switch (Mila always runs on Mastra, Mastra-only PR
 * 2). Both YAMLs dropped their leftover MILA_ENGINE (prod in the Nov 2026 catch-up).
 */
export const GUARDED_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {};

export interface FlagTurnOn { flag: string; yaml: string; live: string | null }

/** Env entries the prod YAML must carry (by name; a secret reference counts) for the code being deployed to work. */
export const REQUIRED_ENV = [
  // Every Mila turn on Mastra signs an athlete pass with it (engine/tools/pass.ts); without it every chat turn fails.
  "NOMILA_MCP_PASS_KEY",
] as const;

/** The first container's env NAMES, plain values and secret references alike. */
export function envNames(service: unknown): Set<string> {
  const env = ((service as any)?.spec?.template?.spec?.containers?.[0]?.env ?? []) as EnvVar[];
  return new Set(env.map((e) => e?.name).filter((n): n is string => typeof n === "string" && n.length > 0));
}

/** The REQUIRED_ENV entries the YAML lacks. */
export function missingRequiredEnv(yamlService: unknown, required: readonly string[] = REQUIRED_ENV): string[] {
  const names = envNames(yamlService);
  return required.filter((n) => !names.has(n));
}

/**
 * The guarded flags this deploy would switch ON: a boolean flag with YAML "true" and live anything else (missing
 * included); a value flag with a YAML value outside its safe values that the live service does not already have.
 */
export function flagsTurnedOn(
  yamlService: unknown, liveService: unknown,
  guarded: readonly string[] = GUARDED_FLAGS, valueFlags: Readonly<Record<string, readonly string[]>> = GUARDED_VALUE_FLAGS,
): FlagTurnOn[] {
  const want = envValues(yamlService);
  const live = envValues(liveService);
  const booleans = guarded
    .filter((f) => want.get(f) === "true" && live.get(f) !== "true")
    .map((f) => ({ flag: f, yaml: "true", live: live.get(f) ?? null }));
  const values = Object.entries(valueFlags)
    .filter(([f, safe]) => { const v = want.get(f); return v !== undefined && !safe.includes(v) && live.get(f) !== v; })
    .map(([f]) => ({ flag: f, yaml: want.get(f)!, live: live.get(f) ?? null }));
  return [...booleans, ...values];
}

function main(argv: string[]): number {
  const [yamlPath, livePath] = argv;
  if (!yamlPath || !livePath) {
    console.error("usage: tsx scripts/prod-flag-guard.ts <cloud-run-prod.yaml> <live-service.json>");
    return 2;
  }
  const yamlService = parse(readFileSync(yamlPath, "utf8"));
  const liveService = JSON.parse(readFileSync(livePath, "utf8"));
  const missing = missingRequiredEnv(yamlService);
  for (const name of missing) {
    console.log(`::error::${yamlPath} has no ${name} env entry, and the code being deployed needs it (Mila runs on Mastra, `
      + `which signs an athlete pass with it on every turn). Add it to the prod YAML (a Secret Manager reference) in the release first.`);
  }
  const on = flagsTurnedOn(yamlService, liveService);
  if (!on.length && !missing.length) {
    console.log(`prod-flag-guard: OK, no guarded flag turns on (${[...GUARDED_FLAGS, ...Object.keys(GUARDED_VALUE_FLAGS)].join(", ")}); required env present (${REQUIRED_ENV.join(", ")})`);
    return 0;
  }
  for (const f of on) {
    console.log(`::error::This deploy would switch ${f.flag} ON (live: ${f.live ?? "<unset>"}, ${yamlPath}: ${f.yaml}). `
      + `Switch it on deliberately first (gcloud run services update nomila-v2-prod --region=us-central1 --update-env-vars ${f.flag}=${f.yaml}), `
      + `or set it back to its safe value ("false") in ${yamlPath} if it was turned off as a kill switch.`);
  }
  return 1;
}

export { main as runGuard };

if (require.main === module) process.exit(main(process.argv.slice(2)));
