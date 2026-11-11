/**
 * use-studio-qa — one generated asset's verdict and cost, read back (PR 11, R-4/R-5).
 *
 *   GET /api/v1/me/studio/assets/:assetId/qa → { assetId, verdict, cost }
 *
 * Behind EXPO_PUBLIC_STUDIO_QA_DISPLAY: off, the query is disabled and nothing is fetched — the
 * chip renders nothing and the server's own STUDIO_QA_DISPLAY answers 404 anyway. The wire shape is
 * the server's (server/studio/qa/routes.ts): flag-or-pass wording, a label, and the cost. No score,
 * no threshold, no number to compare against — those never leave the record.
 */
import { useQuery } from "@tanstack/react-query";
import { getApiUrl, getAuthHeaders } from "../lib/query-client";
import { STUDIO_QA_DISPLAY } from "../lib/flags";

export type QaWording = "pass" | "flag";

export interface QaVerdictWire {
  wording: QaWording;
  label: string;
  subject: "edit" | "generate" | "clip";
  at: string;
  unknownChecks: number;
  identityObservation: { caption: string; caveat: string } | null;
  /** PR 17 (R-6): absent unless the record carries a drift observation. A time and a count, never a score. */
  driftObservation?: { caption: string; line: string };
  spendUsd: number;
}

export interface QaCostWire {
  usd: number;
  basis: "authoritative" | "estimated";
  source: "edit_row" | "job_quote";
}

/**
 * quality-scrappy piece 2: the structure check (length, shape, black, frozen, silent) — flag-or-pass, a label, and
 * one plain sentence per reason. Absent unless the record carries one. Never a number.
 */
export interface QaStructureWire {
  wording: QaWording;
  label: string;
  lines: string[];
}

export interface QaWire {
  assetId: string;
  verdict: QaVerdictWire | null;
  cost: QaCostWire | null;
  structure?: QaStructureWire;
}

export const STUDIO_QA_KEY = ["studio", "qa"] as const;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, getApiUrl()).toString(), {
    headers: { ...(await getAuthHeaders()) },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `Something went wrong (${res.status})`);
  }
  return (await res.json()) as T;
}

export function useAssetQa(assetId: string | null | undefined) {
  return useQuery<QaWire>({
    queryKey: [...STUDIO_QA_KEY, assetId ?? null],
    // The flag first: off, this never fetches, whatever the id.
    enabled: STUDIO_QA_DISPLAY && !!assetId,
    staleTime: 60_000,
    retry: false,
    queryFn: () => get<QaWire>(`/api/v1/me/studio/assets/${assetId}/qa`),
  });
}
