/**
 * BookingCard — one booking in Mila's chat (agent/1 `booking`; AGENT_BOOKINGS_TOOLS): who, what, when, the money (held
 * until the session) and where it stands, on the Mila card surface (DESIGN.md §16).
 *
 * A request waiting for her: Accept and Decline — HER taps, each behind a one-line confirm, on the existing
 * /me/bookings/:id/accept | decline (useBookingAction, the same taps as the booking screen). Mila's suggestion, when she
 * made one, leads. Anything the card can't settle in one tap (several suggested times, a backup link) opens the booking.
 * Mila never answers a buyer and never moves money: nothing here runs without her tap.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { MILA_CARD } from "../mila/milaSurface";
import { MilaButton, SettledLine, SoftChip, partStyles } from "./parts";
import { useAgentCardHandlers } from "./handlers";
import { bookingRefusal, useBooking, useBookingAction } from "../../hooks/use-bookings";
import { BOOKING_STATUS_LABEL } from "../../../shared/agent";
import type { CardOf } from "../../lib/agent/types";
import { haptics } from "../../lib/haptics";

type Answer = "accept" | "decline";

export function BookingChatCard({ card }: { card: CardOf<"booking"> }) {
  const { openLink } = useAgentCardHandlers();
  const p = card.payload;
  const action = useBookingAction(p.bookingId);
  // Where it stands NOW (the booking, from the server), so a reopened chat never offers Accept on an answered request.
  // Until it loads (or if it can't), the card's own snapshot.
  const phase = useBooking(p.bookingId).data?.phase ?? null;
  const waitingForYou = phase ? phase === "request" : p.waitingForYou;
  const statusLabel = phase ? BOOKING_STATUS_LABEL[phase] ?? p.statusLabel : p.statusLabel;
  const [confirming, setConfirming] = useState<Answer | null>(null);
  const [done, setDone] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = card.links[0] ?? { label: "Open booking", target: { screen: "booking", id: p.bookingId } };
  const open = openLink ? () => openLink(link.target, link) : undefined;

  const answer = async (a: Answer) => {
    setError(null);
    try {
      await action.mutateAsync(a === "accept" ? { action: "accept" } : { action: "decline", reason: null });
      haptics.success();
      setDone(a);
    } catch (err) {
      const r = bookingRefusal(err);
      // Several times to pick from, or anything else the booking screen handles: open it there.
      if (r?.code === "PICK_A_TIME" && open) { open(); return; }
      setError(r?.error ? `${r.error[0].toUpperCase()}${r.error.slice(1)}.` : "That didn't go through. Nothing changed.");
    } finally {
      setConfirming(null);
    }
  };

  const order: Answer[] = p.suggested === "decline" ? ["decline", "accept"] : ["accept", "decline"];
  return (
    <Pressable onPress={open} disabled={!open} style={({ pressed }) => [styles.card, pressed && open ? styles.pressed : null]} testID="card-booking"
      accessibilityRole={open ? "button" : undefined} accessibilityLabel={`${p.who}, ${p.what}, ${statusLabel}`}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={partStyles.h4} numberOfLines={1}>{p.who}</Text>
          <Text style={partStyles.caption} numberOfLines={1}>{p.what}</Text>
        </View>
        <SoftChip tone={waitingForYou && !done ? "blue" : "ground"}>{done ? (done === "accept" ? "Accepted by you" : "Declined by you") : statusLabel}</SoftChip>
      </View>
      <Text style={partStyles.body}>{[p.when, p.moneyLine].filter(Boolean).join(" · ")}</Text>
      {p.suggested && waitingForYou && !done ? <Text style={partStyles.caption}>Mila would {p.suggested}. It's your call.</Text> : null}
      {error ? <Text style={partStyles.error}>{error}</Text> : null}
      {done ? (
        <SettledLine text={done === "accept" ? "You accepted it. The buyer hears from Nomila." : "You declined it. The hold is released."} />
      ) : waitingForYou ? (
        confirming ? (
          <View style={styles.confirm}>
            <Text style={partStyles.body}>
              {confirming === "accept" ? "Accept this booking? The buyer's payment is taken now and held until the session." : "Decline this request? The buyer's hold is released."}
            </Text>
            <View style={styles.actions}>
              <MilaButton label={confirming === "accept" ? "Yes, accept" : "Yes, decline"} onPress={() => answer(confirming)} loading={action.isPending} testID="booking-confirm" />
              <MilaButton label="Back" tone="quiet" onPress={() => setConfirming(null)} disabled={action.isPending} />
            </View>
          </View>
        ) : (
          <View style={styles.actions}>
            {order.map((a, i) => (
              <MilaButton key={a} label={a === "accept" ? "Accept" : "Decline"} tone={i === 0 ? "primary" : "soft"} onPress={() => setConfirming(a)} testID={`booking-${a}`} />
            ))}
            {open ? <MilaButton label="Open booking" tone="quiet" icon="arrow-right" onPress={open} /> : null}
          </View>
        )
      ) : open ? (
        <View style={styles.actions}><MilaButton label="Open booking" tone="quiet" icon="arrow-right" onPress={open} /></View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 10 },
  pressed: { opacity: 0.85 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  headText: { flex: 1, minWidth: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  confirm: { gap: 8 },
});
