/**
 * agent/cards.ts — chat cards built from what a run actually did (never from model prose).
 *
 *   action          one per approval item the run queued: approve / edit / decline drive pending_actions
 *   how-i-got-this  when the run read evidence: the facts and pages it used, with sources (from the trace)
 *
 * progress / ready / connect cards come from workers and connectors (later tracks); their shapes are in the contract.
 */
import type { ApprovalItem, ChatCard, EvidenceRef, HowIGotThisCardPayload, MemoryFact } from "../../shared/agent";

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export function actionCard(a: ApprovalItem): ChatCard {
  // "Want me to save that?": the card shows exactly what will be saved (the summary), with Save and Not now — no Edit,
  // because the tap saves the stored arguments as they are.
  if (a.verb === "save_memory") {
    return {
      id: `action:${a.id}`, kind: "action", title: a.title,
      payload: { approvalId: a.id, verb: a.verb, body: a.summary, money: null, buttons: ["approve", "decline"] },
      links: [], runId: a.runId,
    };
  }
  const body = typeof a.args.body === "string" ? a.args.body : null;
  return {
    id: `action:${a.id}`,
    kind: "action",
    title: a.title,
    payload: { approvalId: a.id, verb: a.verb, body, money: a.money ?? null, buttons: ["approve", "edit", "decline"] },
    links: [],
    runId: a.runId,
  };
}

/**
 * One card per id, in first-seen order, the later copy's content winning (what the chat stream does with a data part
 * whose id it has seen). A card id names its run and subject (bookings `booking:<runId>:<bookingId>`, deals, actions),
 * so the same id twice is the same card: a turn that read one booking twice must not show its accept card twice.
 */
export function uniqueCards(cards: readonly ChatCard[]): ChatCard[] {
  const byId = new Map<string, number>();
  const out: ChatCard[] = [];
  for (const c of cards) {
    const at = byId.get(c.id);
    if (at === undefined) { byId.set(c.id, out.length); out.push(c); } else out[at] = c;
  }
  return out;
}

export function howIGotThisCard(p: { runId: string; skillId: string; why: string; evidence: EvidenceRef[]; facts: MemoryFact[] }): ChatCard | null {
  const byId = new Map(p.facts.map((f) => [f.id, f]));
  const facts: HowIGotThisCardPayload["facts"] = [];
  for (const e of p.evidence) {
    if (e.kind === "fact") {
      const f = byId.get(e.factId);
      if (!f) continue;
      const label = f.source.title ?? (f.source.url ? host(f.source.url) : f.type === "said" ? "You said" : "Nomila worked this out");
      facts.push({ claim: f.claim, type: f.type, source: { label, ...(f.source.url ? { url: f.source.url } : {}) } });
    } else if (e.kind === "url") {
      facts.push({ claim: e.title ?? host(e.url), type: "found", source: { label: host(e.url), url: e.url } });
    }
  }
  if (!facts.length) return null;
  return {
    id: `how:${p.runId}`,
    kind: "how-i-got-this",
    title: "How I got this",
    payload: { runId: p.runId, skillId: p.skillId, why: p.why, facts: facts.slice(0, 20) },
    links: [],
    runId: p.runId,
  };
}
