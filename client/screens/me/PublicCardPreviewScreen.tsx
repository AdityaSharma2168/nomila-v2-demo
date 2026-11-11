// PublicCardPreviewScreen — Me › Your public card › Preview as a visitor (design-public-card-v3 §10 "Preview").
//
// GET /api/v1/me/public-card/preview is exactly what Publish would freeze now; this screen draws it the way a VISITOR
// sees the public page: the approved Front Door design (components/frontDoor/FrontDoorPage: the swipe cards, the 2×2
// doors pinned with Mila at the centre, the heart, the footer; no metrics rail). Natively, not a WebView: the public page
// only ever shows the PUBLISHED version, and this is the draft. The heart toggles here; nothing is sent from a preview.
//
//   a door tile / Mila   a sheet saying what that door does for a visitor (nothing opens or sends from a preview)
//   a story tile         swipes to its card, as on the page
//   the footer           Publish (opens the publish sheet; her tap there publishes) or why it can't publish yet + Review

import React, { useState } from "react";
import { View, Text, SafeAreaView, StatusBar, StyleSheet, ActivityIndicator } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Button, StackHeader, Sheet, LinkText } from "../../components/ui";
import { FrontDoorPage } from "../../components/frontDoor/FrontDoorPage";
import { useMyFrontDoor } from "../../hooks/use-my-front-door";
import { PublishSheet } from "../../components/publicCard/PublishSheet";
import { usePublicCardDraft, usePublicCardPreview } from "../../hooks/use-public-card";
import { ERROR_COPY, problemLine, publicCardError, tileExplainer } from "../../lib/publicCardLogic";
import { Bold, BoldType } from "../../constants/theme";

export const PREVIEW_COPY = {
  banner: "Preview. This is what visitors see if you publish now.",
  publish: "Publish",
  review: "Review",
  doorTitle: (label: string) => `${label}, for visitors`,
} as const;

export function PublicCardPreviewScreen() {
  const navigation = useNavigation<any>();
  const preview = usePublicCardPreview();
  const page = useMyFrontDoor();
  const draft = usePublicCardDraft();
  const [door, setDoor] = useState<{ label: string; text: string } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const p = preview.data;
  const d = draft.data;
  const first = p?.content.firstName ?? "";

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <StackHeader title="Me" bold />
      <Text style={styles.banner} testID="preview-banner">{PREVIEW_COPY.banner}</Text>
      {preview.isLoading ? <ActivityIndicator style={styles.spinner} color={Bold.ink} accessibilityLabel="Loading your preview" testID="preview-loading" /> : null}
      {preview.isError ? (
        <View style={styles.errorBlock} testID="preview-error">
          <Text style={styles.errorText}>{problemLine(publicCardError(preview.error))}</Text>
          <Button bold="secondary" onPress={() => preview.refetch()} style={styles.self}>{ERROR_COPY.retry}</Button>
        </View>
      ) : null}
      {p && page.model ? (
        <FrontDoorPage
          model={page.model}
          verified={page.verified}
          chapterImages={page.chapterImages}
          pinnedDoors
          onDoor={(t) => setDoor({ label: t.label, text: tileExplainer(t.key, first) })}
          onAsk={() => setDoor({ label: "Ask Mila", text: tileExplainer("ask", first) })}
        />
      ) : null}
      {d ? (
        <View style={styles.footer}>
          {d.canPublish ? (
            <Button bold="primary" onPress={() => setPublishing(true)} style={styles.flex} testID="preview-publish">{PREVIEW_COPY.publish}</Button>
          ) : (
            <>
              <Text style={styles.blocked} numberOfLines={2} testID="preview-blocked">{d.blockedReason ?? "This draft can't be published yet."}</Text>
              <LinkText onPress={() => navigation.navigate("PublicCardReview")} testID="preview-review">{PREVIEW_COPY.review}</LinkText>
            </>
          )}
        </View>
      ) : null}
      {door ? (
        <Sheet onClose={() => setDoor(null)} title={PREVIEW_COPY.doorTitle(door.label)}>
          <Text style={styles.sheetText} testID="preview-door-text">{door.text}</Text>
        </Sheet>
      ) : null}
      {publishing && d ? (
        <PublishSheet draft={d} onClose={() => setPublishing(false)} onPickHandle={() => { setPublishing(false); navigation.navigate("PublicCardSettings"); }} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // The one look: the preview sits on the white ground, like her page.
  safe:       { flex: 1, backgroundColor: Bold.paper },
  banner:     { ...BoldType.caption, color: Bold.mute, paddingHorizontal: Bold.gutter, paddingBottom: 8 },
  spinner:    { marginTop: 32 },
  errorBlock: { gap: 10, padding: Bold.gutter },
  errorText:  { ...BoldType.body, color: Bold.ink },
  self:       { alignSelf: "flex-start" },
  flex:       { flex: 1 },
  footer:     { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: Bold.gutter, paddingVertical: 10, borderTopWidth: 1, borderTopColor: Bold.line },
  blocked:    { flex: 1, ...BoldType.rowMeta, color: Bold.ink2 },
  sheetText:  { ...BoldType.body, color: Bold.ink2, paddingVertical: 8 },
});
