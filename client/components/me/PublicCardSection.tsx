// PublicCardSection — her public card, at the top of Me (app layout B, agreed 8 Oct 2026; design-public-card-v3 §3
// "her side"). Reads GET /api/v1/me/public-card/draft.
//
//   PUBLIC_CARD off                the existing My Nomi row: her deck, as brands see it (Brand › Deck).
//   PUBLIC_CARD on                 "Your public card":
//     the state                    Draft / Live · vN / Offline, with one plain line, and her link (or how she gets one)
//     Review & publish             → Review (the meta says how many items wait for her, or why it can't publish yet)
//     Preview as a visitor         → Preview (exactly what publishing now would show)
//     Share link                   the system share sheet, only while the card is live
//     Card settings                → Settings (doors, link, M.I.A., search)
//   loading / error                a spinner; the error line with Try again
//   server flag off (404)          says publishing opens soon and keeps the deck row, so nothing is lost
//
// Views: there is no count on the server yet, so none is drawn (never a made-up number).
// Look B: a white card with a 1px line, rows 12 × 14, the black icon tile (DESIGN.md §11).

import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Card, Row, IconTile, SectionHead, Chip, Button } from "../ui";
import { Photo } from "../ui/Photo";
import { usePublicCardDraft } from "../../hooks/use-public-card";
import { publicCardApi } from "../../lib/publicCardApi";
import { CARD_COPY, ERROR_COPY, cardStatus, displayUrl, isDisabled, problemLine, publicCardError, publicCardUrl, reviewMeta } from "../../lib/publicCardLogic";
import { shareCardLink } from "../publicCard/PublishSheet";
import { Bold, BoldType } from "../../constants/theme";

export const PUBLIC_CARD_COPY = {
  nomiTitle: "My Nomi",
  nomiMeta: "Your deck, as brands see it",
  heading: CARD_COPY.heading,
  notOpen: ERROR_COPY.disabled,
  preview: CARD_COPY.deck,
  previewMeta: CARD_COPY.deckMeta,
} as const;

export interface PublicCardSectionProps {
  enabled: boolean;
  photo?: string | null;
  /** Brand › Deck: the flag-off row, and the fallback while the server has the card switched off. */
  onDeck: () => void;
  onReview: () => void;
  onPreview: () => void;
  onSettings: () => void;
}

export function PublicCardSection(props: PublicCardSectionProps) {
  const { enabled, photo, onDeck } = props;
  if (!enabled) {
    const mark = photo ? <Photo uri={photo} style={styles.photo} /> : <IconTile icon="layers" bold="black" />;
    return (
      <Card bold style={styles.card} testID="me-nomi">
        <Row bold leading={mark} value={PUBLIC_CARD_COPY.nomiTitle} meta={PUBLIC_CARD_COPY.nomiMeta} onPress={onDeck} last accessibilityLabel={`${PUBLIC_CARD_COPY.nomiTitle}. ${PUBLIC_CARD_COPY.nomiMeta}`} />
      </Card>
    );
  }
  return <LiveSection {...props} />;
}

function LiveSection({ photo, onDeck, onReview, onPreview, onSettings }: PublicCardSectionProps) {
  const draft = usePublicCardDraft(true);
  const d = draft.data;
  const mark = photo ? <Photo uri={photo} style={styles.photo} /> : <IconTile icon="layers" bold="black" />;

  if (draft.isLoading) {
    return (
      <View style={styles.section} testID="me-public-card">
        <SectionHead title={CARD_COPY.heading} />
        <Card bold>
          <View style={styles.note} testID="me-public-card-loading">
            <ActivityIndicator color={Bold.ink} accessibilityLabel="Loading your public card" />
          </View>
        </Card>
      </View>
    );
  }

  if (draft.isError || !d) {
    const p = publicCardError(draft.error);
    if (isDisabled(p)) {
      return (
        <View style={styles.section} testID="me-public-card">
          <SectionHead title={CARD_COPY.heading} />
          <Card bold>
            <View style={[styles.note, styles.noteLine]}>
              <Feather name="globe" size={16} color={Bold.mute} />
              <Text style={styles.noteText}>{ERROR_COPY.disabled}</Text>
            </View>
            <Row bold leading={mark} value={CARD_COPY.deck} meta={CARD_COPY.deckMeta} onPress={onDeck} last accessibilityLabel={`${CARD_COPY.deck}. ${CARD_COPY.deckMeta}`} />
          </Card>
        </View>
      );
    }
    return (
      <View style={styles.section} testID="me-public-card">
        <SectionHead title={CARD_COPY.heading} />
        <Card bold>
          <View style={styles.errorBlock} testID="me-public-card-error">
            <Text style={styles.noteText}>{problemLine(p)}</Text>
            <Button bold="small" onPress={() => draft.refetch()} style={styles.retry} testID="me-public-card-retry">{ERROR_COPY.retry}</Button>
          </View>
        </Card>
      </View>
    );
  }

  const s = cardStatus(d.card);
  const url = d.card.handle ? publicCardUrl(publicCardApi.publicBase(), d.card.handle) : null;
  const meta = reviewMeta(d);
  return (
    <View style={styles.section} testID="me-public-card">
      <SectionHead title={CARD_COPY.heading} right={<Chip bold={s.live ? "dark" : "line"} testID="me-public-card-status">{s.chip}</Chip>} />
      <Card bold>
        <View style={[styles.state, styles.noteLine]}>
          <Text style={styles.stateLine} testID="me-public-card-line">{s.line}</Text>
          {url ? (
            <Text style={styles.link} selectable testID="me-public-card-link" accessibilityLabel={`Your link: ${displayUrl(url)}`}>{displayUrl(url)}</Text>
          ) : (
            <Text style={styles.noteText}>{CARD_COPY.noHandle}</Text>
          )}
        </View>
        <Row bold leading={<IconTile icon="check-square" bold="black" />} value={CARD_COPY.review} meta={meta} onPress={onReview} accessibilityLabel={`${CARD_COPY.review}. ${meta}`} />
        <Row bold leading={mark} value={CARD_COPY.preview} meta={CARD_COPY.previewMeta} onPress={onPreview} accessibilityLabel={`${CARD_COPY.preview}. ${CARD_COPY.previewMeta}`} />
        {s.live && url ? (
          <Row bold leading={<IconTile icon="share" bold="black" />} value={CARD_COPY.share} meta={displayUrl(url)} onPress={() => shareCardLink(url)} accessibilityLabel={`${CARD_COPY.share}. ${displayUrl(url)}`} />
        ) : null}
        <Row bold leading={<IconTile icon="sliders" bold="black" />} value={CARD_COPY.settings} meta={CARD_COPY.settingsMeta} onPress={onSettings} last accessibilityLabel={`${CARD_COPY.settings}. ${CARD_COPY.settingsMeta}`} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  card:       { marginHorizontal: Bold.gutter, marginTop: 16 },
  section:    { marginHorizontal: Bold.gutter, marginTop: 16, gap: 10 },
  photo:      { width: 40, height: 40, borderRadius: Bold.radius.control, backgroundColor: Bold.ground },
  note:       { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 12, paddingHorizontal: 14 },
  noteLine:   { borderBottomWidth: 1, borderBottomColor: Bold.line },
  noteText:   { flex: 1, ...BoldType.body, color: Bold.ink2 },
  errorBlock: { gap: 10, paddingVertical: 12, paddingHorizontal: 14 },
  retry:      { alignSelf: "flex-start" },
  state:      { gap: 4, paddingVertical: 12, paddingHorizontal: 14 },
  stateLine:  { ...BoldType.rowTitle, color: Bold.ink },
  link:       { ...BoldType.rowMeta, color: Bold.ink2 },
});
