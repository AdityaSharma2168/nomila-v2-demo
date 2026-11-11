// The Opportunities sections around the deals (app layout B, agreed 8 Oct 2026): everything that pays her lands in
// Opportunities. Drawn by OpportunitiesScreen from served data only; nothing here fetches, decides or moves money.
//
//   MoneyStrip       one thin line at the top — "$2,450 coming to you · $1,200 paid in Oct" — only once money exists;
//                    opens Financials
//   SectionTitle     "Deals" / "Bookings" / "Shop" heads, drawn only when a second section exists (a new athlete sees
//                    today's screen, with no heads)
//   BookingsSection  her requests (waiting for her) and upcoming bookings, from GET /me/bookings/summary — only once
//                    she has a published offer. Read-only rows: the booking detail (accept / decline) is not built yet
//   ShopSection      "4 picks live · 212 clicks this week" from GET /me/shop — only once a pick is live; opens My Picks
//
// Look B: Bold / BoldType only, white cards with a 1px line, the blue only for "Waiting for you".

import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { BookingLine } from "../../../shared/meSummaries";
import { Card, IconTile, useReducedMotion } from "../ui";
import { bookingWhen } from "../../lib/financialsLogic";
import { isGroupLine, lineOpener, lineState } from "./bookingsTabLogic";
import { Accent, Bold, BoldType } from "../../constants/theme";
import { HOME_V3 } from "../../lib/flags";

export function MoneyStrip({ line, onPress }: { line: string; onPress: () => void }) {
  const reduced = useReducedMotion();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${line}. Open Financials`}
      testID="money-strip"
      style={({ pressed }) => [styles.strip, pressed && styles.stripPressed, pressed && !reduced && styles.pressed]}
    >
      <Feather name="dollar-sign" size={16} color={Bold.ink} />
      <Text style={styles.stripText} numberOfLines={2}>{line}</Text>
      <Feather name="chevron-right" size={18} color={Bold.quiet} />
    </Pressable>
  );
}

export function SectionTitle({ title, link, onLink }: { title: string; link?: string; onLink?: () => void }) {
  return (
    <View style={styles.head}>
      <Text style={styles.headTitle} accessibilityRole="header">{title}</Text>
      {link && onLink ? (
        <Pressable onPress={onLink} hitSlop={8} accessibilityRole="button" accessibilityLabel={link}>
          <Text style={styles.headLink}>{link}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function BookingRow({ b, last, onOpen, onOpenGroup }: { b: BookingLine; last: boolean; onOpen?: (id: string) => void; onOpenGroup?: (slotId: string) => void }) {
  // An open group's time is ONE row ("4 of 10 booked") that opens the group screen (0153).
  const s = lineState(b);
  const open = lineOpener(b, onOpen, onOpenGroup);
  const label = `${b.title}. ${bookingWhen(b)}. ${s.text}`;
  const Row = open ? Pressable : View;   // Bookings v2: tappable once her booking screens are in the build
  return (
    <Row style={[styles.row, last && styles.rowLast]} accessibilityLabel={label} testID={`booking-row-${b.id}`}
      {...(open ? { onPress: open, accessibilityRole: "button" as const } : {})}>
      <IconTile bold="black" icon={isGroupLine(b) ? "users" : "calendar"} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{b.title}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>{bookingWhen(b)}</Text>
      </View>
      <Text style={s.waiting ? styles.waiting : styles.state}>{s.text}</Text>
    </Row>
  );
}

/** `onOpen` / `onSeeAll` (Bookings v2): a row opens that booking and "See all" opens Bookings, when those screens exist. */
export function BookingsSection({ requests, upcoming, onOpen, onOpenGroup, onSeeAll }: {
  requests: BookingLine[]; upcoming: BookingLine[]; onOpen?: (id: string) => void; onOpenGroup?: (slotId: string) => void; onSeeAll?: () => void;
}) {
  const rows = [...requests, ...upcoming];
  return (
    <View style={styles.section} testID="opps-bookings">
      <SectionTitle title="Bookings" link={onSeeAll ? "See all" : undefined} onLink={onSeeAll} />
      <Card bold>
        {rows.length ? rows.map((b, i) => <BookingRow key={b.id} b={b} last={i === rows.length - 1} onOpen={onOpen} onOpenGroup={onOpenGroup} />) : (
          <View style={[styles.row, styles.rowLast]}>
            <Text style={styles.rowMeta}>No booking requests yet. They arrive here from your card.</Text>
          </View>
        )}
      </Card>
    </View>
  );
}

export function ShopSection({ live, clicks, onOpen }: { live: string; clicks: string; onOpen: () => void }) {
  const reduced = useReducedMotion();
  return (
    <View style={styles.section} testID="opps-shop">
      <SectionTitle title="Shop" link="Your picks" onLink={onOpen} />
      <Card bold>
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`${live}. ${clicks}. Open My Picks`}
          style={({ pressed }) => [styles.row, styles.rowLast, pressed && styles.rowPressed, pressed && !reduced && styles.pressed]}
        >
          <IconTile bold="black" icon="shopping-bag" />
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{live}</Text>
            <Text style={styles.rowMeta}>{clicks}</Text>
          </View>
          <Feather name="chevron-right" size={18} color={Bold.quiet} />
        </Pressable>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  strip:        { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: Bold.ground, borderRadius: Bold.radius.card },
  stripPressed: { opacity: 0.85 },
  stripText:    { flex: 1, ...BoldType.rowTitle, color: Bold.ink },
  pressed:      { transform: [{ scale: Bold.pressScale }] },
  head:         { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginTop: 6 },
  headTitle:    { flex: 1, ...BoldType.section, color: Bold.ink },
  headLink:     { ...BoldType.link, color: Bold.blue },
  section:      { gap: 10 },
  row:          { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  rowLast:      { borderBottomWidth: 0 },
  rowPressed:   { backgroundColor: Bold.ground },
  rowText:      { flex: 1, minWidth: 0, gap: 2 },
  rowTitle:     { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:      { ...BoldType.rowMeta, color: Bold.mute },
  // HOME_V3: "needs you" is pink (the brand colours back as accents); off, the look-B blue as before.
  waiting:      { ...BoldType.caption, color: HOME_V3 ? Accent.pink : Bold.blue },
  state:        { ...BoldType.caption, color: Bold.mute },
});
