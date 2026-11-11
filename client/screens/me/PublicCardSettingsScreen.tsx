// PublicCardSettingsScreen — Me › Your public card › Card settings (design-public-card-v3 §3 doors, §16 Q1–Q3).
//
//   Your link       her handle: edit, Save (PUT /handle). Refusals in her words: 422 shape, 409 reserved / taken,
//                   429 too soon with the date; while a change waits (handleChangeAvailableAt) the field says when.
//   Doors           Partner · Book · Shop · Create · Ask Mila (PATCH /switches). Book and Shop say why they can't work
//                   yet (the draft's availability). On a live card, off pulls the door at once; on waits for a publish.
//   What shows      Show M.I.A. on my card (default off) · Let search engines find my card (default off)
//   Social links    the profiles the page lists (from the preview), with "Coming soon" for choosing per link: the
//                   server has no per-link switch yet, so none is drawn
//   Offline         a live card: Take your card offline → the confirm sheet (POST /unpublish)

import React, { useState } from "react";
import { View, Text, TextInput, ScrollView, SafeAreaView, Switch, StyleSheet, ActivityIndicator } from "react-native";
import { Card, Button, StackHeader, RuledHead, Row, IconTile, Chip } from "../../components/ui";
import { UnpublishSheet } from "../../components/publicCard/PublishSheet";
import { usePublicCardDraft, usePublicCardPreview, useSetHandle, useSetSwitches } from "../../hooks/use-public-card";
import { publicCardApi } from "../../lib/publicCardApi";
import {
  DOOR_COPY, DOOR_ORDER, ERROR_COPY, HANDLE_COPY, SETTINGS_COPY, SWITCH_LABEL, dayLine, displayUrl, doorUnavailable,
  handleErrorLine, handleProblem, normalizeHandle, problemLine, publicCardError, publicCardUrl,
} from "../../lib/publicCardLogic";
import { haptics } from "../../lib/haptics";
import type { PublicCardDraftResponse, PublicCardSwitches } from "../../../shared/publicCard";
import { Bold, BoldType } from "../../constants/theme";

export function PublicCardSettingsScreen() {
  const draft = usePublicCardDraft();
  const d = draft.data;
  const [offline, setOffline] = useState(false);
  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title="Me" bold />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">{SETTINGS_COPY.title}</Text>
        {draft.isLoading ? <ActivityIndicator style={styles.spinner} color={Bold.ink} accessibilityLabel="Loading your card settings" testID="settings-loading" /> : null}
        {draft.isError ? (
          <View style={styles.block} testID="settings-error">
            <Text style={styles.body}>{problemLine(publicCardError(draft.error))}</Text>
            <Button bold="secondary" onPress={() => draft.refetch()} style={styles.self}>{ERROR_COPY.retry}</Button>
          </View>
        ) : null}
        {d ? (
          <>
            <HandleCard d={d} />
            <Switches d={d} />
            <Socials />
            {d.card.status === "published" ? (
              <Card bold>
                <Row bold leading={<IconTile icon="eye-off" bold="black" />} value={SETTINGS_COPY.offline} meta={SETTINGS_COPY.offlineMeta} onPress={() => setOffline(true)} last accessibilityLabel={`${SETTINGS_COPY.offline}. ${SETTINGS_COPY.offlineMeta}`} />
              </Card>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      {offline ? <UnpublishSheet onClose={() => setOffline(false)} /> : null}
    </SafeAreaView>
  );
}

// ─── her link ─────────────────────────────────────────────────────────────────────────────────────────────────────

function HandleCard({ d }: { d: PublicCardDraftResponse }) {
  const setHandle = useSetHandle();
  const current = d.card.handle;
  const [text, setText] = useState(current ?? "");
  const [line, setLine] = useState<string | null>(null);
  const waitDay = dayLine(d.card.handleChangeAvailableAt);
  const locked = !!current && !!waitDay;
  const url = current ? displayUrl(publicCardUrl(publicCardApi.publicBase(), current)) : null;
  const changed = normalizeHandle(text) !== (current ?? "");
  const submit = () => {
    const problem = handleProblem(text);
    if (problem) { setLine(problem); haptics.error(); return; }
    setLine(null);
    setHandle.mutate(normalizeHandle(text), {
      onSuccess: (r) => { haptics.success(); setText(r.handle); setLine(HANDLE_COPY.saved); },
      onError: (err) => { haptics.error(); setLine(handleErrorLine(publicCardError(err))); },
    });
  };
  return (
    <Card bold testID="settings-handle">
      <RuledHead title={SETTINGS_COPY.link} style={styles.ruled} />
      <View style={styles.pad}>
        {url ? <Text style={styles.url} selectable testID="settings-url">{url}</Text> : <Text style={styles.body}>{HANDLE_COPY.first}</Text>}
        <View style={styles.handleRow}>
          <Text style={styles.prefix}>/p/</Text>
          <TextInput
            value={text}
            onChangeText={(t) => { setText(t); setLine(null); }}
            editable={!locked && !setHandle.isPending}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={40}
            placeholder="your-name"
            placeholderTextColor={Bold.quiet}
            style={[styles.input, locked && styles.inputLocked]}
            onSubmitEditing={submit}
            accessibilityLabel={`Your link. ${HANDLE_COPY.rule}`}
            testID="settings-handle-input"
          />
        </View>
        <Text style={styles.meta}>{locked ? HANDLE_COPY.waitUntil(waitDay) : current ? HANDLE_COPY.monthly : HANDLE_COPY.rule}</Text>
        {line ? <Text style={styles.body} accessibilityLiveRegion="polite" testID="settings-handle-line">{line}</Text> : null}
        <Button bold="secondary" onPress={submit} disabled={locked || !changed || !text.trim()} loading={setHandle.isPending} testID="settings-handle-save">{HANDLE_COPY.save}</Button>
      </View>
    </Card>
  );
}

// ─── doors and what shows ─────────────────────────────────────────────────────────────────────────────────────────

function Switches({ d }: { d: PublicCardDraftResponse }) {
  const set = useSetSwitches();
  const [pending, setPending] = useState<Partial<PublicCardSwitches>>({});
  const [notes, setNotes] = useState<Partial<Record<keyof PublicCardSwitches, string>>>({});
  const live = d.card.status === "published";
  const value = (k: keyof PublicCardSwitches) => pending[k] ?? d.card.switches[k];

  const flip = (k: keyof PublicCardSwitches, v: boolean) => {
    haptics.select();
    setPending((p) => ({ ...p, [k]: v }));
    setNotes((n) => ({ ...n, [k]: undefined }));
    set.mutate({ [k]: v }, {
      onSuccess: (r) => {
        setPending((p) => { const { [k]: _drop, ...rest } = p; return rest; });
        const note = r.removalVersion != null ? SETTINGS_COPY.removed : live && k !== "indexable" ? SETTINGS_COPY.nextPublish : undefined;
        setNotes((n) => ({ ...n, [k]: note }));
      },
      onError: (err) => {
        haptics.error();
        setPending((p) => { const { [k]: _drop, ...rest } = p; return rest; });
        setNotes((n) => ({ ...n, [k]: problemLine(publicCardError(err), ERROR_COPY.save) }));
      },
    });
  };

  const row = (k: keyof PublicCardSwitches, title: string, meta: string, extra: string | null, last = false) => (
    <View key={k} style={[styles.switchRow, last && styles.last]} testID={`settings-switch-row-${k}`}>
      <View style={styles.flex}>
        <Text style={styles.switchTitle}>{title}</Text>
        <Text style={styles.meta}>{meta}</Text>
        {extra ? <Text style={styles.unavailable} testID={`settings-unavailable-${k}`}>{extra}</Text> : null}
        {notes[k] ? <Text style={styles.note} accessibilityLiveRegion="polite" testID={`settings-note-${k}`}>{notes[k]}</Text> : null}
      </View>
      <Switch
        value={value(k)}
        onValueChange={(v) => flip(k, v)}
        disabled={pending[k] !== undefined}
        trackColor={{ false: Bold.track, true: Bold.ink }}
        thumbColor={Bold.paper}
        accessibilityLabel={SWITCH_LABEL[k]}
        accessibilityHint={extra ?? meta}
        testID={`settings-switch-${k}`}
      />
    </View>
  );

  return (
    <>
      <Card bold testID="settings-doors">
        <RuledHead title={SETTINGS_COPY.doors} style={styles.ruled} />
        <Text style={[styles.meta, styles.pad]}>{live ? SETTINGS_COPY.doorsLive : SETTINGS_COPY.doorsDraft}</Text>
        {DOOR_ORDER.map((k, i) => row(k, DOOR_COPY[k].title, DOOR_COPY[k].meta, doorUnavailable(k, d.availability), i === DOOR_ORDER.length - 1))}
      </Card>
      <Card bold testID="settings-privacy">
        <RuledHead title={SETTINGS_COPY.privacy} style={styles.ruled} />
        {row("showMia", SETTINGS_COPY.mia, SETTINGS_COPY.miaMeta, null)}
        {row("indexable", SETTINGS_COPY.search, SETTINGS_COPY.searchMeta, null, true)}
      </Card>
    </>
  );
}

// ─── social links (per-link choice is not built on the server yet) ───────────────────────────────────────────────

function Socials() {
  const preview = usePublicCardPreview();
  const socials = preview.data?.content.socials ?? [];
  return (
    <Card bold testID="settings-socials">
      <RuledHead title={SETTINGS_COPY.socials} style={styles.ruled} />
      <Text style={[styles.meta, styles.pad]} testID="settings-socials-soon">{SETTINGS_COPY.socialsSoon}</Text>
      {preview.isLoading ? <ActivityIndicator color={Bold.ink} style={styles.pad} accessibilityLabel="Loading your social links" /> : null}
      {preview.isError ? (
        <View style={[styles.pad, styles.block]}>
          <Text style={styles.body}>{problemLine(publicCardError(preview.error))}</Text>
          <Button bold="small" onPress={() => preview.refetch()} style={styles.self}>{ERROR_COPY.retry}</Button>
        </View>
      ) : null}
      {preview.data && !socials.length ? <Text style={[styles.body, styles.pad]}>{SETTINGS_COPY.socialsNone}</Text> : null}
      {socials.map((s, i) => (
        <View key={`${s.network}:${s.handle}`} style={[styles.switchRow, i === socials.length - 1 && styles.last]} accessibilityLabel={`${s.network} ${s.handle}. Shows on your card. Choosing per link is coming soon.`}>
          <View style={styles.flex}>
            <Text style={styles.switchTitle}>{s.network.charAt(0).toUpperCase() + s.network.slice(1)}</Text>
            <Text style={styles.meta}>{s.handle}</Text>
          </View>
          <Chip bold="line">Coming soon</Chip>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: Bold.paper },
  content:     { paddingHorizontal: Bold.gutter, paddingBottom: 40, gap: 14 },
  title:       { ...BoldType.screenTitleSm, color: Bold.ink },
  spinner:     { marginTop: 24 },
  block:       { gap: 10 },
  self:        { alignSelf: "flex-start" },
  flex:        { flex: 1, gap: 2 },
  body:        { ...BoldType.body, color: Bold.ink2 },
  meta:        { ...BoldType.rowMeta, color: Bold.mute },
  note:        { ...BoldType.rowMeta, color: Bold.ink },
  unavailable: { ...BoldType.rowMeta, color: Bold.ink2 },
  ruled:       { paddingHorizontal: 14, paddingTop: 12 },
  pad:         { paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  url:         { ...BoldType.rowTitle, color: Bold.ink },
  handleRow:   { flexDirection: "row", alignItems: "center", gap: 6 },
  prefix:      { ...BoldType.body, color: Bold.mute },
  input:       { flex: 1, height: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12, ...BoldType.body, color: Bold.ink },
  inputLocked: { backgroundColor: Bold.ground, color: Bold.mute },
  switchRow:   { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  switchTitle: { ...BoldType.rowTitle, color: Bold.ink },
  last:        { borderBottomWidth: 0 },
});
