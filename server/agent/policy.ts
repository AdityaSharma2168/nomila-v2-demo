/**
 * agent/policy.ts — the fixed rules. Everything else is the model's judgment inside a skill; these are not.
 *
 *   skill_toolset   a run may call only the tools its skill lists (whatever the model asks for)
 *   tenancy         the athlete is the run's; arguments naming any athlete id are refused outright
 *   family_privacy  no NEVER content in a draft, proposal or outgoing action: contact details or street addresses
 *                   (format checks) and children's names the athlete has marked never. Family mentions are allowed.
 *   tap_to_send     an act tool (send, post, publish, accept, invite) is never executed by the agent: it is QUEUED
 *   money           anything that moves or commits money is queued too, whatever its declared permission
 *   confirm_first   a propose tool (save what the athlete told Mila) is queued too: saved only on the athlete's tap
 *   cost_cap        a run stops when its own spend, or the athlete's spend today, reaches the cap
 *   source_required a fact without a source is refused (also a CHECK on memory_facts)
 *
 * Pure functions, no database: the harness feeds them what they need, and records every non-allow decision as a
 * trace step.
 */
import type { PolicyDecision, Skill } from "../../shared/agent";
import type { AgentTool } from "./tools";
import { privateFormats } from "./research/privacy";

const ALLOW: PolicyDecision = { decision: "allow", rule: null, reason: "allowed" };

const ATHLETE_ID_KEY = /^athlete[_-]?id$|athleteid/i;

function hasAthleteIdKey(v: unknown, depth = 0): boolean {
  if (depth > 8 || v == null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some((x) => hasAthleteIdKey(x, depth + 1));
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => ATHLETE_ID_KEY.test(k) || hasAthleteIdKey(x, depth + 1));
}

function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

// ─── never content (family_privacy) ──────────────────────────────────────────────────────────────────────────────
//
// Owner rule (9 Oct): family mentions are ALLOWED — family as the athlete publicly presents it is handled with care by
// the skills, not blocked here. What is blocked in anything outgoing is NEVER content only:
//   - contact details and street addresses, by high-precision FORMAT checks (emails, strict phones, street addresses);
//   - children's names the athlete has told Mila never to use (known "never" terms, passed in by the caller).

/** The never-content found in a text: format hits ("contact" / "address") and known never terms (case-insensitive). */
export function findNeverContent(text: string, neverTerms: readonly string[] = []): string[] {
  const hits: string[] = [...privateFormats(text)];
  for (const term of neverTerms) {
    const t = term.trim();
    if (t.length < 2) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu");
    if (re.test(text)) hits.push("never_term");
  }
  return hits;
}

// ─── tool calls ───────────────────────────────────────────────────────────────────────────────────────────────────

export function checkToolCall(params: {
  skill: Pick<Skill, "id" | "tools">; tool: AgentTool | undefined; name: string; args: unknown;
  /** Children's names (or other terms) the athlete has marked never-use. From memory (neverTermsFor). */
  neverTerms?: readonly string[];
}): PolicyDecision {
  const { skill, tool, name, args } = params;
  if (!tool || !skill.tools.includes(name)) {
    return { decision: "deny", rule: "skill_toolset", reason: `${name} is not a tool of skill ${skill.id}` };
  }
  // A flagged tool whose flag is off is left out of the run (ToolRegistry.forSkill); a call that names it anyway is
  // refused here, so a skill may list it while the flag is off without the flag being only a hint to the model.
  if (tool.enabled && !tool.enabled()) {
    return { decision: "deny", rule: "skill_toolset", reason: `${name} is not available right now` };
  }
  if (hasAthleteIdKey(args)) {
    return { decision: "deny", rule: "tenancy", reason: "arguments may not name an athlete; the run's athlete is used" };
  }
  if (tool.permission !== "read") {
    // The tool that maintains the never-use list is exempt from the never-term check for its own statement (adding
    // "Never use: A, B" when A is already listed must not be refused). Format checks (contacts, addresses) still apply.
    const exempt = new Set(args && typeof args === "object" && !Array.isArray(args) ? tool.neverTermExempt?.(args as Record<string, unknown>) ?? [] : []);
    const terms = params.neverTerms ?? [];
    const hits = args && typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>).flatMap(([k, v]) => strings(v).flatMap((t) => findNeverContent(t, exempt.has(k) ? [] : terms)))
      : strings(args).flatMap((t) => findNeverContent(t, terms));
    if (hits.length) return { decision: "deny", rule: "family_privacy", reason: `never-content is not put in anything outgoing (${[...new Set(hits)].join(", ")})` };
  }
  if (tool.money) return { decision: "queue", rule: "money", reason: "anything with money waits for the athlete's tap" };
  if (tool.permission === "act") return { decision: "queue", rule: "tap_to_send", reason: "anything outgoing waits for the athlete's tap" };
  // A propose tool (e.g. saving what the athlete told Mila) is NEVER run by the agent: it waits for the athlete's tap.
  if (tool.permission === "propose") return { decision: "queue", rule: "confirm_first", reason: "this waits for the athlete to confirm it with a tap" };
  return ALLOW;
}

// ─── cost ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function checkCost(params: { runMicroUsd: number; dayMicroUsd: number; runCap: number; dayCap: number }): PolicyDecision & { stop?: "cost_cap_run" | "cost_cap_day" } {
  if (params.dayMicroUsd >= params.dayCap) return { decision: "deny", rule: "cost_cap", reason: "today's spend cap for this athlete is reached", stop: "cost_cap_day" };
  if (params.runMicroUsd >= params.runCap) return { decision: "deny", rule: "cost_cap", reason: "this run's spend cap is reached", stop: "cost_cap_run" };
  return ALLOW;
}

// ─── facts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function checkFactSource(source: { url?: string | null; ref?: string | null }): PolicyDecision {
  const url = source.url?.trim();
  const ref = source.ref?.trim();
  if (!url && !ref) return { decision: "deny", rule: "source_required", reason: "a fact needs a source (a url or a reference)" };
  if (url && !/^https?:\/\//i.test(url)) return { decision: "deny", rule: "source_required", reason: "a source url must be http(s)" };
  return ALLOW;
}
