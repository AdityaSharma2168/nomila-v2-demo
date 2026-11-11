// PublicCardReviewScreen — Me › Your public card › Review & publish (design-public-card-v3 §9–§10 "Review").
//
//   status        canPublish → "Ready to publish", else the server's blockedReason, word for word
//   chapters      in her order (Highlights always first). Per chapter: its note (hidden / short of its minimum /
//                 shows), ↑ ↓ to reorder, Rename, Hide or Show. Highlights never hides or moves.
//   items         each with its words, its source chip (Said · Found · Made · Proof), why it does or doesn't show,
//                 and Approve / Hide. Approving a line Nomila wrote pins that exact wording.
//   offers, picks the Book and Shop doors' items (hide or show)
//   left out      the cut list: what Nomila didn't propose, and why
//   publish       the footer button opens the publish sheet; her tap there is the only thing that publishes
//
// Writes: PUT /api/v1/me/public-card/draft with her decisions, whole (lib/publicCardLogic decisionsFrom + the edit).
// Her choice shows at once; the server's answer replaces it when the last save lands. A failed save says so and
// keeps her choice on screen with Try again / Undo.

import React, { useRef, useState } from "react";
import { View, Text, TextInput, ScrollView, SafeAreaView, StyleSheet, ActivityIndicator } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Card, Button, StackHeader, Chip, RuledHead, Sheet, LinkText } from "../../components/ui";
import { PublishSheet } from "../../components/publicCard/PublishSheet";
import { usePublicCardDraft, useSaveDecisions } from "../../hooks/use-public-card";
import {
  ERROR_COPY, KIND_LABEL, SOURCE_COPY, TITLE_MAX, approveItem, canApprove, canHide, canMove, chapterNote, cutLine,
  decisionsFrom, hideItem, itemLine, itemNote, moveChapter, problemLine, publicCardError, renameChapter, setChapterHidden, shownState,
} from "../../lib/publicCardLogic";
import { haptics } from "../../lib/haptics";
import type { DraftChapter, DraftDecisions, DraftItem, PublicCardDraftResponse } from "../../../shared/publicCard";
import { Bold, BoldType } from "../../constants/theme";

export const REVIEW_COPY = {
  parent: "Me",
  title: "Review your card",
  lede: "Approve what shows, hide what doesn't, and put your chapters in order. Nothing is public until you publish.",
  ready: "Ready to publish.",
  saving: "Saving…",
  undo: "Undo",
  empty: "Nothing to review yet. As Nomila learns more about you, from your story, your media and your signed deals, items appear here for you to approve.",
  noItems: "Nothing here yet.",
  offers: "Book: your offers",
  picks: "Shop: your picks",
  offersOff: "These show only while Book is on and available (Card settings).",
  picksOff: "These show only while Shop is on and available (Card settings).",
  cut: "Left out by Nomila",
  cutLede: "Nomila proposes only what it can point to. These were left out, and why:",
  approve: "Approve",
  hide: "Hide",
  show: "Show",
  rename: "Rename",
  up: "Up",
  down: "Down",
  publish: "Publish",
  preview: "Preview as a visitor",
  renameTitle: "Rename chapter",
  renameSave: "Save name",
  renameDefault: "Use the default name",
} as const;

export function PublicCardReviewScreen() {
  const navigation = useNavigation<any>();
  const draft = usePublicCardDraft();
  const save = useSaveDecisions();
  const [local, setLocal] = useState<DraftDecisions | null>(null);
  const [renaming, setRenaming] = useState<DraftChapter | null>(null);
  const [publishing, setPublishing] = useState(false);
  const seq = useRef(0);
  const d = draft.data;

  const commit = (next: DraftDecisions) => {
    haptics.select();
    setLocal(next);
    const n = ++seq.current;
    save.mutate(next, { onSuccess: () => { if (n === seq.current) setLocal(null); } });
  };
  const base = (): DraftDecisions => local ?? (d ? decisionsFrom(d) : {});

  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title={REVIEW_COPY.parent} bold />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">{REVIEW_COPY.title}</Text>
        <Text style={styles.lede}>{REVIEW_COPY.lede}</Text>
        {draft.isLoading ? <ActivityIndicator style={styles.spinner} color={Bold.ink} accessibilityLabel="Loading your card" testID="review-loading" /> : null}
        {draft.isError ? (
          <View style={styles.errorBlock} testID="review-error">
            <Text style={styles.body}>{problemLine(publicCardError(draft.error))}</Text>
            <Button bold="secondary" onPress={() => draft.refetch()} style={styles.retry}>{ERROR_COPY.retry}</Button>
          </View>
        ) : null}
        {d ? (
          <Review
            d={d}
            local={local}
            commit={commit}
            onRename={setRenaming}
            saveState={save.isPending ? "saving" : save.isError ? "error" : "idle"}
            onRetry={() => local && commit(local)}
            onUndo={() => { save.reset(); setLocal(null); }}
          />
        ) : null}
      </ScrollView>
      {d ? (
        <View style={styles.footer}>
          <LinkText onPress={() => navigation.navigate("PublicCardPreview")} testID="review-preview">{REVIEW_COPY.preview}</LinkText>
          <Button
            bold="primary"
            onPress={() => setPublishing(true)}
            disabled={!d.canPublish || save.isPending || !!local}
            testID="review-publish"
            accessibilityLabel={d.canPublish ? "Publish your card" : `Publish is not available. ${d.blockedReason ?? ""}`}
          >
            {REVIEW_COPY.publish}
          </Button>
        </View>
      ) : null}
      {renaming ? (
        <RenameSheet
          chapter={renaming}
          current={local?.chapters?.[renaming.key]?.title ?? (local ? renaming.defaultTitle : renaming.title)}
          onClose={() => setRenaming(null)}
          onSave={(t) => { commit(renameChapter(base(), renaming, t)); setRenaming(null); }}
        />
      ) : null}
      {publishing && d ? (
        <PublishSheet draft={d} onClose={() => setPublishing(false)} onPickHandle={() => { setPublishing(false); navigation.navigate("PublicCardSettings"); }} />
      ) : null}
    </SafeAreaView>
  );
}

function Review({ d, local, commit, onRename, saveState, onRetry, onUndo }: {
  d: PublicCardDraftResponse;
  local: DraftDecisions | null;
  commit: (next: DraftDecisions) => void;
  onRename: (c: DraftChapter) => void;
  saveState: "idle" | "saving" | "error";
  onRetry: () => void;
  onUndo: () => void;
}) {
  const dec = local ?? decisionsFrom(d);
  // Her order as she left it (her unsaved move included); Highlights first.
  const order = dec.order ?? [];
  const chapters = [...d.chapters].sort((a, b) => rankOf(a.key, order) - rankOf(b.key, order));
  const hiddenOf = (c: DraftChapter) => (local ? !!local.chapters?.[c.key]?.hidden : c.hidden);
  const titleOf = (c: DraftChapter) => (local ? local.chapters?.[c.key]?.title ?? c.defaultTitle : c.title);
  const nothing = d.chapters.every((c) => c.items.length === 0) && !d.offers.length && !d.picks.length;

  return (
    <View style={styles.stack}>
      <View style={[styles.status, d.canPublish && styles.statusReady]} testID="review-status" accessibilityLiveRegion="polite">
        <Text style={[styles.statusText, d.canPublish && styles.statusTextReady]}>{d.canPublish ? REVIEW_COPY.ready : d.blockedReason ?? "This draft can't be published yet."}</Text>
      </View>
      {saveState === "saving" ? <Text style={styles.meta} testID="review-saving">{REVIEW_COPY.saving}</Text> : null}
      {saveState === "error" ? (
        <View style={styles.saveError} testID="review-save-error">
          <Text style={styles.body}>{ERROR_COPY.save}</Text>
          <View style={styles.row}>
            <Button bold="small" onPress={onRetry} testID="review-save-retry">{ERROR_COPY.retry}</Button>
            <Button bold="small" onPress={onUndo} testID="review-save-undo">{REVIEW_COPY.undo}</Button>
          </View>
        </View>
      ) : null}
      {nothing ? <Card bold style={styles.pad}><Text style={styles.body} testID="review-empty">{REVIEW_COPY.empty}</Text></Card> : null}

      {chapters.map((c) => {
        const hidden = hiddenOf(c);
        const title = titleOf(c);
        const up = canMove(chapters, c.key, -1);
        const down = canMove(chapters, c.key, 1);
        const move = (dir: -1 | 1) => commit({ ...dec, order: moveChapter(chapters.map((x) => x.key), c.key, dir) });
        return (
          <Card bold key={c.key} testID={`review-chapter-${c.key}`}>
            <View style={[styles.chHead, hidden && styles.muted]}>
              <Text style={styles.chTitle} accessibilityRole="header">{title.toUpperCase()}</Text>
              <Text style={styles.meta}>{chapterNote(c, hidden)}</Text>
            </View>
            <View style={styles.chActions}>
              {c.key !== "highlights" ? (
                <>
                  <Button bold="small" onPress={() => move(-1)} disabled={!up} accessibilityLabel={`Move ${title} up`} testID={`review-up-${c.key}`}>{REVIEW_COPY.up}</Button>
                  <Button bold="small" onPress={() => move(1)} disabled={!down} accessibilityLabel={`Move ${title} down`} testID={`review-down-${c.key}`}>{REVIEW_COPY.down}</Button>
                </>
              ) : null}
              <Button bold="small" onPress={() => onRename(c)} accessibilityLabel={`Rename ${title}`} testID={`review-rename-${c.key}`}>{REVIEW_COPY.rename}</Button>
              {c.key !== "highlights" ? (
                <Button bold="small" onPress={() => commit(setChapterHidden(dec, c.key, !hidden))} accessibilityLabel={`${hidden ? "Show" : "Hide"} the ${title} chapter`} testID={`review-chapter-toggle-${c.key}`}>
                  {hidden ? REVIEW_COPY.show : REVIEW_COPY.hide}
                </Button>
              ) : null}
            </View>
            {c.items.length ? c.items.map((i, n) => (
              <ItemRow key={i.key} item={i} dec={local} last={n === c.items.length - 1} onApprove={() => commit(approveItem(dec, i))} onHide={() => commit(hideItem(dec, i.key))} />
            )) : <Text style={[styles.meta, styles.pad]}>{REVIEW_COPY.noItems}</Text>}
          </Card>
        );
      })}

      {d.offers.length ? (
        <Card bold testID="review-offers">
          <RuledHead title={REVIEW_COPY.offers} style={styles.ruled} />
          {!(d.availability.book && d.card.switches.book) ? <Text style={[styles.meta, styles.pad]}>{REVIEW_COPY.offersOff}</Text> : null}
          {d.offers.map((i, n) => <ItemRow key={i.key} item={i} dec={local} last={n === d.offers.length - 1} onApprove={() => commit(approveItem(dec, i))} onHide={() => commit(hideItem(dec, i.key))} />)}
        </Card>
      ) : null}
      {d.picks.length ? (
        <Card bold testID="review-picks">
          <RuledHead title={REVIEW_COPY.picks} style={styles.ruled} />
          {!(d.availability.shop && d.card.switches.shop) ? <Text style={[styles.meta, styles.pad]}>{REVIEW_COPY.picksOff}</Text> : null}
          {d.picks.map((i, n) => <ItemRow key={i.key} item={i} dec={local} last={n === d.picks.length - 1} onApprove={() => commit(approveItem(dec, i))} onHide={() => commit(hideItem(dec, i.key))} />)}
        </Card>
      ) : null}

      {d.cut.length ? (
        <Card bold testID="review-cut">
          <RuledHead title={REVIEW_COPY.cut} style={styles.ruled} />
          <Text style={[styles.meta, styles.pad]}>{REVIEW_COPY.cutLede}</Text>
          {d.cut.map((c, n) => {
            const l = cutLine(c);
            return (
              <View key={c.key} style={[styles.item, n === d.cut.length - 1 && styles.last]} accessibilityLabel={`${l.title} left out. ${l.why}`}>
                <Text style={styles.itemText}>{l.title}</Text>
                <Text style={styles.meta}>{l.why}</Text>
              </View>
            );
          })}
        </Card>
      ) : null}
    </View>
  );
}

const rankOf = (k: string, order: string[]) => (k === "highlights" ? -1 : order.includes(k) ? order.indexOf(k) : 1000);

function ItemRow({ item, dec, last, onApprove, onHide }: { item: DraftItem; dec: DraftDecisions | null; last: boolean; onApprove: () => void; onHide: () => void }) {
  const state = shownState(item, dec);
  const l = itemLine(item);
  const note = itemNote(item, state);
  const src = SOURCE_COPY[item.basis];
  const showApprove = canApprove(item, state);
  return (
    <View style={[styles.item, last && styles.last]} testID={`review-item-${item.key}`}>
      <View style={styles.itemTop}>
        <Text style={styles.kind}>{KIND_LABEL[item.kind].toUpperCase()}</Text>
        <View accessible accessibilityLabel={src.a11y}><Chip bold="line">{src.chip}</Chip></View>
      </View>
      <Text style={[styles.itemText, state === "hidden" && styles.muted]} numberOfLines={5}>{l.text}</Text>
      {l.detail ? <Text style={styles.meta}>{l.detail}</Text> : null}
      <Text style={[styles.meta, item.publishable && state !== "hidden" ? styles.ok : null]} testID={`review-note-${item.key}`}>{note}</Text>
      <View style={styles.row}>
        {showApprove ? (
          <Button bold="small" onPress={onApprove} accessibilityLabel={`${state === "hidden" ? "Show" : "Approve"}: ${l.text}`} testID={`review-approve-${item.key}`}>
            {state === "hidden" ? REVIEW_COPY.show : REVIEW_COPY.approve}
          </Button>
        ) : null}
        {canHide(state) ? (
          <Button bold="small" onPress={onHide} accessibilityLabel={`Hide: ${l.text}`} testID={`review-hide-${item.key}`}>{REVIEW_COPY.hide}</Button>
        ) : null}
      </View>
    </View>
  );
}

function RenameSheet({ chapter, current, onClose, onSave }: { chapter: DraftChapter; current: string; onClose: () => void; onSave: (t: string) => void }) {
  const [text, setText] = useState(current);
  return (
    <Sheet onClose={onClose} title={REVIEW_COPY.renameTitle} keyboard>
      <View style={styles.sheetBody} testID="review-rename-sheet">
        <TextInput
          value={text}
          onChangeText={setText}
          maxLength={TITLE_MAX}
          placeholder={chapter.defaultTitle}
          placeholderTextColor={Bold.quiet}
          style={styles.input}
          autoFocus
          accessibilityLabel={`Name for the ${chapter.defaultTitle} chapter`}
          testID="review-rename-input"
        />
        <Text style={styles.meta}>{`Up to ${TITLE_MAX} characters. Visitors see this name.`}</Text>
        <Button bold="primary" onPress={() => onSave(text)} testID="review-rename-save">{REVIEW_COPY.renameSave}</Button>
        {current !== chapter.defaultTitle ? <Button bold="link" onPress={() => onSave("")} testID="review-rename-default">{REVIEW_COPY.renameDefault}</Button> : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  safe:            { flex: 1, backgroundColor: Bold.paper },
  content:         { paddingHorizontal: Bold.gutter, paddingBottom: 32, gap: 12 },
  title:           { ...BoldType.screenTitleSm, color: Bold.ink },
  lede:            { ...BoldType.lede, color: Bold.mute },
  spinner:         { marginTop: 24 },
  errorBlock:      { gap: 10, marginTop: 12 },
  retry:           { alignSelf: "flex-start" },
  stack:           { gap: 12 },
  status:          { padding: 14, borderRadius: Bold.radius.card, borderWidth: 1, borderColor: Bold.line },
  statusReady:     { backgroundColor: Bold.ink, borderColor: Bold.ink },
  statusText:      { ...BoldType.rowTitle, color: Bold.ink },
  statusTextReady: { color: Bold.onDark },
  saveError:       { gap: 8 },
  body:            { ...BoldType.body, color: Bold.ink2 },
  meta:            { ...BoldType.rowMeta, color: Bold.mute },
  ok:              { color: Bold.ink2 },
  pad:             { paddingHorizontal: 14, paddingVertical: 10 },
  ruled:           { paddingHorizontal: 14, paddingTop: 12 },
  chHead:          { paddingHorizontal: 14, paddingTop: 12, gap: 2 },
  chTitle:         { ...BoldType.cardTitle, color: Bold.ink },
  chActions:       { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Bold.line },
  muted:           { opacity: 0.5 },
  item:            { paddingHorizontal: 14, paddingVertical: 12, gap: 4, borderBottomWidth: 1, borderBottomColor: Bold.line },
  last:            { borderBottomWidth: 0 },
  itemTop:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  kind:            { ...BoldType.label, color: Bold.mute },
  itemText:        { ...BoldType.rowTitle, color: Bold.ink },
  row:             { flexDirection: "row", gap: 8, marginTop: 4 },
  footer:          { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: Bold.gutter, paddingVertical: 10, borderTopWidth: 1, borderTopColor: Bold.line, backgroundColor: Bold.paper },
  sheetBody:       { gap: 10, paddingTop: 4 },
  input:           { height: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12, ...BoldType.body, color: Bold.ink },
});
