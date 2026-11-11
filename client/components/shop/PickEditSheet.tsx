// PickEditSheet — one pick, opened from My Picks (Her picks, docs/design/shop-her-picks.md §1, look B).
//
// She edits the title, HER line ("In your words"), the discount code and the category, sees the pick exactly as fans
// will (PickCard, with its "Paid link"), and publishes, hides or deletes it. Mila's suggestion is shown as one, with
// "Use this" — which only copies it into her field; nothing she hasn't saved is ever her words. Publishing runs the
// server's gates: a warning comes back as a 409 she reads here, and "I've checked — publish" resends with
// confirm_warnings. Supplements-off and an unopened shelf come back as plain lines; nothing is ever silently blocked.

import React, { useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { Button, Sheet } from "../ui";
import { PickCard } from "./PickCard";
import { useDeleteShopItem, useUpdateShopItem, type ShopItem, type ShopItemPatch, type ShopWarning } from "../../hooks/use-shop";
import { AMAZON_NO_TAG, CATEGORY_LABEL, EDIT_COPY, PICKS_COPY, detectedLine, shopRefusal } from "../../lib/shopLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";

export function PickEditSheet({ item, categories, onClose }: { item: ShopItem; categories: string[]; onClose: () => void }) {
  const update = useUpdateShopItem();
  const remove = useDeleteShopItem();
  const [title, setTitle] = useState(item.title);
  const [blurb, setBlurb] = useState(item.blurb ?? "");
  const [code, setCode] = useState(item.discountCode ?? "");
  const [category, setCategory] = useState<string | null>(item.category);
  const [warnings, setWarnings] = useState<ShopWarning[]>([]);
  const [line, setLine] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const busy = update.isPending || remove.isPending;

  const fields = (): ShopItemPatch => ({
    ...(title.trim() && title.trim() !== item.title ? { title: title.trim() } : {}),
    ...(blurb.trim() !== (item.blurb ?? "") ? { blurb: blurb.trim() || null } : {}),
    ...(code.trim() !== (item.discountCode ?? "") ? { discount_code: code.trim() || null } : {}),
    ...(category !== item.category ? { category } : {}),
  });

  const send = (patch: ShopItemPatch, closeAfter: boolean) => {
    if (busy) return;
    setLine(null);
    update.mutate({ id: item.id, patch }, {
      onSuccess: () => { haptics.success(); setWarnings([]); if (closeAfter) onClose(); },
      onError: (err) => {
        const r = shopRefusal(err);
        if (r?.code === "needs_confirmation" && r.warnings?.length) { setWarnings(r.warnings); return; }
        if (r?.code === "supplements_off") { setWarnings(r.warnings ?? []); setLine(r.error); return; }
        if (r?.code === "needs_category") { setLine(EDIT_COPY.needsCategory); return; }
        if (r?.code === "not_eligible") { setLine(EDIT_COPY.notEligible); return; }
        setLine(r?.error && r.status < 500 ? r.error : PICKS_COPY.error);
      },
    });
  };
  const confirmable = warnings.length > 0 && warnings.every((w) => w.code === "exclusivity" || w.code === "school_sponsor");

  const onDelete = () => {
    if (!armedDelete) { haptics.warning(); setArmedDelete(true); return; }
    remove.mutate(item.id, { onSuccess: () => { haptics.success(); onClose(); } });
  };

  return (
    <Sheet onClose={() => { if (!busy) onClose(); }} title={EDIT_COPY.title} keyboard>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" testID="pick-edit-sheet">
        <Text style={styles.label}>{EDIT_COPY.preview}</Text>
        <PickCard pick={{ title: title.trim() || item.title, imageUrl: item.imageUrl, store: item.merchant ?? item.host, priceCents: item.priceCents, currency: item.currency, blurb: blurb.trim() || null, discountCode: code.trim() || null }} />
        <Text style={styles.meta}>{detectedLine(item.source, item.networkTag)}</Text>
        {item.source === "amazon" && !item.networkTag ? <Text style={styles.warn}>{AMAZON_NO_TAG}</Text> : null}

        <Text style={styles.label}>{EDIT_COPY.name}</Text>
        <TextInput value={title} onChangeText={setTitle} maxLength={160} style={styles.input} accessibilityLabel={EDIT_COPY.name} testID="pick-title" />

        <Text style={styles.herLabel}>{EDIT_COPY.words}</Text>
        <TextInput value={blurb} onChangeText={setBlurb} placeholder={EDIT_COPY.wordsPlaceholder} placeholderTextColor={Bold.quiet} multiline maxLength={280} style={[styles.input, styles.multi]} accessibilityLabel={EDIT_COPY.words} testID="pick-blurb" />
        {item.blurbSuggestion && item.blurbSuggestion !== blurb.trim() ? (
          <View style={styles.suggestion} testID="pick-suggestion">
            <Text style={styles.suggestionLabel}>{EDIT_COPY.suggestion}</Text>
            <Text style={styles.meta}>{item.blurbSuggestion}</Text>
            <Button bold="link" onPress={() => setBlurb(item.blurbSuggestion ?? "")} testID="pick-use-suggestion">{EDIT_COPY.useThis}</Button>
          </View>
        ) : null}

        <Text style={styles.label}>{EDIT_COPY.code}</Text>
        <TextInput value={code} onChangeText={setCode} placeholder={EDIT_COPY.codePlaceholder} placeholderTextColor={Bold.quiet} autoCapitalize="characters" maxLength={40} style={styles.input} accessibilityLabel={EDIT_COPY.code} testID="pick-code" />

        <Text style={styles.label}>{EDIT_COPY.category}</Text>
        <View style={styles.chips}>
          {categories.map((c) => {
            const on = c === category;
            return (
              <Pressable key={c} onPress={() => { haptics.select(); setCategory(c); }} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[styles.chip, on && styles.chipOn]} testID={`pick-category-${c}`}>
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{CATEGORY_LABEL[c] ?? c}</Text>
              </Pressable>
            );
          })}
        </View>

        {warnings.map((w, i) => <Text key={`${w.code}-${i}`} style={styles.warn} testID={`pick-warning-${w.code}`}>{w.text}</Text>)}
        {line ? <Text style={styles.error} testID="pick-line">{line}</Text> : null}

        {confirmable ? (
          <Button bold="primary" onPress={() => send({ ...fields(), status: "live", confirm_warnings: true }, true)} loading={update.isPending} testID="pick-publish-confirmed">{EDIT_COPY.publishAnyway}</Button>
        ) : item.status !== "live" ? (
          <Button bold="primary" onPress={() => send({ ...fields(), status: "live" }, true)} loading={update.isPending} testID="pick-publish">{EDIT_COPY.publish}</Button>
        ) : null}
        <View style={styles.row}>
          <Button bold="secondary" onPress={() => send(fields(), true)} disabled={busy} style={styles.flex} testID="pick-save">{EDIT_COPY.save}</Button>
          {item.status === "live" ? <Button bold="secondary" onPress={() => send({ ...fields(), status: "hidden" }, true)} disabled={busy} style={styles.flex} testID="pick-hide">{EDIT_COPY.hide}</Button> : null}
        </View>
        <Button bold="link" onPress={onDelete} disabled={busy} testID="pick-delete">{armedDelete ? EDIT_COPY.deleteConfirm : EDIT_COPY.delete}</Button>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll:          { maxHeight: 620 },
  body:            { gap: 10, paddingBottom: 8 },
  label:           { ...BoldType.label, color: Bold.mute, marginTop: 4 },
  herLabel:        { ...BoldType.herLabel, color: Bold.blue, marginTop: 4 },
  meta:            { ...BoldType.rowMeta, color: Bold.ink2 },
  input:           { minHeight: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12, paddingVertical: 10, ...BoldType.body, color: Bold.ink, backgroundColor: Bold.paper },
  multi:           { minHeight: 72, textAlignVertical: "top", borderLeftWidth: 3, borderLeftColor: Bold.blue },
  suggestion:      { backgroundColor: Bold.ground, borderRadius: Bold.radius.control, padding: 10, gap: 4 },
  suggestionLabel: { ...BoldType.label, color: Bold.mute },
  chips:           { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip:            { height: 36, paddingHorizontal: 12, borderRadius: Bold.radius.control, borderWidth: 1.5, borderColor: Bold.ink, alignItems: "center", justifyContent: "center", backgroundColor: Bold.paper },
  chipOn:          { backgroundColor: Bold.ink },
  chipText:        { ...BoldType.chipLine, color: Bold.ink },
  chipTextOn:      { color: Bold.onDark },
  warn:            { ...BoldType.rowMeta, color: Bold.ink, borderLeftWidth: 3, borderLeftColor: Bold.ink, paddingLeft: 10 },
  error:           { ...BoldType.caption, color: Bold.ink2 },
  row:             { flexDirection: "row", gap: 8 },
  flex:            { flex: 1 },
});
