import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import { invalidateDealQueries } from "../lib/dealQueryKeys";

type ReplyIntent = "accept" | "negotiate" | "request_terms" | "decline";
type DraftStyle  = "friendly" | "professional";
type DraftVoice  = "athlete" | "agent";

interface GenerateOptions {
  reply_intent?:       ReplyIntent;
  /** The deal type's own intent (shared/deals) — the reply sheet's chip. The server drafts it as chosen (DEALS_REPLY_V2). */
  intent?:             string;
  /** Her "their term → your ask" rows. */
  term_asks?:          Array<{ term: string; ask: string }>;
  /** The ONE figure she typed (a counter, her rate). */
  figure?:             number;
  style?:              DraftStyle;
  voice?:              DraftVoice;
  selected_terms?:     string[];
  custom_instruction?: string;
  include_media_kit?:  boolean;
}

/**
 * Streams an LLM-generated reply draft for a deal from
 * `POST /api/v1/me/deals/:id/draft` (Server-Sent Events).
 *
 * Shared between the inline Reply preview card (DealCard) and the full
 * draft modal (DealActionSheet) so the SSE parsing lives in one place.
 */
// Watchdog budgets — the server also guards the stream, but the client must
// bound it independently so a dropped connection / stalled reader can't spin the
// UI forever (the reader.read() loop is otherwise unbounded).
const DRAFT_IDLE_MS  = 30_000;  // max gap between chunks
const DRAFT_TOTAL_MS = 120_000; // absolute ceiling

export function useDealDraft(dealId: string) {
  const qc = useQueryClient();
  const [draft, setDraft]         = useState("");
  const [streaming, setStreaming] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  /** The thread the server wrote this draft for (the stream's done event): propose the send on it. */
  const [threadId, setThreadId]   = useState<string | null>(null);

  const abortRef    = useRef<AbortController | null>(null);
  const mountedRef  = useRef(true);
  const timedOutRef = useRef(false);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setDraft("");
    setStreaming(false);
    setGenerated(false);
    setError(null);
  }, []);

  const generate = useCallback(async (opts: GenerateOptions = {}) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    timedOutRef.current = false;

    setStreaming(true);
    setDraft("");
    setGenerated(false);
    setError(null);

    // Idle timer resets on every chunk; total timer is a hard ceiling. Either
    // firing aborts the fetch, surfacing a timeout instead of an infinite spinner.
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOutRef.current = true; controller.abort(); }, DRAFT_IDLE_MS);
    };
    const totalTimer = setTimeout(() => { timedOutRef.current = true; controller.abort(); }, DRAFT_TOTAL_MS);

    try {
      bumpIdle();
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`${getApiUrl()}/api/v1/me/deals/${dealId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          reply_intent:       opts.reply_intent ?? "accept",
          style:              opts.style ?? "friendly",
          voice:              opts.voice ?? "athlete",
          selected_terms:     opts.selected_terms ?? [],
          custom_instruction: opts.custom_instruction?.trim() || undefined,
          include_media_kit:  opts.include_media_kit ?? false,
          ...(opts.intent ? { intent: opts.intent } : {}),
          ...(opts.term_asks?.length ? { term_asks: opts.term_asks } : {}),
          ...(opts.figure != null ? { figure: opts.figure } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const msg = await res.text().catch(() => "Unknown error");
        throw new Error(msg);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        bumpIdle();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload) as { token?: string; done?: boolean; error?: string; replace?: string; thread_id?: string | null };
            if (ev.error) { setError(ev.error); break; }
            if (ev.token) setDraft((prev) => prev + ev.token);
            // Final sanitized email (greeting + body + signature) — replaces the
            // raw streamed tokens wholesale.
            if (typeof ev.replace === "string") setDraft(ev.replace);
            if (ev.done)  { setGenerated(true); if (typeof ev.thread_id === "string") setThreadId(ev.thread_id); }
          } catch {}
        }
      }
    } catch (err: any) {
      if (timedOutRef.current) {
        setError("Draft timed out — try again.");
      } else if (err.name !== "AbortError") {
        setError("Could not generate draft — check your connection and try again.");
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      setStreaming(false);
    }
  }, [dealId]);

  // Allow the consumer to edit the draft text directly.
  const editDraft = useCallback((next: string) => {
    setDraft(next);
    setGenerated(true);
    // The "Saved"/"also in your Gmail drafts" confirmations describe the text as it was
    // when saved. Once it changes they are false, so they clear on the first keystroke
    // rather than asserting that unsaved edits are sitting in the athlete's Gmail.
    setSaved(false);
    setGmailDraft(null);
  }, []);

  // ── Persistence ──────────────────────────────────────────────────────────────
  //
  // Two callers with different needs, so the request itself is stateless and the
  // button wrapper owns the spinner:
  //   · persistDraft — fire-and-forget on sheet close. Touches no React state, so a
  //     component that is unmounting mid-request doesn't setState after unmount.
  //   · saveDraft    — the explicit "Save as draft" button; drives saving/saved.
  //
  // `mirrorToGmail` decides whether the server also writes a native Gmail Draft. A
  // silent autosave must NOT: it would put half-finished text in the athlete's real
  // mailbox, where the poll path then re-ingests it into the thread. Pressing the
  // button is the opt-in.
  const persistDraft = useCallback(async (
    body: string,
    opts: { mirrorToGmail?: boolean } = {},
  ): Promise<{ ok: boolean; gmailDraft?: string }> => {
    if (!body.trim()) return { ok: false };
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`${getApiUrl()}/api/v1/me/deals/${dealId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ body, mirror_to_gmail: opts.mirrorToGmail === true }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json().catch(() => ({}));
      // The deals list carries latest_draft, and it is cached with staleTime: Infinity.
      // Without this the draft is on the server but the NEXT open still reads the stale
      // cached deal, seeds an empty editor, and the whole restore feature silently does
      // nothing. Invalidate rather than refetch so a closing sheet doesn't block on it.
      invalidateDealQueries(qc);
      return { ok: true, gmailDraft: json?.latest_draft?.gmail_draft as string | undefined };
    } catch {
      return { ok: false };
    }
  }, [dealId, qc]);

  /** Abandon the saved draft. Used when the editor is emptied, so deleted text stays deleted. */
  const clearDraft = useCallback(async (): Promise<boolean> => {
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`${getApiUrl()}/api/v1/me/deals/${dealId}/draft`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(await res.text());
      invalidateDealQueries(qc);
      return true;
    } catch {
      return false;
    }
  }, [dealId, qc]);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  // Whether the last explicit save reached Gmail ("saved") or couldn't ("unavailable"),
  // so the UI can offer a reconnect instead of silently promising a Gmail draft.
  const [gmailDraft, setGmailDraft] = useState<string | null>(null);
  const saveDraft = useCallback(async (opts: { mirrorToGmail?: boolean } = {}) => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    setSaved(false);
    // Default ON: every caller of this is a deliberate "save this" press.
    const result = await persistDraft(draft, { mirrorToGmail: opts.mirrorToGmail !== false });
    // The sheet can be dismissed mid-request. Reporting into an unmounted component is
    // pointless, and `setError` here is the ONLY signal an explicit save failed — so if
    // nobody is left to read it, don't pretend otherwise.
    if (!mountedRef.current) return;
    if (result.ok) {
      setSaved(true);
      setGmailDraft(result.gmailDraft ?? null);
    } else {
      setError("Couldn't save draft — try again.");
    }
    setSaving(false);
  }, [draft, saving, persistDraft]);

  // Cleanup abort on unmount
  useEffect(() => () => { mountedRef.current = false; abortRef.current?.abort(); }, []);

  return {
    draft, streaming, generated, error, generate, reset, editDraft, threadId,
    saveDraft, persistDraft, clearDraft, saving, saved, gmailDraft,
  };
}
