/**
 * askMila.flag.test.ts — ASK_MILA_PUBLIC is ON in dev (the wiring PR) and OFF in prod, and needs PUBLIC_CARD; the limits are the design's numbers
 * (design-public-card-v3 §4 "Limits"), the daily ones tunable by env, the spend cap's "0" a kill switch; the visitor key
 * is a daily-salted hash that never contains the IP and changes every UTC day.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ASK_MILA, askMilaPublicEnabled, costMicroUsd, visitorHash } from "./config";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envOf = (file: string) =>
  (parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string; value?: string }[]);

const KEYS = ["ASK_MILA_PUBLIC", "PUBLIC_CARD", "ASK_MILA_VISITOR_DAILY_TURNS", "ASK_MILA_ATHLETE_DAILY_TURNS", "ASK_MILA_DAILY_SPEND_CAP_USD", "SESSION_SECRET"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("ASK_MILA_PUBLIC", () => {
  it.each([["cloud-run-dev.yaml", "true"], ["cloud-run-prod.yaml", "false"]])("%s pins it to %s, exactly once", (file, value) => {
    expect(envOf(file).filter((e) => e.name === "ASK_MILA_PUBLIC")).toEqual([{ name: "ASK_MILA_PUBLIC", value }]);
  });

  it("only the exact string \"true\" is on, and only with PUBLIC_CARD on", () => {
    process.env.PUBLIC_CARD = "true";
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      if (v === undefined) delete process.env.ASK_MILA_PUBLIC; else process.env.ASK_MILA_PUBLIC = v;
      expect(askMilaPublicEnabled()).toBe(false);
    }
    process.env.ASK_MILA_PUBLIC = "true";
    expect(askMilaPublicEnabled()).toBe(true);
    process.env.PUBLIC_CARD = "false";
    expect(askMilaPublicEnabled()).toBe(false);
  });
});

describe("limits", () => {
  it("the design's numbers by default", () => {
    for (const k of KEYS.slice(2, 5)) delete process.env[k];
    expect({ msg: ASK_MILA.messageMaxChars, session: ASK_MILA.sessionMaxTurns, idle: ASK_MILA.idleMinutes, visitor: ASK_MILA.visitorDailyTurns, athlete: ASK_MILA.athleteDailyTurns, keep: ASK_MILA.transcriptDays })
      .toEqual({ msg: 300, session: 20, idle: 15, visitor: 30, athlete: 400, keep: 90 });
    expect(ASK_MILA.dailySpendCapMicroUsd).toBe(20_000_000);
  });

  it("the daily ones are env-tunable; nonsense falls back; \"0\" spend is the kill switch", () => {
    process.env.ASK_MILA_VISITOR_DAILY_TURNS = "12";
    process.env.ASK_MILA_ATHLETE_DAILY_TURNS = "abc";
    process.env.ASK_MILA_DAILY_SPEND_CAP_USD = "0";
    expect([ASK_MILA.visitorDailyTurns, ASK_MILA.athleteDailyTurns, ASK_MILA.dailySpendCapMicroUsd]).toEqual([12, 400, 0]);
    process.env.ASK_MILA_DAILY_SPEND_CAP_USD = "-5";
    expect(ASK_MILA.dailySpendCapMicroUsd).toBe(20_000_000);
  });

  it("cost is tokens × $/MTok in micro-dollars, thinking billed as output, rounded up", () => {
    expect(costMicroUsd({ promptTokens: 1000, outputTokens: 50, thinkingTokens: 100 })).toBe(Math.ceil(1000 * 0.5 + 150 * 3));
    expect(costMicroUsd({ promptTokens: 0, outputTokens: 0, thinkingTokens: 0 })).toBe(0);
  });
});

describe("the visitor key", () => {
  it("is a hash that never contains the IP, the same within a UTC day and different the next", () => {
    process.env.SESSION_SECRET = "k1";
    const d1 = new Date("2026-10-08T01:00:00Z"); const d1b = new Date("2026-10-08T23:00:00Z"); const d2 = new Date("2026-10-09T01:00:00Z");
    const h = visitorHash("203.0.113.7", d1);
    expect(h).not.toContain("203");
    expect(visitorHash("203.0.113.7", d1b)).toBe(h);
    expect(visitorHash("203.0.113.7", d2)).not.toBe(h);
    expect(visitorHash("203.0.113.8", d1)).not.toBe(h);
    process.env.SESSION_SECRET = "k2";
    expect(visitorHash("203.0.113.7", d1)).not.toBe(h);
  });
});
