// SessionSetupSheet — a new session in ONE three-step sheet (the one look + "Fewer taps", owner-approved 22 Oct 2026):
//   1 What   the session type, who it's for (just one fan · a fan + friends · an open group) and, for a group, how
//            many people (2–20), and the length; defaults picked (1:1 video call · just one fan · 30 min). An open
//            group also picks how spots confirm (0154): on their own (default) or "I approve each spot"
//   2 Price  price chips (per person for a group); "You get $50" big (a group: "$25 per person · up to $250"); the fan's all-in total ONCE, as a small line ("Fans see $59.53, including
//            the Nomila fee") — the only place the athlete sees it
//   3 When   her hours (HoursEditor, flexible hours Nov 2026): a quick start fills them, then any days and hours,
//            different on some days if she likes; and the free-cancellation window (24h default)
// Done saves the offer (with her weekly hours), adds the open times her hours make over the next 4 weeks and publishes
// it. A refusal (payouts not ready, anything the server still asks for) keeps the draft and says why, with the full
// editor one tap away.
import React, { useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { LookButton, LookChip, LookSheet } from "../look";
import { Look, useLook } from "../../constants/theme";
import { slotBatches } from "../../lib/lookLogic";
import { countLine, hoursProblems, hoursStarts, presetHours, toAvailability, type WeekHours } from "../../lib/availabilityLogic";
import { HoursEditor } from "./HoursEditor";
import { AUDIENCE_OPTIONS, clampPeople, defaultPeople, dollarsToCents, usd } from "../../lib/bookingsLogic";
import type { Audience } from "../../lib/bookingsTypes";
import { useAddSlots, useOfferAction, useQuote, useSaveOffer } from "../../hooks/use-bookings";
import { setupRefusalLine } from "./parts";

type Kind = "video_call" | "clinic" | "appearance";
const KINDS: Array<{ key: Kind; label: string; location: "virtual" | "in_person" }> = [
  { key: "video_call", label: "1:1 video call", location: "virtual" },
  { key: "clinic", label: "In-person session", location: "in_person" },
  { key: "appearance", label: "Appearance", location: "in_person" },
];
const LENGTHS = [30, 45, 60];
const PRICES = [3000, 5000, 7500, 10000];
const WINDOWS = [24, 48, 168];

/** The chip's (and the title's) name for a kind: a group's video call isn't "1:1". */
export function kindLabel(kind: Kind, audience: Audience = "one"): string {
  if (kind === "video_call" && audience !== "one") return "Group video call";
  return KINDS.find((x) => x.key === kind)!.label;
}

export function sessionTitle(kind: Kind, minutes: number, audience: Audience = "one"): string {
  return `${kindLabel(kind, audience)} · ${minutes} min`;
}

export function SessionSetupSheet({ visible, onClose, onDone, onOpenEditor, calendarConnected = false, now = new Date() }: {
  visible: boolean; onClose: () => void; onDone: () => void; onOpenEditor: (offerId: string | null) => void;
  calendarConnected?: boolean; now?: Date;
}) {
  const L = useLook();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kind, setKind] = useState<Kind>("video_call");
  const [minutes, setMinutes] = useState(30);
  const [audience, setAudience] = useState<Audience>("one");
  const [people, setPeople] = useState(1);
  const [approve, setApprove] = useState(false);
  const group = audience !== "one";
  const [price, setPrice] = useState(5000);
  const [other, setOther] = useState<string | null>(null);
  const [hours, setHours] = useState<WeekHours>(() => presetHours("weekday_evenings"));
  // "Only when I say": fans request a time (request mode), no hours.
  const [request, setRequest] = useState(false);
  const { height } = useWindowDimensions();
  const [windowH, setWindowH] = useState(24);
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  // The open times already added to the draft, so a retry after a refusal part-way through sends only the rest.
  const added = useRef<{ offerId: string | null; starts: Set<string> }>({ offerId: null, starts: new Set() });
  const cents = other !== null ? dollarsToCents(other) : price;
  const quote = useQuote(cents && cents > 0 ? cents : null);
  const save = useSaveOffer();
  const addSlots = useAddSlots();
  const publish = useOfferAction();
  const busy = save.isPending || addSlots.isPending || publish.isPending;
  const starts = useMemo(() => request ? [] : hoursStarts(hours, minutes, now), [request, hours, minutes, now]);
  const hoursOk = request || (hoursProblems(hours, minutes).length === 0 && starts.length > 0);

  function pickAudience(a: Audience) {
    setAudience(a);
    setPeople(defaultPeople(a));
    // An open group needs set times (fans book a spot in one): "Only when I say" doesn't apply.
    if (a === "open_group") setRequest(false);
  }

  async function finish() {
    setError(null);
    if (!hoursOk) return;
    const k = KINDS.find((x) => x.key === kind)!;
    try {
      const saved = await save.mutateAsync({ id: draftId, draft: {
        format: kind, title: sessionTitle(kind, minutes, audience), price_cents: cents ?? 5000, duration_minutes: minutes,
        location_mode: k.location, video_mode: k.location === "virtual" ? "livekit" : null,
        scheduling_mode: request ? "request" : "slots", free_cancel_hours: windowH,
        audience, max_people: group ? people : 1, approve_each_spot: audience === "open_group" && approve,
        availability: request ? null : toAvailability(hours),
      } });
      const id = saved.offer.id;
      setDraftId(id);
      if (added.current.offerId !== id) added.current = { offerId: id, starts: new Set() };
      // The server takes at most SLOTS_PER_REQUEST times per request; her hours usually make more (Weekday evenings,
      // 30 min, over 4 weeks: 96).
      for (const batch of slotBatches(starts, added.current.starts)) {
        await addSlots.mutateAsync({ offerId: id, starts: batch });
        for (const t of batch) added.current.starts.add(t);
      }
      await publish.mutateAsync({ id, action: "publish" });
      onDone();
    } catch (err) {
      setError(setupRefusalLine(err));
    }
  }

  const stepper = (
    <View style={s.stepper}>
      {[1, 2, 3].map((n) => <View key={n} style={[s.bar, { backgroundColor: n <= step ? L.act : L.line }]} />)}
    </View>
  );

  return (
    <LookSheet visible={visible} onClose={onClose} title="New session" sub="Three quick steps. You can change it any time." testID="session-setup"
      footer={
        <>
          {error ? (
            <View style={{ gap: 6 }}>
              <Text style={[Look.type.meta, { color: L.actTintInk }]} testID="session-setup-error">{error}</Text>
              <LookButton kind="secondary" small onPress={() => onOpenEditor(draftId)}>Open the full editor</LookButton>
            </View>
          ) : null}
          {step < 3
            ? <LookButton onPress={() => setStep((step + 1) as 2 | 3)} disabled={step === 2 && !(cents && cents > 0)} testID="session-setup-next">{step === 1 ? "Next: your price" : "Next: when you're free"}</LookButton>
            : <LookButton onPress={finish} loading={busy} disabled={!hoursOk} testID="session-setup-done">Publish this session</LookButton>}
          {step > 1 ? <LookButton kind="ghost" small onPress={() => setStep((step - 1) as 1 | 2)}>Back</LookButton> : null}
        </>
      }>
      {stepper}
      {step === 1 ? (
        <View style={s.group} testID="setup-step-what">
          <Text style={[Look.type.label, { color: L.ink2 }]}>What</Text>
          <View style={s.wrap}>{KINDS.map((k) => <LookChip key={k.key} selected={kind === k.key} onPress={() => setKind(k.key)} testID={`kind-${k.key}`}>{kindLabel(k.key, audience)}</LookChip>)}</View>
          <Text style={[Look.type.label, { color: L.ink2 }]}>{"Who's it for?"}</Text>
          <View style={s.wrap}>{AUDIENCE_OPTIONS.map((a) => <LookChip key={a.key} selected={audience === a.key} onPress={() => pickAudience(a.key)} testID={`audience-${a.key}`}>{a.label}</LookChip>)}</View>
          {group ? (
            <>
              <Text style={[Look.type.label, { color: L.ink2 }]}>How many people?</Text>
              <View style={s.people}>
                <LookChip onPress={() => setPeople(clampPeople(people - 1))} testID="people-minus">−</LookChip>
                <Text style={[Look.type.heading, s.count, { color: L.ink }]} accessibilityLiveRegion="polite" testID="people-count">{`Up to ${people}`}</Text>
                <LookChip onPress={() => setPeople(clampPeople(people + 1))} testID="people-plus">+</LookChip>
              </View>
              <Text style={[Look.type.meta, { color: L.muted }]}>{audience === "private_group"
                ? "One fan books the whole time and brings friends. Each friend gets their own call link."
                : approve ? "Fans each book and pay for their own spot. Each spot waits for your OK, like a request."
                  : "Fans each book and pay for their own spot. Booked spots confirm on their own."}</Text>
              {audience === "open_group" ? (
                <>
                  <Text style={[Look.type.label, { color: L.ink2 }]}>Spots</Text>
                  <View style={s.wrap}>
                    <LookChip selected={!approve} onPress={() => setApprove(false)} testID="approve-off">Confirm on their own</LookChip>
                    <LookChip selected={approve} onPress={() => setApprove(true)} testID="approve-on">I approve each spot</LookChip>
                  </View>
                </>
              ) : null}
            </>
          ) : null}
          <Text style={[Look.type.label, { color: L.ink2 }]}>How long</Text>
          <View style={s.wrap}>{LENGTHS.map((m) => <LookChip key={m} selected={minutes === m} onPress={() => setMinutes(m)} testID={`len-${m}`}>{`${m} min`}</LookChip>)}</View>
        </View>
      ) : null}
      {step === 2 ? (
        <View style={s.group} testID="setup-step-price">
          <Text style={[Look.type.label, { color: L.ink2 }]}>{group ? "Price per person" : "Your price"}</Text>
          <View style={s.wrap}>
            {PRICES.map((p) => <LookChip key={p} selected={other === null && price === p} onPress={() => { setOther(null); setPrice(p); }} testID={`price-${p}`}>{usd(p)}</LookChip>)}
            <LookChip selected={other !== null} onPress={() => setOther(other ?? "")} testID="price-other">Other</LookChip>
          </View>
          {other !== null ? (
            <TextInput value={other} onChangeText={setOther} keyboardType="decimal-pad" placeholder="$ amount" placeholderTextColor={L.muted}
              style={[Look.type.body, s.input, { color: L.ink, borderColor: L.line, backgroundColor: L.card }]} testID="price-input" />
          ) : null}
          <View style={[s.get, { backgroundColor: L.greenTint }]} testID="you-get">
            {group ? (
              <>
                <Text style={[Look.type.money, { color: L.green }]}>You get {cents ? `${usd(cents)} per person` : "—"}</Text>
                <Text style={[Look.type.meta, { color: L.ink2 }]}>{cents ? `Up to ${usd(cents * people)} per session · 100% of your price` : "100% of your price"}</Text>
              </>
            ) : (
              <>
                <Text style={[Look.type.money, { color: L.green }]}>You get {cents ? usd(cents) : "—"}</Text>
                <Text style={[Look.type.meta, { color: L.ink2 }]}>100% of your price, every session</Text>
              </>
            )}
          </View>
          {quote.data ? <Text style={[Look.type.meta, { color: L.muted }]} testID="fans-see">Fans see {usd(quote.data.buyerTotalCents)}{group ? " per person" : ""}, including the Nomila fee.</Text> : null}
        </View>
      ) : null}
      {step === 3 ? (
        <ScrollView style={{ maxHeight: height * 0.6 }} contentContainerStyle={s.group} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} testID="setup-step-when">
          <Text style={[Look.type.label, { color: L.ink2 }]}>When can fans book you?</Text>
          <HoursEditor hours={hours} onChange={setHours} minutes={minutes} calendarConnected={calendarConnected}
            request={request} onRequest={audience === "open_group" ? undefined : setRequest} testID="hours-editor" />
          {!request ? <Text style={[Look.type.metaStrong, { color: L.ink }]} testID="hours-count">{countLine(starts.length)}</Text> : null}
          <Text style={[Look.type.label, { color: L.ink2 }]}>Free cancellation until</Text>
          <View style={s.wrap}>{WINDOWS.map((h) => <LookChip key={h} selected={windowH === h} onPress={() => setWindowH(h)} testID={`window-${h}`}>{h === 168 ? "7 days before" : `${h}h before`}</LookChip>)}</View>
        </ScrollView>
      ) : null}
    </LookSheet>
  );
}

const s = StyleSheet.create({
  stepper: { flexDirection: "row", gap: 6 },
  bar:     { flex: 1, height: 4, borderRadius: 2 },
  group:   { gap: 10 },
  wrap:    { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input:   { minHeight: 48, borderWidth: 1.5, borderRadius: 16, paddingHorizontal: 14 },
  get:     { borderRadius: 16, padding: 14, gap: 2 },
  people:  { flexDirection: "row", alignItems: "center", gap: 12 },
  count:   { minWidth: 72, textAlign: "center" },
});
