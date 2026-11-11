/**
 * ThreadMakeIt — Make it, as a sheet over the thread (session persistence plan v2 §4, D1a).
 *
 * THE SAME SCREEN. MakeItScreen is rendered unchanged — the same preview check (`useGenerationPlan`), the same card,
 * the same derived-mask correction, the same "Not what I meant" — by a container that belongs to the thread
 * instead of the navigator. MakeItRoute and MadeItScreen are untouched: the brand and personal flows still push
 * them, and with EXPO_PUBLIC_STUDIO_SESSIONS off Create anything does too.
 *
 * ─── WHAT CHANGES IS WHERE THE ANSWERS GO ──────────────────────────────────────────────────────────────
 *
 *   a preview lands     → `onPreview`: its card goes in the thread (and, when threads are kept, its plan entry)
 *   the check asks      → `onAsk`: the ask is Mila's reply in the thread (and its ask entry)
 *   she approves        → `onApprove`: the sheet closes and the THREAD runs the generate, so the run outlives the
 *                         sheet and the result lands where the loading tile is. Nothing navigates to Made it.
 *   Not what I meant    → `onRejected`, once the server has recorded it: the sheet closes and her words go back
 *                         in the composer
 *
 * ─── THE HOOKS LIVE OUTSIDE THE MODAL ──────────────────────────────────────────────────────────────────
 *
 * Closing the sheet hides it; it does not unmount this. A check she closed the sheet on before it answered still
 * lands, and its card still appears in the thread with the figure she would have seen — rather than a preview row
 * the server wrote that no thread ever names. The thread mounts a new one (a new `job.key`) for every send and
 * every Check again, so each open is its own check, its own mask and its own refusal, exactly as each push of
 * MakeItRoute was.
 */
import React, { useEffect, useRef, useState } from "react";
import { Modal } from "react-native";
import { useGenerationPlan } from "../../hooks/use-studio-pending";
import {
  useRejectInterpretation,
  type StudioRegion,
} from "../../hooks/use-studio";
import type { GenerationPlanView } from "../../lib/studio-contract";
import { MakeItScreen } from "./MakeItScreen";
import type { SheetJob } from "./threadLogic";

/** The line under the title — Create anything's own, as MakeItRoute was handed it. */
const LINE = "Made from what you said and what you attached.";

export function ThreadMakeIt({
  job,
  open,
  onPreview,
  onAsk,
  onApprove,
  onRejected,
  onClose,
}: {
  job: SheetJob;
  /** Whether the sheet is showing. False keeps the check alive behind the thread. */
  open: boolean;
  onPreview: (previewId: string, plan: GenerationPlanView) => void;
  /** The ask's code, and the vague ask's op chips when it carries them (PR 19). */
  onAsk: (reason: string, suggestions?: string[]) => void;
  /** With the plan she approved, so the thread can card it even if the approval outran `onPreview`. */
  onApprove: (previewId: string, plan: GenerationPlanView) => void;
  onRejected: (previewId: string) => void;
  onClose: () => void;
}) {
  /** Her correction to the derived box. Sending it re-checks and mints a new preview — a new card, the old one folds. */
  const [correctedRegions, setCorrectedRegions] = useState<
    StudioRegion[] | null
  >(null);
  const { data: plan, isLoading: checking } = useGenerationPlan({
    title: job.prompt,
    line: LINE,
    format: job.format,
    attachments: job.attachments,
    frameAssetId: job.frameAssetId,
    direction: job.prompt,
    regions: correctedRegions,
    // What the send already checked, when it did (C2) — shown, never asked again.
    seed: job.seed ?? null,
    // quality-scrappy piece 5: Try again on a failed output — the fresh check carries the gate's codes.
    ...(job.corrective?.length ? { corrective: job.corrective } : {}),
  });
  const reject = useRejectInterpretation();
  const [runError, setRunError] = useState<string | null>(null);

  // Each preview is reported ONCE. The hook re-renders with the same previewId many times, and StrictMode runs
  // effects twice; the thread would otherwise card the same check twice (the server's unique index on the entry's
  // preview would save it once, but the screen would still show two).
  const reported = useRef<string | null>(null);
  const report = useRef(onPreview);
  const ask = useRef(onAsk);
  useEffect(() => {
    report.current = onPreview;
    ask.current = onAsk;
  });
  // Runs whenever the plan changes, and does anything only the first time a NEW previewId appears — when `plan`
  // holds that check's own verdict.
  useEffect(() => {
    if (!plan.previewId || reported.current === plan.previewId) return;
    reported.current = plan.previewId;
    report.current(plan.previewId, plan);
  }, [plan]);

  const asked = useRef(false);
  useEffect(() => {
    if (!plan.askReason || checking || asked.current) return;
    asked.current = true;
    ask.current(plan.askReason, plan.askSuggestions ?? undefined);
  }, [plan.askReason, plan.askSuggestions, checking]);

  // One approval per sheet. The button closes the sheet on the first tap, so a second can only be a double tap —
  // and the server would bill it once anyway (same job); this keeps it from starting a second watch.
  const approved = useRef(false);
  const onMake = () => {
    if (!plan.previewId || !plan.canGenerate || approved.current) return;
    approved.current = true;
    onApprove(plan.previewId, plan);
  };

  const onReject = async () => {
    if (!plan.previewId || reject.isPending) return;
    setRunError(null);
    try {
      await reject.mutateAsync({ previewId: plan.previewId });
      onRejected(plan.previewId);
    } catch (e) {
      // It stays open and says so, rather than leaving her unsure whether the refusal landed (MakeItRoute's rule).
      setRunError(
        e instanceof Error ? e.message : "Couldn't record that right now.",
      );
    }
  };

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <MakeItScreen
        plan={plan}
        checking={checking}
        busy={false}
        runError={runError}
        runNote={null}
        onBack={onClose}
        onMake={onMake}
        onCorrectRegions={setCorrectedRegions}
        onReject={onReject}
        rejecting={reject.isPending}
      />
    </Modal>
  );
}
