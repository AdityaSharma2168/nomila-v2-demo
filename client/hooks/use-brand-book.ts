// The brand book (server/services/brandBook, BRAND_BOOK_V1): GET /api/v1/me/brand-book, her taps to write it, swap a
// line and make the reel. A 404 (the flag off) reads as `null`: Me keeps opening the existing brand screen. While the
// book is being written or the reel is rendering, the read polls every few seconds; otherwise it does not.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import type { BrandBookResponse, BrandBookReel } from "../../shared/brandBook";

export const BRAND_BOOK_KEY = "/api/v1/me/brand-book";

const busy = (b: BrandBookResponse | null | undefined) => b?.status === "building" || b?.reel?.status === "rendering";

export function useBrandBook(enabled = true) {
  return useQuery<BrandBookResponse | null>({
    queryKey: [BRAND_BOOK_KEY],
    enabled,
    queryFn: async () => {
      try { return (await (await apiRequest("GET", BRAND_BOOK_KEY)).json()) as BrandBookResponse; }
      catch (e) { if (e instanceof Error && e.message.startsWith("404")) return null; throw e; }
    },
    refetchInterval: (q) => (busy(q.state.data) ? 4000 : false),
  });
}

export function useWriteBrandBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await (await apiRequest("POST", BRAND_BOOK_KEY)).json()) as { status: "building"; version: number },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: [BRAND_BOOK_KEY] }); },
  });
}

export function useChooseLine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { page: string; slot: string; index: number }) =>
      (await (await apiRequest("POST", `${BRAND_BOOK_KEY}/line`, v)).json()) as BrandBookResponse,
    onSuccess: (book) => { qc.setQueryData([BRAND_BOOK_KEY], book); },
  });
}

export function useMakeBookReel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await (await apiRequest("POST", `${BRAND_BOOK_KEY}/reel`)).json()) as { reel: BrandBookReel },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: [BRAND_BOOK_KEY] }); },
  });
}
