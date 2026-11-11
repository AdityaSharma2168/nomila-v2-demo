import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type { MediaKitData } from "../components/card-native/types";

// ─── The Nomi Card itself (GET /api/card/:athleteId — signed MediaKitData) ─────
// The real card data: identity, deck order, the discriminated `cards[]` union, signed image/
// video URLs already baked in (server signs at serve time — see kitCache.signKit). Powers the
// native CardDeck (client/components/card-native/CardDeck.tsx).

// brandId > 0 fetches the brand-TAILORED deck (a pitch); omitted serves the generic card.
export function useAthleteCard(athleteId: string | undefined, brandId?: number) {
  const path = brandId ? `/api/card/${athleteId}?brandId=${brandId}` : `/api/card/${athleteId}`;
  const query = useQuery<MediaKitData>({
    queryKey: [path],
    enabled:  !!athleteId,
  });

  return {
    kit:       query.data,
    isLoading: query.isLoading,
    isError:   query.isError,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}

// ─── Persist the chosen look (PUT /api/v1/athletes/:id/card-theme[?brandId=N] — authed) ────
// Without brandId: her card's look, which flows to the app + every share of it. With brandId: the look of her pitch
// to that brand (until she picks one, the pitch wears the look recommended from the brand's category). Refetches
// the matching kit on success.

export function useSaveCardTheme(athleteId: string | undefined, brandId?: number) {
  const qc = useQueryClient();
  const path = brandId ? `/api/card/${athleteId}?brandId=${brandId}` : `/api/card/${athleteId}`;
  return useMutation<{ ok: boolean; theme: string }, Error, string>({
    mutationFn: (theme) =>
      apiRequest("PUT", `/api/v1/athletes/${athleteId}/card-theme${brandId ? `?brandId=${brandId}` : ""}`, { theme }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [path] });
    },
  });
}

// ─── Nomi Card themes (GET /api/card/themes — public) ──────────────────────────
// The card is theme-agnostic data; these are the "looks" a brand can be shown.

export interface CardThemesResponse {
  themes: string[];
}

export function useCardThemes() {
  const query = useQuery<CardThemesResponse>({
    queryKey: ["/api/card/themes"],
  });

  return {
    themes:    query.data?.themes ?? [],
    isLoading: query.isLoading,
    error:     query.error as Error | null,
  };
}

// ─── The athlete's shares (GET /api/v1/athletes/:id/shares — authed) ───────────
// Powers the "opens" pip on the Brand entry + the "Track opens" count.

export interface ShareListItem {
  id:         string;
  mode:       string;   // live | snapshot
  tailoring:  string;   // generic | brand
  scope:      string;   // public | recipient
  label:      string | null;
  recipient:  string | null;
  revoked:    boolean;
  createdAt:  string;
  opens:      number;
  lastOpened: string | null;
}

export function useShares(athleteId: string | undefined) {
  const query = useQuery<ShareListItem[]>({
    queryKey: [`/api/v1/athletes/${athleteId}/shares`],
    enabled:  !!athleteId,
  });

  const shares     = query.data ?? [];
  const totalOpens = shares.reduce((sum, s) => sum + (s.opens ?? 0), 0);

  return {
    shares,
    totalOpens,
    isLoading: query.isLoading,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}

// ─── Exact daily opens (GET /api/v1/athletes/:id/card-opens — authed) ──────────
// One row per calendar day with a real open, across all the athlete's shares — the
// precise 14-day overview strip (vs. lumping opens on each share's last-open day).

export interface CardOpensResponse {
  days:  number;
  byDay: { day: string; opens: number }[];   // day = "YYYY-MM-DD"
}

export function useAthleteOpensByDay(athleteId: string | undefined, days = 14) {
  const query = useQuery<CardOpensResponse>({
    queryKey: [`/api/v1/athletes/${athleteId}/card-opens`, days],
    queryFn:  () => apiRequest("GET", `/api/v1/athletes/${athleteId}/card-opens?days=${days}`).then((r) => r.json()),
    enabled:  !!athleteId,
  });
  return {
    byDay:     query.data?.byDay ?? [],
    isLoading: query.isLoading,
    refetch:   query.refetch,
  };
}

// ─── Create a share (POST /api/v1/athletes/:id/shares — authed) ────────────────
// Mirrors server CreateShareOpts; the first slice only needs { mode: "live" }.

export interface CreateShareInput {
  mode?:           "live" | "snapshot";
  tailoring?:      "generic" | "brand";
  brandId?:        number;   // per-brand tailoring — the picked/resolved brand
  dealId?:         string;
  scope?:          "public" | "recipient";
  gate?:           "none" | "email";
  label?:          string;
  recipientName?:  string;
  recipientEmail?: string;
  expiresAt?:      string;   // ISO date
}

export interface CreateShareResult {
  shareId:        string;
  url:            string;
  recipientToken: string | null;
}

export function useCreateShare(athleteId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<CreateShareResult, Error, CreateShareInput>({
    mutationFn: (body) =>
      apiRequest("POST", `/api/v1/athletes/${athleteId}/shares`, body).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/v1/athletes/${athleteId}/shares`] });
    },
  });
}

// ─── Per-share analytics (GET /api/v1/shares/:shareId/analytics — owner only) ───
// Opens · unique viewers · forwards · dwell — the sales-signal read on one share.

export interface ShareOpen {
  at:        string;   // ISO timestamp of the open
  isForward: boolean;  // opened without the recipient token (link was forwarded)
  dwellMs:   number | null;
}

export interface ShareAnalytics {
  opens:      number;
  viewers:    number;
  forwards:   number;
  lastOpened: string | null;
  avgDwellMs: number;
  timeline:   ShareOpen[];   // one entry per open, oldest → newest (exact dot strips)
}

export function useShareAnalytics(shareId: string | undefined) {
  const query = useQuery<ShareAnalytics>({
    queryKey: [`/api/v1/shares/${shareId}/analytics`],
    enabled:  !!shareId,
  });

  return {
    analytics: query.data,
    isLoading: query.isLoading,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}

// ─── Revoke a share (POST /api/v1/shares/:shareId/revoke — owner only) ─────────
// "Turn the link off." Invalidates the list + that share's analytics on success.

export function useRevokeShare(athleteId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (shareId) =>
      apiRequest("POST", `/api/v1/shares/${shareId}/revoke`).then((r) => r.json()),
    onSuccess: (_data, shareId) => {
      qc.invalidateQueries({ queryKey: [`/api/v1/athletes/${athleteId}/shares`] });
      qc.invalidateQueries({ queryKey: [`/api/v1/shares/${shareId}/analytics`] });
    },
  });
}

// ─── The athlete's pipeline brands (GET /api/v1/athletes/:id/brands — authed) ──
// The brands she's already talking to (from deals/threads → inboxBrands). Powers
// section 1 of the BrandPicker; `hasTailoredCard` marks the ones ready to send.

export interface AthleteBrand {
  brandId:         number;
  name:            string;
  category:        string | null;
  tier:            string | null;
  logoUrl:         string | null;
  domain:          string | null;
  description:     string | null;
  enriched:        boolean;
  hasTailoredCard: boolean;
}

export interface AthleteBrandsResponse {
  brands: AthleteBrand[];
}

export function useAthleteBrands(athleteId: string | undefined) {
  const query = useQuery<AthleteBrandsResponse>({
    queryKey: [`/api/v1/athletes/${athleteId}/brands`],
    enabled:  !!athleteId,
  });

  return {
    brands:    query.data?.brands ?? [],
    isLoading: query.isLoading,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}

// ─── Resolve / add a brand (POST /api/v1/brands/resolve — authed) ──────────────
// Dedup + add: converges on the shared getOrResearchBrand entry point. Returns the
// canonical brandId; `researching:true` = it's being researched right now (Spec 9).

export interface ResolveBrandInput {
  name:    string;
  domain?: string;
}

export interface ResolveBrandResult {
  brandId:     number;
  name:        string;
  logo:        string | null;
  category:    string | null;
  tier:        string | null;
  audience:    string | null;
  description: string | null;
  domain:      string | null;
  researching: boolean;
}

export function useResolveBrand() {
  return useMutation<ResolveBrandResult, Error, ResolveBrandInput>({
    mutationFn: (body) =>
      apiRequest("POST", "/api/v1/brands/resolve", body).then((r) => r.json()),
  });
}

// ─── Global brand suggestions (GET /api/v1/brands/search?q= — authed) ──────────
// Already-researched brands from the shared store — the "Other brands we know" section of
// the create picker, so a known brand is one tap without re-researching.

export interface GlobalBrand {
  brandId:     number;
  name:        string;
  category:    string | null;
  tier:        string | null;
  logoUrl:     string | null;
  domain:      string | null;
  description: string | null;
}

export function useSearchBrands(q: string) {
  const needle = q.trim();
  const query = useQuery<{ brands: GlobalBrand[] }>({
    queryKey: [`/api/v1/brands/search`, needle],
    queryFn:  () => apiRequest("GET", `/api/v1/brands/search?q=${encodeURIComponent(needle)}`).then((r) => r.json()),
    enabled:  needle.length >= 2,
  });
  return { results: query.data?.brands ?? [], isLoading: query.isLoading };
}
