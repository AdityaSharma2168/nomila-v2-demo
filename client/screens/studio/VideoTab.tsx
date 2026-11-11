/**
 * VideoTab — PROVISIONAL. An isolation surface for the detached video pipelines (V4, extended V7).
 *
 * ─── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────────────────────────
 *
 * It is a throwaway observation harness: somewhere to watch a video job move
 * `queued → running → succeeded` with its own eyes, and to watch the first real Veo spends after
 * the flag is flipped, WITHOUT touching the content surface people actually use.
 *
 * ─── IT HOLDS BOTH PIPELINES NOW (V7 layer 4) ───────────────────────────────────────────────────
 *
 * videoEntryLogic.ts named two: upload → stitch → music, and generate-from-keyframes. The first is
 * functional here (TimelineBuilder); the second is a shell that says so (KeyframesShell). The
 * original job-id watcher stays below them, because watching a generate move through the queue is
 * still the only way to see that half with your own eyes.
 *
 * All three are MOUNTED here and implemented elsewhere, which is the rule this file was built
 * under: nothing in it may be load-bearing, so moving any of them out is a re-mount.
 *
 * It is NOT the eventual home. MadeShelf and ThreadCards already carry non-IMAGE branches and
 * `listStudioContent` already returns VIDEO rows, so the clips have a place to go; the migration
 * out of this tab is a V7-era task. That is why every piece of machinery it mounts —
 * `VideoEntry`, `ClipPlayer`, `videoEntryLogic`, the watch itself — lives outside this file and
 * knows nothing about it. Moving them is a re-mount. Nothing here may be load-bearing.
 *
 * ─── WHY YOU TYPE A JOB ID ──────────────────────────────────────────────────────────────────────
 *
 * There is no "list my video jobs" route, and inventing one is server work and out of this half's
 * scope. More to the point there is nothing to list: `STUDIO_VIDEO_ENABLED` is off by default, so
 * no clip can be generated at all until it is flipped, and Create anything sends photos. So the
 * harness takes the one thing you will have in your hand the moment you flip it and send — the
 * jobId `POST /studio/generate` answers with — and watches it.
 *
 * ─── NOTHING HERE SPENDS ────────────────────────────────────────────────────────────────────────
 *
 * Watching is `GET /studio/jobs/:jobId`, which is reconnect-and-refresh and drives no execution:
 * the runner works the queue on its own tick (/api/internal/studio-video-tick). Polling it cannot
 * start, resume or advance a job, which is exactly why a paid provider call is not behind it.
 *
 * DESIGN.md: pills at least 120px; cards at radius `lg`; no blur; Feather icons; reanimated only.
 */
import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { HapticPressable } from "../../components/HapticPressable";
import { VideoEntry } from "../../components/studio/VideoEntry";
import { KeyframesShell } from "../../components/studio/KeyframesShell";
import { TimelineBuilder } from "../../components/studio/TimelineBuilder";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { useRunWatch, type Watch } from "../../hooks/use-studio-sessions";
import { videoEntryFromJob, type VideoEntryView } from "./videoEntryLogic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One job being observed. `view` is replaced on every tick that says anything. */
interface Observed {
  jobId: string;
  view: VideoEntryView;
}

export function VideoTab({
  onOpenDetail,
  initialClipId,
  onInitialClipTaken,
  captionFeel = null,
}: {
  onOpenDetail?: (assetId: string) => void;
  /** Passed to the timeline — the Board's "Fine-tune in Video" (TimelineBuilder). */
  initialClipId?: string | null;
  onInitialClipTaken?: () => void;
  /** The Board's words and purpose, for the caption suggestion (PR 15, R-5) — passed through. */
  captionFeel?: { feel: string[]; objective: string } | null;
}) {
  const [draft, setDraft] = useState("");
  const [observed, setObserved] = useState<Observed[]>([]);

  const watches = useMemo<Watch[]>(
    () =>
      observed
        // Settled entries drop out of the watch list, which is what a well-behaved caller does.
        // The hook no longer DEPENDS on that — see the settle-once memory in useRunWatch — but a
        // caller that leaks is not something to model in the surface built to observe leaks.
        .filter((o) => o.view.working)
        .map((o) => ({ key: o.jobId, jobId: o.jobId, kind: "video" as const })),
    [observed],
  );

  const put = useCallback((jobId: string, view: VideoEntryView) => {
    setObserved((list) =>
      list.map((o) => (o.jobId === jobId ? { ...o, view } : o)),
    );
  }, []);

  useRunWatch(
    watches,
    (key, outcome, read) =>
      put(key, videoEntryFromJob(read ?? "error", outcome)),
    (key, _phase, read) => put(key, videoEntryFromJob(read, "continue")),
  );

  const add = () => {
    const jobId = draft.trim();
    if (!UUID_RE.test(jobId) || observed.some((o) => o.jobId === jobId)) return;
    setObserved((list) => [
      // A job not yet read opens as `working` until the first tick says otherwise — the same
      // default an unreadable tick gets, and for the same reason: we have learned nothing.
      { jobId, view: videoEntryFromJob("error", "continue") },
      ...list,
    ]);
    setDraft("");
  };

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
    >
      {/* Pipeline 1 — functional. Its own scroll view is nested deliberately: it is a self-
          contained surface that will be lifted out of this tab whole. */}
      <TimelineBuilder
        onOpenDetail={onOpenDetail}
        initialClipId={initialClipId}
        onInitialClipTaken={onInitialClipTaken}
        captionFeel={captionFeel}
      />

      {/* Pipeline 2 — a shell, and obviously one. */}
      <KeyframesShell />

      <View style={styles.note}>
        <Feather
          name="alert-triangle"
          size={14}
          color={Colors.light.textMuted}
        />
        <Text style={styles.noteTxt}>
          Provisional. Paste a video GENERATE job id to watch it move through
          the queue. Nothing here spends.
        </Text>
      </View>

      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Job id"
          placeholderTextColor={Colors.light.textQuiet}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={add}
          returnKeyType="go"
        />
        <HapticPressable
          style={[styles.pill, !UUID_RE.test(draft.trim()) && styles.pillOff]}
          onPress={add}
          disabled={!UUID_RE.test(draft.trim())}
          accessibilityRole="button"
          accessibilityLabel="Watch this job"
        >
          <Feather name="eye" size={14} color={Colors.light.buttonText} />
          <Text style={styles.pillTxt}>Watch</Text>
        </HapticPressable>
      </View>

      {observed.length === 0 ? (
        <Text style={styles.empty}>Nothing being watched.</Text>
      ) : (
        observed.map((o) => (
          <VideoEntry
            key={o.jobId}
            view={o.view}
            caption={o.jobId}
            onOpenDetail={onOpenDetail}
          />
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: Spacing.md, gap: Spacing.md },
  note: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    padding: Spacing.sm,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  noteTxt: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
  },
  row: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  input: {
    flex: 1,
    height: 44,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: Colors.light.card,
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.text,
  },
  pill: {
    minWidth: 120,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
    height: 44,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primary,
  },
  pillOff: { opacity: 0.4 },
  pillTxt: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "600",
    fontSize: 13,
    color: Colors.light.buttonText,
  },
  empty: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: Colors.light.textMuted,
    textAlign: "center",
    paddingVertical: Spacing.lg,
  },
});
