// MyPicksScreen — Me › My Picks: her product shelf manager (Her picks, docs/design/shop-her-picks.md §1, look B).
// Behind EXPO_PUBLIC_SHOP_V1 (the Me door) and the server's SHOP_V1 (the routes).
//
//   Gate          the black block, until her shelf is open: "I'm 18 or older", the international-student question
//                 (never guessed) and, for a yes, the visa warning she acknowledges. A known minor sees one plain line.
//   Add a pick    paste her link (or Paste from the clipboard) → a DRAFT with what the page said. Her link, as given.
//   From your brands  (SHOP_SHOPIFY_APP) her brands' Shopify catalogs, once a brand approves her: pick, don't paste.
//   Your picks    her order (up / down), each row: picture, title, Live · clicks / Draft / Hidden → the edit sheet
//                 (her words, code, category, the fan preview with "Paid link", publish / hide / delete)
//   NIL Go        college athletes: her signed brand deals per brand against $600 — a reminder, never a filing — and
//                 the plain note that her own affiliate income isn't counted
//   Settings      supplements (off; on only after the warning), her school's apparel sponsor, the international answer
//
// The share sheet (receiving a link from another app) needs a native build; paste + clipboard ship first.

import React, { useState } from "react";
import { View, Text, TextInput, ScrollView, SafeAreaView, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Card, Button, StackHeader, RuledHead, SectionHead, IconTile } from "../../components/ui";
import { Photo } from "../../components/ui/Photo";
import { PickEditSheet } from "../../components/shop/PickEditSheet";
import { FromYourBrands } from "../../components/shop/FromYourBrands";
import { SHOP_SHOPIFY_APP } from "../../lib/flags";
import { useAddShopItem, useReorderShopItems, useShop, useShopSettings, type ShopItem, type ShopResponse } from "../../hooks/use-shop";
import { PICKS_COPY, dollars, moveId, pickMeta, shopRefusal } from "../../lib/shopLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";

export function MyPicksScreen() {
  const shop = useShop();
  const data = shop.data;
  const [editing, setEditing] = useState<ShopItem | null>(null);

  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title={PICKS_COPY.parent} bold />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>{PICKS_COPY.title}</Text>
        <Text style={styles.lede}>{PICKS_COPY.lede}</Text>
        {shop.isLoading ? <ActivityIndicator style={{ marginTop: 24 }} color={Bold.ink} /> : null}
        {shop.isError ? <Button bold="secondary" onPress={() => shop.refetch()} style={styles.retry}>Retry</Button> : null}
        {data ? (
          <>
            <Gate data={data} />
            <AddPick />
            {SHOP_SHOPIFY_APP ? <FromYourBrands /> : null}
            <PickList items={data.items} onOpen={setEditing} />
            <NilGo data={data} />
            <Settings data={data} />
          </>
        ) : null}
      </ScrollView>
      {editing && data ? <PickEditSheet item={editing} categories={data.categories} onClose={() => setEditing(null)} /> : null}
    </SafeAreaView>
  );
}

// ─── The gate: the one black block, only until the shelf is open ──────────────────────────────────────────────────

function Gate({ data }: { data: ShopResponse }) {
  const settings = useShopSettings();
  const s = data.settings;
  if (s.eligible) return null;
  if (s.needs.includes("minor")) {
    return <Card bold style={styles.card} testID="picks-minor"><Text style={styles.body}>{PICKS_COPY.minor}</Text></Card>;
  }
  const busy = settings.isPending;
  return (
    <View style={styles.gate} testID="picks-gate">
      <Text style={styles.gateTitle}>{PICKS_COPY.gateTitle}</Text>
      {s.adultConfirmed ? (
        <Text style={styles.gateDone}>{PICKS_COPY.adultDone}</Text>
      ) : (
        <Button bold="onHero" onPress={() => settings.mutate({ adult_confirmed: true })} disabled={busy} testID="picks-adult">{PICKS_COPY.adult}</Button>
      )}
      {s.internationalStudent === null ? (
        <>
          <Text style={styles.gateText}>{PICKS_COPY.intlQuestion}</Text>
          <View style={styles.row}>
            <Button bold="onHero" onPress={() => settings.mutate({ international_student: true })} disabled={busy} style={styles.flex} testID="picks-intl-yes">{PICKS_COPY.yes}</Button>
            <Button bold="onHero" onPress={() => settings.mutate({ international_student: false })} disabled={busy} style={styles.flex} testID="picks-intl-no">{PICKS_COPY.no}</Button>
          </View>
        </>
      ) : s.internationalStudent && !s.internationalAcknowledged ? (
        <>
          <Text style={styles.gateText} testID="picks-intl-warning">{PICKS_COPY.intlWarning}</Text>
          <Button bold="onHero" onPress={() => settings.mutate({ international_ack: true })} disabled={busy} testID="picks-intl-ack">{PICKS_COPY.intlAck}</Button>
        </>
      ) : null}
      {settings.isError ? <Text style={styles.gateDone}>{PICKS_COPY.error}</Text> : null}
    </View>
  );
}

// ─── Add a pick: paste her link → a draft ─────────────────────────────────────────────────────────────────────────

function AddPick() {
  const add = useAddShopItem();
  const [url, setUrl] = useState("");
  const [line, setLine] = useState<string | null>(null);
  const submit = (link: string) => {
    if (!link.trim() || add.isPending) return;
    setLine(null);
    add.mutate({ url: link.trim() }, {
      onSuccess: (r) => { haptics.success(); setUrl(""); setLine(r.existing ? PICKS_COPY.existing : PICKS_COPY.added); },
      onError: (err) => { const r = shopRefusal(err); setLine(r?.error && r.status < 500 ? r.error : PICKS_COPY.error); },
    });
  };
  const paste = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) { setUrl(text.trim()); haptics.select(); }
    } catch { /* nothing to paste */ }
  };
  return (
    <Card bold style={styles.card} testID="picks-add">
      <RuledHead title={PICKS_COPY.addTitle} />
      <TextInput
        value={url} onChangeText={setUrl} placeholder={PICKS_COPY.addPlaceholder} placeholderTextColor={Bold.quiet}
        autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input}
        onSubmitEditing={() => submit(url)} accessibilityLabel={PICKS_COPY.addPlaceholder} testID="picks-url"
      />
      <View style={styles.row}>
        <Button bold="secondary" onPress={paste} style={styles.flex} testID="picks-paste">{PICKS_COPY.paste}</Button>
        <Button bold="primary" onPress={() => submit(url)} loading={add.isPending} disabled={!url.trim()} style={styles.flex} testID="picks-add-button">{PICKS_COPY.add}</Button>
      </View>
      {line ? <Text style={styles.meta} testID="picks-add-line">{line}</Text> : null}
      <Text style={styles.caption}>{PICKS_COPY.addNote}</Text>
    </Card>
  );
}

// ─── Her picks, in her order ──────────────────────────────────────────────────────────────────────────────────────

function PickList({ items, onOpen }: { items: ShopItem[]; onOpen: (i: ShopItem) => void }) {
  const reorder = useReorderShopItems();
  const ids = items.map((i) => i.id);
  const move = (id: string, dir: -1 | 1) => {
    const next = moveId(ids, id, dir);
    if (next !== ids && !reorder.isPending) { haptics.select(); reorder.mutate(next); }
  };
  return (
    <View style={styles.section}>
      <SectionHead title={PICKS_COPY.listTitle} sub={items.length ? `${items.length}` : null} />
      {items.length === 0 ? (
        <Text style={styles.meta} testID="picks-empty">{PICKS_COPY.empty}</Text>
      ) : (
        <Card bold>
          {items.map((it, i) => (
            <View key={it.id} style={[styles.pickRow, i < items.length - 1 && styles.rowLine]}>
              <Pressable style={styles.pickMain} onPress={() => onOpen(it)} accessibilityRole="button" accessibilityLabel={`${it.title}, ${pickMeta(it.status, it.clicks7d, it.clicks30d)}`} testID={`pick-row-${it.id}`}>
                {it.imageUrl ? <Photo uri={it.imageUrl} style={styles.thumb} /> : <IconTile icon="shopping-bag" bold="grey" />}
                <View style={styles.flex}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{it.title}</Text>
                  <Text style={[styles.rowMeta, it.status === "live" && styles.live]} numberOfLines={1}>{pickMeta(it.status, it.clicks7d, it.clicks30d)}</Text>
                </View>
              </Pressable>
              <View style={styles.order}>
                <Pressable onPress={() => move(it.id, -1)} disabled={i === 0} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Move ${it.title} up`} testID={`pick-up-${it.id}`}>
                  <Feather name="chevron-up" size={18} color={i === 0 ? Bold.line : Bold.ink} />
                </Pressable>
                <Pressable onPress={() => move(it.id, 1)} disabled={i === items.length - 1} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Move ${it.title} down`} testID={`pick-down-${it.id}`}>
                  <Feather name="chevron-down" size={18} color={i === items.length - 1 ? Bold.line : Bold.ink} />
                </Pressable>
              </View>
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}

// ─── NIL Go: a reminder, never a filing ───────────────────────────────────────────────────────────────────────────

function NilGo({ data }: { data: ShopResponse }) {
  const n = data.nilGo;
  if (!n.applies) return null;
  return (
    <Card bold style={styles.card} testID="picks-nilgo">
      <RuledHead title={n.copy.title} />
      <Text style={styles.body}>{n.copy.rule}</Text>
      {n.brands.map((b) => (
        <View key={b.brand} style={styles.nilRow} testID={`nilgo-${b.brand}`}>
          <Text style={[styles.rowTitle, styles.flex]} numberOfLines={1}>{b.brand}</Text>
          <Text style={styles.rowMeta}>{dollars(b.totalCents)}</Text>
          <Text style={[styles.rowMeta, b.reportable && styles.live]}>{b.reportable ? PICKS_COPY.nilGoReport : PICKS_COPY.nilGoUnder}</Text>
        </View>
      ))}
      <Text style={styles.caption}>{n.copy.notFiling}</Text>
      <Text style={styles.caption} testID="nilgo-affiliate-note">{n.copy.affiliateNote}</Text>
    </Card>
  );
}

// ─── Settings: supplements, her school's sponsor, the international answer ────────────────────────────────────────

function Settings({ data }: { data: ShopResponse }) {
  const settings = useShopSettings();
  const s = data.settings;
  const [confirmSupp, setConfirmSupp] = useState(false);
  const [sponsor, setSponsor] = useState(s.schoolApparelSponsor ?? "");
  const busy = settings.isPending;
  return (
    <Card bold style={styles.card} testID="picks-settings">
      <RuledHead title={PICKS_COPY.settingsTitle} />
      <View style={styles.settingRow}>
        <Text style={[styles.rowTitle, styles.flex]}>{`${PICKS_COPY.supplements}: ${s.supplementsOn ? PICKS_COPY.supplementsOn : PICKS_COPY.supplementsOff}`}</Text>
        <Button bold="small" disabled={busy} onPress={() => (s.supplementsOn ? settings.mutate({ supplements_opt_in: false }) : setConfirmSupp(true))} testID="picks-supplements">
          {s.supplementsOn ? PICKS_COPY.supplementsTurnOff : PICKS_COPY.supplementsTurnOn}
        </Button>
      </View>
      {confirmSupp && !s.supplementsOn ? (
        <View style={styles.confirm} testID="picks-supplements-warning">
          <Text style={styles.body}>{PICKS_COPY.supplementsWarning}</Text>
          <Button bold="primary" disabled={busy} onPress={() => settings.mutate({ supplements_opt_in: true }, { onSuccess: () => setConfirmSupp(false) })} testID="picks-supplements-confirm">{PICKS_COPY.supplementsConfirm}</Button>
        </View>
      ) : null}
      <Text style={styles.label}>{PICKS_COPY.sponsor}</Text>
      <View style={styles.row}>
        <TextInput value={sponsor} onChangeText={setSponsor} placeholder={PICKS_COPY.sponsorPlaceholder} placeholderTextColor={Bold.quiet} maxLength={80} style={[styles.input, styles.flex]} accessibilityLabel={PICKS_COPY.sponsor} testID="picks-sponsor" />
        <Button bold="small" disabled={busy || sponsor.trim() === (s.schoolApparelSponsor ?? "")} onPress={() => settings.mutate({ school_apparel_sponsor: sponsor.trim() || null })} style={styles.sponsorSave} testID="picks-sponsor-save">{PICKS_COPY.save}</Button>
      </View>
      <Text style={styles.caption}>{PICKS_COPY.sponsorNote}</Text>
      {s.internationalStudent !== null ? (
        <View style={styles.settingRow}>
          <Text style={[styles.rowTitle, styles.flex]}>{`${PICKS_COPY.international}: ${s.internationalStudent ? PICKS_COPY.yes : PICKS_COPY.no}`}</Text>
          <Button bold="small" disabled={busy} onPress={() => settings.mutate({ international_student: !s.internationalStudent })} testID="picks-intl-change">{PICKS_COPY.change}</Button>
        </View>
      ) : null}
      {settings.isError ? <Text style={styles.caption}>{PICKS_COPY.error}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: Bold.paper },
  content:     { paddingHorizontal: Bold.gutter, paddingBottom: 40, gap: 16 },
  title:       { ...BoldType.screenTitleSm, color: Bold.ink },
  lede:        { ...BoldType.lede, color: Bold.mute, marginTop: -8 },
  retry:       { alignSelf: "flex-start" },
  card:        { padding: 14, gap: 10 },
  section:     { gap: 8 },
  gate:        { backgroundColor: Bold.ink, borderRadius: Bold.radius.card, padding: 16, gap: 12 },
  gateTitle:   { ...BoldType.section, color: Bold.onDark },
  gateText:    { ...BoldType.read, color: Bold.onDarkSoft },
  gateDone:    { ...BoldType.rowMeta, color: Bold.onDarkLabel },
  body:        { ...BoldType.body, color: Bold.ink2 },
  meta:        { ...BoldType.rowMeta, color: Bold.ink2 },
  caption:     { ...BoldType.caption, color: Bold.mute },
  label:       { ...BoldType.label, color: Bold.mute, marginTop: 4 },
  input:       { minHeight: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12, ...BoldType.body, color: Bold.ink, backgroundColor: Bold.paper },
  row:         { flexDirection: "row", gap: 8, alignItems: "center" },
  flex:        { flex: 1 },
  pickRow:     { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, gap: 8 },
  rowLine:     { borderBottomWidth: 1, borderBottomColor: Bold.line },
  pickMain:    { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  thumb:       { width: 40, height: 40, borderRadius: Bold.radius.control, backgroundColor: Bold.ground },
  rowTitle:    { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:     { ...BoldType.rowMeta, color: Bold.mute },
  live:        { color: Bold.blue },
  order:       { gap: 6, alignItems: "center" },
  nilRow:      { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: Bold.line },
  settingRow:  { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  confirm:     { gap: 10, padding: 12, backgroundColor: Bold.ground, borderRadius: Bold.radius.control },
  sponsorSave: { alignSelf: "center" },
});
