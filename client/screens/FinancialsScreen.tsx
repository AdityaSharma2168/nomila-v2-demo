// Financials — her money in one place (app layout B, agreed 8 Oct 2026). Pushed inside the Opportunities tab from the
// money strip ("‹ OPPORTUNITIES") and from Home's money rows. Read from GET /api/v1/me/financials (shared/meSummaries
// FinancialSummary); nothing on this screen spends, refunds or releases money.
//
//   the block       the screen's ONE black block: "Coming to you" and the amount, "$1,200 paid in Oct · $4,900 this year"
//   Payouts         upcoming (where each stands) then paid, newest first — a deal's row opens that deal
//   Holds           a brand's refundable seriousness hold, in progress — opens the deal
//   Refunds         this year's count, then each refund — opens the deal
//   Payout account  her Stripe Connect state: "Payouts on" · "Finishing setup" · "Not set up"; "Set up payouts" is her
//                   tap → POST /me/connect/onboard → Stripe's hosted page (it moves no money)
//
// Loading: a spinner. Error: one line and Try again. No money yet: one line saying where it will show.

import React, { useState } from "react";
import { View, Text, ScrollView, SafeAreaView, StatusBar, Pressable, StyleSheet, ActivityIndicator, Linking } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { MoneyLine } from "../../shared/meSummaries";
import { useFinancials, startPayoutSetup } from "../hooks/use-financials";
import { FIN_COPY, accountLine, paidLine, shortDate, stageLine } from "../lib/financialsLogic";
import { money } from "../lib/whatMattersNext";
import { Button, Card, IconTile, LinkText, SectionHead, StackHeader, useReducedMotion } from "../components/ui";
import { usePullRefresh, pullRefresh } from "../components/ui/PullRefresh";
import { Bold, BoldType } from "../constants/theme";

type Nav = { navigate: (screen: string, params?: object) => void };

function MoneyRow({ line, meta, onPress, last }: { line: MoneyLine; meta: string; onPress?: () => void; last: boolean }) {
  const reduced = useReducedMotion();
  const label = line.label || (line.source === "booking" ? "A booking" : "A deal");
  const body = (
    <>
      <IconTile bold="black" icon={line.source === "booking" ? "calendar" : "briefcase"} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{label}</Text>
        <Text style={styles.rowMeta} numberOfLines={2}>{meta}</Text>
      </View>
      <Text style={styles.amount}>{money(line.amountCents, line.currency)}</Text>
      {onPress ? <Feather name="chevron-right" size={18} color={Bold.quiet} /> : null}
    </>
  );
  const a11y = `${label}. ${meta}. ${money(line.amountCents, line.currency)}`;
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y} testID={`fin-row-${line.id}`}
      style={({ pressed }) => [styles.row, last && styles.rowLast, pressed && styles.rowPressed, pressed && !reduced && styles.pressed]}>
      {body}
    </Pressable>
  ) : (
    <View style={[styles.row, last && styles.rowLast]} accessibilityLabel={a11y} testID={`fin-row-${line.id}`}>{body}</View>
  );
}

export function FinancialsScreen({ now = new Date() }: { now?: Date } = {}) {
  const navigation = useNavigation<Nav>();
  const fin = useFinancials();
  const f = fin.data;
  const pull = usePullRefresh(() => fin.refetch());
  const [setupError, setSetupError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  // A deal's money opens that deal (Opportunities › Deal); a booking has no detail screen yet, so its row only reads.
  const openFor = (l: MoneyLine) => (l.dealId ? () => navigation.navigate("DealDetail", { dealId: l.dealId }) : undefined);
  const onSetUp = async () => {
    setSetupError(null); setOpening(true);
    try { await Linking.openURL(await startPayoutSetup()); } catch { setSetupError(FIN_COPY.setUpError); } finally { setOpening(false); }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <StackHeader bold title={FIN_COPY.back} />
      <ScrollView contentContainerStyle={styles.content} refreshControl={pullRefresh(pull)} testID="financials">
        <Text style={styles.title} accessibilityRole="header">{FIN_COPY.title}</Text>

        {fin.isLoading ? (
          <View style={styles.state} testID="financials-loading"><ActivityIndicator color={Bold.ink} /></View>
        ) : fin.isError || !f ? (
          <View style={styles.state} testID="financials-error">
            <Text style={styles.stateText}>{FIN_COPY.error}</Text>
            <LinkText onPress={() => { void fin.refetch(); }}>Try again</LinkText>
          </View>
        ) : (
          <>
            {/* ── the one black block ── */}
            <View style={styles.block} testID="financials-block" accessibilityLabel={`${FIN_COPY.coming}: ${money(f.comingCents, f.currency)}`}>
              <Text style={styles.blockLabel}>{FIN_COPY.coming}</Text>
              <Text style={styles.blockNumber}>{money(f.comingCents, f.currency)}</Text>
              {paidLine(f, now) ? <Text style={styles.blockLine}>{paidLine(f, now)}</Text> : null}
            </View>

            {!f.hasMoney ? (
              <Card bold style={styles.card} testID="financials-empty">
                <View style={[styles.row, styles.rowLast]}>
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{FIN_COPY.nothing}</Text>
                    <Text style={styles.rowMeta}>{FIN_COPY.nothingLine}</Text>
                  </View>
                </View>
              </Card>
            ) : null}

            {f.payouts.upcoming.length + f.payouts.paid.length > 0 ? (
              <View style={styles.section} testID="financials-payouts">
                <SectionHead title={FIN_COPY.payouts} />
                <Card bold>
                  {[...f.payouts.upcoming.map((l) => ({ l, meta: stageLine(l.stage) })), ...f.payouts.paid.map((l) => ({ l, meta: `${l.direct ? "Paid by them directly" : "Paid"} ${shortDate(l.at)}` }))].map(({ l, meta }, i, all) => (
                    <MoneyRow key={l.id} line={l} meta={meta} onPress={openFor(l)} last={i === all.length - 1} />
                  ))}
                </Card>
              </View>
            ) : null}

            {f.holds.length ? (
              <View style={styles.section} testID="financials-holds">
                <SectionHead title={FIN_COPY.holds} />
                <Card bold>
                  {f.holds.map((l, i) => <MoneyRow key={l.id} line={l} meta={FIN_COPY.holdLine} onPress={openFor(l)} last={i === f.holds.length - 1} />)}
                </Card>
              </View>
            ) : null}

            {f.refunds.items.length ? (
              <View style={styles.section} testID="financials-refunds">
                <SectionHead title={FIN_COPY.refunds} sub={`${f.refunds.countYear} this year`} />
                <Card bold>
                  {f.refunds.items.map((l, i) => <MoneyRow key={l.id} line={l} meta={`Refunded ${shortDate(l.at)}`} onPress={openFor(l)} last={i === f.refunds.items.length - 1} />)}
                </Card>
              </View>
            ) : null}

            {/* ── payout account: always, so she can set it up before her first payout ── */}
            <View style={styles.section} testID="financials-account">
              <SectionHead title={FIN_COPY.account} />
              <Card bold>
                {(() => {
                  const a = accountLine(f.account);
                  return (
                    <View style={[styles.row, styles.rowLast, styles.accountRow]}>
                      <IconTile bold="black" icon="credit-card" />
                      <View style={styles.rowText}>
                        <Text style={styles.rowTitle}>{`Stripe · ${a.title}`}</Text>
                        <Text style={styles.rowMeta}>{a.line}</Text>
                        {a.action ? (
                          <Button bold="small" onPress={onSetUp} disabled={opening} loading={opening} style={styles.setUp} accessibilityLabel={a.action}>{a.action}</Button>
                        ) : null}
                        {setupError ? <Text style={styles.error}>{setupError}</Text> : null}
                      </View>
                    </View>
                  );
                })()}
              </Card>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: Bold.paper },
  content:     { paddingHorizontal: Bold.gutter, paddingBottom: 48, gap: 16 },
  title:       { ...BoldType.screenTitleSm, color: Bold.ink },
  state:       { paddingVertical: 24, gap: 8, alignItems: "flex-start" },
  stateText:   { ...BoldType.body, color: Bold.ink2 },
  block:       { backgroundColor: Bold.ink, borderRadius: Bold.radius.card, padding: 16, gap: 4 },
  blockLabel:  { ...BoldType.label, color: Bold.onDarkLabel },
  blockNumber: { ...BoldType.bigNumber, color: Bold.onDark },
  blockLine:   { ...BoldType.read, color: Bold.onDarkSoft },
  card:        {},
  section:     { gap: 10 },
  row:         { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line },
  rowLast:     { borderBottomWidth: 0 },
  rowPressed:  { backgroundColor: Bold.ground },
  pressed:     { transform: [{ scale: Bold.pressScale }] },
  rowText:     { flex: 1, minWidth: 0, gap: 2 },
  rowTitle:    { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:     { ...BoldType.rowMeta, color: Bold.mute },
  amount:      { ...BoldType.h4, color: Bold.ink },
  accountRow:  { alignItems: "flex-start" },
  setUp:       { alignSelf: "flex-start", marginTop: 8 },
  error:       { ...BoldType.caption, color: Bold.ink2, marginTop: 6 },
});
