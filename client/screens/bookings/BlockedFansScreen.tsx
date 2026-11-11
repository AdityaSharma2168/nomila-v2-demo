// BlockedFansScreen — her Blocked fans (0154), reached from Bookings › Your sessions. Each row: the first name she
// blocked, when, and where (a booking, a friend in a group call); "Unblock" opens a small confirm sheet. Unblocking
// lets them book and join again; it doesn't bring back anything that was cancelled. Never a hash or contact detail.
import React, { useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { StackHeader, pullRefresh, usePullRefresh } from "../../components/ui";
import { ConfirmSheet, Empty, ErrorLine, Loading, refusalLine } from "../../components/bookings/parts";
import { LookButton, LookCard } from "../../components/look";
import { useFanBlocks, useUnblockFan } from "../../hooks/use-bookings";
import { fmtDay } from "../../lib/bookingsLogic";
import { openBookingDetail } from "../../navigation/bookingsNav";
import { haptics } from "../../lib/haptics";
import { Look, useLook } from "../../constants/theme";
import type { FanBlockView } from "../../lib/bookingsTypes";

const WHERE: Record<FanBlockView["source"], string> = { booking: "From a booking", guest: "A friend in a group call", live: "From a Live" };

export function BlockedFansScreen() {
  const L = useLook();
  const navigation = useNavigation<any>();
  const q = useFanBlocks();
  const refresh = usePullRefresh(() => q.refetch());
  const [unblocking, setUnblocking] = useState<FanBlockView | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const rows = q.data ?? [];
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: L.bg }]}>
      <StackHeader title="Blocked fans" />
      <ScrollView contentContainerStyle={styles.content} refreshControl={pullRefresh(refresh)} testID="blocks-scroll">
        <Text style={[Look.type.body, { color: L.ink2 }]}>
          {"People you blocked can't book you, request you or join your calls. They aren't told."}
        </Text>
        {flash ? <Text style={[Look.type.bodyStrong, { color: L.ink }]} testID="blocks-flash">{flash}</Text> : null}
        {q.isLoading ? <Loading testID="blocks-loading" /> : null}
        {q.isError ? <ErrorLine text="Couldn't load your blocked fans. Pull down to try again." testID="blocks-error" /> : null}
        {q.data && rows.length === 0 ? <Empty title="No one blocked" body="If someone makes you uncomfortable, block them from their booking or from the call." testID="blocks-empty" /> : null}
        {rows.length ? (
          <LookCard style={styles.flush}>
            {rows.map((b, i) => (
              <View key={b.id} style={[styles.row, i < rows.length - 1 && { borderBottomWidth: 1, borderBottomColor: L.line }]} testID={`block-row-${b.id}`}>
                <View style={styles.flex}>
                  <Text style={[Look.type.bodyStrong, { color: L.ink }]}>{b.firstName}</Text>
                  <Text style={[Look.type.meta, { color: L.ink2 }]}>{`${WHERE[b.source]} · ${fmtDay(b.blockedAt)}`}{b.reason ? ` · “${b.reason}”` : ""}</Text>
                  {b.bookingId ? (
                    <Text style={[Look.type.meta, { color: L.ink, textDecorationLine: "underline" }]} onPress={() => openBookingDetail(navigation, b.bookingId!)}
                      accessibilityRole="link" testID={`block-booking-${b.id}`}>Open the booking</Text>
                  ) : null}
                </View>
                <LookButton kind="ghost" small onPress={() => setUnblocking(b)} testID={`unblock-${b.id}`} accessibilityLabel={`Unblock ${b.firstName}`}>Unblock</LookButton>
              </View>
            ))}
          </LookCard>
        ) : null}
      </ScrollView>
      {unblocking ? <UnblockSheet b={unblocking} onClose={() => setUnblocking(null)} onDone={() => { setFlash(`${unblocking.firstName} is unblocked.`); setUnblocking(null); }} /> : null}
    </SafeAreaView>
  );
}

function UnblockSheet({ b, onClose, onDone }: { b: FanBlockView; onClose: () => void; onDone: () => void }) {
  const unblock = useUnblockFan();
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    setError(null);
    unblock.mutate(b.id, { onSuccess: () => { haptics.success(); onDone(); }, onError: (err) => setError(refusalLine(err, "Couldn't unblock them. Try again.")) });
  };
  return (
    <ConfirmSheet title={`Unblock ${b.firstName}?`} confirm={`Unblock ${b.firstName}`} cancelLabel="Keep blocked" onConfirm={confirm} onClose={onClose}
      busy={unblock.isPending} error={error} testID="unblock-sheet">
      <Text style={Look.type.body}>{`${b.firstName} will be able to book you and join your calls again. Anything that was cancelled stays cancelled.`}</Text>
    </ConfirmSheet>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1 },
  content: { paddingHorizontal: Look.gutter, paddingBottom: 80, gap: 12 },
  flush:   { padding: 0, overflow: "hidden" },
  row:     { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 12, paddingHorizontal: 16 },
  flex:    { flex: 1, gap: 2 },
});
