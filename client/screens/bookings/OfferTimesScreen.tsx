// OfferTimesScreen — an offer › Your times (slots mode). Her open times, each lasting the offer's length; add one by
// picking a day and a start time (her own time zone); remove a free one. A time a buyer has asked for (or booked) is
// held — it can't be removed here; she answers the request instead. Adding or removing a time reaches nobody, so it is
// a plain tap (no confirm sheet).
import React, { useMemo, useState } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { Button, Card, RuledHead, StackHeader, pullRefresh, usePullRefresh } from "../../components/ui";
import { Empty, ErrorLine, Loading, refusalLine } from "../../components/bookings/parts";
import { useAddSlots, useOffer, useSlots, useWithdrawSlot } from "../../hooks/use-bookings";
import { dayOptions, fmtDay, fmtRange, startIso, timeOptions } from "../../lib/bookingsLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";

const PROBLEM: Record<string, string> = {
  too_soon: "That's too soon: pick a time at least a few hours away, so you have time to answer.",
  too_far: "That's too far ahead. Times can be up to 60 days out.",
  overlap: "That overlaps one of your other times.",
  "before available_from": "That's before this offer starts.",
  "after available_until": "That's after this offer ends.",
};

export function OfferTimesScreen({ now: nowProp }: { now?: Date }) {
  const route = useRoute<any>();
  const [now] = useState(() => nowProp ?? new Date());
  const offerId: string = route.params?.offerId;
  const offer = useOffer(offerId);
  const slots = useSlots(offerId);
  const add = useAddSlots();
  const withdraw = useWithdrawSlot();
  const days = useMemo(() => dayOptions(now, 30), [now]);
  const times = useMemo(() => timeOptions(), []);
  const [day, setDay] = useState(0);
  const [time, setTime] = useState<number | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const refresh = usePullRefresh(() => Promise.all([offer.refetch(), slots.refetch()]));

  const addTime = () => {
    if (time === null) return;
    setLine(null);
    add.mutate({ offerId, starts: [startIso(days[day].date, time)] }, {
      onSuccess: () => { haptics.success(); setTime(null); setLine("Added. Buyers can ask for it now."); },
      onError: (err: any) => {
        const m = /"problem":"([^"]+)"/.exec(err?.message ?? "");
        setLine(m && PROBLEM[m[1]] ? PROBLEM[m[1]] : refusalLine(err, "Couldn't add that time. Try again."));
      },
    });
  };
  const remove = (slotId: string) => {
    setLine(null);
    withdraw.mutate({ offerId, slotId }, { onError: (err) => setLine(refusalLine(err, "Couldn't remove that time. Try again.")) });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title={offer.data?.title ?? "Offer"} bold />
      <ScrollView contentContainerStyle={styles.content} refreshControl={pullRefresh(refresh)} keyboardShouldPersistTaps="handled" testID="times-scroll">
        <Text style={styles.title}>Your times</Text>
        {offer.data ? <Text style={styles.caption}>Each time lasts {offer.data.durationMinutes} minutes. Buyers see them in their own time zone.</Text> : null}

        {slots.isLoading ? <Loading testID="times-loading" /> : null}
        {slots.isError ? <ErrorLine text="Couldn't load your times. Pull down to try again." testID="times-error" /> : null}
        {slots.data && slots.data.length === 0 ? <Empty title="No times yet" body="Add the times you're free. Buyers pick one and you still approve every request." testID="times-empty" /> : null}
        {slots.data && slots.data.length ? (
          <Card bold>
            {slots.data.map((s, i) => (
              <View key={s.id} style={[styles.slot, i < slots.data!.length - 1 && styles.line]} testID={`slot-${s.id}`}>
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>{fmtRange(s.startsAt, s.endsAt)}</Text>
                  <Text style={styles.rowMeta}>{s.taken ? "Someone asked for this time" : "Open"}</Text>
                </View>
                {s.taken ? null : (
                  <Pressable onPress={() => remove(s.id)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${fmtRange(s.startsAt, s.endsAt)}`} testID={`slot-remove-${s.id}`}>
                    <Feather name="x" size={18} color={Bold.ink} />
                  </Pressable>
                )}
              </View>
            ))}
          </Card>
        ) : null}

        <Card bold>
          <View style={styles.pad}>
            <RuledHead title="Add a time" />
            <Text style={styles.label}>Day</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {days.map((d, i) => (
                <Chip key={d.key} on={i === day} label={d.label} onPress={() => setDay(i)} testID={`day-${i}`} />
              ))}
            </ScrollView>
            <Text style={styles.label}>Start time · {fmtDay(days[day].date.toISOString())}</Text>
            <View style={styles.wrap}>
              {times.map((t) => <Chip key={t.minutes} on={t.minutes === time} label={t.label} onPress={() => setTime(t.minutes)} testID={`time-${t.minutes}`} />)}
            </View>
            {line ? <Text style={styles.body} testID="times-line">{line}</Text> : null}
            <Button bold="primary" onPress={addTime} disabled={time === null} loading={add.isPending} testID="times-add">Add this time</Button>
          </View>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function Chip({ on, label, onPress, testID }: { on: boolean; label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable onPress={() => { haptics.select(); onPress(); }} style={[styles.chip, on && styles.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }} testID={testID}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe:      { flex: 1, backgroundColor: Bold.paper },
  content:   { paddingHorizontal: Bold.gutter, paddingBottom: 48, gap: 14 },
  title:     { ...BoldType.screenTitleSm, color: Bold.ink, marginTop: 8 },
  caption:   { ...BoldType.caption, color: Bold.mute },
  pad:       { padding: 14, gap: 10 },
  label:     { ...BoldType.label, color: Bold.mute },
  chips:     { gap: 8 },
  wrap:      { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip:      { minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1.5, borderColor: Bold.line, borderRadius: Bold.radius.control },
  chipOn:    { borderColor: Bold.ink, backgroundColor: Bold.ink },
  chipText:  { ...BoldType.chipLine, color: Bold.ink },
  chipTextOn: { color: Bold.onDark },
  slot:      { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  line:      { borderBottomWidth: 1, borderBottomColor: Bold.line },
  flex:      { flex: 1 },
  rowTitle:  { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:   { ...BoldType.rowMeta, color: Bold.mute },
  body:      { ...BoldType.body, color: Bold.ink },
});
