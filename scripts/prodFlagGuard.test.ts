/**
 * prodFlagGuard.test.ts — scripts/prod-flag-guard.ts: a production deploy never switches a guarded flag ON (the kill
 * switch survives the next promotion), may always switch one OFF, and the prod YAML ships every guarded flag that is
 * in it as "false" today (each is switched on by the owner, never by a deploy). deploy-prod.yml runs the guard before
 * the backup, the migration and the deploy. It also refuses a prod YAML without an env entry the code needs
 * (REQUIRED_ENV: NOMILA_MCP_PASS_KEY, since Mila always runs on Mastra); that rule runs at deploy time only.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { envNames, envValues, flagsTurnedOn, GUARDED_FLAGS, GUARDED_VALUE_FLAGS, missingRequiredEnv, REQUIRED_ENV, runGuard } from "./prod-flag-guard";

const svc = (env: Record<string, string>) => ({ spec: { template: { spec: { containers: [{ env: Object.entries(env).map(([name, value]) => ({ name, value })) }] } } } });
const ROOT = join(__dirname, "..");

describe("prod-flag-guard", () => {
  it("refuses a deploy that would switch a killed flag back on", () => {
    expect(flagsTurnedOn(svc({ MILA_TF_WAITLIST: "true" }), svc({ MILA_TF_WAITLIST: "false" }))).toEqual([{ flag: "MILA_TF_WAITLIST", yaml: "true", live: "false" }]);
  });

  it("refuses when the live service does not carry the flag at all", () => {
    expect(flagsTurnedOn(svc({ LEAN_SIGNUP_RESEARCH: "true" }), svc({}))).toEqual([{ flag: "LEAN_SIGNUP_RESEARCH", yaml: "true", live: null }]);
  });

  it("lets a deploy keep a flag on, switch it off, or leave it off", () => {
    expect(flagsTurnedOn(svc({ QUICK_SCORE_ONE_CALL: "true" }), svc({ QUICK_SCORE_ONE_CALL: "true" }))).toEqual([]);
    expect(flagsTurnedOn(svc({ QUICK_SCORE_ONE_CALL: "false" }), svc({ QUICK_SCORE_ONE_CALL: "true" }))).toEqual([]);
    expect(flagsTurnedOn(svc({ QUICK_SCORE_ONE_CALL: "false" }), svc({}))).toEqual([]);
  });

  it("ignores flags it does not guard, and secret references", () => {
    expect(flagsTurnedOn(svc({ AGENT_V3: "true" }), svc({ AGENT_V3: "false" }))).toEqual([]);
    const withSecret = { spec: { template: { spec: { containers: [{ env: [{ name: "X", valueFrom: { secretKeyRef: { name: "S", key: "latest" } } }] }] } } } };
    expect(envValues(withSecret).has("X")).toBe(false);
  });

  it("guards every release flag of this rollout", () => {
    expect([...GUARDED_FLAGS]).toEqual(expect.arrayContaining(["LEAN_SIGNUP_RESEARCH", "QUICK_SCORE_ONE_CALL", "MILA_TF_WAITLIST", "MILA_PROACTIVE", "MILA_CHAT_V2", "DEALS_PARTITION_FLASH", "VOICE_GRANT_ENFORCE", "OUTLOOK_SEND", "CONTENT_READY_QUEUE", "GAME_DAY_SIGNALS"]));
  });

  it("the prod YAML ships every guarded flag it carries as \"false\", except those the owner switched on live first", () => {
    // Switched on on the live service by the owner after the 10 Nov 2026 catch-up promote (the optimized waitlist, plain
    // screens); the YAML matches the live service. Every other guarded flag, MILA_TF_WAITLIST included, ships "false".
    const ON_LIVE = ["LEAN_SIGNUP_RESEARCH", "QUICK_SCORE_ONE_CALL"];
    const prod = envValues(parse(readFileSync(join(ROOT, "gcp", "cloud-run-prod.yaml"), "utf8")));
    for (const f of GUARDED_FLAGS) if (prod.has(f)) expect([f, prod.get(f)]).toEqual([f, ON_LIVE.includes(f) ? "true" : "false"]);
  });

  it("MILA_PROACTIVE is guarded on its own (P1 removed its MILA_TF_CHAT coupling)", () => {
    expect(GUARDED_FLAGS).toContain("MILA_PROACTIVE");
    expect(flagsTurnedOn(svc({ MILA_PROACTIVE: "true" }), svc({ MILA_PROACTIVE: "false" }))).toEqual([{ flag: "MILA_PROACTIVE", yaml: "true", live: "false" }]);
    expect(flagsTurnedOn(svc({ MILA_PROACTIVE: "false" }), svc({ MILA_PROACTIVE: "true" }))).toEqual([]);
  });

  it("the value-flag mechanism: a safe value or unset ships; any other value only once the live service has it", () => {
    // No value flag is guarded today (MILA_ENGINE and MILA_MASTRA_ATHLETES went with the engine switch); the mechanism stays.
    expect(GUARDED_VALUE_FLAGS).toEqual({});
    const vf = { SOME_MODE: ["off", "safe"] };
    expect(flagsTurnedOn(svc({ SOME_MODE: "safe" }), svc({ SOME_MODE: "on" }), [], vf)).toEqual([]);
    expect(flagsTurnedOn(svc({ SOME_MODE: "on" }), svc({}), [], vf)).toEqual([{ flag: "SOME_MODE", yaml: "on", live: null }]);
    expect(flagsTurnedOn(svc({ SOME_MODE: "on" }), svc({ SOME_MODE: "off" }), [], vf)).toEqual([{ flag: "SOME_MODE", yaml: "on", live: "off" }]);
    expect(flagsTurnedOn(svc({ SOME_MODE: "on" }), svc({ SOME_MODE: "on" }), [], vf)).toEqual([]);
    expect(flagsTurnedOn(svc({}), svc({ SOME_MODE: "on" }), [], vf)).toEqual([]);
  });

  it("the engine switch is gone: no guard for MILA_ENGINE / MILA_MASTRA_ATHLETES / MILA_TF_CHAT, none in the dev YAML", () => {
    for (const k of ["MILA_ENGINE", "MILA_MASTRA_ATHLETES", "MILA_TF_CHAT"]) {
      expect([k, (GUARDED_FLAGS as readonly string[]).includes(k), k in GUARDED_VALUE_FLAGS]).toEqual([k, false, false]);
    }
    const dev = envValues(parse(readFileSync(join(ROOT, "gcp", "cloud-run-dev.yaml"), "utf8")));
    for (const k of ["MILA_ENGINE", "MILA_MASTRA_ATHLETES", "MILA_TF_CHAT"]) expect([k, dev.has(k)]).toEqual([k, false]);
    expect(dev.get("MASTRA_TELEMETRY_DISABLED")).toBe("1");
  });

  it("MILA_CHAT_V2 (the AI SDK chat route): on in dev, off in prod, and a deploy can never switch it on", () => {
    const prod = envValues(parse(readFileSync(join(ROOT, "gcp", "cloud-run-prod.yaml"), "utf8")));
    const dev = envValues(parse(readFileSync(join(ROOT, "gcp", "cloud-run-dev.yaml"), "utf8")));
    expect([prod.get("MILA_CHAT_V2"), dev.get("MILA_CHAT_V2")]).toEqual(["false", "true"]);
    expect(flagsTurnedOn(svc({ MILA_CHAT_V2: "true" }), svc({ MILA_CHAT_V2: "false" }))).toEqual([{ flag: "MILA_CHAT_V2", yaml: "true", live: "false" }]);
  });

  it("MILA_CARDS_V2 (the card system v2's producers): on in dev, off in prod, and a deploy can never switch it on", () => {
    const prod = envValues(parse(readFileSync(join(ROOT, "gcp", "cloud-run-prod.yaml"), "utf8")));
    const dev = envValues(parse(readFileSync(join(ROOT, "gcp", "cloud-run-dev.yaml"), "utf8")));
    expect([prod.get("MILA_CARDS_V2"), dev.get("MILA_CARDS_V2")]).toEqual(["false", "true"]);
    expect(GUARDED_FLAGS).toContain("MILA_CARDS_V2");
    expect(flagsTurnedOn(svc({ MILA_CARDS_V2: "true" }), svc({ MILA_CARDS_V2: "false" }))).toEqual([{ flag: "MILA_CARDS_V2", yaml: "true", live: "false" }]);
  });

  it("MILA_WELCOME (the Welcome capability choices): on in dev, off in prod, and a deploy can never switch it on", () => {
    const prod = envValues(parse(readFileSync(join(ROOT, "gcp", "cloud-run-prod.yaml"), "utf8")));
    const dev = envValues(parse(readFileSync(join(ROOT, "gcp", "cloud-run-dev.yaml"), "utf8")));
    expect([prod.get("MILA_WELCOME"), dev.get("MILA_WELCOME")]).toEqual(["false", "true"]);
    expect(GUARDED_FLAGS).toContain("MILA_WELCOME");
    expect(flagsTurnedOn(svc({ MILA_WELCOME: "true" }), svc({ MILA_WELCOME: "false" }))).toEqual([{ flag: "MILA_WELCOME", yaml: "true", live: "false" }]);
  });

  it("deploy-prod.yml runs the guard before the backup, the migration and the deploy", () => {
    const wf = readFileSync(join(ROOT, ".github", "workflows", "deploy-prod.yml"), "utf8");
    const guard = wf.indexOf("scripts/prod-flag-guard.ts");
    expect(guard).toBeGreaterThan(0);
    for (const later of ["gcloud sql backups create", "bash scripts/db-migrate.sh", "gcloud run services replace"]) expect(wf.indexOf(later)).toBeGreaterThan(guard);
  });
});

describe("required env: the prod YAML must carry NOMILA_MCP_PASS_KEY (Mila always runs on Mastra)", () => {
  const withSecret = (names: string[]) => ({ spec: { template: { spec: { containers: [{ env: names.map((name) => ({ name, valueFrom: { secretKeyRef: { name, key: "latest" } } })) }] } } } });
  const prodYaml = () => parse(readFileSync(join(ROOT, "gcp", "cloud-run-prod.yaml"), "utf8"));
  const setEnv = (svcObj: any, env: any[]) => { svcObj.spec.template.spec.containers[0].env = env; return svcObj; };

  it("a secret reference counts; a missing entry is named", () => {
    expect(REQUIRED_ENV).toContain("NOMILA_MCP_PASS_KEY");
    expect(envNames(withSecret(["NOMILA_MCP_PASS_KEY"])).has("NOMILA_MCP_PASS_KEY")).toBe(true);
    expect(missingRequiredEnv(withSecret(["NOMILA_MCP_PASS_KEY"]))).toEqual([]);
    expect(missingRequiredEnv(withSecret(["OPENAI_API_KEY"]))).toEqual(["NOMILA_MCP_PASS_KEY"]);
    expect(missingRequiredEnv({})).toEqual(["NOMILA_MCP_PASS_KEY"]);
  });

  it("the dev YAML carries it", () => {
    expect(missingRequiredEnv(parse(readFileSync(join(ROOT, "gcp", "cloud-run-dev.yaml"), "utf8")))).toEqual([]);
  });

  it("the prod YAML carries it, from prod's OWN secret (never dev's NOMILA_MCP_PASS_KEY), exactly once", () => {
    expect(missingRequiredEnv(prodYaml())).toEqual([]);
    const entries = (prodYaml().spec.template.spec.containers[0].env as any[]).filter((e) => e.name === "NOMILA_MCP_PASS_KEY");
    expect(entries).toEqual([{ name: "NOMILA_MCP_PASS_KEY", valueFrom: { secretKeyRef: { name: "NOMILA_MCP_PASS_KEY_PROD", key: "latest" } } }]);
  });

  it("the guard passes the prod YAML file itself against a live service that has its flag values but not yet the key", () => {
    // The live side keeps the YAML's own guarded values (so this stays true when a later PR sets a flag "true" to match
    // a live flip) and lacks the pass key (as prod did before this release): the file on disk must carry it.
    const dir = mkdtempSync(join(tmpdir(), "prod-guard-"));
    const live = join(dir, "live.json");
    const liveEnv = (prodYaml().spec.template.spec.containers[0].env as any[]).filter((e) => e.name !== "NOMILA_MCP_PASS_KEY");
    writeFileSync(live, JSON.stringify(setEnv(prodYaml(), liveEnv)));
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try { expect(runGuard([join(ROOT, "gcp", "cloud-run-prod.yaml"), live])).toBe(0); } finally { log.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("the guard run (what deploy-prod.yml runs) refuses the prod YAML without it and passes with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "prod-guard-"));
    const live = join(dir, "live.json");
    const base = prodYaml();
    const env = (base.spec.template.spec.containers[0].env as any[]).filter((e) => e.name !== "NOMILA_MCP_PASS_KEY");
    writeFileSync(live, JSON.stringify(setEnv(prodYaml(), env)));
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const without = join(dir, "without.yaml");
      writeFileSync(without, stringify(setEnv(prodYaml(), env)));
      expect(runGuard([without, live])).toBe(1);
      expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/has no NOMILA_MCP_PASS_KEY env entry/);
      const withKey = join(dir, "with.yaml");
      writeFileSync(withKey, stringify(setEnv(prodYaml(), [...env, { name: "NOMILA_MCP_PASS_KEY", valueFrom: { secretKeyRef: { name: "NOMILA_MCP_PASS_KEY_PROD", key: "latest" } } }])));
      expect(runGuard([withKey, live])).toBe(0);
    } finally { log.mockRestore(); }
  });

  it("runs at deploy time only: no PR workflow runs the guard script, so a prod YAML without the key fails no PR", () => {
    const wfDir = join(ROOT, ".github", "workflows");
    const runners = readdirSync(wfDir).filter((f) => readFileSync(join(wfDir, f), "utf8").includes("npx tsx scripts/prod-flag-guard.ts"));
    expect(runners).toEqual(["deploy-prod.yml"]);
  });
});
