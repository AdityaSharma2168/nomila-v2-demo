/**
 * use-push-preferences — her notification choices (GET / PATCH /api/v1/me/push/preferences): on or off, each kind, and
 * quiet hours. The server answers every write with the whole set, which replaces the cache.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

export interface PushPreferences {
  enabled: boolean;
  planReady: boolean;
  brandReply: boolean;
  waiting: boolean;
  /** "Mila's suggestions" (absent from an older server: read as on). */
  milaSuggestion?: boolean;
  quietHours: boolean;
  /** Minutes after local midnight. */
  quietStart: number;
  quietEnd: number;
  /** Lock-screen privacy: a brand's name in a notification only when on (default off). */
  showBrandNames: boolean;
}

const KEY = ["/api/v1/me/push/preferences"] as const;

export function usePushPreferences() {
  return useQuery<PushPreferences>({ queryKey: KEY, queryFn: () => apiRequest("GET", KEY[0]).then((r) => r.json()) });
}

export function useUpdatePushPreferences() {
  const qc = useQueryClient();
  return useMutation<PushPreferences, Error, Partial<PushPreferences>>({
    mutationFn: (patch) => apiRequest("PATCH", KEY[0], patch).then((r) => r.json()),
    // The switch moves at once; a failed write puts it back.
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: KEY });
      const before = qc.getQueryData<PushPreferences>(KEY);
      if (before) qc.setQueryData(KEY, { ...before, ...patch });
      return before;
    },
    onError: (_e, _p, before) => { if (before) qc.setQueryData(KEY, before as PushPreferences); },
    onSuccess: (next) => qc.setQueryData(KEY, next),
  });
}

/** "10pm" · "8am" · "10:30pm" — a quiet-hours bound in words. */
export function clockWords(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}
