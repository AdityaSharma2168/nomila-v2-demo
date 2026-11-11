// PickCard — one pick as fans will see it (Her picks, docs/design/shop-her-picks.md §5.4, look B).
//
// The "PAID LINK" disclosure is part of this component and has NO prop to hide it: anywhere a pick is drawn, the
// disclosure is drawn with it (FTC: "paid link" next to the link). Her own line, when she wrote one, is set in her words
// style; Mila's suggestion is never passed here. Used by My Picks (her preview) and Mila's pick card.

import React from "react";
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Chip } from "../ui";
import { Photo } from "../ui/Photo";
import { Bold, BoldType } from "../../constants/theme";
import { DISCLOSURE, formatPrice } from "../../lib/shopLogic";

export interface PickCardData {
  title: string;
  imageUrl: string | null;
  store: string | null;
  priceCents: number | null;
  currency: string | null;
  /** HER words only. */
  blurb?: string | null;
  discountCode?: string | null;
}

export function PickCard({ pick, style, testID }: { pick: PickCardData; style?: StyleProp<ViewStyle>; testID?: string }) {
  const price = formatPrice(pick.priceCents, pick.currency);
  return (
    <View style={[styles.card, style]} testID={testID ?? "pick-card"}>
      <View style={styles.row}>
        {pick.imageUrl ? (
          <Photo uri={pick.imageUrl} style={styles.image} />
        ) : (
          <View style={[styles.image, styles.blank]}>
            <Feather name="shopping-bag" size={18} color={Bold.mute} />
          </View>
        )}
        <View style={styles.body}>
          {pick.store ? <Text style={styles.store} numberOfLines={1}>{pick.store}</Text> : null}
          <Text style={styles.title} numberOfLines={2}>{pick.title}</Text>
          {price ? <Text style={styles.meta}>{price}</Text> : null}
        </View>
      </View>
      {pick.blurb ? (
        <View style={styles.her}>
          <Text style={styles.herText}>{`“${pick.blurb}”`}</Text>
        </View>
      ) : null}
      <View style={styles.foot}>
        {pick.discountCode ? <Text style={styles.meta} numberOfLines={1}>{`Code ${pick.discountCode}`}</Text> : <View />}
        <Chip bold="dark" testID="pick-disclosure">{DISCLOSURE}</Chip>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card:    { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, padding: 14, gap: 10 },
  row:     { flexDirection: "row", gap: 12 },
  image:   { width: 64, height: 64, borderRadius: Bold.radius.control, backgroundColor: Bold.ground },
  blank:   { alignItems: "center", justifyContent: "center" },
  body:    { flex: 1, gap: 2 },
  store:   { ...BoldType.label, color: Bold.mute },
  title:   { ...BoldType.rowTitle, color: Bold.ink },
  meta:    { ...BoldType.rowMeta, color: Bold.ink2 },
  her:     { borderLeftWidth: 3, borderLeftColor: Bold.blue, paddingLeft: 12, paddingVertical: 2 },
  herText: { ...BoldType.herWords, color: Bold.ink },
  foot:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
});
