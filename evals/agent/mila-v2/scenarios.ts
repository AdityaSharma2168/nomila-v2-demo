/**
 * evals/agent/mila-v2/scenarios.ts — the golden set as both runners read it: scenarios.json (what Mia approves),
 * contexts.json (the CONTEXT each turn gets), the rubric from README.md, and the ONE turn input both runners send.
 *
 *   live      run.ts sends userTurn(s) to the real model (no engine)
 *   offline   flows.ts sends the same userTurn(s) through the real Mastra build with a scripted model
 *
 * Chat scenarios: CONTEXT written out from contexts.json, then the athlete's (or a visitor's) message.
 * Waitlist scenarios (contexts.json `waitlist`): the real waitlist turn input (agent/waitlist/turn.ts): the moment's
 * APP UPDATES line, the waitlist surface and playbook (a session's first turn), the real waitlist CONTEXT built by
 * waitlistContextText from the scenario's state, then the message (or none, on a moment turn).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WaitlistMoment } from "../../../server/agent/waitlist/turn";
import type { WaitlistState } from "../../../server/agent/waitlist/state";

/**
 * The waitlist turn's real builders, loaded only when a waitlist scenario is rendered: they import server/db, which
 * needs DATABASE_URL to load (never to run: nothing here queries it). The live runner sets a placeholder first.
 */
function waitlistBuilders() {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { turnInputText } = require("../../../server/agent/engine/context") as typeof import("../../../server/agent/engine/context");
  const { WAITLIST_MOMENT_LINES, waitlistPreface } = require("../../../server/agent/waitlist/turn") as typeof import("../../../server/agent/waitlist/turn");
  const { waitlistContextText } = require("../../../server/agent/waitlist/state") as typeof import("../../../server/agent/waitlist/state");
  /* eslint-enable @typescript-eslint/no-var-requires */
  return { turnInputText, WAITLIST_MOMENT_LINES, waitlistPreface, waitlistContextText };
}

export interface Scenario { id: string; area: string; athlete: string; context: string; message: string | null; pass: string; fail: string; checks: string[] }
export interface WaitlistCtx { moment: WaitlistMoment | null; state: WaitlistState }
export interface Ctx { name: string; surface?: string; can_do_now?: string; lines: string[]; waitlist?: WaitlistCtx }

const DIR = __dirname;
export const SCENARIOS: Scenario[] = JSON.parse(readFileSync(join(DIR, "scenarios.json"), "utf8")).scenarios;
export const CTX = JSON.parse(readFileSync(join(DIR, "contexts.json"), "utf8")) as { default_can_do_now: string; contexts: Record<string, Ctx> };

/** The rubric rows from README.md, so the judge always grades against the table Mia approves. */
export function rubricFromReadme(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of md.split("\n")) {
    const m = /^\|\s*(R\d)\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/.exec(line);
    if (m) out[m[1]] = `${m[1]} ${m[2].trim()}. PASSES when: ${m[3].trim()}. FAILS when: ${m[4].trim()}.`;
  }
  return out;
}
export const RUBRIC = rubricFromReadme(readFileSync(join(DIR, "README.md"), "utf8"));

export const TODAY = "2026-10-26";

export const ctxOf = (s: Pick<Scenario, "id">): Ctx => {
  const c = CTX.contexts[s.id];
  if (!c) throw new Error(`no context for ${s.id}`);
  return c;
};
export const isWaitlist = (s: Pick<Scenario, "id">): boolean => !!ctxOf(s).waitlist;

export function contextBlock(s: Scenario): string {
  const c = ctxOf(s);
  if (c.waitlist) return waitlistBuilders().waitlistContextText(c.waitlist.state, new Date(`${TODAY}T12:00:00Z`));
  return [
    "CONTEXT (built by Nomila for this turn)",
    `Today: ${TODAY}`,
    `Opened from: ${c.surface ?? "the Mila tab (chat with the athlete)"}`,
    c.surface ? null : `Athlete: ${c.name} (they/them)`,
    ...c.lines,
    `CAN DO NOW: ${c.can_do_now ?? CTX.default_can_do_now}`,
  ].filter(Boolean).join("\n");
}

/** The one turn input both runners send (`engine` picks the waitlist surface's tool words: Mastra's, the only ones). */
export function userTurn(s: Scenario, engine: "mastra" = "mastra"): string {
  const c = ctxOf(s);
  if (c.waitlist) {
    const { turnInputText, WAITLIST_MOMENT_LINES, waitlistPreface } = waitlistBuilders();
    return turnInputText({
      events: [],
      updates: c.waitlist.moment ? [WAITLIST_MOMENT_LINES[c.waitlist.moment]] : [],
      preface: waitlistPreface(true, engine),
      context: contextBlock(s),
      message: s.message,
    });
  }
  const who = c.surface ? "VISITOR MESSAGE" : "ATHLETE MESSAGE";
  return `<context>\n${contextBlock(s)}\n</context>\n\n${who}\n${s.message}`;
}
