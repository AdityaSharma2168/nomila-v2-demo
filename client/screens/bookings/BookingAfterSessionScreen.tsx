// BookingAfterSessionScreen — Bookings v2, the after-session part of A5 (look B). Reached by leaving a call, or from the
// booking detail once the session has started.
//
//   Session done        notifies the buyer ("Did it happen?"); NEVER pays by itself. Then "We asked them to confirm".
//   Buyer didn't show   from start + 15 min, after a confirm step; she is paid on the normal clock unless they report
//   Attendance          (0154) when Nomila's call has no attendance evidence at all, a neutral line ("We couldn't
//                       confirm attendance for this call") — never "they didn't join" on a guess
//   Rejoin call         while the join window is still open
//   I'm OK / Share      in person: the check-in, and her phone's share sheet with the friend's check-in link
//   Report a problem    holds the money; a person at Nomila reviews it (support email from the server's config)
//
// Every button is shown only when the server's matching `can…` flag is true (no dead taps); a refused tap shows a
// short line, never a raw error. Data: useBookingSession + the four mutations in hooks/use-booking-session.

import React, { useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Button, StackHeader } from "../../components/ui";
import { useBookingSession, useBuyerNoShow, useCheckIn, useReportProblem, useSessionDone } from "../../hooks/use-booking-session";
import { ATHLETE_REPORT_OPTIONS, afterSummary, attendanceLine, clock, dayAndTime, errorLine, money, type ReportCategory } from "../../lib/bookingSessionLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";

export function BookingAfterSessionScreen() {
  const route = useRoute();
  const navigation = useNavigation<any>();
  const { bookingId } = (route.params ?? {}) as { bookingId: string };
  const session = useBookingSession(bookingId);
  const done = useSessionDone(bookingId);
  const noShow = useBuyerNoShow(bookingId);
  const report = useReportProblem(bookingId);
  const checkIn = useCheckIn(bookingId);
  const [confirmNoShow, setConfirmNoShow] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [category, setCategory] = useState<ReportCategory | null>(null);
  const [details, setDetails] = useState("");
  const [line, setLine] = useState<string | null>(null);

  const v = session.data;
  if (!v) {
    return (
      <SafeAreaView style={styles.safe}>
        <StackHeader title="Booking" bold />
        <View style={styles.center}>
          {session.isError ? (
            <>
              <Text style={styles.body} testID="after-error">{errorLine(session.error)}</Text>
              <Button bold="secondary" onPress={() => session.refetch()} style={styles.gap} testID="after-retry">Try again</Button>
            </>
          ) : <ActivityIndicator color={Bold.ink} testID="after-loading" />}
        </View>
      </SafeAreaView>
    );
  }

  const a = v.after;
  const summary = afterSummary(v);
  const fail = (err: unknown) => { haptics.error(); setLine(errorLine(err)); };
  const ok = () => { haptics.success(); setLine(null); };
  const canRejoin = v.video.mode === "livekit" && v.video.joinState === "open" && !a.reportOpen;
  const sent = report.data;
  const attendance = attendanceLine(v, Date.parse(v.serverNow) || Date.now());

  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title="Booking" bold />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.eyebrow}>{`${v.booking.title} · ${v.booking.buyerName}`}</Text>
        <Text style={styles.title} testID="after-title">{summary.title}</Text>
        <Text style={styles.body} testID="after-line">{summary.line}</Text>
        {attendance ? <Text style={styles.meta} testID="attendance-unknown">{attendance}</Text> : null}
        {line ? <Text style={styles.error} testID="after-tap-error">{line}</Text> : null}

        {a.canMarkSessionDone ? (
          <Button bold="primary" loading={done.isPending} onPress={() => done.mutate(undefined, { onSuccess: ok, onError: fail })} style={styles.gap} testID="session-done">
            Session done
          </Button>
        ) : null}
        {canRejoin ? <Button bold="secondary" onPress={() => navigation.replace("BookingSession", { bookingId })} style={styles.gap} testID="rejoin">Rejoin call</Button> : null}

        {v.safety.inPerson && v.safety.canCheckIn ? (
          <Button bold="primary" loading={checkIn.isPending} onPress={() => checkIn.mutate(undefined, { onSuccess: ok, onError: fail })} style={styles.gap} testID="checkin">{"I'm OK"}</Button>
        ) : null}
        {v.safety.inPerson && v.safety.checkedInAt ? <Text style={styles.meta} testID="checked-in">{`You checked in at ${clock(v.safety.checkedInAt)}.`}</Text> : null}
        {v.safety.inPerson && v.safety.checkinUrl ? (
          <Button
            bold="secondary"
            onPress={() => void Share.share({ message: `My session: ${dayAndTime(v.booking.startsAt)}${v.booking.venue ? ` at ${v.booking.venue}` : ""}. Check in on me here: ${v.safety.checkinUrl}` })}
            style={styles.gap}
            testID="share-session"
          >Share my session with a friend</Button>
        ) : null}

        {a.canMarkBuyerNoShow && !confirmNoShow ? (
          <Pressable onPress={() => setConfirmNoShow(true)} style={styles.row} accessibilityRole="button" testID="buyer-no-show">
            <View style={{ flex: 1 }}>
              <Text style={styles.h4}>{"Buyer didn't show"}</Text>
              <Text style={styles.meta}>{"Waited 15 minutes? You'll still be paid."}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={Bold.quiet} />
          </Pressable>
        ) : null}
        {a.canMarkBuyerNoShow && confirmNoShow ? (
          <View style={styles.card} testID="no-show-confirm">
            <Text style={styles.h4}>{`${v.booking.buyerName} didn't show?`}</Text>
            {attendance ? <Text style={styles.meta} testID="no-show-attendance-unknown">{`${attendance} Mark this only if you waited and they didn't come.`}</Text> : null}
            <Text style={styles.body}>{`If you mark this, we'll tell ${v.booking.buyerName} and you'll be paid ${money(v.booking.priceCents)}${a.releaseDueAt ? ` on ${dayAndTime(a.releaseDueAt)}` : " 48 hours after the end"}, unless they report a problem.`}</Text>
            <Button bold="primary" loading={noShow.isPending} onPress={() => noShow.mutate(undefined, { onSuccess: () => { ok(); setConfirmNoShow(false); }, onError: fail })} style={styles.gap} testID="no-show-mark">{"Buyer didn't show"}</Button>
            <Button bold="secondary" onPress={() => setConfirmNoShow(false)} style={styles.gap} testID="no-show-cancel">Cancel</Button>
          </View>
        ) : null}

        {sent ? (
          <View style={styles.card} testID="report-sent">
            <Text style={styles.h4}>Report sent</Text>
            <Text style={styles.body}>{`The payment is held while a person at Nomila looks. We'll reply by ${dayAndTime(sent.replyBy)}.`}</Text>
          </View>
        ) : a.canReport && !a.reportOpen && !reporting ? (
          <Button bold="link" onPress={() => setReporting(true)} style={styles.gap} testID="open-report">Report a problem</Button>
        ) : null}
        {reporting && !sent ? (
          <View style={styles.card} testID="report-form">
            <Text style={styles.h4}>What happened?</Text>
            {ATHLETE_REPORT_OPTIONS.map((o) => (
              <Pressable key={o.category} onPress={() => setCategory(o.category)} style={styles.option} accessibilityRole="radio" accessibilityState={{ selected: category === o.category }} testID={`report-${o.category}`}>
                <Feather name={category === o.category ? "check-circle" : "circle"} size={18} color={category === o.category ? Bold.ink : Bold.quiet} />
                <Text style={styles.optionText}>{o.label}</Text>
              </Pressable>
            ))}
            <TextInput value={details} onChangeText={setDetails} placeholder="Tell us more (optional)" placeholderTextColor={Bold.quiet} multiline maxLength={2000} style={styles.input} testID="report-details" />
            <Button bold="primary" disabled={!category} loading={report.isPending} onPress={() => category && report.mutate({ category, details: details.trim() || undefined }, { onSuccess: ok, onError: fail })} style={styles.gap} testID="report-send">Send report</Button>
            <Button bold="secondary" onPress={() => setReporting(false)} style={styles.gap} testID="report-cancel">Cancel</Button>
            <Text style={styles.caption}>In danger right now? Call 911.</Text>
          </View>
        ) : null}

        <Text style={styles.support}>{`Questions or safety concerns? ${v.supportEmail} · In danger? Call 911.`}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: Bold.paper },
  center:  { flex: 1, alignItems: "center", justifyContent: "center", padding: Bold.gutter },
  content: { padding: Bold.gutter, paddingBottom: 40 },
  eyebrow: { ...BoldType.label, color: Bold.mute, marginBottom: 8 },
  title:   { ...BoldType.screenTitleSm, color: Bold.ink, marginBottom: 8 },
  body:    { ...BoldType.body, color: Bold.ink2 },
  meta:    { ...BoldType.rowMeta, color: Bold.mute, marginTop: 4 },
  h4:      { ...BoldType.h4, color: Bold.ink, marginBottom: 4 },
  caption: { ...BoldType.caption, color: Bold.mute, marginTop: 8 },
  error:   { ...BoldType.read, color: Bold.ink, marginTop: 12 },
  support: { ...BoldType.caption, color: Bold.mute, marginTop: 32 },
  gap:     { marginTop: 12 },
  row:     { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, paddingVertical: 12, paddingHorizontal: 14, marginTop: 16, minHeight: 44 },
  card:    { borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, padding: 14, marginTop: 16 },
  option:  { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  optionText: { ...BoldType.rowTitle, color: Bold.ink },
  input:   { ...BoldType.body, color: Bold.ink, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, padding: 12, minHeight: 88, marginTop: 8, textAlignVertical: "top" },
});
