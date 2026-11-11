/**
 * agent/documents/cards.ts — the chat cards the documents tools and the document_build workflow show, built by code
 * from the source's own state (never from model prose).
 *
 *   ready     what the app draws today: the document's kind, its name, one status line and Open. Sent while
 *             AGENT_DOCUMENTS_CARD is off (everywhere, until the owner approves the new card).
 *   document  the proposed card (shared/agent.ts DocumentCardPayload): preview, status, Open · Change something · Share.
 *   progress  a build in the background (documents_make), flipped to done or failed by the workflow's tell step.
 *
 * Open goes to the screen the app already maps in the chat (client/lib/agent/navigate.ts chatTargetFor): Me for the
 * brand book and the public page, Pitches for a pitch.
 */
import type { ChatCard, DocumentCardPayload, DocumentKind, ReadyCardPayload } from "../../../shared/agent";
import { agentDocumentsCardEnabled } from "./config";
import type { DocRef, DocSummary } from "./source";

export const KIND_LABEL: Record<DocumentKind, string> = { brand_book: "Brand book", public_page: "Public page", pitch: "Pitch" };

/** The document's name as the athlete reads it. */
export function docTitle(kind: DocumentKind, brandName: string | null): string {
  if (kind === "pitch") return `${brandName ?? "Brand"} pitch`;
  return kind === "brand_book" ? "Your brand book" : "Your public page";
}

const day = (iso: string | null, now: Date): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(t).toISOString().slice(0, 10);
};

/** "Ready · updated today · not shared yet" — the one line under the title. */
export function statusLine(s: DocSummary, now: Date = new Date()): string {
  if (s.state === "building") return "Being made now";
  if (s.state === "failed") return "Couldn't be finished last time";
  if (s.state === "none") return "Not made yet";
  const parts: string[] = ["Ready"];
  const when = day(s.updatedAt, now);
  if (when) parts.push(`updated ${when}`);
  if (s.kind === "pitch") {
    parts.push(s.shared ? (s.shared.opens ? `opened ${s.shared.opens} ${s.shared.opens === 1 ? "time" : "times"}` : "shared, not opened yet") : "not shared yet");
    if (s.stale) parts.push("your page changed since");
  }
  if (s.kind === "public_page") parts.push(s.published ? `published${s.published.version ? ` (version ${s.published.version})` : ""}` : "not published");
  return parts.join(" · ");
}

const OPEN_SCREEN: Record<DocumentKind, string> = { brand_book: "me", public_page: "me", pitch: "pitches" };
const READY_KIND: Record<DocumentKind, ReadyCardPayload["itemKind"]> = { brand_book: "brief", public_page: "page", pitch: "deck" };

function refKey(s: Pick<DocSummary, "kind" | "brand">): string {
  return s.kind === "pitch" ? `pitch:${s.brand?.id ?? 0}` : s.kind;
}

/** The card for one document: the proposed `document` card while AGENT_DOCUMENTS_CARD is on, else today's `ready` card. */
export function documentCard(s: DocSummary, runId: string, now: Date = new Date()): ChatCard {
  const title = docTitle(s.kind, s.brand?.name ?? null);
  const link = { label: "Open", target: { screen: OPEN_SCREEN[s.kind] } };
  const id = `doc:${runId}:${refKey(s)}`;
  if (agentDocumentsCardEnabled()) {
    const name = s.kind === "pitch" ? `my ${s.brand?.name ?? ""} pitch`.replace(/\s+/g, " ") : s.kind === "brand_book" ? "my brand book" : "my public page";
    const payload: DocumentCardPayload = {
      kind: s.kind,
      brand: s.brand ? { id: s.brand.id, name: s.brand.name, logoUrl: s.brand.logoUrl } : null,
      state: s.state,
      statusLine: statusLine(s, now),
      thumbUrl: s.thumbUrl,
      updatedAt: s.updatedAt,
      shared: s.kind === "pitch" ? s.shared : null,
      published: s.kind === "public_page" ? s.published : null,
      actions: {
        change: s.state === "ready" ? `Change something on ${name}` : null,
        share: s.state === "ready" && s.kind !== "brand_book" ? (s.kind === "pitch" ? `Share ${name}` : "Publish my public page") : null,
      },
    };
    return { id, kind: "document", title, payload, links: [link], runId };
  }
  const payload: ReadyCardPayload = { itemKind: READY_KIND[s.kind], itemId: refKey(s), summary: statusLine(s, now), experimental: false };
  return { id, kind: "ready", title, payload, links: [link], runId };
}

/** The progress card documents_make shows while the document_build run works (its tell step flips it). */
export function buildProgressCard(workflowRunId: string, ref: DocRef, runId: string): ChatCard {
  const label = ref.kind === "pitch" ? `Building your pitch for ${ref.brand.name}` : ref.kind === "brand_book" ? "Writing your brand book" : "Rebuilding your public page";
  return {
    id: `doc-progress:${workflowRunId}`, kind: "progress", title: label,
    payload: { step: 1, of: 1, label, state: "running", steps: [{ label, state: "running" }], workflowRunId }, links: [], runId,
  };
}

/** The same progress card, done or failed (the tell step rewrites it in place). */
export function progressSettled(card: ChatCard, state: "done" | "failed"): ChatCard {
  if (card.kind !== "progress") return card;
  return { ...card, payload: { ...card.payload, state, steps: (card.payload.steps ?? []).map((s) => ({ ...s, state })) } };
}
