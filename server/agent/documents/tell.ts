/**
 * agent/documents/tell.ts — the document_build tell step: Mila comes back into each chat that asked.
 *
 *   1. The chats that asked: assistant rows whose cards hold this run's progress card (payload.workflowRunId), written
 *      by documents_make in that chat's turn (or in a later chat that joined the build).
 *   2. Per asking chat, once (the follow-up card id is doc-ready:<run>): the progress card flips to done or failed in
 *      place, and ONE assistant row goes under it — a fixed line (below; no model call, no cost) and, when the document
 *      is ready, its card.
 *
 * The line is code, not a model: it says only what happened, so there is nothing to check. Nothing here sends anything.
 */
import type { ChatCard } from "../../../shared/agent";
import { documentCard, progressSettled } from "./cards";
import type { DocBrand, DocRef, DocumentsSource } from "./source";
import type { DocumentBuildInput } from "./workflow";

export interface DocTellChats {
  /** Assistant rows holding this run's progress card, athlete-scoped: one per asking chat (the newest). */
  asking(athleteId: string, workflowRunId: string): Promise<Array<{ rowId: string; conversationId: string; cards: ChatCard[] }>>;
  hasCard(athleteId: string, conversationId: string, cardId: string): Promise<boolean>;
  setCards(athleteId: string, rowId: string, cards: ChatCard[]): Promise<void>;
  insert(athleteId: string, conversationId: string, row: { content: string; cards: ChatCard[] }): Promise<void>;
}

export const docReadyCardId = (runId: string) => `doc-ready:${runId}`;

/** What Mila says when the build settles. Fixed text; a brand's name is one of her own brands. */
export function readyLine(i: Pick<DocumentBuildInput, "kind" | "brandName">, ok: boolean, needsALook = false): string {
  const what = i.kind === "pitch" ? `your pitch for ${i.brandName ?? "that brand"}` : i.kind === "brand_book" ? "your brand book" : "your public page";
  // Built, but it failed its check before delivery (A4): not ready, said plainly. Nothing was sent or published.
  if (!ok && needsALook) return `I made ${what}, but it needs a look before it's ready, so I'm not showing it yet. Nothing went out. Ask me to try again.`;
  if (!ok) return `I couldn't finish ${what} this time. Nothing changed and nothing went out. Ask me again in a little while.`;
  const lead = what.charAt(0).toUpperCase() + what.slice(1);
  return i.kind === "brand_book"
    ? `${lead} is ready. Tell me anything you'd like changed.`
    : `${lead} is ready. Tell me anything you'd like changed, or ask me to share it when you're happy.`;
}

export async function tellDocumentReady(
  deps: { chats: DocTellChats; source: Pick<DocumentsSource, "summary">; now?: Date },
  athleteId: string,
  run: { runId: string; input: DocumentBuildInput; ok: boolean; needsALook?: boolean },
): Promise<{ told: string[]; alreadyTold: string[] }> {
  const asking = await deps.chats.asking(athleteId, run.runId);
  const told: string[] = [];
  const alreadyTold: string[] = [];
  if (!asking.length) return { told, alreadyTold };

  const ref: DocRef | null = run.input.kind === "pitch"
    ? (run.input.brandId ? { kind: "pitch", brand: { id: run.input.brandId, name: run.input.brandName ?? "Brand", logoUrl: null, confirmed: true, researched: true } satisfies DocBrand } : null)
    : { kind: run.input.kind };
  const s = run.ok && ref ? await deps.source.summary(athleteId, ref).catch(() => null) : null;
  const cardId = docReadyCardId(run.runId);
  const cards: ChatCard[] = s && s.state === "ready" ? [{ ...documentCard(s, run.runId, deps.now), id: cardId }] : [];
  // A ready document whose card couldn't be read is still ready: say so without a card rather than say it failed.
  const line = readyLine(run.input, run.ok, !!run.needsALook);

  for (const a of asking) {
    // Told already: the follow-up card is there, or this chat's progress card has settled (a write that had no card).
    const progress = a.cards.find((c) => c.kind === "progress" && c.payload.workflowRunId === run.runId);
    const settled = progress?.kind === "progress" && progress.payload.state !== "running";
    if (settled || (await deps.chats.hasCard(athleteId, a.conversationId, cardId))) { alreadyTold.push(a.conversationId); continue; }
    const flipped = a.cards.map((c) => (c.kind === "progress" && c.payload.workflowRunId === run.runId ? progressSettled(c, run.ok ? "done" : "failed") : c));
    // The line first, then the flip: a retry after a crash between the two writes finds the card (ready) and stops.
    await deps.chats.insert(athleteId, a.conversationId, { content: line, cards });
    await deps.chats.setCards(athleteId, a.rowId, flipped);
    told.push(a.conversationId);
  }
  return { told, alreadyTold };
}
