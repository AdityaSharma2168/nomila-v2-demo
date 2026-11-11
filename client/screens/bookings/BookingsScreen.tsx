// BookingsScreen — Business › Bookings in the one look (owner-approved 22 Oct 2026): REQUESTS · BOOKED · YOUR SESSIONS.
//
//   Requests       decided on the card: Accept · Suggest a time · Decline, each with a 10-second Undo (RequestCard)
//   Booked         upcoming sessions, then past ones (each opens its detail). An open group's time is ONE row
//                  ("Group clinic · Sat 10:00 am · 4 of 10 booked"), from GET /bookings/groups; its per-fan spots that
//                  GET /bookings also lists are hidden here (0153)
//   Your sessions  the payout-setup block until Stripe can pay them; "paused by Nomila" after missed sessions; live,
//                  paused and draft sessions (each opens the editor); "New session" opens the 3-step setup sheet
//
// The athlete sees only "You get". Pull to refresh refetches this screen's own queries; no refresh buttons.
import React, { useMemo, useState } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { StackHeader, pullRefresh, usePullRefresh } from "../../components/ui";
import { BookingRow, Empty, ErrorLine, GroupRow, Loading, PayoutSetupBlock } from "../../components/bookings/parts";
import { BookingPayoutsCard } from "../../components/bookings/BookingPayoutsCard";
import { RequestCard } from "../../components/bookings/RequestCard";
import { SessionSetupSheet } from "../../components/bookings/SessionSetupSheet";
import { LookButton, LookCard, LookChip, UndoToast } from "../../components/look";
import { useBookingList, useBookingsSummary, useGroupSessions, useOffers, useSlots } from "../../hooks/use-bookings";
import { BOOKINGS_COPY, FORMAT_LABEL, bookedEntries, offerMeta, payoutsOf } from "../../lib/bookingsLogic";
import { openBlockedFans, openBookingDetail, openGroupSession, openOfferEditor, routeRegistered, type BookingsTab } from "../../navigation/bookingsNav";
import { BoldType, Look, useLook } from "../../constants/theme";
import type { BookingListItemView, BookingsSummaryView, GroupSessionListItemView, OfferView } from "../../lib/bookingsTypes";
import { OPPS_LABEL } from "../../lib/flags";

export function BookingsScreen() {
  const L = useLook();
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const summary = useBookingsSummary();
  const s = summary.data ?? null;
  const initial: BookingsTab = route.params?.tab ?? (s && s.requests > 0 ? "requests" : s && s.offers.published + s.offers.paused === 0 ? "offers" : "booked");
  const [tab, setTab] = useState<BookingsTab | null>(null);
  const current = tab ?? initial;
  const requests = useBookingList("requests", current === "requests");
  const upcoming = useBookingList("upcoming", current === "booked");
  const past = useBookingList("past", current === "booked");
  const groupsUpcoming = useGroupSessions("upcoming", current === "booked");
  const groupsPast = useGroupSessions("past", current === "booked");
  const offers = useOffers();
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
  const [setup, setSetup] = useState(false);
  const refresh = usePullRefresh(() => Promise.all([summary.refetch(), requests.refetch(), upcoming.refetch(), past.refetch(), groupsUpcoming.refetch(), groupsPast.refetch(), offers.refetch()]));
  const pastEntries = bookedEntries(past.data ?? [], groupsPast.data ?? [], "desc");

  const tabs: Array<{ key: BookingsTab; label: string; count?: number }> = [
    { key: "requests", label: BOOKINGS_COPY.tabs.requests, count: s?.requests },
    { key: "booked", label: BOOKINGS_COPY.tabs.booked },
    { key: "offers", label: "Your sessions" },
  ];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: L.bg }]}>
      <StackHeader title={route.params?.back ?? OPPS_LABEL} bold dark={L.dark} />
      <ScrollView contentContainerStyle={styles.content} refreshControl={pullRefresh(refresh)} showsVerticalScrollIndicator={false} testID="bookings-scroll">
        <Text style={[BoldType.screenTitleSm, { color: L.ink, marginTop: 8, marginBottom: 14 }]} accessibilityRole="header">{BOOKINGS_COPY.title}</Text>
        {summary.isLoading ? <Loading /> : null}
        {summary.isError ? <ErrorLine text={BOOKINGS_COPY.loadError} /> : null}
        {s ? (
          <>
            <View style={styles.tabs} accessibilityRole="tablist">
              {tabs.map((t) => (
                <LookChip key={t.key} selected={current === t.key} onPress={() => setTab(t.key)} testID={`tab-${t.key}`}>
                  {t.count ? `${t.label} · ${t.count}` : t.label}
                </LookChip>
              ))}
            </View>
            {current === "requests" ? (
              <Requests q={requests} offers={offers.data ?? []} onAnswered={() => { summary.refetch(); requests.refetch(); }} onToast={setToast}
                empty={{
                  title: BOOKINGS_COPY.noRequests,
                  body: s.offers.published > 0 ? BOOKINGS_COPY.noRequestsBody : BOOKINGS_COPY.noRequestsNoOffer,
                  action: { label: "See your sessions", onPress: () => setTab("offers") },
                  testID: "requests-empty",
                }} />
            ) : null}
            {current === "booked" ? (
              <View style={styles.list}>
                <Text style={[Look.type.label, { color: L.ink2 }]}>Coming up</Text>
                <Rows q={upcoming} groups={groupsUpcoming.data ?? []} empty={{ title: BOOKINGS_COPY.noBooked, body: BOOKINGS_COPY.noBookedBody, testID: "upcoming-empty" }}
                  onOpen={(id) => openBookingDetail(navigation, id)} onOpenGroup={(slotId) => openGroupSession(navigation, slotId)} />
                {pastEntries.length ? (
                  <>
                    <Text style={[Look.type.label, { color: L.ink2, marginTop: 8 }]}>Past</Text>
                    <Rows q={past} groups={groupsPast.data ?? []} order="desc" onOpen={(id) => openBookingDetail(navigation, id)} onOpenGroup={(slotId) => openGroupSession(navigation, slotId)} />
                  </>
                ) : null}
              </View>
            ) : null}
            {current === "offers" ? <SessionsTab s={s} q={offers} onOpen={(id) => openOfferEditor(navigation, id)} onNew={() => setSetup(true)}
              onBlocked={routeRegistered(navigation, "BookingBlocks") ? () => openBlockedFans(navigation) : undefined} /> : null}
          </>
        ) : null}
        {!summary.isLoading && !summary.isError && !s ? <ErrorLine text="Bookings aren't on for your account yet." testID="bookings-off" /> : null}
      </ScrollView>
      <UndoToast visible={!!toast} text={toast?.text ?? ""} onUndo={() => toast?.undo()} testID="bookings-toast" />
      {setup ? (
        <SessionSetupSheet visible onClose={() => setSetup(false)} onDone={() => { setSetup(false); offers.refetch(); summary.refetch(); }}
          onOpenEditor={(id) => { setSetup(false); openOfferEditor(navigation, id); }} />
      ) : null}
    </SafeAreaView>
  );
}

/** The offer a request is for: its sessions match on title and format (the list item carries no offer id). */
export function offerFor(b: Pick<BookingListItemView, "title" | "format">, offers: OfferView[]): OfferView | null {
  return offers.find((o) => o.title === b.title && o.format === b.format) ?? null;
}

function Requests({ q, offers, onAnswered, onToast, empty }: {
  q: ReturnType<typeof useBookingList>; offers: OfferView[]; onAnswered: () => void;
  onToast: (t: { text: string; undo: () => void } | null) => void;
  empty: { title: string; body: string; action?: { label: string; onPress: () => void }; testID: string };
}) {
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorLine text={BOOKINGS_COPY.loadError} />;
  const rows = q.data ?? [];
  if (!rows.length) return <Empty {...empty} />;
  return (
    <View style={styles.list}>
      {rows.map((b) => <RequestWithTimes key={b.id} b={b} offer={offerFor(b, offers)} onAnswered={onAnswered} onToast={onToast} />)}
    </View>
  );
}

function RequestWithTimes({ b, offer, onAnswered, onToast }: {
  b: BookingListItemView; offer: OfferView | null; onAnswered: () => void; onToast: (t: { text: string; undo: () => void } | null) => void;
}) {
  const slots = useSlots(offer?.id ?? null);
  const open = useMemo(() => (slots.data ?? []).filter((x) => !x.taken).map((x) => ({ id: x.id, startsAt: x.startsAt })), [slots.data]);
  return <RequestCard b={b} openTimes={open} onAnswered={onAnswered} onToast={onToast} />;
}

function Rows({ q, groups, order = "asc", empty, onOpen, onOpenGroup }: {
  q: ReturnType<typeof useBookingList>;
  /** Open-group times (one row each); their per-fan spots in `q` are hidden. */
  groups: GroupSessionListItemView[];
  order?: "asc" | "desc";
  empty?: { title: string; body: string; action?: { label: string; onPress: () => void }; testID: string };
  onOpen: (id: string) => void;
  onOpenGroup: (slotId: string) => void;
}) {
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorLine text={BOOKINGS_COPY.loadError} />;
  const rows = bookedEntries(q.data ?? [], groups, order);
  if (!rows.length) return empty ? <Empty {...empty} /> : null;
  return (
    <LookCard style={styles.flush}>
      {rows.map((e, i) => e.kind === "group"
        ? <GroupRow key={`g-${e.g.slotId}`} g={e.g} last={i === rows.length - 1} onPress={() => onOpenGroup(e.g.slotId)} />
        : <BookingRow key={e.b.id} b={e.b} last={i === rows.length - 1} onPress={() => onOpen(e.b.id)} />)}
    </LookCard>
  );
}

function SessionRow({ o, last, onPress }: { o: OfferView; last: boolean; onPress: () => void }) {
  const L = useLook();
  return (
    <Pressable style={({ pressed }) => [styles.row, !last && { borderBottomWidth: 1, borderBottomColor: L.line }, pressed && { transform: [{ scale: Look.pressScale }] }]}
      onPress={onPress} accessibilityRole="button" accessibilityLabel={`${o.title}, ${offerMeta(o)}`} testID={`offer-row-${o.id}`}>
      <View style={styles.flex}>
        <Text style={[Look.type.bodyStrong, { color: L.ink }]} numberOfLines={1}>{o.title}</Text>
        <Text style={[Look.type.meta, { color: L.ink2 }]} numberOfLines={1}>{FORMAT_LABEL[o.format]} · {offerMeta(o)}</Text>
      </View>
      <Feather name="chevron-right" size={20} color={L.muted} />
    </Pressable>
  );
}

function SessionsTab({ s, q, onOpen, onNew, onBlocked }: {
  s: BookingsSummaryView; q: ReturnType<typeof useOffers>; onOpen: (id: string | null) => void; onNew: () => void; onBlocked?: () => void;
}) {
  const L = useLook();
  if (q.isLoading) return <Loading testID="offers-loading" />;
  if (q.isError) return <ErrorLine text={BOOKINGS_COPY.offersError} testID="offers-error" />;
  const all = q.data ?? [];
  // An older or partial overview can arrive without payouts: read it as "not set up" rather than crash the tab.
  const payouts = payoutsOf(s);
  const groups: Array<[string, OfferView[]]> = [
    ["Live on your page", all.filter((o) => o.status === "published")],
    ["Paused", all.filter((o) => o.status === "paused")],
    ["Drafts", all.filter((o) => o.status === "draft")],
  ];
  return (
    <View style={styles.list}>
      {s.pausedByNomila ? (
        <LookCard testID="offers-paused">
          <Text style={[Look.type.heading, { color: L.ink }]}>{BOOKINGS_COPY.pausedTitle}</Text>
          <Text style={[Look.type.body, { color: L.ink2, marginTop: 4 }]}>{BOOKINGS_COPY.pausedBody}</Text>
          <Text style={[Look.type.meta, { color: L.muted, marginTop: 6 }]}>{"We'll email you within 1 business day. Questions:"} {s.supportEmail}</Text>
        </LookCard>
      ) : <PayoutSetupBlock payouts={payouts} />}
      {all.length === 0 ? (
        <Empty title={BOOKINGS_COPY.sellTitle} body={BOOKINGS_COPY.sellBody} testID="offers-empty" />
      ) : groups.filter(([, rows]) => rows.length).map(([title, rows]) => (
        <View key={title} style={{ gap: 8 }}>
          <Text style={[Look.type.label, { color: L.ink2 }]}>{title}</Text>
          <LookCard style={styles.flush}>{rows.map((o, i) => <SessionRow key={o.id} o={o} last={i === rows.length - 1} onPress={() => onOpen(o.id)} />)}</LookCard>
        </View>
      ))}
      {!s.pausedByNomila ? <LookButton kind={payouts.ready ? "primary" : "secondary"} icon="plus" onPress={onNew} testID="offer-new">New session</LookButton> : null}
      {all.length ? <Text style={[Look.type.meta, { color: L.muted }]}>{BOOKINGS_COPY.offersFoot}</Text> : null}
      <BookingPayoutsCard />
      {onBlocked ? (
        <LookCard onPress={onBlocked} style={styles.row} testID="blocked-fans-door" accessibilityLabel="Blocked fans">
          <Feather name="slash" size={18} color={L.ink2} />
          <View style={styles.flex}>
            <Text style={[Look.type.bodyStrong, { color: L.ink }]}>Blocked fans</Text>
            <Text style={[Look.type.meta, { color: L.ink2 }]}>{"People who can't book you or join your calls"}</Text>
          </View>
          <Feather name="chevron-right" size={20} color={L.muted} />
        </LookCard>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1 },
  content: { paddingHorizontal: Look.gutter, paddingBottom: 120 },
  tabs:    { flexDirection: "row", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  list:    { gap: 12 },
  flush:   { padding: 0, overflow: "hidden" },
  row:     { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 12, paddingHorizontal: 16 },
  flex:    { flex: 1 },
});
