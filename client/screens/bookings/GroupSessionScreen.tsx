// GroupSessionScreen — one open-group time with its people (Bookings v2, group sessions 0153). Each fan booked and paid
// for their own spot; she sees the time ONCE (GET /bookings/groups/:slotId), the same look as the booking detail:
//
//   the black block   when, how many booked; Join call (the call screen on the time's ONE room) inside the window;
//                     Session done once it has started (a confirm sheet: everyone who booked is asked to confirm)
//   who's coming      each fan's first name, their spot, and whether they joined; a row opens that fan's own booking
//                     (its messages, "Report a problem", their money). "Block" on a row (0154) opens the block confirm
//                     sheet (their spot here, if upcoming, is cancelled and refunded in full); a blocked fan says so
//   money             what she receives: her per-person price × every paid spot
//   cancel            "Cancel this time" opens a sheet with the preview ("4 people get a full refund of $100") and her
//                     card fee (first one free); nothing happens until she confirms
//
// Every tap that reaches a fan or moves money is hers, on a confirm sheet.
import React, { useState } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { Button, Card, RuledHead, StackHeader, pullRefresh, usePullRefresh } from "../../components/ui";
import { ConfirmSheet, ErrorLine, Loading, refusalLine } from "../../components/bookings/parts";
import { BlockSheet } from "../../components/bookings/BlockSheet";
import { useGroupAction, useGroupCancelPreview, useGroupSession } from "../../hooks/use-bookings";
import {
  BOOKINGS_COPY, FORMAT_LABEL, attendeeLine, fmtDay, fmtRange, groupCancelLine, groupPhaseLine, usd, windowLabel,
} from "../../lib/bookingsLogic";
import { openBookingDetail, sessionDoors } from "../../navigation/bookingsNav";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";
import type { GroupSessionView } from "../../lib/bookingsTypes";

export function GroupSessionScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const slotId: string = route.params?.slotId;
  const q = useGroupSession(slotId, { poll: true });
  const refresh = usePullRefresh(() => q.refetch());
  const doors = sessionDoors(navigation);
  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title="Bookings" bold />
      <ScrollView contentContainerStyle={styles.content} refreshControl={pullRefresh(refresh)} keyboardShouldPersistTaps="handled" testID="group-scroll">
        {q.isLoading ? <Loading testID="group-loading" /> : null}
        {q.isError ? <ErrorLine text={BOOKINGS_COPY.detailError} testID="group-error" /> : null}
        {q.data ? <Detail g={q.data} join={doors.groupJoin} onOpenBooking={(id) => openBookingDetail(navigation, id)} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Detail({ g, join, onOpenBooking }: { g: GroupSessionView; join: ((slotId: string) => void) | null; onOpenBooking: (id: string) => void }) {
  const [sheet, setSheet] = useState<null | "cancel" | "done">(null);
  const [blocking, setBlocking] = useState<{ bookingId: string; name: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const live = g.phase === "booked" || g.phase === "happening";
  return (
    <View style={styles.stack}>
      <Text style={styles.eyebrow}>Open group · {groupPhaseLine(g.phase)}</Text>
      <Text style={styles.title}>{g.title}</Text>
      <Text style={styles.meta} testID="group-spots">{`${g.spotsTaken} of ${g.capacity} booked`}{live && g.spotsLeft > 0 ? ` · ${g.spotsLeft === 1 ? "1 spot" : `${g.spotsLeft} spots`} left` : ""}</Text>
      {flash ? <Text style={styles.flash} testID="group-flash">{flash}</Text> : null}

      <View style={styles.block} testID="group-block">
        <Text style={styles.blockEyebrow}>{g.phase === "happening" ? "Happening now" : g.phase === "finished" ? "Finished" : g.phase === "canceled" ? "Cancelled" : fmtDay(g.startsAt)}</Text>
        <Text style={styles.blockTitle}>{fmtRange(g.startsAt, g.endsAt)}</Text>
        {g.locationMode === "virtual" ? (
          <Text style={styles.blockBody}>{"One call for everyone. Join opens 10 minutes before. Nomila doesn't record calls."}{g.video.fallbackLink ? ` Backup link: ${g.video.fallbackLink}` : ""}</Text>
        ) : <Text style={styles.blockBody}>{FORMAT_LABEL[g.format]} in person.</Text>}
        {join && g.actions.join ? <Button bold="onHero" onPress={() => join(g.slotId)} testID="group-join">Join call</Button> : null}
        {g.actions.sessionDone ? <Button bold="onHero" onPress={() => setSheet("done")} testID="group-done">Session done</Button> : null}
      </View>

      <Card bold testID="group-people"><View style={styles.pad}>
        <RuledHead title="Who's coming" />
        {g.attendees.length === 0 ? <Text style={styles.meta} testID="group-people-empty">No one has booked yet.</Text> : null}
        {g.attendees.map((a) => (
          <Pressable key={a.bookingId} onPress={() => onOpenBooking(a.bookingId)} style={({ pressed }) => [styles.person, pressed && styles.pressed]}
            accessibilityRole="button" accessibilityLabel={`${a.firstName}, ${attendeeLine(a)}`} testID={`group-person-${a.bookingId}`}>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{a.firstName}</Text>
              <Text style={styles.meta}>{attendeeLine(a)}</Text>
            </View>
            {a.blocked ? <Text style={styles.meta} testID={`group-blocked-${a.bookingId}`}>Blocked</Text> : (
              <Pressable onPress={() => setBlocking({ bookingId: a.bookingId, name: a.firstName })} hitSlop={8} style={styles.blockBtn}
                accessibilityRole="button" accessibilityLabel={`Block ${a.firstName}`} testID={`group-block-${a.bookingId}`}>
                <Text style={styles.blockText}>Block</Text>
              </Pressable>
            )}
            <Feather name="chevron-right" size={18} color={Bold.quiet} />
          </Pressable>
        ))}
      </View></Card>

      <Card bold testID="group-money"><View style={styles.pad}>
        <View style={styles.money}>
          <View style={styles.flex}>
            <Text style={styles.rowTitle}>{g.phase === "canceled" ? "Refunded" : "You'll receive"}</Text>
            <Text style={styles.meta}>{usd(g.unitPriceCents)} per person · each spot is paid when that fan says it happened, or 48 hours after.</Text>
          </View>
          <Text style={styles.big}>{usd(g.phase === "canceled" ? 0 : g.receiveCents)}</Text>
        </View>
      </View></Card>

      {g.actions.cancel ? (
        <Pressable style={styles.door} onPress={() => setSheet("cancel")} accessibilityRole="button" testID="group-cancel-door">
          <Text style={[styles.rowTitle, styles.flex]}>Cancel this time</Text>
          <Feather name="chevron-right" size={18} color={Bold.quiet} />
        </Pressable>
      ) : null}
      <Text style={styles.caption}>Questions or safety concerns? {g.supportEmail}</Text>

      {sheet === "cancel" ? <CancelGroupSheet g={g} onClose={() => setSheet(null)} onDone={(n) => { setSheet(null); setFlash(n ? `Cancelled. ${n === 1 ? "1 person gets" : `${n} people get`} a full refund.` : "Cancelled."); }} /> : null}
      {blocking ? <BlockSheet target={{ bookingId: blocking.bookingId }} name={blocking.name} onClose={() => setBlocking(null)}
        onDone={(r) => { const n = blocking.name; setBlocking(null); setFlash(r.canceled ? `${n} is blocked. Their spot is cancelled and refunded.` : `${n} is blocked.`); }} /> : null}
      {sheet === "done" ? <DoneSheet g={g} onClose={() => setSheet(null)} onDone={() => { setSheet(null); setFlash("Done. We've asked everyone to confirm."); }} /> : null}
    </View>
  );
}

function CancelGroupSheet({ g, onClose, onDone }: { g: GroupSessionView; onClose: () => void; onDone: (refunded: number) => void }) {
  const act = useGroupAction(g.slotId);
  const preview = useGroupCancelPreview(g.slotId, true);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const p = preview.data;
  const confirm = () => {
    setError(null);
    act.mutate({ action: "cancel", reason: reason.trim() }, {
      // People, not bookings: the preview's count when the cancel refunded exactly the spots it previewed.
      onSuccess: (r) => {
        haptics.success();
        const n = "canceled" in r ? r.canceled : 0;
        onDone(p && n === p.bookings ? p.people ?? n : n);
      },
      onError: (err) => setError(refusalLine(err, "Couldn't cancel. Nothing changed. Try again.")),
    });
  };
  return (
    <ConfirmSheet title="Cancel this time?" confirm="Cancel and refund everyone" cancelLabel="Keep it" onConfirm={confirm} onClose={onClose}
      busy={act.isPending || preview.isLoading} error={error} testID="group-cancel-sheet">
      {preview.isLoading ? <Loading testID="group-cancel-preview-loading" /> : null}
      {preview.isError ? <ErrorLine text="Couldn't work out the refunds. Check your connection." testID="group-cancel-preview-error" /> : null}
      {p ? (
        <>
          <Text style={styles.body} testID="group-cancel-refund">{groupCancelLine(p)}</Text>
          {p.bookings > 0 ? (p.firstCancelFree ? (
            <><Text style={styles.rowTitle}>{"This one's on us"}</Text><Text style={styles.meta}>Usually the card fees come out of your next payout when you cancel. Your first cancellation is free.</Text></>
          ) : <Text style={styles.meta} testID="group-cancel-fee">The card fees (about {usd(p.estCardFeeCents)}) come out of your next payout.</Text>) : null}
        </>
      ) : null}
      <Text style={styles.label}>Reason (sent to everyone)</Text>
      <TextInput value={reason} onChangeText={setReason} placeholder="I'm sorry, I can't make it because…" placeholderTextColor={Bold.quiet} multiline maxLength={500}
        style={styles.input} accessibilityLabel="Reason" testID="group-cancel-reason" />
      <Text style={styles.caption}>Fans can cancel their own spot for their money back up to {windowLabel(g.freeCancelHours)} before.</Text>
    </ConfirmSheet>
  );
}

function DoneSheet({ g, onClose, onDone }: { g: GroupSessionView; onClose: () => void; onDone: () => void }) {
  const act = useGroupAction(g.slotId);
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    setError(null);
    act.mutate({ action: "session_done" }, {
      onSuccess: () => { haptics.success(); onDone(); },
      onError: (err) => setError(refusalLine(err, "Couldn't mark it done. Try again.")),
    });
  };
  return (
    <ConfirmSheet title="Mark this session done?" confirm="Session done" cancelLabel="Not yet" onConfirm={confirm} onClose={onClose} busy={act.isPending} error={error} testID="group-done-sheet">
      <Text style={styles.body}>{"We'll ask everyone who booked to confirm it happened. Each spot is paid to you when they do, or 48 hours after the end if nothing's reported."}</Text>
    </ConfirmSheet>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: Bold.paper },
  content:     { paddingHorizontal: Bold.gutter, paddingBottom: 48 },
  stack:       { gap: 14 },
  eyebrow:     { ...BoldType.label, color: Bold.mute, marginTop: 8 },
  title:       { ...BoldType.screenTitleSm, color: Bold.ink },
  meta:        { ...BoldType.rowMeta, color: Bold.mute },
  flash:       { ...BoldType.read, color: Bold.ink },
  pad:         { padding: 14, gap: 8 },
  body:        { ...BoldType.body, color: Bold.ink },
  caption:     { ...BoldType.caption, color: Bold.mute },
  label:       { ...BoldType.label, color: Bold.mute, marginTop: 4 },
  money:       { flexDirection: "row", alignItems: "center", gap: 12 },
  big:         { ...BoldType.cellValue, color: Bold.ink },
  rowTitle:    { ...BoldType.rowTitle, color: Bold.ink },
  flex:        { flex: 1 },
  person:      { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, borderTopWidth: 1, borderTopColor: Bold.line },
  blockBtn:    { minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: Bold.radius.chip, borderWidth: 1.5, borderColor: Bold.line, alignItems: "center", justifyContent: "center" },
  blockText:   { ...BoldType.buttonSmall, color: Bold.ink },
  pressed:     { transform: [{ scale: Bold.pressScale }] },
  block:       { backgroundColor: Bold.ink, borderRadius: Bold.radius.card, padding: 16, gap: 10 },
  blockEyebrow: { ...BoldType.label, color: Bold.onDarkLabel },
  blockTitle:  { ...BoldType.bannerTitle, color: Bold.onDark },
  blockBody:   { ...BoldType.lede, color: Bold.onDarkSoft },
  door:        { flexDirection: "row", alignItems: "center", minHeight: 48, borderBottomWidth: 1, borderBottomColor: Bold.line },
  input:       { ...BoldType.body, color: Bold.ink, minHeight: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12, paddingTop: 12 },
});
