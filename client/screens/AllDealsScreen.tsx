// AllDealsScreen — All deals and All bookings: the Opportunities header's search (deals design §5c "All deals", §7b (b);
// behind EXPO_PUBLIC_OPPS_V2).
//
//   one box     looks through brand and agency names, the kind of deal, where it stands, what they asked and amounts
//               (bookings: who booked, the offer, the date, where it stands) — GET /me/deals/search, /me/bookings/search
//   tabs        Active · Done · Closed, each with its count
//   chips       the deal types (bookings: the formats) with counts; Closed adds "Not a deal" — the filed mail, so
//               nothing is ever lost
//   rows        the logo, the brand, the money line, the type, where it stands and the last activity. A row opens the
//               same detail (a closed deal read-only); a booking row opens the booking
//   ＋ Add a deal  a deal she never emailed about (the contract sheet)
//
// Every field is derived on the server; no email text. Pull to refresh. While the server's DEALS_SEARCH is off the
// search answers 404: one plain line says search isn't on yet.
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, FlatList, SafeAreaView, StatusBar, ActivityIndicator, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute } from "@react-navigation/native";
import { StackHeader } from "../components/ui/StackHeader";
import { LogoMark } from "../components/ui/LogoMark";
import { Chip, Button } from "../components/ui";
import { usePullRefresh, pullRefresh } from "../components/ui/PullRefresh";
import { ChoiceChip, ChipRow, TopTabs } from "../components/deals/ChoiceChip";
import { AddContractSheet } from "../components/deals/AddContractSheet";
import { useBookingSearch, useDealSearch, type BookingSearchRow, type DealSearchRow, type SearchTab } from "../hooks/use-deal-search";
import { bookingRowLine, cappedLine, closedHint, dealRowLogo, dealRowStatus, onlyNotADeal, SEARCH_TABS } from "../components/opps/searchLogic";
import { openBookingDetail } from "../navigation/bookingsNav";
import { BOOKINGS, MILA_CARDS_V2 } from "../lib/flags";
import { DealRow as KitDealRow } from "../components/mila/cards/kit/DealRowCard";
import { Bold, BoldType } from "../constants/theme";
import { haptics } from "../lib/haptics";
import { OPPS_LABEL } from "../lib/flags";

type Mode = "deals" | "bookings";

/** Wait for her to stop typing before asking the server. */
function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

function DealRow({ r, onPress }: { r: DealSearchRow; onPress: () => void }) {
  const logo = dealRowLogo(r);
  const status = dealRowStatus(r);
  // The card system v2 (EXPO_PUBLIC_MILA_CARDS_V2, decision 15): the shared row card's anatomy, without buttons — the
  // logo tile, where it stands as the meta, brand + money as the headline, the type and the ask under it.
  if (MILA_CARDS_V2) {
    // "via" (an agency) stays visible, as on today's row; the logo is the brand's own.
    const sub = [r.via ? `via ${r.via}` : null, r.type_label && !sameWords(r.money, r.type_label) ? r.type_label : null, r.ask ? `Asked: ${r.ask}` : null].filter(Boolean).join(" · ");
    return (
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${r.brand.name}${r.via ? `, via ${r.via}` : ""}. ${r.money}. ${r.type_label ?? ""} ${status}`}
        style={({ pressed }) => [styles.kitRow, pressed && styles.pressed]} testID={`all-deals-row-${r.opportunity_id}`}>
        <KitDealRow brand={{ name: r.brand.name, logoUrl: logo.logoUrl, domain: logo.domain, isPerson: false }}
          meta={status} headline={`${r.brand.name} · ${r.money}`} sub={sub || null} />
      </Pressable>
    );
  }
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${r.brand.name}. ${r.money}. ${r.type_label ?? ""} ${status}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]} testID={`all-deals-row-${r.opportunity_id}`}>
      <LogoMark bold logoUrl={logo.logoUrl} domain={logo.domain} name={r.brand.name} size={40} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{r.via ? `${r.brand.name} · via ${r.via}` : r.brand.name}</Text>
        <Text style={styles.rowMeta} numberOfLines={2}>{r.ask ? `Asked: ${r.ask}` : r.money}</Text>
        {r.ask ? <Text style={styles.rowMeta} numberOfLines={1}>{r.money}</Text> : null}
        <View style={styles.rowFoot}>
          {/* The type chip is dropped when the money line already says it ("No fee yet — ask…" + "NO FEE YET"). */}
          {r.type_label && !sameWords(r.money, r.type_label) ? <Chip bold="dark">{r.type_label}</Chip> : null}
          <Text style={styles.rowStatus} numberOfLines={1}>{status}</Text>
        </View>
      </View>
      <Feather name="chevron-right" size={18} color={Bold.quiet} />
    </Pressable>
  );
}

/** True when `line` already starts with `label` (case and punctuation aside). Pure. */
export function sameWords(line: string | null | undefined, label: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return !!line && norm(line).startsWith(norm(label));
}

function BookingRow({ r, onPress }: { r: BookingSearchRow; onPress?: () => void }) {
  const line = bookingRowLine(r);
  const waiting = r.status === "requested";
  const body = (
    <>
      <View style={styles.tile}><Feather name="calendar" size={18} color={Bold.onDark} /></View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{`${r.title} · ${r.buyer}`}</Text>
        <Text style={styles.rowMeta} numberOfLines={1}>{line}</Text>
        <View style={styles.rowFoot}>
          {waiting ? <Chip bold="blue">{r.status_label}</Chip> : <Text style={styles.rowStatus}>{r.status_label}</Text>}
        </View>
      </View>
      {onPress ? <Feather name="chevron-right" size={18} color={Bold.quiet} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.row} accessibilityLabel={`${r.title}. ${r.buyer}. ${line}. ${r.status_label}`}>{body}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${r.title}. ${r.buyer}. ${line}. ${r.status_label}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]} testID={`all-bookings-row-${r.id}`}>
      {body}
    </Pressable>
  );
}

export function AllDealsScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const mode: Mode = route.params?.mode === "bookings" ? "bookings" : "deals";
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<SearchTab>(route.params?.tab ?? "active");
  const [filter, setFilter] = useState<string | null>(null);
  const [notADeal, setNotADeal] = useState<boolean>(!!route.params?.notADeal);
  const [adding, setAdding] = useState(false);
  const query = useDebounced(q);

  const deals = useDealSearch(query, tab, notADeal ? null : filter, mode === "deals");
  const bookings = useBookingSearch(query, tab, filter, mode === "bookings");
  const active = mode === "deals" ? deals : bookings;
  const pull = usePullRefresh(() => active.refetch());

  const switchTab = (t: SearchTab) => { setTab(t); setFilter(null); if (t !== "closed") setNotADeal(false); };

  const dealRows = useMemo(() => {
    const rows = deals.data?.rows ?? [];
    return notADeal ? onlyNotADeal(rows) : rows;
  }, [deals.data, notADeal]);

  const res = active.data;
  const off = !active.isLoading && res === null;
  const tabs = SEARCH_TABS.map((t) => ({ ...t, count: res ? res.tabs[t.key] : null }));
  const title = mode === "deals" ? "All deals" : "All bookings";
  const placeholder = mode === "deals" ? "Search brand, agency, type, amount…" : "Search who booked, offer, date…";

  const header = (
    <View style={styles.head}>
      <View style={styles.titleRow}>
        <Text style={styles.title} accessibilityRole="header">{title}</Text>
        {mode === "deals" ? (
          <Button bold="small" onPress={() => { haptics.tap(); setAdding(true); }} icon={<Feather name="plus" size={14} color={Bold.ink} />}
            accessibilityLabel="Add a deal" testID="all-deals-add">Add a deal</Button>
        ) : null}
      </View>
      <View style={styles.search}>
        <Feather name="search" size={18} color={Bold.mute} />
        <TextInput
          style={styles.input}
          value={q}
          onChangeText={setQ}
          placeholder={placeholder}
          placeholderTextColor={Bold.quiet}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={`Search ${title.toLowerCase()}`}
          testID="all-deals-search"
        />
        {q ? (
          <Pressable onPress={() => setQ("")} hitSlop={12} accessibilityRole="button" accessibilityLabel="Clear search">
            <Feather name="x" size={18} color={Bold.mute} />
          </Pressable>
        ) : null}
      </View>
      <TopTabs tabs={tabs} active={tab} onChange={switchTab} testID="all-deals-tabs" />
      {mode === "deals" && deals.data ? (
        <ChipRow>
          <ChoiceChip selected={!filter && !notADeal} onPress={() => { setFilter(null); setNotADeal(false); }} count={deals.data.tabs[tab]} testID="all-deals-type-all">All</ChoiceChip>
          {deals.data.types.map((t) => (
            <ChoiceChip key={t.type} selected={!notADeal && filter === t.type} onPress={() => { setNotADeal(false); setFilter(t.type); }} count={t.count} testID={`all-deals-type-${t.type}`}>{t.label}</ChoiceChip>
          ))}
          {tab === "closed" && deals.data.not_a_deal > 0 ? (
            <ChoiceChip selected={notADeal} onPress={() => { setFilter(null); setNotADeal(true); }} count={deals.data.not_a_deal} testID="all-deals-not-a-deal">Not a deal</ChoiceChip>
          ) : null}
        </ChipRow>
      ) : null}
      {mode === "bookings" && bookings.data && bookings.data.formats.length > 1 ? (
        <ChipRow>
          <ChoiceChip selected={!filter} onPress={() => setFilter(null)} count={bookings.data.tabs[tab]}>All</ChoiceChip>
          {bookings.data.formats.map((f) => (
            <ChoiceChip key={f.format} selected={filter === f.format} onPress={() => setFilter(f.format)} count={f.count}>{f.label}</ChoiceChip>
          ))}
        </ChipRow>
      ) : null}
      {mode === "deals" && deals.data ? (() => {
        const hint = closedHint(deals.data, deals.data.tab === "active" ? null : deals.data.not_a_deal);
        return hint ? <Text style={styles.caption}>{hint}</Text> : null;
      })() : null}
    </View>
  );

  const empty = active.isLoading ? (
    <View style={styles.center}><ActivityIndicator color={Bold.ink} /></View>
  ) : active.isError ? (
    <View style={styles.center}>
      <Text style={styles.muted}>Couldn’t search right now.</Text>
      <Pressable onPress={() => active.refetch()} hitSlop={12} accessibilityRole="button"><Text style={styles.link}>Try again</Text></Pressable>
    </View>
  ) : off ? (
    <View style={styles.center}><Text style={styles.muted}>Search isn’t on yet. Your deals are on the board.</Text></View>
  ) : (
    <View style={styles.center}><Text style={styles.muted}>{q.trim() ? `Nothing matches “${q.trim()}” here.` : "Nothing here yet."}</Text></View>
  );

  const capped = res ? cappedLine(res.total, res.rows.length) : null;

  return (
    <SafeAreaView style={styles.root} testID="all-deals">
      <StatusBar barStyle="dark-content" />
      <StackHeader title={OPPS_LABEL} bold onBack={() => navigation.goBack()} />
      {mode === "deals" ? (
        <FlatList
          data={dealRows}
          keyExtractor={(r) => r.opportunity_id}
          renderItem={({ item }) => (
            <DealRow r={item} onPress={() => navigation.navigate("OpportunityDetail", { opportunityId: item.opportunity_id })} />
          )}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={capped ? <Text style={[styles.caption, styles.foot]}>{capped}</Text> : null}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={pullRefresh(pull)}
        />
      ) : (
        <FlatList
          data={bookings.data?.rows ?? []}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <BookingRow r={item} onPress={BOOKINGS ? () => openBookingDetail(navigation, item.id) : undefined} />}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
          ListFooterComponent={capped ? <Text style={[styles.caption, styles.foot]}>{capped}</Text> : null}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={pullRefresh(pull)}
        />
      )}
      {mode === "deals" ? (
        <AddContractSheet visible={adding} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); void deals.refetch(); }} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:      { flex: 1, backgroundColor: Bold.paper },
  list:      { paddingHorizontal: Bold.gutter, paddingBottom: 48 },
  head:      { gap: 12, paddingBottom: 8 },
  titleRow:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title:     { ...BoldType.screenTitleSm, color: Bold.ink, flexShrink: 1 },
  search:    { flexDirection: "row", alignItems: "center", gap: 10, height: 48, paddingHorizontal: 12, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, backgroundColor: Bold.paper },
  input:     { flex: 1, ...BoldType.body, color: Bold.ink, height: 46 },
  row:       { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  pressed:   { backgroundColor: Bold.ground },
  kitRow:    { borderBottomWidth: 1, borderBottomColor: Bold.line },
  tile:      { width: 40, height: 40, borderRadius: Bold.radius.control, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  rowText:   { flex: 1, minWidth: 0, gap: 3 },
  rowTitle:  { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:   { ...BoldType.rowMeta, color: Bold.ink2 },
  rowFoot:   { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 2 },
  rowStatus: { ...BoldType.caption, color: Bold.mute, flexShrink: 1 },
  caption:   { ...BoldType.caption, color: Bold.mute },
  foot:      { paddingTop: 12 },
  center:    { alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 48 },
  muted:     { ...BoldType.lede, color: Bold.mute, textAlign: "center" },
  link:      { ...BoldType.link, color: Bold.blue },
});
