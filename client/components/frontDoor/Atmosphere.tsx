/**
 * Atmosphere — the ATMOSPHERE image (DESIGN.md §9): a venue, surface, piece of equipment, light or texture, never a
 * person, a logo or text, behind content that is NOT about the athlete (a chapter card, a pillar tile, a section header).
 * Promoted from the approved prototype (PR #900, client/screens/prototypes/Atmosphere.tsx).
 *
 *   <AtmosphereCredit text />                 the credit line, top-left over an image (the deck's solid panel, never a blur)
 *   <AtmosphereImage uri credit style />      the image full-bleed in its box, with its credit line
 *   <AtmosphereSlot image domain height />    the picker's image when it served one, else the CATEGORY DEFAULT
 *                                             (components/strategy/RecommendationVisual) — the clean fallback while the
 *                                             picker is off or has nothing for the slot
 *
 * Images come from the picker route (POST /me/atmosphere/pick via hooks/use-me-memory useAtmosphere), never her library.
 */
import React from "react";
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Photo } from "../ui/Photo";
import { CategoryDefault } from "../strategy/RecommendationVisual";
import { Bold, BoldType } from "../../constants/theme";

export function AtmosphereCredit({ style, text }: { style?: StyleProp<ViewStyle>; text: string }) {
  return (
    <View style={[styles.credit, style]} pointerEvents="none" testID="atmosphere-credit">
      <Text style={styles.creditText} numberOfLines={1}>{text}</Text>
    </View>
  );
}

export function AtmosphereImage({ uri, style, children, testID, credit }: { uri: string; style?: StyleProp<ViewStyle>; children?: React.ReactNode; testID?: string; credit: string }) {
  return (
    <View style={[styles.box, style]} testID={testID ?? "atmosphere-image"}>
      <Photo uri={uri} style={StyleSheet.absoluteFill} />
      {children}
      <AtmosphereCredit text={credit} />
    </View>
  );
}

/** The slot's picker image, or the category default for `domain` (a goal / chapter domain word). */
export function AtmosphereSlot({ image, domain, height, style, children, testID }: {
  image: { url: string; credit: string } | null | undefined;
  domain: string | null;
  height: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  testID?: string;
}) {
  if (image) return <AtmosphereImage uri={image.url} credit={image.credit} style={[{ height }, style]} testID={testID}>{children}</AtmosphereImage>;
  return (
    <View style={[styles.box, { height }, style]} testID={testID ? `${testID}-default` : "atmosphere-default"}>
      <CategoryDefault domain={domain} height={height} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  box:        { overflow: "hidden", backgroundColor: Bold.heroBlank },
  credit:     { position: "absolute", top: 8, left: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: Bold.radius.chip, backgroundColor: Bold.deck.panel, borderWidth: 1, borderColor: Bold.deck.panelLine },
  creditText: { ...BoldType.caption, color: Bold.onDarkSoft },
});
