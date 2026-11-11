// Home v3's story circles (EXPO_PUBLIC_HOME_V3; the "Alive" framework's Circle: a ring = new, a badge = needs you).
// One circle per CircleKey the model gives (This week · Offers · Moments, and Wins only when there is one). The ring is
// the circle's accent (pink; gold for Wins) while any item in it is unseen, and a thin grey once all are seen; the
// badge is the count that needs her. The picture is what the screen hands it: a photo (cover-filled), a logo (whole,
// on a white disc — a logo is never cropped like a photo), a brand's initial on that disc when it has no logo, or a date (a calendar face: weekday in pink over the day);
// else the circle's glyph on the quiet ground. Nothing here decides: lib/homeV3Logic does.

import React from "react";
import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Accent, Bold, BoldType, Fonts } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { Photo } from "../ui/Photo";
import { LogoMark } from "../ui/LogoMark";
import { badgeText, ringState, type Circle, type CircleKey, type DateFace, type StoryItem } from "../../lib/homeV3Logic";
import { MomentArt } from "../studioV3/MomentArt";

/** What a circle shows inside its ring. */
/** A logo is the Opportunities cards' own LogoMark chain (stored logo → the domain's favicon → initials). */
export type CircleFace = { photo: string } | { logo: { url: string | null; domain: string | null; name: string } } | { initial: string } | { date: DateFace }
  /** The next moment's picture (its post's photo, its atmosphere image, else its kind's card), never a bare date. */
  | { moment: StoryItem; imageUrl: string | null };

type IconName = React.ComponentProps<typeof Feather>["name"];

const GLYPH: Record<CircleKey, IconName> = { week: "calendar", offers: "briefcase", bookings: "clock", moments: "flag", wins: "award" };
const SIZE = 58;
const RING = 3;
const GAP = 2;

export function StoryCircles({ circles, seen, images, onOpen }: {
  circles: Circle[];
  seen: ReadonlySet<string>;
  images?: Partial<Record<CircleKey, CircleFace | null>>;
  onOpen: (circle: Circle) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} testID="home-v3-circles">
      {circles.map((c) => {
        const ring = ringState(c, seen);
        const color = ring === "seen" ? Accent.seen : ring === "gold" ? Accent.gold : Accent.pink;
        const img = images?.[c.key] ?? null;
        const label = `${c.label}${c.badge ? `, ${c.badge} need you` : ""}${ring === "seen" ? "" : ", new"}`;
        return (
          <Pressable
            key={c.key}
            onPress={() => { haptics.press(); onOpen(c); }}
            accessibilityRole="button"
            accessibilityLabel={label}
            testID={`home-v3-circle-${c.key}`}
            style={({ pressed }) => [styles.circle, pressed && styles.pressed]}
          >
            <View style={[styles.ring, { borderColor: color, borderWidth: ring === "seen" ? 1.5 : RING }]} testID={`home-v3-ring-${c.key}-${ring}`}>
              {img && "photo" in img ? (
                <Photo uri={img.photo} style={styles.face} transition={0} />
              ) : img && "logo" in img ? (
                <LogoMark bold logoUrl={img.logo.url} domain={img.logo.domain} name={img.logo.name} size={SIZE} style={styles.logoRound} />
              ) : img && "initial" in img ? (
                <View style={[styles.face, styles.logoDisc]}>
                  <Text style={styles.initial}>{img.initial}</Text>
                </View>
              ) : img && "moment" in img ? (
                <MomentArt story={img.moment} imageUrl={img.imageUrl} size="thumb" chip={false} style={styles.face} />
              ) : img && "date" in img ? (
                <View style={[styles.face, styles.dateFace]} testID={`home-v3-date-${c.key}`}>
                  {img.date.top ? <Text style={styles.dateTop}>{img.date.top}</Text> : null}
                  <Text style={styles.dateBig} numberOfLines={1} adjustsFontSizeToFit>{img.date.big}</Text>
                </View>
              ) : (
                <View style={[styles.face, styles.glyph]}>
                  <Feather name={GLYPH[c.key]} size={22} color={c.key === "wins" ? Accent.gold : Bold.ink} />
                </View>
              )}
            </View>
            {c.badge ? (
              <View style={styles.badge} testID={`home-v3-badge-${c.key}`}>
                <Text style={styles.badgeText}>{badgeText(c.badge)}</Text>
              </View>
            ) : null}
            <Text style={styles.label} numberOfLines={1}>{c.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const OUTER = SIZE + 2 * (RING + GAP);

const styles = StyleSheet.create({
  row:       { paddingHorizontal: Bold.gutter, gap: 14, paddingVertical: 6 },
  circle:    { alignItems: "center", gap: 5, width: OUTER + 6 },
  pressed:   { transform: [{ scale: Bold.pressScale }] },
  ring:      { width: OUTER, height: OUTER, borderRadius: OUTER / 2, alignItems: "center", justifyContent: "center" },
  face:      { width: SIZE, height: SIZE, borderRadius: SIZE / 2, overflow: "hidden" },
  glyph:     { backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  logoDisc:  { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, alignItems: "center", justifyContent: "center" },
  logoRound: { borderRadius: SIZE / 2 },
  dateFace:  { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  initial:   { ...BoldType.headedTitle, fontSize: 24, lineHeight: 30, color: Bold.ink },
  dateTop:   { ...BoldType.chip, fontSize: 9, lineHeight: 12, letterSpacing: 0.9, color: Accent.pink },
  dateBig:   { ...BoldType.headedTitle, fontSize: 22, lineHeight: 24, color: Bold.ink },
  badge:     { position: "absolute", top: -2, right: 0, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: Accent.pink, borderWidth: 2, borderColor: Bold.paper, alignItems: "center", justifyContent: "center" },
  badgeText: { ...BoldType.chip, letterSpacing: 0, color: Bold.onDark },
  label:     { ...BoldType.caption, fontFamily: Fonts.bodySemiBold, fontWeight: "600", color: Bold.ink },
});
