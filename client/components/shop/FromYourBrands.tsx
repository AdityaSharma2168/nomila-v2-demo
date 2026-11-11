// FromYourBrands — "select, don't paste" on My Picks (the catalog-only Shopify app, docs/design/shop-her-picks.md §12,
// look B). Behind EXPO_PUBLIC_SHOP_SHOPIFY_APP.
//
// Only brands she works with that installed the app are listed. "Ask to feature" sends the brand her request; once the
// brand approves her (in its Shopify admin), "Browse products" opens the catalog and "Add" makes a DRAFT pick whose link
// carries the code the brand gave her. Nothing is published here: she publishes on My Picks like any other pick.

import React, { useState } from "react";
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Button, Card, IconTile, RuledHead, Sheet } from "../ui";
import { Photo } from "../ui/Photo";
import { useAddFromCatalog, useBrandCatalog, useRequestBrand, useShopBrands, type ShopBrand } from "../../hooks/use-shop";
import { BRANDS_COPY, formatPrice } from "../../lib/shopLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";

export function FromYourBrands() {
  const brands = useShopBrands();
  const request = useRequestBrand();
  const [open, setOpen] = useState<ShopBrand | null>(null);
  const list = brands.data?.brands ?? [];
  if (!list.length) return null;
  return (
    <Card bold style={styles.card} testID="picks-brands">
      <RuledHead title={BRANDS_COPY.title} />
      <Text style={styles.lede}>{BRANDS_COPY.lede}</Text>
      {list.map((b) => (
        <View key={b.shopId} style={styles.row} testID={`brand-${b.shopId}`}>
          <View style={styles.flex}>
            <Text style={styles.title} numberOfLines={1}>{b.name}</Text>
            <Text style={styles.meta} numberOfLines={1}>{b.state === "approved" && b.code ? BRANDS_COPY.code(b.code) : b.domain}</Text>
          </View>
          {b.state === "approved" ? (
            <Button bold="small" onPress={() => setOpen(b)} testID={`brand-browse-${b.shopId}`}>{BRANDS_COPY.browse}</Button>
          ) : b.state === "none" ? (
            <Button bold="small" disabled={request.isPending} onPress={() => request.mutate(b.shopId, { onSuccess: () => haptics.success() })} testID={`brand-ask-${b.shopId}`}>{BRANDS_COPY.ask}</Button>
          ) : (
            <Text style={styles.meta}>{b.state === "pending" ? BRANDS_COPY.pending : BRANDS_COPY.declined}</Text>
          )}
        </View>
      ))}
      {open ? <CatalogSheet brand={open} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

function CatalogSheet({ brand, onClose }: { brand: ShopBrand; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const catalog = useBrandCatalog(brand.shopId, query);
  const add = useAddFromCatalog();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const products = catalog.data?.products ?? [];
  return (
    <Sheet onClose={onClose} title={`${brand.name} · ${BRANDS_COPY.sheetTitle}`} keyboard>
      <TextInput value={q} onChangeText={setQ} onSubmitEditing={() => setQuery(q.trim())} placeholder={BRANDS_COPY.search} placeholderTextColor={Bold.quiet} returnKeyType="search" style={styles.input} accessibilityLabel={BRANDS_COPY.search} testID="catalog-search" />
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled" testID="catalog-sheet">
        {!catalog.isLoading && !products.length ? <Text style={styles.meta}>{BRANDS_COPY.none}</Text> : null}
        {products.map((p) => {
          const done = added.has(p.id);
          return (
            <View key={p.id} style={styles.product}>
              {p.imageUrl ? <Photo uri={p.imageUrl} style={styles.thumb} /> : <IconTile icon="shopping-bag" bold="grey" />}
              <View style={styles.flex}>
                <Text style={styles.title} numberOfLines={2}>{p.title}</Text>
                <Text style={styles.meta}>{p.available ? formatPrice(p.priceCents, p.currency) ?? "" : BRANDS_COPY.unavailable}</Text>
              </View>
              {done ? (
                <View style={styles.done}><Feather name="check" size={16} color={Bold.ink} /><Text style={styles.meta}>{BRANDS_COPY.added}</Text></View>
              ) : (
                <Pressable
                  onPress={() => add.mutate(p.id, { onSuccess: () => { haptics.success(); setAdded((s) => new Set(s).add(p.id)); } })}
                  disabled={add.isPending} accessibilityRole="button" accessibilityLabel={`${BRANDS_COPY.add} ${p.title}`} style={styles.addBtn} testID={`catalog-add-${p.id}`}
                >
                  <Text style={styles.addText}>{BRANDS_COPY.add}</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card:    { padding: 14, gap: 10 },
  lede:    { ...BoldType.caption, color: Bold.mute },
  row:     { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, borderTopWidth: 1, borderTopColor: Bold.line, paddingTop: 10 },
  flex:    { flex: 1 },
  title:   { ...BoldType.rowTitle, color: Bold.ink },
  meta:    { ...BoldType.rowMeta, color: Bold.mute },
  input:   { minHeight: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12, ...BoldType.body, color: Bold.ink, backgroundColor: Bold.paper, marginBottom: 8 },
  scroll:  { maxHeight: 480 },
  product: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Bold.line },
  thumb:   { width: 40, height: 40, borderRadius: Bold.radius.control, backgroundColor: Bold.ground },
  done:    { flexDirection: "row", alignItems: "center", gap: 4 },
  addBtn:  { height: Bold.buttonSmall, paddingHorizontal: 12, borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.control, alignItems: "center", justifyContent: "center", minWidth: 64 },
  addText: { ...BoldType.buttonSmall, color: Bold.ink },
});
