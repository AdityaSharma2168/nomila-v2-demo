// MilaShopWidget — the confirm card for a pick Mila got ready (Her picks, docs/design/shop-her-picks.md §7, look B).
//
// Mila's tool WRITES NOTHING. The card shows the product as fans would see it (PickCard, with its "Paid link"), what
// Nomila detected about her link, any warning, and Mila's suggested line labelled as a suggestion (never her words).
// "Add as a draft" calls POST /me/shop/items — her tap — and the pick is a draft until she publishes it on My Picks.
// Mila's suggestion travels only as `suggested_blurb`, which is stored apart from her words and never shown to fans.

import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Button } from "../ui";
import { PickCard } from "../shop/PickCard";
import { useAddShopItem } from "../../hooks/use-shop";
import type { ShopItemWidgetData } from "../../hooks/use-mila-chat";
import { AMAZON_NO_TAG, detectedLine } from "../../lib/shopLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "./milaSurface";

export const SHOP_CARD_COPY = {
  title: "Add this to your picks?",
  add: "Add as a draft",
  added: "Added as a draft. Publish it on My Picks when it's ready.",
  existing: "It's already on your picks.",
  suggestion: "Suggested by Mila — not shown to anyone unless you use it",
  closed: "Your shelf isn't open yet. You can add it now and finish setting up on My Picks.",
  safety: "Nothing is added or published without your tap. The link stays yours.",
  error: "Couldn't add that. Try again.",
} as const;

export function MilaShopWidget({ data }: { data: ShopItemWidgetData }) {
  const add = useAddShopItem();
  const [done, setDone] = useState<null | "added" | "existing">(null);
  const onAdd = () => {
    if (add.isPending || done) return;
    add.mutate({ url: data.url, suggested_blurb: data.suggestedBlurb }, {
      onSuccess: (r) => { haptics.success(); setDone(r.existing ? "existing" : "added"); },
    });
  };

  return (
    <View style={styles.card} testID="mila-shop-card">
      <Text style={styles.eyebrow}>{SHOP_CARD_COPY.title}</Text>
      <PickCard pick={{ title: data.title, imageUrl: data.imageUrl, store: data.store ?? data.host, priceCents: data.priceCents, currency: data.currency }} />
      <Text style={styles.meta} testID="mila-shop-detected">{detectedLine(data.source, data.networkTag)}</Text>
      {data.amazonWithoutTag ? <Text style={styles.warn}>{AMAZON_NO_TAG}</Text> : null}
      {data.warnings.map((w, i) => (
        <Text key={`${w.code}-${i}`} style={styles.warn} testID={`mila-shop-warning-${w.code}`}>{w.text}</Text>
      ))}
      {data.suggestedBlurb ? (
        <View style={styles.suggestion} testID="mila-shop-suggestion">
          <Text style={styles.suggestionLabel}>{SHOP_CARD_COPY.suggestion}</Text>
          <Text style={styles.meta}>{data.suggestedBlurb}</Text>
        </View>
      ) : null}
      {!data.shelfOpen ? <Text style={styles.meta}>{SHOP_CARD_COPY.closed}</Text> : null}
      {done ? (
        <Text style={styles.done} testID="mila-shop-done">{done === "added" ? SHOP_CARD_COPY.added : SHOP_CARD_COPY.existing}</Text>
      ) : (
        <>
          {add.isError ? <Text style={styles.error}>{SHOP_CARD_COPY.error}</Text> : null}
          <Button bold="primary" onPress={onAdd} loading={add.isPending} testID="mila-shop-add">{SHOP_CARD_COPY.add}</Button>
          <Text style={styles.safety}>{SHOP_CARD_COPY.safety}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // A light Mila card with the soft lift, no border (milaSurface; DESIGN.md §16).
  card:            { ...MILA_CARD, padding: 14, gap: 10 },
  eyebrow:         { ...BoldType.h4, color: Bold.ink },
  meta:            { ...BoldType.rowMeta, color: Bold.ink2 },
  warn:            { ...BoldType.rowMeta, color: Bold.ink, borderLeftWidth: 3, borderLeftColor: Bold.ink, paddingLeft: 10 },
  suggestion:      { backgroundColor: Bold.ground, borderRadius: Bold.radius.control, padding: 10, gap: 4 },
  suggestionLabel: { ...BoldType.label, color: Bold.mute },
  done:            { ...BoldType.rowMeta, color: Bold.ink },
  error:           { ...BoldType.caption, color: Bold.mute },
  safety:          { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
});
