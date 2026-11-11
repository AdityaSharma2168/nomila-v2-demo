// Receipts for what she did to a deal, with Undo (deals design §5: "Undo is on the receipt, labelled as her own action").
//
// The server writes ONE agent_actions row per act and marks who did it: payload.actor "athlete" (her tap — closing a deal,
// her "yes" that marked it agreed) or the agent's own filing (no actor, or "mila"). The receipt says so in plain words;
// it never claims Nomila did what she did. The routes that act (dispose, approve) don't return the receipt's id, so Undo
// finds the newest live receipt on that deal for that act and undoes it.
import { apiRequest } from "../../lib/query-client";
import type { AgentActionKind, AgentActionRow } from "../../hooks/use-agent-actions";

/** Who did it, as she reads it. Pure. */
export function receiptActor(row: Pick<AgentActionRow, "payload">): "You" | "Mila" | "Nomila" {
  const actor = row.payload?.actor;
  if (actor === "athlete") return "You";
  if (actor === "mila") return "Mila";
  return "Nomila";
}

/** The receipt's one line: "Marked agreed · by you", "Closed as not interested · by you", "Set aside · by Nomila". Pure. */
export function receiptLine(row: Pick<AgentActionRow, "action" | "payload">): string {
  const who = receiptActor(row);
  const by = who === "You" ? "by you" : `by ${who}`;
  const p = row.payload ?? {};
  if (p.kind === "deal_agreed") return `Marked agreed · ${by}`;
  if (row.action === "reclassify") {
    const label = p.athlete_label as string | undefined;
    if (label === "not_a_deal") return `Closed as not a deal · ${by}`;
    if (label === "expired") return `Closed as too late · ${by}`;
    if (label === "not_interested") return `Closed as not interested · ${by}`;
  }
  if (row.action === "confirm_signed") return `Marked signed · ${by}`;
  if (row.action === "file" || row.action === "auto_archive") return `Set aside · ${by}`;
  return `Done · ${by}`;
}

/** The newest live (not undone, reversible) receipt on this deal that matches. Pure. */
export function pickReceipt(rows: readonly AgentActionRow[], match: (r: AgentActionRow) => boolean): AgentActionRow | null {
  const live = rows.filter((r) => !r.undone_at && r.reversible && match(r));
  live.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  return live[0] ?? null;
}

/** Find the receipt and undo it. Resolves to the undone row, or null when there was nothing to undo. */
export async function undoLatest(dealId: string, action: AgentActionKind, match: (r: AgentActionRow) => boolean = () => true): Promise<AgentActionRow | null> {
  const rows = (await (await apiRequest("GET", `/api/v1/me/agent-actions?deal_id=${encodeURIComponent(dealId)}&action=${action}`)).json()) as AgentActionRow[];
  const row = pickReceipt(Array.isArray(rows) ? rows : [], match);
  if (!row) return null;
  await apiRequest("POST", `/api/v1/me/agent-actions/${row.id}/undo`);
  return row;
}

export const isAgreedReceipt = (r: AgentActionRow) => r.payload?.kind === "deal_agreed";
export const isDisposeReceipt = (r: AgentActionRow) => r.payload?.actor === "athlete" && typeof r.payload?.athlete_label === "string";
