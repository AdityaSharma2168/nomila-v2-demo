// The M.I.A. card's data as today's Home score block reads it (screens/home/HomeScreen.tsx), shared by Home v3's small
// ring and Me v3's full card: GET /me/overview's entry, then GET /me/intelligence for the read and the bands.

import { useMeOverview } from "../../hooks/use-me-knowledge";
import { useMeIntelligence } from "../../hooks/use-me-intelligence";
import { meCardModel, ringBands } from "../../lib/myIntelligenceLogic";
import { confidenceHomeLine } from "../../lib/strategyLogic";

export function useMiaCard() {
  const overview = useMeOverview();
  const entry = overview.data?.intelligence ?? null;
  const intel = useMeIntelligence(!!entry && entry.score != null);
  const card = meCardModel(entry, intel.data);
  const assessment = card.score ? intel.data?.assessment ?? null : null;
  return {
    overview,
    entry,
    intel,
    score: card.score ? Number(card.score) : null,
    early: card.early,
    line: card.line,
    bands: assessment && !card.early ? ringBands(assessment) : undefined,
    confidence: assessment ? confidenceHomeLine(assessment.overall.level) : null,
    preliminary: !!(intel.data?.preview?.preliminary ?? entry?.preliminary),
    preliminaryLine: intel.data?.preview?.label ?? null,
    refetch: () => Promise.all([overview.refetch(), entry && entry.score != null ? intel.refetch() : undefined]),
  };
}
