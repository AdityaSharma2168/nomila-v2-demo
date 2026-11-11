import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

// ─── Nomi Card editor — the athlete's control surface (server contract, DO NOT change) ──
// GET assembles the deck + everything addable/editable; PUT persists a thin override
// layer on top of the Strategist's auto-built deck. Overrides apply at serve automatically,
// so the /card/:id WebView shows edits as soon as the PUT resolves.

export interface CardEditableField {
  field:      string;
  value:      string;
  alternates: string[];   // ~5 Narrator (Mila) takes; may be [] (nothing to pick between)
}

export interface CardEditorCard {
  id:       string;
  type:     string;
  title:    string;
  editable: CardEditableField[];
  image:    string | null;         // signed URL — only cover/fit-style cards carry one
  mediaGcsPath?: string | null;    // durable path of the card's current media (for the picker's "On card" badge)
}

export interface CardEditorLibraryItem {
  id:    string;
  type:  string;
  title: string;
}

export interface CardImagePoolItem {
  gcsPath:  string;
  shotType: string;
  hero:     number;
  url:      string;   // signed thumb
}

export interface CardOverrides {
  order?:  string[];    // athlete's card sequence — cover is always pinned first
  removed?: string[];   // hidden card ids (cover can NOT be removed)
  added?:   string[];   // library card ids pulled into the deck
  copy?:    Record<string, { text: string; pick?: number }>;   // key = `${cardId}.${field}`
  // cardId → media swap: a bare gcsPath for photo cards; { path, poster } for the video card.
  images?:  Record<string, string | { path: string; poster?: string }>;
}

export interface CardEditorResponse {
  deck:       string[];
  library:    CardEditorLibraryItem[];
  cards:      CardEditorCard[];
  overrides:  CardOverrides;
  imagePool:  CardImagePoolItem[];
}

// ─── GET /api/v1/athletes/:id/card-editor?brandId=0 (authed) ───────────────────

export function useCardEditor(athleteId: string | undefined, brandId = 0) {
  const query = useQuery<CardEditorResponse>({
    queryKey: [`/api/v1/athletes/${athleteId}/card-editor`, brandId],
    queryFn:  () =>
      apiRequest("GET", `/api/v1/athletes/${athleteId}/card-editor?brandId=${brandId}`).then((r) => r.json()),
    enabled:  !!athleteId,
  });

  return {
    deck:       query.data?.deck ?? [],
    library:    query.data?.library ?? [],
    cards:      query.data?.cards ?? [],
    overrides:  query.data?.overrides ?? {},
    imagePool:  query.data?.imagePool ?? [],
    isLoading:  query.isLoading,
    error:      query.error as Error | null,
    refetch:    query.refetch,
  };
}

// ─── PUT /api/v1/athletes/:id/card-overrides?brandId=0 (authed) ────────────────
// On success, invalidate the editor query (every brandId variant for this athlete, since
// the key prefix-matches) plus the athlete-brands list — `hasTailoredCard` reads the same
// deck this mutates.

export function useSaveOverrides(athleteId: string | undefined, brandId = 0) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, CardOverrides>({
    mutationFn: (body) =>
      apiRequest("PUT", `/api/v1/athletes/${athleteId}/card-overrides?brandId=${brandId}`, body).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/v1/athletes/${athleteId}/card-editor`] });
      qc.invalidateQueries({ queryKey: [`/api/v1/athletes/${athleteId}/brands`] });
      // The rendered deck reads /api/card/:id (staleTime: Infinity) — refetch it so published
      // edits (copy, order, photo swaps) actually show on the card, not just in the editor preview.
      qc.invalidateQueries({ queryKey: [`/api/card/${athleteId}`] });
    },
  });
}
