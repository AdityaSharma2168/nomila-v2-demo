// PublishSheet and UnpublishSheet — the two taps that change what the public sees (tap-to-send: her own tap, never
// Mila's, never automatic). design-public-card-v3 §10 "Publish": her tap freezes the draft into version N+1 and the
// link switches to it at once; unpublish is one confirmed tap and the link stops opening.
//
//   PublishSheet     confirm (what goes public: chapters, doors, the link) → publishing → live (version, link, Share)
//                    or refused: the server's own sentence (422 "Add a chapter or turn on a door to publish"), "Pick your
//                    link" (409 needs_handle → Card settings), not open yet (404), or the network line, with Try again
//   UnpublishSheet   confirm → offline, or the error with Try again

import React, { useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Share, Platform } from "react-native";
import { Button, Sheet } from "../ui";
import { usePublicCardPreview, usePublishCard, useUnpublishCard } from "../../hooks/use-public-card";
import { publicCardApi } from "../../lib/publicCardApi";
import {
  PUBLISH_COPY, displayUrl, problemLine, publicCardError, publicCardUrl, publishErrorLine, publishSummary, ERROR_COPY,
} from "../../lib/publicCardLogic";
import { haptics } from "../../lib/haptics";
import type { PublicCardDraftResponse, PublicCardPublishResponse } from "../../../shared/publicCard";
import { Bold, BoldType } from "../../constants/theme";

/** The system share sheet with her link. */
export async function shareCardLink(url: string): Promise<void> {
  try {
    await Share.share(Platform.OS === "ios" ? { url } : { message: url });
  } catch {
    /* she closed the sheet */
  }
}

export function PublishSheet({ draft, onClose, onPickHandle }: {
  draft: PublicCardDraftResponse;
  onClose: () => void;
  /** 409 needs_handle: take her to Card settings to pick her link. */
  onPickHandle: () => void;
}) {
  const preview = usePublicCardPreview(draft.canPublish);
  const publish = usePublishCard();
  const [done, setDone] = useState<PublicCardPublishResponse | null>(null);
  const live = draft.card.status === "published";

  if (done) {
    const url = publicCardUrl(publicCardApi.publicBase(), done.handle);
    return (
      <Sheet onClose={onClose} title={PUBLISH_COPY.doneTitle}>
        <View style={styles.body} testID="publish-done">
          <Text style={styles.lede} accessibilityLiveRegion="polite">{`Version ${done.version} is live at your link.`}</Text>
          <Text style={styles.url} selectable>{displayUrl(url)}</Text>
          <Button bold="secondary" onPress={() => shareCardLink(url)} testID="publish-share">{PUBLISH_COPY.share}</Button>
          <Button bold="primary" onPress={onClose} testID="publish-done-close">{PUBLISH_COPY.done}</Button>
        </View>
      </Sheet>
    );
  }

  const problem = publish.isError ? publicCardError(publish.error) : null;
  const go = () => {
    publish.mutate(undefined, {
      onSuccess: (r) => { haptics.success(); setDone(r); },
      onError: () => { haptics.error(); },
    });
  };
  const summary = preview.data ? publishSummary(preview.data.content) : null;
  const url = draft.card.handle ? displayUrl(publicCardUrl(publicCardApi.publicBase(), draft.card.handle)) : null;

  return (
    <Sheet onClose={() => { if (!publish.isPending) onClose(); }} title={PUBLISH_COPY.title}>
      <View style={styles.body} testID="publish-sheet">
        {!draft.canPublish ? (
          <>
            <Text style={styles.lede} testID="publish-blocked">{draft.blockedReason ?? "This draft can't be published yet."}</Text>
            <Button bold="secondary" onPress={onClose}>{PUBLISH_COPY.cancel}</Button>
          </>
        ) : (
          <>
            <Text style={styles.lede}>{live ? PUBLISH_COPY.republish : PUBLISH_COPY.lede}</Text>
            {preview.isLoading ? <ActivityIndicator color={Bold.ink} accessibilityLabel="Loading what goes public" /> : null}
            {preview.isError ? (
              <View style={styles.block}>
                <Text style={styles.error}>{problemLine(publicCardError(preview.error))}</Text>
                <Button bold="small" onPress={() => preview.refetch()} testID="publish-preview-retry">{ERROR_COPY.retry}</Button>
              </View>
            ) : null}
            {summary ? (
              <View style={styles.block} testID="publish-summary">
                <Text style={styles.k}>CHAPTERS</Text>
                <Text style={styles.v}>{summary.chapters.join(" · ")}</Text>
                <Text style={styles.k}>DOORS</Text>
                <Text style={styles.v}>{summary.doors.length ? summary.doors.join(" · ") : "None"}</Text>
                <Text style={styles.k}>YOUR LINK</Text>
                <Text style={styles.v}>{url ?? "Nomila suggests one from your name."}</Text>
              </View>
            ) : null}
            {problem ? (
              <View style={styles.block} testID="publish-error">
                <Text style={styles.error} accessibilityLiveRegion="assertive">{publishErrorLine(problem)}</Text>
                {problem.code === "needs_handle" ? <Button bold="secondary" onPress={onPickHandle} testID="publish-pick-handle">{PUBLISH_COPY.pickHandle}</Button> : null}
              </View>
            ) : null}
            <Button bold="primary" onPress={go} loading={publish.isPending} disabled={!summary} testID="publish-confirm" accessibilityLabel={live ? "Publish this version" : "Publish your card"}>
              {problem && problem.code !== "needs_handle" ? ERROR_COPY.retry : PUBLISH_COPY.publish}
            </Button>
            <Button bold="link" onPress={onClose} disabled={publish.isPending}>{PUBLISH_COPY.cancel}</Button>
          </>
        )}
      </View>
    </Sheet>
  );
}

export function UnpublishSheet({ onClose }: { onClose: () => void }) {
  const unpublish = useUnpublishCard();
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <Sheet onClose={onClose} title={PUBLISH_COPY.offlineDone}>
        <View style={styles.body} testID="unpublish-done">
          <Text style={styles.lede} accessibilityLiveRegion="polite">Your link no longer opens. Publish again any time from Review.</Text>
          <Button bold="primary" onPress={onClose}>{PUBLISH_COPY.done}</Button>
        </View>
      </Sheet>
    );
  }
  const problem = unpublish.isError ? publicCardError(unpublish.error) : null;
  return (
    <Sheet onClose={() => { if (!unpublish.isPending) onClose(); }} title={PUBLISH_COPY.offlineTitle}>
      <View style={styles.body} testID="unpublish-sheet">
        <Text style={styles.lede}>{PUBLISH_COPY.offlineLede}</Text>
        {problem ? <Text style={styles.error} testID="unpublish-error" accessibilityLiveRegion="assertive">{problemLine(problem, "Taking your card offline didn't go through. Try again.")}</Text> : null}
        <Button
          bold="primary"
          onPress={() => unpublish.mutate(undefined, { onSuccess: () => { haptics.success(); setDone(true); }, onError: () => haptics.error() })}
          loading={unpublish.isPending}
          testID="unpublish-confirm"
        >
          {problem ? ERROR_COPY.retry : PUBLISH_COPY.offlineConfirm}
        </Button>
        <Button bold="link" onPress={onClose} disabled={unpublish.isPending}>{PUBLISH_COPY.cancel}</Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body:  { gap: 12, paddingTop: 4 },
  lede:  { ...BoldType.body, color: Bold.ink2 },
  url:   { ...BoldType.rowTitle, color: Bold.ink },
  block: { gap: 4, paddingVertical: 4 },
  k:     { ...BoldType.label, color: Bold.mute, marginTop: 4 },
  v:     { ...BoldType.rowTitle, color: Bold.ink },
  error: { ...BoldType.body, color: Bold.ink },
});
