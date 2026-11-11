// The small pieces her Bookings screens share (look B, DESIGN.md): the confirm sheet every buyer-reaching or
// money-moving tap goes through, a booking row, the payout-setup black block, the top tabs, and the loading / error /
// empty lines.
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Button, Chip, Sheet } from "../ui";
import { Bold, BoldType, Look, useLook } from "../../constants/theme";
import { LookButton, LookChip } from "../look";
import { haptics } from "../../lib/haptics";
import { bookingRefusal, useStartPayouts } from "../../hooks/use-bookings";
import type { BookingListItemView, GroupSessionListItemView, PayoutStatusView } from "../../lib/bookingsTypes";
import { BOOKINGS_COPY, checkBadges, groupCardLine, groupPhaseLine, namesLine, partyTag, payoutNeedsLine, phaseLine, respondChip, setupRefusalText, whenLine } from "../../lib/bookingsLogic";

/**
 * The confirm sheet (tap-to-send): nothing reaches the buyer or moves money until she taps the black button here.
 * The secondary button only closes. An error stays on the sheet in the server's own words.
 */
export function ConfirmSheet({ title, children, confirm, onConfirm, busy, error, cancelLabel = "Back", onClose, testID }: {
  title: string; children?: React.ReactNode; confirm: string; onConfirm: () => void; busy?: boolean; error?: string | null;
  cancelLabel?: string; onClose: () => void; testID?: string;
}) {
  return (
    <Sheet onClose={onClose} title={title} keyboard>
      <View style={styles.sheetBody} testID={testID}>
        {children}
        {error ? <Text style={styles.errorLine} testID={testID ? `${testID}-error` : undefined}>{error}</Text> : null}
        <Button bold="primary" onPress={onConfirm} loading={busy} testID={testID ? `${testID}-confirm` : undefined}>{confirm}</Button>
        <Button bold="secondary" onPress={onClose} disabled={busy} testID={testID ? `${testID}-back` : undefined}>{cancelLabel}</Button>
      </View>
    </Sheet>
  );
}

/** A server refusal in plain words for a sheet ("Couldn't …" when it's not one the server explained). */
export function refusalLine(err: unknown, fallback: string): string {
  const r = bookingRefusal(err);
  return r?.error && r.status < 500 ? r.error.charAt(0).toUpperCase() + r.error.slice(1) : fallback;
}

/** The new-session sheet's refusal line: the server's own reason spelled out (it has no fields to highlight). */
export function setupRefusalLine(err: unknown): string {
  return setupRefusalText(bookingRefusal(err));
}

function initials(label: string): string {
  const parts = label.replace(/\./g, "").split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "·";
}

/** One request or booking in a list: who, what and when, what was checked, and the deadline when it waits on them. */
export function BookingRow({ b, onPress, last, now = new Date() }: { b: BookingListItemView; onPress: () => void; last?: boolean; now?: Date }) {
  const L = useLook();
  const waiting = b.phase === "request";
  const chip = waiting ? respondChip(b.respondBy, now) : null;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, !last && { borderBottomWidth: 1, borderBottomColor: L.line }, pressed && styles.pressed]}
      onPress={() => { haptics.tap(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={`${b.buyerLabel}, ${b.title}, ${phaseLine(b)}`}
      testID={`booking-row-${b.id}`}
    >
      <View style={[styles.initials, { backgroundColor: L.actTint }]}><Text style={[Look.type.bodyStrong, { color: L.actTintInk }]}>{initials(b.buyerLabel)}</Text></View>
      <View style={styles.rowText}>
        <Text style={[Look.type.bodyStrong, { color: L.ink }]} numberOfLines={1}>{b.buyerLabel}{b.checks.parent ? " · parent" : ""}</Text>
        <Text style={[Look.type.meta, { color: L.ink2 }]} numberOfLines={1}>{b.title}{partyTag(b)} · {whenLine(b)}</Text>
        <View style={styles.badges}>
          {waiting ? checkBadges(b.checks).map((t) => <LookChip key={t} tone="green">{t}</LookChip>) : <Text style={[Look.type.meta, { color: b.phase === "paid" ? L.green : L.ink2 }]}>{phaseLine(b)}</Text>}
          {chip ? <LookChip tone="act">{chip}</LookChip> : null}
          {b.unreadMessages > 0 ? <LookChip tone="act">{b.unreadMessages === 1 ? "1 new message" : `${b.unreadMessages} new messages`}</LookChip> : null}
        </View>
      </View>
      <Feather name="chevron-right" size={20} color={L.muted} />
    </Pressable>
  );
}

/** One open-group time in a list (0153): "Group clinic · Sat 14 Nov, 10:00 am · 4 of 10 booked" and who's coming. */
export function GroupRow({ g, onPress, last }: { g: GroupSessionListItemView; onPress: () => void; last?: boolean }) {
  const L = useLook();
  const line = groupCardLine(g);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, !last && { borderBottomWidth: 1, borderBottomColor: L.line }, pressed && styles.pressed]}
      onPress={() => { haptics.tap(); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={`${g.title}, ${line}`}
      testID={`group-row-${g.slotId}`}
    >
      <View style={[styles.initials, { backgroundColor: L.actTint }]}><Feather name="users" size={18} color={L.actTintInk} /></View>
      <View style={styles.rowText}>
        <Text style={[Look.type.bodyStrong, { color: L.ink }]} numberOfLines={1}>{g.title}</Text>
        <Text style={[Look.type.meta, { color: L.ink2 }]} numberOfLines={2}>{line}</Text>
        <View style={styles.badges}>
          <Text style={[Look.type.meta, { color: L.ink2 }]} numberOfLines={1}>{g.phase === "booked" ? namesLine(g.firstNames) : `${groupPhaseLine(g.phase)} · ${namesLine(g.firstNames)}`}</Text>
        </View>
      </View>
      <Feather name="chevron-right" size={20} color={L.muted} />
    </Pressable>
  );
}

/** The dark block until Stripe can send them money: "Set up payouts" opens Stripe's own sign-up. */
export function PayoutSetupBlock({ payouts, testID = "payout-setup" }: { payouts: PayoutStatusView; testID?: string }) {
  const L = useLook();
  const start = useStartPayouts();
  const [line, setLine] = React.useState<string | null>(null);
  if (payouts.ready) return null;
  const needs = payouts.hasAccount ? payoutNeedsLine(payouts.requirementsDue) : null;
  const go = () => {
    setLine(null);
    start.mutate(undefined, {
      // Loaded on tap: the in-app browser is a native module the rest of the screen never needs.
      onSuccess: async ({ url }) => {
        try { const WebBrowser = await import("expo-web-browser"); await WebBrowser.openBrowserAsync(url); }
        catch { setLine("Couldn't open Stripe. Try again."); }
      },
      onError: () => setLine("Couldn't reach Stripe. Try again."),
    });
  };
  return (
    <View style={[styles.block, { backgroundColor: L.hero }]} testID={testID}>
      <Text style={[Look.type.label, { color: "rgba(255,255,255,0.7)" }]}>{BOOKINGS_COPY.payoutsTitle}</Text>
      <Text style={[Look.type.heading, { color: L.onHero }]}>{payouts.hasAccount ? "Stripe needs one more thing" : BOOKINGS_COPY.payoutsCta}</Text>
      <Text style={[Look.type.body, { color: "rgba(255,255,255,0.92)" }]}>{needs ?? BOOKINGS_COPY.payoutsBody}</Text>
      <LookButton onPress={go} loading={start.isPending} testID={`${testID}-cta`}>{payouts.hasAccount ? "Continue to Stripe" : BOOKINGS_COPY.payoutsCta}</LookButton>
      {line ? <Text style={[Look.type.body, { color: "rgba(255,255,255,0.92)" }]}>{line}</Text> : null}
    </View>
  );
}

/** Top tabs (Strategy's pattern): 12/800 uppercase, an ink underline on the active one, a blue count when it waits on her. */
export function TopTabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ key: T; label: string; count?: number }>; value: T; onChange: (t: T) => void }) {
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {tabs.map((t) => (
        <Pressable key={t.key} onPress={() => { haptics.select(); onChange(t.key); }} style={styles.tab} accessibilityRole="tab"
          accessibilityState={{ selected: value === t.key }} testID={`tab-${t.key}`} hitSlop={8}>
          <Text style={[styles.tabText, value === t.key && styles.tabTextOn]}>{t.label}</Text>
          {t.count ? <View style={styles.tabCount}><Text style={styles.tabCountText}>{t.count}</Text></View> : null}
          {value === t.key ? <View style={styles.tabRule} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

export function Loading({ testID = "bookings-loading" }: { testID?: string }) {
  const L = useLook();
  return (
    <View style={styles.loading} testID={testID}>
      <ActivityIndicator color={L.ink} />
      {[0, 1, 2].map((i) => <View key={i} style={[styles.skeleton, { backgroundColor: L.line }]} />)}
    </View>
  );
}

export function ErrorLine({ text, testID = "bookings-error" }: { text: string; testID?: string }) {
  const L = useLook();
  return <Text style={[Look.type.body, { color: L.ink, marginVertical: 8 }]} testID={testID}>{text}</Text>;
}

export function Empty({ title, body, action, testID }: { title: string; body: string; action?: { label: string; onPress: () => void }; testID?: string }) {
  const L = useLook();
  return (
    <View style={styles.empty} testID={testID}>
      <Text style={[Look.type.heading, { color: L.ink }]}>{title}</Text>
      <Text style={[Look.type.body, { color: L.ink2 }]}>{body}</Text>
      {action ? <LookButton kind="secondary" onPress={action.onPress} testID={testID ? `${testID}-action` : undefined}>{action.label}</LookButton> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheetBody:   { gap: 12, paddingBottom: 8 },
  errorLine:   { ...BoldType.body, color: Bold.ink, marginVertical: 8 },
  row:         { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 64, paddingVertical: 12, paddingHorizontal: 16 },
  rowLine:     { borderBottomWidth: 1, borderBottomColor: Bold.line },
  pressed:     { transform: [{ scale: Bold.pressScale }] },
  initials:    { width: 40, height: 40, borderRadius: 20, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  initialsText: { ...BoldType.rowTitle, color: Bold.ink },
  rowText:     { flex: 1, gap: 2 },
  rowTitle:    { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:     { ...BoldType.rowMeta, color: Bold.mute },
  badges:      { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  block:       { borderRadius: Look.radius.card, padding: 16, gap: 10 },
  blockEyebrow: { ...BoldType.label, color: Bold.onDarkLabel },
  blockTitle:  { ...BoldType.bannerTitle, color: Bold.onDark },
  blockBody:   { ...BoldType.lede, color: Bold.onDarkSoft },
  tabs:        { flexDirection: "row", gap: 18, borderBottomWidth: 1, borderBottomColor: Bold.line, marginBottom: 12 },
  tab:         { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 10 },
  tabText:     { ...BoldType.segment, color: Bold.quiet },
  tabTextOn:   { color: Bold.ink },
  tabRule:     { position: "absolute", left: 0, right: 0, bottom: -1, height: 3, backgroundColor: Bold.ink },
  tabCount:    { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: Bold.radius.chip, backgroundColor: Bold.blue, alignItems: "center", justifyContent: "center" },
  tabCountText: { ...BoldType.chip, color: Bold.onDark },
  loading:     { gap: 10, paddingVertical: 16 },
  skeleton:    { height: 56, borderRadius: Look.radius.tile },
  empty:       { gap: 8, paddingVertical: 24 },
  emptyTitle:  { ...BoldType.cardTitle, color: Bold.ink },
  emptyBody:   { ...BoldType.body, color: Bold.mute },
});
