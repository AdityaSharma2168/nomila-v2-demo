// publicCardApi — the ONE transport for her public card (server/routes/mePublicCard.ts). Typed with the shared
// contract (shared/publicCard.ts). Every route answers only for the signed-in athlete: nothing here sends an athlete id.
//
//   GET   /api/v1/me/public-card/draft      getDraft()          her chapters, items, what was cut, canPublish
//   PUT   /api/v1/me/public-card/draft      saveDecisions(d)    her decisions, replaced whole
//   GET   /api/v1/me/public-card/preview    getPreview()        exactly what Publish would freeze now
//   POST  /api/v1/me/public-card/publish    publish()           HER tap only (tap-to-send)
//   POST  /api/v1/me/public-card/unpublish  unpublish()
//   PATCH /api/v1/me/public-card/switches   setSwitches(patch)
//   PUT   /api/v1/me/public-card/handle     setHandle(handle)
//
// Errors are thrown as apiRequest throws them ("<status>: <body>"); publicCardError() in publicCardLogic reads them.
// Tests replace this module and nothing else.

import { apiRequest, getApiUrl } from "./query-client";
import type {
  PublicCardDraftRequest, PublicCardDraftResponse, PublicCardHandleResponse, PublicCardPreviewResponse,
  PublicCardPublishResponse, PublicCardSwitchesRequest, PublicCardSwitchesResponse, PublicCardUnpublishResponse,
} from "../../shared/publicCard";

const BASE = "/api/v1/me/public-card";

async function json<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, route, body);
  return (await res.json()) as T;
}

export const publicCardApi = {
  getDraft: () => json<PublicCardDraftResponse>("GET", `${BASE}/draft`),
  saveDecisions: (d: PublicCardDraftRequest) => json<PublicCardDraftResponse>("PUT", `${BASE}/draft`, d),
  getPreview: () => json<PublicCardPreviewResponse>("GET", `${BASE}/preview`),
  publish: () => json<PublicCardPublishResponse>("POST", `${BASE}/publish`, {}),
  unpublish: () => json<PublicCardUnpublishResponse>("POST", `${BASE}/unpublish`, {}),
  setSwitches: (patch: PublicCardSwitchesRequest) => json<PublicCardSwitchesResponse>("PATCH", `${BASE}/switches`, patch),
  setHandle: (handle: string) => json<PublicCardHandleResponse>("PUT", `${BASE}/handle`, { handle }),
  /** Where the public page lives: EXPO_PUBLIC_PUBLIC_CARD_BASE_URL when set, else the API host (which serves /p/:handle). */
  publicBase: (): string => (process.env.EXPO_PUBLIC_PUBLIC_CARD_BASE_URL?.trim() || getApiUrl()).replace(/\/+$/, ""),
};
