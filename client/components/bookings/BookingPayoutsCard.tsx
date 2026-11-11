// BookingPayoutsCard — booking money on the Bookings screen: what's coming to her and when, what was paid, and any
// card fee she covered (booking screens design A8, the booking part). The whole money picture — deals too, holds,
// refunds, tax forms, her payout account — is the Financials screen (app layout B, the layout track); this card links
// there once that screen exists in the build, and never draws a dead link before.
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { Card, LinkText, RuledHead } from "../ui";
import { Bold, BoldType } from "../../constants/theme";
import { useBookingPayouts } from "../../hooks/use-bookings";
import { fmtDay, usd } from "../../lib/bookingsLogic";
import { sessionDoors } from "../../navigation/bookingsNav";
import { ErrorLine, Loading } from "./parts";
import type { BookingPayoutsView } from "../../lib/bookingsTypes";

const STATE: Record<BookingPayoutsView["items"][number]["state"], (due: string | null) => string> = {
  held:     (due) => (due ? `When they confirm, or ${fmtDay(due)}` : "After the session"),
  on_hold:  () => "On hold · a report is open",
  paid:     (due) => (due ? `Paid ${fmtDay(due)}` : "Paid"),
  refunded: () => "Refunded",
};

export function BookingPayoutsCard() {
  const navigation = useNavigation<any>();
  const q = useBookingPayouts();
  const financials = sessionDoors(navigation).financials;
  if (q.isLoading) return <Loading testID="payouts-loading" />;
  if (q.isError) return <ErrorLine text="Couldn't load your payouts. Pull down to try again." testID="payouts-error" />;
  const p = q.data!;
  return (
    <Card bold testID="booking-payouts">
      <View style={styles.pad}>
        <RuledHead title="Booking money" right={financials ? <LinkText onPress={financials} testID="payouts-financials">Financials</LinkText> : undefined} />
        <Text style={styles.big} testID="payouts-coming">{usd(p.comingCents)}</Text>
        <Text style={styles.meta}>Coming to you{p.paidCents ? ` · ${usd(p.paidCents)} paid` : ""}</Text>
        {p.items.length === 0 ? <Text style={styles.meta} testID="payouts-empty">Nothing paid yet. Money from your bookings will show here.</Text> : null}
        {p.items.slice(0, 6).map((it) => (
          <View key={it.bookingId} style={styles.item} testID={`payout-${it.bookingId}`}>
            <View style={styles.flex}>
              <Text style={styles.itemTitle} numberOfLines={1}>{it.title} · {it.buyerLabel}</Text>
              <Text style={styles.meta}>{STATE[it.state](it.dueAt)}{it.cardFeeCents ? ` · ${usd(it.amountCents + it.cardFeeCents)} − ${usd(it.cardFeeCents)} card fee` : ""}</Text>
            </View>
            <Text style={styles.amount}>{usd(it.amountCents)}</Text>
          </View>
        ))}
        {p.cardFees.length ? (
          <View style={styles.fees}>
            <Text style={styles.label}>Card fees</Text>
            {p.cardFees.map((f) => (
              <View key={f.bookingId} style={styles.item} testID={`fee-${f.bookingId}`}>
                <View style={styles.flex}>
                  <Text style={styles.itemTitle}>You cancelled · {fmtDay(f.at)}</Text>
                  <Text style={styles.meta}>{f.status === "waived" ? "First one free, on us" : f.status === "recovered" ? "Taken from a payout" : f.status === "owed" ? "Comes out of your next payout" : "Written off"}</Text>
                </View>
                <Text style={styles.amount}>{f.status === "waived" ? "$0" : `−${usd(f.amountCents)}`}</Text>
              </View>
            ))}
            <Text style={styles.meta}>When you cancel or miss a session, the buyer gets everything back and the card fee comes out of your next payout.</Text>
          </View>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  pad:       { padding: 14, gap: 6 },
  big:       { ...BoldType.cellValue, color: Bold.ink },
  meta:      { ...BoldType.rowMeta, color: Bold.mute },
  item:      { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderTopWidth: 1, borderTopColor: Bold.line },
  itemTitle: { ...BoldType.rowTitle, color: Bold.ink },
  amount:    { ...BoldType.rowTitle, color: Bold.ink },
  flex:      { flex: 1 },
  fees:      { marginTop: 10, gap: 4 },
  label:     { ...BoldType.label, color: Bold.mute },
});
