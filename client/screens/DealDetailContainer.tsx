import React, { useCallback, useState } from "react";
import { Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { OpportunitiesStackParamList } from "../navigation/MainTabNavigator";
import { DealDetailScreen, type DealDetailSection } from "./DealDetailScreen";
import { DealActionSheet } from "../components/deals/DealActionSheet";
import { DismissSheet, type DealDisposition } from "../components/deals/DismissSheet";
import { CreatePitchFlow } from "../components/pitch/CreatePitchFlow";
import type { DealItem } from "../components/deals/DealCard";
import { useAuth } from "../lib/auth-context";
import { useDeals } from "../hooks/use-deals";
import { apiRequest } from "../lib/query-client";
import { openReply } from "../lib/reply-link";
import { proposeAndApproveReply, sendErrorMessage } from "../hooks/use-pending-actions";
import { statusAfterReply } from "../components/deals/replyStatus";

// ─────────────────────────────────────────────────────────────────────────────
// DealDetailContainer — holds the overlay state (DealActionSheet + CreatePitchFlow)
// and mutation wiring for the pushed DealDetailScreen. Everything here mirrors
// OpportunitiesScreen's Classic list: the status/saved PATCH helpers and the
// DealActionSheet onSend are reused verbatim so send/status behavior is identical.
// ─────────────────────────────────────────────────────────────────────────────

type Nav = NativeStackNavigationProp<OpportunitiesStackParamList, "DealDetail">;

export function DealDetailContainer({
  dealId,
  section,
}: {
  dealId: string;
  section?: DealDetailSection;
}) {
  const navigation = useNavigation<Nav>();
  const { athlete } = useAuth();
  const { refetch } = useDeals();

  const [activeSheet, setActiveSheet] =
    useState<{ deal: DealItem; mode: "accept" | "negotiate" | "terms" } | null>(null);
  const [pitchDeal, setPitchDeal] = useState<DealItem | null>(null);
  const [dismissing, setDismissing] = useState<DealItem | null>(null);
  const [disposing, setDisposing] = useState(false);

  // Same status/saved mutation helpers OpportunitiesScreen uses (PATCH → refetch).
  const handleSetStatus = useCallback(
    async (id: string, status: string) => {
      try {
        await apiRequest("PATCH", `/api/v1/me/deals/${id}`, { status });
      } finally {
        await refetch();
      }
    },
    [refetch],
  );

  const handleToggleSaved = useCallback(
    async (id: string, saved: boolean) => {
      try {
        await apiRequest("PATCH", `/api/v1/me/deals/${id}`, { saved });
      } finally {
        await refetch();
      }
    },
    [refetch],
  );


  /**
   * The labelled dismiss. "Save for later" is a plain bookmark, but the two judgements
   * post to /dispose, which records payload.athlete_label — the ground-truth signal the
   * eval fixture cannot source automatically (a reply means "declining politely" as often
   * as it means "interested", and an advanced status can be the summarizer's own doing).
   */
  const handleDispose = useCallback(
    async (deal: DealItem, disposition: DealDisposition) => {
      if (disposition === "save") {
        setDismissing(null);
        await handleToggleSaved(deal.id, !deal.saved);
        return;
      }
      setDisposing(true);
      try {
        await apiRequest("POST", `/api/v1/me/deals/${deal.id}/dispose`, { disposition });
        setDismissing(null);
        navigation.goBack();
      } catch (err) {
        // Keep the sheet open so the choice isn't silently lost.
        Alert.alert("Couldn't save that", err instanceof Error ? err.message : String(err));
      } finally {
        setDisposing(false);
      }
    },
    [handleToggleSaved, navigation],
  );

  return (
    <>
      <DealDetailScreen
        dealId={dealId}
        initialSection={section}
        onBack={() => navigation.goBack()}
        onAccept={(deal) => setActiveSheet({ deal, mode: "accept" })}
        onNegotiate={(deal) => setActiveSheet({ deal, mode: "negotiate" })}
        onAskTerms={(deal) => setActiveSheet({ deal, mode: "terms" })}
        onDecline={(deal) => setDismissing(deal)}
        onSetStatus={handleSetStatus}
        onToggleSaved={handleToggleSaved}
        onViewThread={(deal) => {
          if (deal.threadId)
            navigation.navigate("Thread", { threadId: deal.threadId, brandName: deal.brandName });
        }}
        onOpenPitch={(deal) => {
          if (deal.brandId != null) setPitchDeal(deal);
        }}
      />

      {/* Composer — reused verbatim from OpportunitiesScreen (send behavior frozen). */}
      {activeSheet && (
        <DealActionSheet
          deal={activeSheet.deal}
          mode={activeSheet.mode}
          onClose={() => setActiveSheet(null)}
          onSend={async (body: string, intent) => {
            const { deal } = activeSheet;
            try {
              if (deal.threadId) {
                await proposeAndApproveReply({ dealId: deal.id, threadId: deal.threadId, body });
              } else {
                await openReply(null, body);
              }
            } catch (err: any) {
              Alert.alert(
                "Couldn't send reply",
                sendErrorMessage(err),
              );
              return; // keep the sheet open so the draft isn't lost
            }
            setActiveSheet(null);
            handleSetStatus(deal.id, statusAfterReply(intent));
          }}
        />
      )}

      {/* Per-deal pitch — seeds CreatePitchFlow with the deal's brand and jumps to
          the Studio PitchDetail on completion (mirrors StudioScreen's onCreated). */}
      {pitchDeal && pitchDeal.brandId != null && (
        <CreatePitchFlow
          visible
          athleteId={athlete?.id}
          initialBrand={{
            brandId: pitchDeal.brandId,
            name: pitchDeal.brandName,
            domain: pitchDeal.brandDomain,
            category: pitchDeal.brandCategory,
            tier: pitchDeal.brandTier,
          }}
          onClose={() => setPitchDeal(null)}
          onCreated={(brandId, brandName) => {
            setPitchDeal(null);
            (navigation.getParent() as any)?.navigate("Studio", {
              screen: "PitchDetail",
              params: { brandId, brandName },
            });
          }}
        />
      )}
      {dismissing && (
        <DismissSheet
          visible
          brandName={dismissing.brandName}
          busy={disposing}
          onClose={() => setDismissing(null)}
          onChoose={(d) => handleDispose(dismissing, d)}
        />
      )}
    </>
  );
}
