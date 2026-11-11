// OfferEditorScreen — Bookings › New offer / an offer (booking screens design A2). One scrolling screen:
//
//   what it is      video call or in person (clinic / appearance / custom), the title, her words, the length
//   who it's for    just one fan · a fan + friends · an open group, and for a group how many people (2–20); her price
//                   is then per person (0153). An open group needs set times.
//   her price       "You receive $150 · buyers pay $177.96" — the server's quote, refreshed as she types
//   where           in person: her venue + the tick "a public place or my usual venue, not my home" (shown to buyers
//                   only after they've paid)
//   times           her times (slots) or buyers suggest up to 3; "Edit hours" (slots) reopens her weekly hours
//                   (EditHoursSheet): new times added, ones outside the hours withdrawn, booked ones never
//   her rules       under-18s with a parent, returning buyers only, ID check (always on in person)
//   cancellations   24 hours · 48 hours · 7 days, and her own rule if SHE cancels
//   publish         her tap on a confirm sheet ("It goes on your card now. You still approve every request."), gated
//                   until Stripe can pay her; Save draft is always there. Pause / resume / delete on a saved offer.
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { Button, Card, RuledHead, StackHeader } from "../../components/ui";
import { ConfirmSheet, ErrorLine, Loading, PayoutSetupBlock, refusalLine } from "../../components/bookings/parts";
import { useBookingsSummary, useOffer, useOfferAction, useQuote, useSaveOffer, type OfferDraft } from "../../hooks/use-bookings";
import {
  AUDIENCE_OPTIONS, BOOKINGS_COPY, GROUP_MAX_PEOPLE, GROUP_MIN_PEOPLE, clampPeople, defaultPeople, dollarsToCents, payoutsOf, receiveLine, usd, windowLabel,
} from "../../lib/bookingsLogic";
import { openOfferTimes } from "../../navigation/bookingsNav";
import { EditHoursSheet } from "../../components/bookings/EditHoursSheet";
import { fromAvailability, hoursSummary } from "../../lib/availabilityLogic";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";
import type { Audience, OfferFormat, OfferView } from "../../lib/bookingsTypes";

interface Form {
  kind: "video" | "in_person"; format: OfferFormat; title: string; description: string; duration: number; price: string;
  venue: string; venueOk: boolean; scheduling: "slots" | "request"; minors: boolean; returning: boolean; idCheck: boolean;
  window: number; adult: boolean; audience: Audience; people: number;
  /** Open groups (0154): each spot waits for her Accept. */
  approve: boolean;
}

function fromOffer(o: OfferView): Form {
  return {
    kind: o.locationMode === "in_person" ? "in_person" : "video", format: o.format, title: o.title, description: o.description ?? "",
    duration: o.durationMinutes, price: String(o.priceCents / 100), venue: o.venue ?? "", venueOk: o.venueConfirmed,
    scheduling: o.schedulingMode, minors: o.allowMinorAttendees, returning: o.returningBuyersOnly, idCheck: o.requireIdVerification,
    window: o.freeCancelHours, adult: o.adultAttested, audience: o.audience ?? "one", people: o.audience && o.audience !== "one" ? o.maxPeople : 1,
    approve: !!o.approveEachSpot,
  };
}

function toDraft(f: Form, cents: number): OfferDraft {
  return {
    format: f.kind === "video" ? "video_call" : f.format === "video_call" ? "clinic" : f.format,
    title: f.title.trim(), description: f.description.trim() || null, price_cents: cents, duration_minutes: f.duration,
    location_mode: f.kind === "video" ? "virtual" : "in_person", venue: f.kind === "in_person" ? f.venue.trim() || null : null,
    ...(f.kind === "in_person" && f.venueOk ? { venue_confirmed: true } : {}),
    scheduling_mode: f.scheduling, allow_minor_attendees: f.minors, returning_buyers_only: f.returning,
    require_id_verification: f.kind === "in_person" ? true : f.idCheck, free_cancel_hours: f.window,
    audience: f.audience, max_people: f.audience === "one" ? 1 : clampPeople(f.people),
    approve_each_spot: f.audience === "open_group" && f.approve,
  };
}

/** The group sizes she picks from (2–20 in the usual steps), always including the one the offer has. */
export function peopleOptions(current: number): number[] {
  const steps = [2, 3, 4, 5, 6, 8, 10, 12, 15, GROUP_MAX_PEOPLE];
  const n = current >= GROUP_MIN_PEOPLE ? clampPeople(current) : null;
  return [...new Set(n ? [...steps, n] : steps)].sort((x, y) => x - y);
}

/** The quote follows her typing, a beat behind (one server call per pause, not per keystroke). */
function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function OfferEditorScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const [offerId, setOfferId] = useState<string | null>(route.params?.offerId ?? null);
  const summary = useBookingsSummary();
  const offer = useOffer(offerId);
  if (offerId && offer.isLoading) return <Frame><Loading testID="offer-loading" /></Frame>;
  if (offerId && offer.isError) return <Frame><ErrorLine text="Couldn't load this offer. Go back and try again." testID="offer-error" /></Frame>;
  if (summary.isLoading) return <Frame><Loading testID="offer-loading" /></Frame>;
  if (!summary.data) return <Frame><ErrorLine text={BOOKINGS_COPY.loadError} testID="offer-error" /></Frame>;
  return <Editor key={offer.data?.id ?? "new"} existing={offer.data ?? null} limits={summary.data.limits} payoutsReady={payoutsOf(summary.data).ready}
    payouts={summary.data.payouts} onSaved={(id) => setOfferId(id)} onDone={() => navigation.goBack()} onTimes={(id) => openOfferTimes(navigation, id)} />;
}

function Frame({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title="Bookings" bold right={right} />
      {children}
    </SafeAreaView>
  );
}

function Editor({ existing, limits, payoutsReady, payouts, onSaved, onDone, onTimes }: {
  existing: OfferView | null; limits: { minPriceCents: number; maxPriceCents: number; durationOptions: number[]; freeCancelHoursOptions: number[]; freeCancelHoursDefault: number };
  payoutsReady: boolean; payouts: Parameters<typeof PayoutSetupBlock>[0]["payouts"];
  onSaved: (id: string) => void; onDone: () => void; onTimes: (id: string) => void;
}) {
  const [f, setF] = useState<Form>(() => existing ? fromOffer(existing) : {
    kind: "video", format: "video_call", title: "", description: "", duration: limits.durationOptions.includes(30) ? 30 : limits.durationOptions[0],
    price: "", venue: "", venueOk: false, scheduling: "request", minors: false, returning: false, idCheck: false,
    window: limits.freeCancelHoursDefault, adult: false, audience: "one", people: 1, approve: false,
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const group = f.audience !== "one";
  // Who it's for: a group starts at a sensible size; an open group needs set times (fans book a spot in one).
  const setAudience = (a: Audience) => setF((x) => ({ ...x, audience: a, people: defaultPeople(a), ...(a === "open_group" ? { scheduling: "slots" as const } : {}) }));
  const cents = dollarsToCents(f.price);
  const inRange = cents !== null && cents >= limits.minPriceCents && cents <= limits.maxPriceCents;
  const quoteFor = useDebounced(inRange ? cents : null);
  const quote = useQuote(quoteFor);
  const save = useSaveOffer();
  const act = useOfferAction();
  const [line, setLine] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "publish" | "menu" | "delete">(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  // Edit hours (flexible hours): her weekly hours, reopened from the offer.
  const [hoursOpen, setHoursOpen] = useState(false);
  const [hoursLine, setHoursLine] = useState<string | null>(null);
  const savedHours = fromAvailability(existing?.availability);

  const live = existing?.status === "published";
  const problems = useMemo(() => {
    const out: string[] = [];
    if (!f.title.trim()) out.push("Add a title.");
    if (!inRange) out.push(`Your price must be between ${usd(limits.minPriceCents)} and ${usd(limits.maxPriceCents)}.`);
    if (f.kind === "in_person" && (!f.venue.trim() || !f.venueOk)) out.push("Add the place and tick that it isn't your home.");
    return out;
  }, [f, inRange, limits]);
  const canPublish = payoutsReady && problems.length === 0 && !!quote.data;

  const [savedId, setSavedId] = useState<string | null>(existing?.id ?? null);
  /** Save (create the first time). `remember` re-opens the screen on the saved offer (Save draft); publish leaves. */
  const persist = async (remember: boolean): Promise<OfferView> => {
    const r = await save.mutateAsync({ id: savedId, draft: toDraft(f, cents!) });
    setSavedId(r.offer.id);
    if (remember && !existing) onSaved(r.offer.id);
    return r.offer;
  };
  const saveDraft = () => {
    if (!f.title.trim() || !inRange) { setLine(problems[0] ?? null); return; }
    setLine(null);
    persist(true).then(() => { haptics.success(); setLine(live ? "Saved. Changes apply to new requests only." : "Saved as a draft."); })
      .catch((err) => setLine(refusalLine(err, "Couldn't save. Nothing changed. Try again.")));
  };
  const publish = () => {
    setSheetError(null);
    persist(false)
      .then((o) => act.mutateAsync({ id: o.id, action: "publish" }))
      .then(() => { haptics.success(); setSheet(null); onDone(); })
      .catch((err) => setSheetError(refusalLine(err, "Couldn't publish. Nothing changed. Try again.")));
  };
  const runAction = (action: "pause" | "resume" | "delete") => {
    setSheetError(null);
    act.mutateAsync({ id: existing!.id, action })
      .then(() => { haptics.success(); setSheet(null); if (action === "delete") onDone(); })
      .catch((err) => setSheetError(refusalLine(err, "Couldn't do that. Nothing changed. Try again.")));
  };

  const menu = existing ? (
    <Pressable onPress={() => setSheet("menu")} hitSlop={10} accessibilityRole="button" accessibilityLabel="More" testID="offer-menu">
      <Feather name="more-horizontal" size={20} color={Bold.ink} />
    </Pressable>
  ) : undefined;

  return (
    <Frame right={menu}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} testID="offer-editor">
        <Text style={styles.title}>{existing ? existing.title : BOOKINGS_COPY.newOffer}</Text>
        {live ? <Text style={styles.caption}>Live on your card. Changes apply to new requests only.</Text> : null}

        <Section title="What is it">
          <Choice value={f.kind} options={[["video", "Video call"], ["in_person", "In person"]]} onChange={(v) => set("kind", v as Form["kind"])} testID="kind" />
          {f.kind === "in_person" ? (
            <Choice value={f.format === "video_call" ? "clinic" : f.format} options={[["clinic", "Clinic"], ["appearance", "Appearance"], ["custom", "Something else"]]} onChange={(v) => set("format", v as OfferFormat)} testID="format" />
          ) : null}
          <Field label="Title" value={f.title} onChange={(v) => set("title", v)} max={80} placeholder="1:1 video call" testID="title" />
          <Field label="What they get (shown in your words)" value={f.description} onChange={(v) => set("description", v)} max={600} multiline placeholder="30 minutes on anything you'd like to ask." testID="description" />
          <Text style={styles.label}>Length</Text>
          <Choice value={String(f.duration)} options={limits.durationOptions.map((m) => [String(m), `${m} min`])} onChange={(v) => set("duration", Number(v))} testID="duration" />
        </Section>

        <Section title="Who it's for">
          <Choice value={f.audience} options={AUDIENCE_OPTIONS.map((a) => [a.key, a.label])} onChange={(v) => setAudience(v as Audience)} testID="audience" />
          {group ? (
            <>
              <Text style={styles.label}>How many people</Text>
              <Choice value={String(f.people)} options={peopleOptions(f.people).map((n) => [String(n), String(n)])}
                onChange={(v) => set("people", Number(v))} testID="people" />
              <Text style={styles.caption}>{f.audience === "private_group"
                ? `One fan books the whole time for up to ${f.people} people and invites friends. Each friend gets their own call link.`
                : `Up to ${f.people} fans each book and pay for their own spot.${f.approve ? " You approve each spot, like a request." : " Booked spots confirm on their own."}`}</Text>
              {f.audience === "open_group" ? (
                <Tick on={f.approve} onPress={() => set("approve", !f.approve)} label="Approve each spot — every fan's spot waits for your OK" testID="rule-approve-spots" />
              ) : null}
            </>
          ) : null}
          {existing && existing.liveBookings > 0 ? <Text style={styles.caption}>{"People are booked, so who it's for can't change now."}</Text> : null}
        </Section>

        <Section title="Your price">
          <Field label={group ? "Price per person (USD)" : "Your price (USD)"} value={f.price} onChange={(v) => set("price", v)} keyboard="decimal-pad" placeholder="150" testID="price" />
          {f.price && !inRange ? <Text style={styles.note} testID="price-range">Between {usd(limits.minPriceCents)} and {usd(limits.maxPriceCents)}.</Text> : null}
          {inRange && quote.data ? <Text style={styles.receive} testID="receive-line">{`${receiveLine(quote.data)}${group ? " per person" : ""}`}</Text> : null}
          {inRange && group ? <Text style={styles.caption} testID="receive-max">Up to {usd(cents! * f.people)} per session.</Text> : null}
          {inRange && quote.isError ? <Text style={styles.note} testID="quote-error">{"Couldn't work out the buyer price. Check your connection."}</Text> : null}
          <Text style={styles.caption}>Buyers pay a Nomila service fee on top of your price. You keep all of your price.</Text>
        </Section>

        {f.kind === "in_person" ? (
          <Section title="Where">
            <Field label="Place" value={f.venue} onChange={(v) => { set("venue", v); set("venueOk", false); }} max={200} placeholder="A public place or your usual venue" testID="venue" />
            <Tick on={f.venueOk} onPress={() => set("venueOk", !f.venueOk)} label="This is a public place or my usual venue, not my home." testID="venue-ok" />
            <Text style={styles.caption}>{"Buyers see the place only after they've paid."}</Text>
          </Section>
        ) : null}

        <Section title="Times">
          <Choice value={f.scheduling} options={f.audience === "open_group" ? [["slots", "I pick the times"]] : [["request", "Buyers suggest times"], ["slots", "I pick the times"]]}
            onChange={(v) => set("scheduling", v as Form["scheduling"])} testID="scheduling" />
          {f.scheduling === "slots" && existing?.schedulingMode === "slots" ? (
            <Pressable style={styles.door} onPress={() => setHoursOpen(true)} accessibilityRole="button" testID="offer-edit-hours">
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>Edit hours</Text>
                <Text style={styles.rowMeta} numberOfLines={2} testID="offer-hours-summary">{savedHours ? hoursSummary(savedHours) : "Pick the days and hours fans can book"}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Bold.quiet} />
            </Pressable>
          ) : null}
          {hoursLine ? <Text style={styles.caption} testID="offer-hours-line">{hoursLine}</Text> : null}
          {f.scheduling === "slots" ? (
            existing ? (
              <Pressable style={styles.door} onPress={() => onTimes(existing.id)} accessibilityRole="button" testID="offer-times">
                <Text style={styles.rowTitle}>Your times</Text>
                <Text style={styles.rowMeta}>{existing.openSlots === 1 ? "1 open" : `${existing.openSlots} open`}</Text>
                <Feather name="chevron-right" size={18} color={Bold.quiet} />
              </Pressable>
            ) : <Text style={styles.caption}>Save this offer, then add your times.</Text>
          ) : <Text style={styles.caption}>Buyers suggest up to 3 times and you pick one.</Text>}
        </Section>

        <Section title="Your rules">
          <Tick on={f.minors} onPress={() => set("minors", !f.minors)} label="Allow under-18s, only with a parent there" testID="rule-minors" />
          <Tick on={f.returning} onPress={() => set("returning", !f.returning)} label="Returning buyers only — people you've met before" testID="rule-returning" />
          <Tick on={f.kind === "in_person" || f.idCheck} disabled={f.kind === "in_person"} onPress={() => set("idCheck", !f.idCheck)}
            label={f.kind === "in_person" ? "ID check — always on for in person" : "ID check (ID + selfie, by Stripe)"} testID="rule-id" />
        </Section>

        <Section title="Cancellations">
          <Text style={styles.body}>Buyers can cancel for a refund up to</Text>
          <Choice value={String(f.window)} options={limits.freeCancelHoursOptions.map((h) => [String(h), windowLabel(h)])} onChange={(v) => set("window", Number(v))} testID="window" />
          <Text style={styles.body}>{"before the session. After that, you're paid even if they cancel or don't show."}</Text>
          <Text style={styles.label}>If you cancel</Text>
          <Text style={styles.body}>The buyer gets a full refund and the card fee comes out of your next payout. Your first one is on us.</Text>
        </Section>

        {!payoutsReady ? <PayoutSetupBlock payouts={payouts} testID="editor-payouts" /> : null}
        {line ? <Text style={styles.note} testID="editor-line">{line}</Text> : null}
        <Button bold="primary" onPress={() => { setSheetError(null); setSheet("publish"); }} disabled={!canPublish} testID="offer-publish">{live ? "Publish changes" : "Publish"}</Button>
        <Button bold="secondary" onPress={saveDraft} loading={save.isPending && sheet === null} testID="offer-save">{live ? "Save changes" : "Save draft"}</Button>
      </ScrollView>

      {sheet === "publish" && quote.data ? (
        <ConfirmSheet title="Publish this offer?" confirm="Publish to my card" cancelLabel="Not yet" onConfirm={publish} onClose={() => setSheet(null)}
          busy={save.isPending || act.isPending} error={sheetError} testID="publish-sheet">
          <Text style={styles.rowTitle}>{f.title.trim()} · {f.duration} min</Text>
          <Text style={styles.rowMeta}>{f.scheduling === "slots" ? "Your times" : "Buyers suggest times"} · refunds up to {windowLabel(f.window)} before</Text>
          <Money label={group ? "You receive per person" : "You receive"} sub={group ? `up to ${usd(quote.data.athleteReceivesCents * f.people)} per session` : undefined} value={usd(quote.data.athleteReceivesCents)} />
          <Money label={group ? "Each person pays" : "Buyers pay"} sub={`includes ${usd(quote.data.serviceFeeCents)} Nomila service fee`} value={usd(quote.data.buyerTotalCents)} />
          <Text style={styles.body}>{f.audience === "open_group" && !f.approve ? "It goes on your card now. Fans book their own spots; booked spots confirm on their own." : f.audience === "open_group" ? "It goes on your card now. Fans book their own spots; you approve each one." : "It goes on your card now. You still approve every request."}</Text>
        </ConfirmSheet>
      ) : null}
      {hoursOpen && existing ? (
        <EditHoursSheet offer={existing} onClose={() => setHoursOpen(false)}
          onSaved={(l) => { haptics.success(); setHoursOpen(false); setHoursLine(l); }} />
      ) : null}
      {sheet === "menu" && existing ? (
        <ConfirmSheet title={existing.title} confirm={existing.status === "published" ? "Pause this offer" : existing.status === "paused" && existing.pausedReason === "athlete" ? "Resume this offer" : "Delete this offer"}
          onConfirm={() => existing.status === "published" ? runAction("pause") : existing.status === "paused" && existing.pausedReason === "athlete" ? runAction("resume") : setSheet("delete")}
          onClose={() => setSheet(null)} busy={act.isPending} error={sheetError} testID="menu-sheet">
          <Text style={styles.body}>{existing.status === "published" ? "Paused offers leave your card. Booked sessions still go ahead." : existing.pausedReason && existing.pausedReason !== "athlete" ? "Nomila paused this offer while support takes a look. You can still delete it." : "Delete removes it from your card. Booked sessions still go ahead."}</Text>
          {existing.status !== "draft" ? <Button bold="link" onPress={() => setSheet("delete")} testID="menu-delete">Delete this offer</Button> : null}
        </ConfirmSheet>
      ) : null}
      {sheet === "delete" && existing ? (
        <ConfirmSheet title="Delete this offer?" confirm="Delete" cancelLabel="Keep it" onConfirm={() => runAction("delete")} onClose={() => setSheet(null)} busy={act.isPending} error={sheetError} testID="delete-sheet">
          <Text style={styles.body}>It comes off your card. Requests and sessions already booked still go ahead.</Text>
        </ConfirmSheet>
      ) : null}
    </Frame>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card bold style={styles.section}><View style={styles.sectionPad}><RuledHead title={title} />{children}</View></Card>;
}

function Field({ label, value, onChange, max, placeholder, multiline, keyboard, testID }: {
  label: string; value: string; onChange: (v: string) => void; max?: number; placeholder?: string; multiline?: boolean; keyboard?: "decimal-pad"; testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput value={value} onChangeText={onChange} maxLength={max} placeholder={placeholder} placeholderTextColor={Bold.quiet}
        multiline={multiline} keyboardType={keyboard} style={[styles.input, multiline && styles.inputMulti]} accessibilityLabel={label} testID={`field-${testID}`} />
    </View>
  );
}

function Choice({ value, options, onChange, testID }: { value: string; options: Array<[string, string]>; onChange: (v: string) => void; testID: string }) {
  return (
    <View style={styles.choices}>
      {options.map(([k, label]) => (
        <Pressable key={k} onPress={() => { haptics.select(); onChange(k); }} style={[styles.choice, value === k && styles.choiceOn]}
          accessibilityRole="button" accessibilityState={{ selected: value === k }} testID={`${testID}-${k}`}>
          <Text style={[styles.choiceText, value === k && styles.choiceTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Tick({ on, onPress, label, disabled, testID }: { on: boolean; onPress: () => void; label: string; disabled?: boolean; testID: string }) {
  return (
    <Pressable onPress={() => { if (!disabled) { haptics.select(); onPress(); } }} style={styles.tick} accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: !!disabled }} testID={testID}>
      <View style={[styles.box, on && styles.boxOn]}>{on ? <Feather name="check" size={14} color={Bold.onDark} /> : null}</View>
      <Text style={[styles.body, styles.flex, disabled && styles.muted]}>{label}</Text>
    </Pressable>
  );
}

function Money({ label, sub, value }: { label: string; sub?: string; value: string }) {
  return (
    <View style={styles.money}>
      <View style={styles.flex}><Text style={styles.rowTitle}>{label}</Text>{sub ? <Text style={styles.rowMeta}>{sub}</Text> : null}</View>
      <Text style={styles.moneyValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: Bold.paper },
  content:    { paddingHorizontal: Bold.gutter, paddingBottom: 48, gap: 14 },
  title:      { ...BoldType.screenTitleSm, color: Bold.ink, marginTop: 8 },
  section:    {},
  sectionPad: { padding: 14, gap: 10 },
  field:      { gap: 6 },
  label:      { ...BoldType.label, color: Bold.mute },
  input:      { ...BoldType.body, color: Bold.ink, minHeight: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12 },
  inputMulti: { minHeight: 88, paddingTop: 12, textAlignVertical: "top" },
  choices:    { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice:     { minHeight: 36, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1.5, borderColor: Bold.line, borderRadius: Bold.radius.control },
  choiceOn:   { borderColor: Bold.ink, backgroundColor: Bold.ink },
  choiceText: { ...BoldType.chipLine, color: Bold.ink },
  choiceTextOn: { color: Bold.onDark },
  tick:       { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  box:        { width: 22, height: 22, borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.chip, alignItems: "center", justifyContent: "center" },
  boxOn:      { backgroundColor: Bold.ink },
  body:       { ...BoldType.body, color: Bold.ink },
  muted:      { color: Bold.mute },
  caption:    { ...BoldType.caption, color: Bold.mute },
  note:       { ...BoldType.body, color: Bold.ink },
  receive:    { ...BoldType.rowTitle, color: Bold.ink },
  door:       { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  rowTitle:   { ...BoldType.rowTitle, color: Bold.ink, flex: 1 },
  rowMeta:    { ...BoldType.rowMeta, color: Bold.mute },
  money:      { flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: 1, borderTopColor: Bold.line, paddingTop: 10 },
  moneyValue: { ...BoldType.cellValue, color: Bold.ink },
  flex:       { flex: 1 },
});
