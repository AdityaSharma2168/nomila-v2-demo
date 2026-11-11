// RequestCard — a booking request decided ON the card (the one look + "Fewer taps", owner-approved 22 Oct 2026):
// Accept · Suggest a time (three time chips; the chip tap sends) · Decline (a reason chip). Each answer shows at once
// with a 10-second Undo; the request only goes out when the window closes (lib/lookLogic.withUndo), so Undo never has
// to reverse a capture or a message. The athlete sees only "You get" — never the fan's total.
// Tapping the card opens the same decisions in a sheet with the fan's message (RequestSheet).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { LookButton, LookCard, LookChip, LookSheet, SuggestedTimeChips } from "../look";
import { Look, useLook } from "../../constants/theme";
import { alternativeTimes, withUndo, type OpenTime } from "../../lib/lookLogic";
import { FORMAT_LABEL, checkBadges, fmtWhen, partyTag, respondChip, usd, whenLine } from "../../lib/bookingsLogic";
import { useBooking, useBookingAction } from "../../hooks/use-bookings";
import type { BookingListItemView } from "../../lib/bookingsTypes";

export type RequestAnswer = { kind: "accept"; start?: string } | { kind: "propose"; time: string } | { kind: "decline"; reason: DeclineReason };
export type DeclineReason = "time" | "fit" | "felt_off";
export const DECLINE_REASONS: Array<{ key: DeclineReason; label: string }> = [
  { key: "time", label: "That time doesn't work" },
  { key: "fit", label: "Not the right fit" },
  { key: "felt_off", label: "Something felt off" },
];

/** What the toast says while the Undo window is open. */
export function answerToast(a: RequestAnswer, first: string): string {
  if (a.kind === "accept") return `Accepted · ${first} is booked`;
  if (a.kind === "propose") return `Offered ${fmtWhen(a.time)} to ${first}`;
  return `Declined · ${first}'s hold is released`;
}

export function RequestCard({ b, openTimes, onAnswered, onToast, now = new Date() }: {
  b: BookingListItemView;
  /** The athlete's open times for this session (for the suggested alternatives). */
  openTimes: OpenTime[];
  onAnswered: () => void;
  /** Show (or hide with null) the screen's Undo toast. */
  onToast: (t: { text: string; undo: () => void } | null) => void;
  now?: Date;
}) {
  const L = useLook();
  const act = useBookingAction(b.id);
  const [mode, setMode] = useState<Mode>("idle");
  const [sent, setSent] = useState<RequestAnswer | null>(null);
  const [sheet, setSheet] = useState(false);
  const pending = useRef<ReturnType<typeof withUndo> | null>(null);
  const first = b.buyerLabel.split(" ")[0] || b.buyerLabel;
  const requested = b.startsAt ?? b.proposedTimes[0]?.start ?? null;
  const alternatives = useMemo(() => alternativeTimes(requested, openTimes, now).map((startsAt) => ({ startsAt })), [requested, openTimes, now]);
  const chip = respondChip(b.respondBy, now);

  // Leaving the screen inside the window still sends the answer (Undo is for a slip, not a way to lose a reply).
  useEffect(() => () => { pending.current?.flush(); }, []);

  function answer(a: RequestAnswer) {
    setSent(a); setMode("idle"); setSheet(false);
    const u = withUndo(() => {
      const input = a.kind === "accept" ? { action: "accept" as const, ...(a.start ? { start: a.start } : {}) }
        : a.kind === "propose" ? { action: "propose" as const, times: [a.time] }
        : { action: "decline" as const, reason: a.reason };
      act.mutate(input as never, { onSettled: () => { pending.current = null; onAnswered(); } });
      onToast(null);
    }, Look.undoMs);
    pending.current = u;
    onToast({ text: answerToast(a, first), undo: () => { if (u.undo()) { pending.current = null; setSent(null); onToast(null); } } });
  }

  const body = (
    <>
      <View style={s.head}>
        <View style={[s.avatar, { backgroundColor: L.actTint }]}><Text style={[Look.type.bodyStrong, { color: L.actTintInk }]}>{first.slice(0, 1).toUpperCase()}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={[Look.type.bodyStrong, { color: L.ink }]} numberOfLines={2}>{first} wants a {FORMAT_LABEL[b.format].toLowerCase()}</Text>
          <Text style={[Look.type.meta, { color: L.ink2 }]} numberOfLines={1}>{whenLine(b)}{partyTag(b)}</Text>
          {checkBadges(b.checks).length ? <Text style={[Look.type.meta, { color: L.green }]} numberOfLines={1}>{checkBadges(b.checks).join(" · ")}</Text> : null}
        </View>
        {chip ? <LookChip tone="act">{chip}</LookChip> : null}
      </View>
      <View style={[s.getPanel, { backgroundColor: L.greenTint }]}>
        <Text style={[Look.type.bodyStrong, { color: L.green }]}>You get {usd(b.receiveCents)}</Text>
        <Text style={[Look.type.meta, { color: L.ink2 }]}>Their card is held · charged only if you accept</Text>
      </View>
    </>
  );

  if (sent) {
    return (
      <LookCard testID={`request-${b.id}`}>
        {body}
        <Text style={[Look.type.bodyStrong, { color: L.ink, marginTop: 12 }]} testID={`request-${b.id}-sent`}>{answerToast(sent, first)}</Text>
      </LookCard>
    );
  }

  return (
    <>
      <LookCard testID={`request-${b.id}-card`}>
        {/* The card's own content opens the sheet; the decision buttons stay separate targets (never a button inside a button). */}
        <Pressable onPress={() => setSheet(true)} testID={`request-${b.id}`} accessibilityRole="button" accessibilityLabel={`${first}'s request, ${whenLine(b)}`}>
          {body}
        </Pressable>
        <Decisions suggest={b.audience !== "open_group"} mode={mode} setMode={setMode} alternatives={alternatives} theirTimes={b.startsAt ? [] : b.proposedTimes.map((p) => ({ startsAt: p.start }))} onAnswer={answer} busy={act.isPending} testPrefix={`request-${b.id}`} />
      </LookCard>
      {sheet ? <RequestSheet id={b.id} first={first} b={b} alternatives={alternatives} onClose={() => setSheet(false)} onAnswer={answer} /> : null}
    </>
  );
}

type Mode = "idle" | "suggest" | "decline" | "pick";
function Decisions({ suggest = true, mode, setMode, alternatives, theirTimes, onAnswer, busy, testPrefix }: {
  /** An open-group spot she approves (0154) is at the time she set: no "Suggest a time". */
  suggest?: boolean; mode: Mode; setMode: (m: Mode) => void; alternatives: OpenTime[];
  /** The fan suggested several times (no fixed start): Accept first asks which one. */
  theirTimes: OpenTime[]; onAnswer: (a: RequestAnswer) => void; busy: boolean; testPrefix: string;
}) {
  const L = useLook();
  if (mode === "pick") {
    return (
      <View style={s.block}>
        <SuggestedTimeChips label="Accept one of their times" times={theirTimes} format={fmtWhen} onPick={(t) => onAnswer({ kind: "accept", start: t.startsAt })} testID={`${testPrefix}-their-times`} />
        <LookButton kind="ghost" small onPress={() => setMode("idle")}>Back</LookButton>
      </View>
    );
  }
  if (mode === "suggest") {
    return (
      <View style={s.block}>
        <SuggestedTimeChips label="Or offer one of these" times={alternatives} format={fmtWhen} onPick={(t) => onAnswer({ kind: "propose", time: t.startsAt })} testID={`${testPrefix}-times`} />
        <LookButton kind="ghost" small onPress={() => setMode("idle")}>Back</LookButton>
      </View>
    );
  }
  if (mode === "decline") {
    return (
      <View style={s.block}>
        <Text style={[Look.type.label, { color: L.ink2 }]}>Pick a reason · the fan sees a kind version</Text>
        <View style={s.wrap}>
          {DECLINE_REASONS.map((r) => <LookChip key={r.key} onPress={() => onAnswer({ kind: "decline", reason: r.key })} testID={`${testPrefix}-reason-${r.key}`}>{r.label}</LookChip>)}
        </View>
        <LookButton kind="ghost" small onPress={() => setMode("idle")}>Back</LookButton>
      </View>
    );
  }
  return (
    <View style={s.actions}>
      <LookButton onPress={() => theirTimes.length > 1 ? setMode("pick") : onAnswer({ kind: "accept", start: theirTimes[0]?.startsAt })} loading={busy} style={s.grow} testID={`${testPrefix}-accept`}>Accept</LookButton>
      {suggest ? <LookButton kind="secondary" onPress={() => setMode("suggest")} style={s.grow} testID={`${testPrefix}-suggest`}>Suggest a time</LookButton> : null}
      <LookButton kind="ghost" onPress={() => setMode("decline")} testID={`${testPrefix}-decline`}>Decline</LookButton>
    </View>
  );
}

export function RequestSheet({ id, first, b, alternatives, onClose, onAnswer }: {
  id: string; first: string; b: BookingListItemView; alternatives: OpenTime[]; onClose: () => void; onAnswer: (a: RequestAnswer) => void;
}) {
  const L = useLook();
  const detail = useBooking(id);
  const d = detail.data;
  const [mode, setMode] = useState<Mode>("idle");
  return (
    <LookSheet visible onClose={onClose} title={`${first} wants a ${FORMAT_LABEL[b.format].toLowerCase()}`} sub={d ? `Asked ${fmtWhen(d.createdAt)}` : undefined} testID={`request-sheet-${id}`}>
      {d?.buyerMessage ? <Text style={[Look.type.body, { color: L.ink, fontStyle: "italic" }]}>“{d.buyerMessage}”</Text> : null}
      <View style={[s.facts, { borderColor: L.line }]}>
        <Fact k="Session" v={b.title} />
        <Fact k="When" v={whenLine(b)} />
        {d?.minorFirstName ? <Fact k="Attending" v={`${d.minorFirstName}, with a parent present`} /> : null}
      </View>
      <View style={[s.getPanel, { backgroundColor: L.greenTint }]}>
        <Text style={[Look.type.money, { color: L.green }]}>You get {usd(b.receiveCents)}</Text>
        <Text style={[Look.type.meta, { color: L.ink2 }]}>Paid out after the call</Text>
      </View>
      <Decisions suggest={b.audience !== "open_group"} mode={mode} setMode={setMode} alternatives={alternatives} theirTimes={b.startsAt ? [] : b.proposedTimes.map((p) => ({ startsAt: p.start }))} onAnswer={onAnswer} busy={false} testPrefix={`request-sheet-${id}`} />
    </LookSheet>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  const L = useLook();
  return (
    <View style={s.fact}>
      <Text style={[Look.type.meta, { color: L.ink2, width: 84 }]}>{k}</Text>
      <Text style={[Look.type.bodyStrong, { color: L.ink, flex: 1 }]}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  head:     { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar:   { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  getPanel: { marginTop: 12, borderRadius: Look.radius.tile, padding: 12, gap: 2 },
  actions:  { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" },
  grow:     { flexGrow: 1 },
  block:    { marginTop: 14, gap: 10 },
  wrap:     { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  facts:    { borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 8, gap: 6 },
  fact:     { flexDirection: "row", gap: 8 },
});
