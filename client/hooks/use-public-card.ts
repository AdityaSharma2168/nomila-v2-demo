// use-public-card — her public card's reads and writes (react-query over lib/publicCardApi).
//
//   usePublicCardDraft(enabled)    GET draft         the Me section, Review, Settings (availability, switches, handle)
//   usePublicCardPreview(enabled)  GET preview       the Preview screen, the publish sheet's summary, Settings' socials
//   useSaveDecisions()             PUT draft         Review; serialised (one scope) so whole-replace writes land in order
//   usePublishCard()               POST publish      the publish sheet, on her tap only
//   useUnpublishCard()             POST unpublish    Settings, after her confirm
//   useSetSwitches()               PATCH switches    Settings
//   useSetHandle()                 PUT handle        Settings
//
// Every write puts the server's answer into the draft cache and refreshes the preview, so each screen shows the
// server's truth after a change, never a guess.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publicCardApi } from "../lib/publicCardApi";
import type { PublicCardDraftRequest, PublicCardDraftResponse, PublicCardSwitchesRequest } from "../../shared/publicCard";

export const PUBLIC_CARD_KEY = ["me", "public-card"] as const;
export const DRAFT_KEY = [...PUBLIC_CARD_KEY, "draft"] as const;
export const PREVIEW_KEY = [...PUBLIC_CARD_KEY, "preview"] as const;

export function usePublicCardDraft(enabled = true) {
  return useQuery({ queryKey: DRAFT_KEY, queryFn: publicCardApi.getDraft, enabled });
}

export function usePublicCardPreview(enabled = true) {
  return useQuery({ queryKey: PREVIEW_KEY, queryFn: publicCardApi.getPreview, enabled, staleTime: 0 });
}

export function useSaveDecisions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: PublicCardDraftRequest) => publicCardApi.saveDecisions(d),
    scope: { id: "public-card-decisions" },
    onSuccess: (draft) => {
      qc.setQueryData(DRAFT_KEY, draft);
      qc.invalidateQueries({ queryKey: PREVIEW_KEY });
    },
  });
}

export function usePublishCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => publicCardApi.publish(),
    onSettled: () => { qc.invalidateQueries({ queryKey: PUBLIC_CARD_KEY }); },
  });
}

export function useUnpublishCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => publicCardApi.unpublish(),
    onSettled: () => { qc.invalidateQueries({ queryKey: PUBLIC_CARD_KEY }); },
  });
}

export function useSetSwitches() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PublicCardSwitchesRequest) => publicCardApi.setSwitches(patch),
    scope: { id: "public-card-switches" },
    onSuccess: (r) => {
      qc.setQueryData<PublicCardDraftResponse>(DRAFT_KEY, (d) => (d ? { ...d, card: { ...d.card, switches: r.switches } } : d));
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: PUBLIC_CARD_KEY }); },
  });
}

export function useSetHandle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => publicCardApi.setHandle(handle),
    onSuccess: (r) => {
      qc.setQueryData<PublicCardDraftResponse>(DRAFT_KEY, (d) => (d ? { ...d, card: { ...d.card, handle: r.handle, handleChangeAvailableAt: r.handleChangeAvailableAt } } : d));
      qc.invalidateQueries({ queryKey: PUBLIC_CARD_KEY });
    },
  });
}
