/**
 * use-studio-edits — the typed edit door from the client (PR 9, Lane 3a): recommend, quote, run, accept,
 * discard. Every call is her tap's; nothing here fires on its own except the recommendation READ, which
 * spends nothing on her behalf and runs only when a brief exists.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import type {
  EditPresented,
  EditQuote,
  RecommendAnswer,
  StudioEditOp,
} from "../screens/studio/editTypes";
import { STUDIO_MEDIA_KEY } from "./use-studio-media";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(new URL(path, getApiUrl()).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await getAuthHeaders()),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `Something went wrong (${res.status})`);
  }
  return (await res.json()) as T;
}

export const RECOMMEND_KEY = ["studio", "edits", "recommend"] as const;

/**
 * The recommendation pass for the photo she just selected. Runs once per (asset, brief) for ten minutes
 * (the server memoizes the same key); disabled with no asset or no brief lines — manual only.
 */
export function useRecommendEdits(
  assetId: string | null,
  briefLines: readonly string[],
  brand: string | null,
) {
  return useQuery<RecommendAnswer>({
    queryKey: [...RECOMMEND_KEY, assetId, briefLines.join("\n"), brand],
    enabled: !!assetId && briefLines.length > 0,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: () =>
      post<RecommendAnswer>("/api/v1/me/studio/edits/recommend", {
        assetId,
        briefLines: [...briefLines],
        brand,
      }),
  });
}

export interface QuoteEditInput {
  sourceAssetId: string;
  op: StudioEditOp;
  params: Record<string, unknown>;
  brandId?: number | null;
  /** PR 18: one of her already-read references, as a style modifier. Built by `quoteBodyFor`; absent when none. */
  styleAssetId?: string;
}

export function useEditQuote() {
  return useMutation<
    { edit: EditPresented; quote: EditQuote },
    Error,
    QuoteEditInput
  >({
    mutationFn: (input) => post("/api/v1/me/studio/edits/quote", input),
  });
}

/** Spends, once. The server claims the quote atomically; a second tap answers the same refusal. */
export function useEditRun() {
  return useMutation<{ edit: EditPresented }, Error, { id: string }>({
    mutationFn: ({ id }) => post(`/api/v1/me/studio/edits/${id}/run`),
  });
}

/** The ONE library write. Her library strips re-read afterwards so the new photo can be picked. */
export function useEditAccept() {
  const qc = useQueryClient();
  return useMutation<
    { edit: EditPresented; assetId: string },
    Error,
    { id: string }
  >({
    mutationFn: ({ id }) => post(`/api/v1/me/studio/edits/${id}/accept`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STUDIO_MEDIA_KEY });
    },
  });
}

export function useEditDiscard() {
  return useMutation<{ edit: EditPresented }, Error, { id: string }>({
    mutationFn: ({ id }) => post(`/api/v1/me/studio/edits/${id}/discard`),
  });
}

// ─── Her already-read style references (PR 18) ──────────────────────────────────────────────────────────

export interface StyleReferenceRow {
  assetId: string;
  analysisId: string;
  /** The reading's light, in its words. Shown as plain text, never as markup. */
  caption: string;
  readAt: string;
  thumbUrl: string | null;
}

export const STYLE_REFS_KEY = ["studio", "style-references"] as const;

/**
 * The picker's list: ONLY references she has already had read (ADI-GO18 G8). Nothing here reads a new one or
 * spends. A 404 is the flag off on the server, and answers an empty list.
 */
export function useStyleReferences(enabled: boolean) {
  return useQuery<{ references: StyleReferenceRow[] }>({
    queryKey: [...STYLE_REFS_KEY],
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(
        new URL("/api/v1/me/studio/style-references", getApiUrl()).toString(),
        { headers: { ...(await getAuthHeaders()) } },
      );
      if (res.status === 404) return { references: [] };
      if (!res.ok) throw new Error(`Something went wrong (${res.status})`);
      return (await res.json()) as { references: StyleReferenceRow[] };
    },
  });
}

// ─── The carousel batch (Lane 4) ────────────────────────────────────────────────────────────────────────

export interface BatchLine {
  assetId: string;
  cleanup: { id: string; op: StudioEditOp; costUsd: number | null } | null;
  ads: { id: string; costUsd: number | null }[];
}
export interface BatchQuoteAnswer {
  batchId: string;
  lines: BatchLine[];
  totalUsd: number;
  unpriced: boolean;
}
export interface BatchViewAnswer {
  batchId: string;
  candidates: EditPresented[];
  intermediates: { id: string; status: string; sourceAssetId: string }[];
  running: boolean;
  canReroll: boolean;
}

export const BATCH_KEY = ["studio", "edits", "batch"] as const;
export const EDITS_KEY = ["studio", "edits", "list"] as const;

/** The itemized quote — nothing runs. */
export function useBatchQuote() {
  return useMutation<BatchQuoteAnswer, Error, Record<string, unknown>>({
    mutationFn: (body) => post("/api/v1/me/studio/edits/batch/quote", body),
  });
}

/** Her Create tap. Returns as soon as the rows are queued; the screen polls from here. */
export function useBatchRun() {
  const qc = useQueryClient();
  return useMutation<
    { batchId: string; queued: number },
    Error,
    { batchId: string }
  >({
    mutationFn: ({ batchId }) =>
      post(`/api/v1/me/studio/edits/batch/${batchId}/run`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BATCH_KEY });
    },
  });
}

/** The batch as the screen shows it, polled every 3 s while anything is still running. */
export function useBatch(batchId: string | null) {
  return useQuery<BatchViewAnswer>({
    queryKey: [...BATCH_KEY, batchId],
    enabled: !!batchId,
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
    queryFn: async () => {
      const res = await fetch(
        new URL(
          `/api/v1/me/studio/edits/batch/${batchId}`,
          getApiUrl(),
        ).toString(),
        {
          headers: { ...(await getAuthHeaders()) },
        },
      );
      if (!res.ok) throw new Error(`Something went wrong (${res.status})`);
      return (await res.json()) as BatchViewAnswer;
    },
  });
}

export function useBatchReroll() {
  const qc = useQueryClient();
  return useMutation<
    { id: string; costUsd: number | null; unpriced: boolean },
    Error,
    { batchId: string; assetId: string }
  >({
    mutationFn: ({ batchId, assetId }) =>
      post(`/api/v1/me/studio/edits/batch/${batchId}/reroll`, { assetId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BATCH_KEY });
    },
  });
}

/** Download all = keep every ready candidate (the discarded skipped). The library strips re-read. */
export function useBatchAcceptAll() {
  const qc = useQueryClient();
  return useMutation<
    { assetIds: string[]; skipped: number },
    Error,
    { batchId: string }
  >({
    mutationFn: ({ batchId }) =>
      post(`/api/v1/me/studio/edits/batch/${batchId}/accept-all`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BATCH_KEY });
      qc.invalidateQueries({ queryKey: STUDIO_MEDIA_KEY });
      qc.invalidateQueries({ queryKey: EDITS_KEY });
    },
  });
}

/** Her edit rows, newest first — the Now feed reads the carousels waiting for her out of it. */
export function useEditsList(enabled = true) {
  return useQuery<{ edits: EditPresented[] }>({
    queryKey: [...EDITS_KEY],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(
        new URL("/api/v1/me/studio/edits", getApiUrl()).toString(),
        {
          headers: { ...(await getAuthHeaders()) },
        },
      );
      if (res.status === 404) return { edits: [] }; // the flag is off
      if (!res.ok) throw new Error(`Something went wrong (${res.status})`);
      return (await res.json()) as { edits: EditPresented[] };
    },
  });
}
