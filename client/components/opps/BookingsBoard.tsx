// BookingsBoard — the Bookings tab on Opportunities (deals design §7b (c), (d); behind EXPO_PUBLIC_OPPS_V2).
//
//   set up      "What matters next": the requests she has to answer, each a card with the blue "Waiting for you";
//               then "Coming up": her accepted and confirmed sessions as rows (date, who, the money held). "See all"
//               opens Bookings (requests · booked · offers). From GET /me/bookings/summary — read-only here; answering
//               a request happens on its own screen, on her tap.
//   not set up  "You haven't set up bookings yet": one line on what bookings are and one button to her public page in
//               Me, at its Book door, where she switches it on and sets her offers and prices.
//
// The whole card is the target (DESIGN.md §11): no in-card button that does what the tap already does. Bold only.
import React from "react";
import { Image, View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { BookingLine, BookingsSummary } from "../../../shared/meSummaries";
import { Button, Card, Chip, IconTile, SectionHead } from "../ui";
import { bookingState, bookingWhen } from "../../lib/financialsLogic";
import { Accent, Bold, BoldType } from "../../constants/theme";
import { HOME_V3 } from "../../lib/flags";
import { BOOKINGS_EMPTY_COPY, BOOKINGS_SOON_COPY, SHOP_SOON_COPY, isGroupLine, lineOpener, lineState, requestsLede } from "./bookingsTabLogic";

// The empty state's one picture (DESIGN.md §13, illustration tier: empty states only).
const EMPTY_ART = require("../../assets/illustrations/empty-bookings.jpg");
export { BOOKINGS_EMPTY_COPY, BOOKINGS_SOON_COPY, SHOP_SOON_COPY, bookingsTabState, requestsLede } from "./bookingsTabLogic";

function RequestCard({ b, onOpen }: { b: BookingLine; onOpen?: (id: string) => void }) {
  const s = bookingState(b);
  const label = `${b.title}. ${bookingWhen(b)}. ${s.text}`;
  const inner = (
    <>
      <View style={styles.chips}>
        <Chip bold="dark">Request</Chip>
        {s.waiting ? <Chip bold="blue">{s.text}</Chip> : null}
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>{b.title}</Text>
      <Text style={styles.meta}>{bookingWhen(b)}</Text>
    </>
  );
  if (!onOpen) return <Card bold style={styles.card} testID={`booking-request-${b.id}`}>{inner}</Card>;
  return (
    <Pressable onPress={() => onOpen(b.id)} accessibilityRole="button" accessibilityLabel={label} testID={`booking-request-${b.id}`}
      style={({ pressed }) => [styles.card, styles.cardFrame, pressed && styles.pressed]}>
      {inner}
    </Pressable>
  );
}

function UpcomingRow({ b, last, onOpen, onOpenGroup }: { b: BookingLine; last: boolean; onOpen?: (id: string) => void; onOpenGroup?: (slotId: string) => void }) {
  // An open group's time is ONE row ("4 of 10 booked") that opens the group screen (0153).
  const s = lineState(b);
  const open = lineOpener(b, onOpen, onOpenGroup);
  const label = `${b.title}. ${bookingWhen(b)}. ${s.text}`;
  const body = (
    <>
      <IconTile bold="black" icon={isGroupLine(b) ? "users" : "calendar"} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{b.title}</Text>
        <Text style={styles.meta} numberOfLines={1}>{bookingWhen(b)}</Text>
      </View>
      <Text style={s.waiting ? styles.waiting : styles.state}>{s.text}</Text>
    </>
  );
  const testID = isGroupLine(b) ? `booking-group-${b.slotId}` : `booking-upcoming-${b.id}`;
  if (!open) return <View style={[styles.row, last && styles.rowLast]} accessibilityLabel={label} testID={testID}>{body}</View>;
  return (
    <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={label} testID={testID}
      style={({ pressed }) => [styles.row, last && styles.rowLast, pressed && styles.rowPressed]}>
      {body}
    </Pressable>
  );
}

export function BookingsEmpty({ onSetUp }: { onSetUp: () => void }) {
  return (
    <View style={styles.empty} testID="bookings-empty">
      {HOME_V3 ? <Image source={EMPTY_ART} style={styles.emptyArt} accessibilityIgnoresInvertColors testID="bookings-empty-art" /> : null}
      <Text style={styles.emptyTitle} accessibilityRole="header">{BOOKINGS_EMPTY_COPY.title}</Text>
      <Text style={styles.lede}>{BOOKINGS_EMPTY_COPY.body}</Text>
      <Button bold="primary" onPress={onSetUp} testID="bookings-set-up">{BOOKINGS_EMPTY_COPY.button}</Button>
      <Text style={styles.caption}>{BOOKINGS_EMPTY_COPY.caption}</Text>
    </View>
  );
}

/** Bookings not live yet (no EXPO_PUBLIC_BOOKINGS): what bookings are, and "Coming soon". Nothing to tap. */
export function BookingsComingSoon() {
  return (
    <View style={styles.empty} testID="bookings-soon" accessibilityLabel={`${BOOKINGS_SOON_COPY.title}. ${BOOKINGS_SOON_COPY.chip}. ${BOOKINGS_SOON_COPY.body}`}>
      {HOME_V3 ? <Image source={EMPTY_ART} style={styles.emptyArt} accessibilityIgnoresInvertColors /> : null}
      <View style={styles.soonHead}>
        <Text style={styles.emptyTitle} accessibilityRole="header">{BOOKINGS_SOON_COPY.title}</Text>
        <Chip bold="line">{BOOKINGS_SOON_COPY.chip}</Chip>
      </View>
      <Text style={styles.lede}>{BOOKINGS_SOON_COPY.body}</Text>
    </View>
  );
}

/** Shop not live yet (no EXPO_PUBLIC_SHOP_V1): one quiet row under the deals, "Coming soon". Nothing to tap. */
export function ShopComingSoon() {
  return (
    <View style={styles.soonSection} testID="opps-shop-soon">
      <Text style={styles.soonTitle} accessibilityRole="header">{SHOP_SOON_COPY.title}</Text>
      <Card bold>
        <View style={[styles.row, styles.rowLast]} accessibilityLabel={`${SHOP_SOON_COPY.line}. ${SHOP_SOON_COPY.chip}`}>
          <IconTile bold="black" icon="shopping-bag" />
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{SHOP_SOON_COPY.line}</Text>
          </View>
          <Chip bold="line">{SHOP_SOON_COPY.chip}</Chip>
        </View>
      </Card>
    </View>
  );
}

export function BookingsBoard({ summary, onOpen, onOpenGroup, onSeeAll }: {
  summary: BookingsSummary; onOpen?: (id: string) => void; onOpenGroup?: (slotId: string) => void; onSeeAll?: () => void;
}) {
  const lede = requestsLede(summary.requests.length);
  return (
    <View style={styles.board} testID="bookings-board">
      <SectionHead title="What matters next" sub={lede ?? "Nothing waiting on you right now."} />
      {summary.requests.map((b) => <RequestCard key={b.id} b={b} onOpen={onOpen} />)}
      <SectionHead title="Coming up" link={onSeeAll ? "See all" : null} onLink={onSeeAll} style={styles.gap} />
      <Card bold>
        {summary.upcoming.length ? summary.upcoming.map((b, i) => <UpcomingRow key={b.id} b={b} last={i === summary.upcoming.length - 1} onOpen={onOpen} onOpenGroup={onOpenGroup} />) : (
          <View style={[styles.row, styles.rowLast]}>
            <Feather name="calendar" size={18} color={Bold.quiet} />
            <Text style={styles.meta}>Nothing booked yet. Accepted sessions show here.</Text>
          </View>
        )}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  board:      { gap: 12 },
  gap:        { marginTop: 8 },
  card:       { gap: 8, padding: 14 },
  cardFrame:  { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card },
  pressed:    { transform: [{ scale: Bold.pressScale }] },
  chips:      { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  cardTitle:  { ...BoldType.cardTitle, color: Bold.ink },
  meta:       { ...BoldType.rowMeta, color: Bold.mute, flexShrink: 1 },
  row:        { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  rowLast:    { borderBottomWidth: 0 },
  rowPressed: { backgroundColor: Bold.ground },
  rowText:    { flex: 1, minWidth: 0, gap: 2 },
  rowTitle:   { ...BoldType.rowTitle, color: Bold.ink },
  // HOME_V3: "needs you" is pink (the brand colours back as accents); off, the look-B blue as before.
  waiting:    { ...BoldType.caption, color: HOME_V3 ? Accent.pink : Bold.blue },
  state:      { ...BoldType.caption, color: Bold.mute },
  empty:      { gap: 14, paddingTop: 24 },
  emptyArt:   { width: 104, height: 104, alignSelf: "center" },
  emptyTitle: { ...BoldType.statement, color: Bold.ink },
  lede:       { ...BoldType.body, color: Bold.ink2 },
  caption:    { ...BoldType.caption, color: Bold.mute, textAlign: "center" },
  soonHead:   { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  soonSection:{ gap: 8, marginTop: 6 },
  soonTitle:  { ...BoldType.section, color: Bold.ink },
});
