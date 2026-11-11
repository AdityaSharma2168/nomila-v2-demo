// BookingDetailScreen — one request or booking across its life (booking screens design A4 + A5).
//
//   request          who and when (or the times they suggested: she picks one), their message (plain text: their words,
//                    not hers), what we checked, that it fits her rules, what she receives. Accept (black) and Decline
//                    (outlined) never fold away; both open a confirm sheet. "Suggest other times" is the third door.
//   waiting          she suggested times (the buyer picks) · the hold had lapsed (the buyer has a pay link)
//   booked           the black block: Join (the session PR's call screen, #868) or the place; Cancel opens a sheet that
//                    previews the refund and her card fee (first one free)
//   after            the session PR's after-session screen (Session done · Buyer didn't show · Report a problem)
//   money            what she'll receive and when, on hold, or paid (minus a card fee she covered)
//   messages         relayed through Nomila; the buyer never sees her email or phone; held messages say so
//   block            (0154) "Block <name>" opens a confirm sheet with the server's preview (an upcoming paid booking of
//                    theirs is cancelled with a full refund); once blocked, a quiet line says so
//
// Every tap that reaches the buyer or moves money is hers, on a confirm sheet. Mila can explain this screen; she can
// never press anything on it.
import React, { useMemo, useState } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { Feather } from "@expo/vector-icons";
import { Button, Card, RuledHead, StackHeader, pullRefresh, usePullRefresh } from "../../components/ui";
import { ConfirmSheet, ErrorLine, Loading, refusalLine } from "../../components/bookings/parts";
import { BlockSheet } from "../../components/bookings/BlockSheet";
import {
  bookingRefusal, useBooking, useBookingAction, useBookingThread, useCancelPreview, usePostMessage,
} from "../../hooks/use-bookings";
import {
  BOOKINGS_COPY, FORMAT_LABEL, dayOptions, partyTag, peopleCount, fmtDay, fmtRange, fmtWhen, startIso, timeOptions, usd, windowLabel,
} from "../../lib/bookingsLogic";
import { sessionDoors } from "../../navigation/bookingsNav";
import { haptics } from "../../lib/haptics";
import { Bold, BoldType } from "../../constants/theme";
import type { AcceptResultView, BookingDetailView, BookingMessageView } from "../../lib/bookingsTypes";

type SheetName = null | "accept" | "decline" | "propose" | "cancel" | "block";

export function BookingDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const id: string = route.params?.bookingId;
  const q = useBooking(id);
  const thread = useBookingThread(id, !!q.data?.actions.message);
  const refresh = usePullRefresh(() => Promise.all([q.refetch(), thread.refetch()]));
  const doors = sessionDoors(navigation);
  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title="Bookings" bold />
      <ScrollView contentContainerStyle={styles.content} refreshControl={pullRefresh(refresh)} keyboardShouldPersistTaps="handled" testID="booking-scroll">
        {q.isLoading ? <Loading testID="booking-loading" /> : null}
        {q.isError ? <ErrorLine text={BOOKINGS_COPY.detailError} testID="booking-error" /> : null}
        {q.data ? <Detail b={q.data} thread={thread} join={doors.join} after={doors.after} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Detail({ b, thread, join, after }: {
  b: BookingDetailView; thread: ReturnType<typeof useBookingThread>;
  join: ((id: string) => void) | null; after: ((id: string) => void) | null;
}) {
  const [sheet, setSheet] = useState<SheetName>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const name = b.buyerLabel.split(" ")[0];
  const isRequest = b.phase === "request";
  const when = b.startsAt ? fmtRange(b.startsAt, b.endsAt) : null;
  return (
    <View style={styles.stack}>
      {isRequest ? <Text style={styles.eyebrow} testID="detail-eyebrow">Request{b.respondBy ? ` · reply by ${fmtWhen(b.respondBy)}` : ""}</Text> : null}
      <Text style={styles.title}>{isRequest ? b.buyerLabel : `${FORMAT_LABEL[b.format]} with ${b.buyerLabel}`}</Text>
      <Text style={styles.meta}>{b.title}{partyTag(b)}{when ? ` · ${when}` : ""}{b.checks.parent ? ` · ${b.buyerLabel} (parent)${b.minorFirstName ? ` with ${b.minorFirstName}` : " with one under-18"}` : ""}</Text>
      {flash ? <Text style={styles.flash} testID="detail-flash">{flash}</Text> : null}

      {b.audience === "private_group" ? <PartyBlock b={b} /> : null}
      {isRequest ? <RequestBody b={b} onSheet={setSheet} /> : null}
      {b.phase === "waiting_buyer" ? (
        <Card bold testID="waiting-buyer"><View style={styles.pad}>
          <Text style={styles.body}>You suggested {b.athleteProposedTimes.map((t) => fmtWhen(t.start)).join(", ")}. {name} picks one, then you accept it here.</Text>
        </View></Card>
      ) : null}
      {b.phase === "waiting_payment" ? (
        <Card bold testID="waiting-payment"><View style={styles.pad}>
          <Text style={styles.body}>{name}{"'s card hold had ended, so we sent them a link to pay"}{b.payBy ? ` by ${fmtWhen(b.payBy)}` : ""}. The time is held for them until then.</Text>
        </View></Card>
      ) : null}
      {["booked", "happening", "finished"].includes(b.phase) ? <SessionBlock b={b} join={join} after={after} onCancel={() => setSheet("cancel")} /> : null}
      {["on_hold", "paid", "finished", "booked", "happening", "canceled", "refunded"].includes(b.phase) ? <PayoutBlock b={b} /> : null}
      {["declined", "withdrawn", "expired"].includes(b.phase) ? (
        <Text style={styles.body} testID="closed-line">{b.phase === "declined" ? `You declined. ${name} was told; their hold was released.` : b.phase === "withdrawn" ? `${name} withdrew this request.` : `This request expired. ${name} was told; their hold was released.`}</Text>
      ) : null}

      <Timeline b={b} />
      {b.actions.message ? <Thread b={b} thread={thread} /> : null}
      {b.fanBlocked ? <Text style={styles.meta} testID="detail-blocked">{`You blocked ${name}. Unblock them from Your sessions › Blocked fans.`}</Text> : null}
      {b.actions.block ? (
        <Pressable style={styles.door} onPress={() => setSheet("block")} accessibilityRole="button" testID="block-door">
          <Text style={[styles.rowTitle, styles.flex]}>{`Block ${name}`}</Text>
          <Feather name="chevron-right" size={18} color={Bold.quiet} />
        </Pressable>
      ) : null}
      <Text style={styles.caption}>Questions or safety concerns? {b.supportEmail}</Text>

      {sheet === "accept" ? <AcceptSheet b={b} onClose={() => setSheet(null)} onDone={(r) => { setSheet(null); setFlash(r.result === "confirmed" ? `Accepted. We've emailed ${name}.` : `Accepted. ${name}'s hold had ended, so we sent them a link to pay.`); }} /> : null}
      {sheet === "decline" ? <DeclineSheet b={b} onClose={() => setSheet(null)} onDone={() => { setSheet(null); setFlash(`Declined. We've let ${name} know.`); }} /> : null}
      {sheet === "propose" ? <ProposeSheet b={b} onClose={() => setSheet(null)} onDone={() => { setSheet(null); setFlash(`We've sent ${name} your times.`); }} /> : null}
      {sheet === "block" ? <BlockSheet target={{ bookingId: b.id }} name={name} onClose={() => setSheet(null)}
        onDone={(r) => { setSheet(null); setFlash(r.canceled ? `${name} is blocked. Their upcoming booking is cancelled and refunded.` : `${name} is blocked.`); }} /> : null}
      {sheet === "cancel" ? <CancelSheet b={b} onClose={() => setSheet(null)} onDone={() => { setSheet(null); setFlash(`Cancelled. ${name} gets a full refund.`); }} /> : null}
    </View>
  );
}

/** A private group: how many people the booking is for, and the friends invited so far (first names only). */
export function PartyBlock({ b }: { b: Pick<BookingDetailView, "buyerLabel" | "partySize" | "guests"> }) {
  const name = b.buyerLabel.split(" ")[0];
  const friends = (b.guests ?? []).map((g) => g.name?.trim().split(/\s+/)[0] || "A friend");
  const open = Math.max(0, b.partySize - 1 - friends.length);
  return (
    <Card bold testID="party-block"><View style={styles.pad}>
      <RuledHead title="Who's coming" />
      <Text style={styles.rowTitle} testID="party-size">{peopleCount(b.partySize)}</Text>
      <Text style={styles.body} testID="party-names">{[name, ...friends].join(", ")}</Text>
      {open > 0 ? <Text style={styles.meta}>{open === 1 ? `${name} can still invite 1 friend.` : `${name} can still invite ${open} friends.`} Each friend gets their own call link.</Text> : null}
    </View></Card>
  );
}

function RequestBody({ b, onSheet }: { b: BookingDetailView; onSheet: (s: SheetName) => void }) {
  return (
    <>
      {b.proposedTimes.length > 1 ? (
        <Card bold><View style={styles.pad}>
          <RuledHead title="Times they suggested" />
          {b.proposedTimes.map((t) => <Text key={t.start} style={styles.body}>{fmtWhen(t.start)}</Text>)}
          {b.proposedNote ? <Text style={styles.meta}>“{b.proposedNote}”</Text> : null}
        </View></Card>
      ) : null}
      {b.buyerMessage ? (
        <Card bold><View style={styles.pad}><RuledHead title="Their message" /><Text style={styles.body} testID="buyer-message">“{b.buyerMessage}”</Text></View></Card>
      ) : null}
      <Card bold testID="checks"><View style={styles.pad}>
        <RuledHead title="What we checked" />
        {b.checks.email ? <Check text="Email code confirmed" /> : null}
        {b.checks.phone ? <Check text="Phone code confirmed" /> : null}
        {b.checks.idChecked ? <Check text="ID and selfie checked by Stripe" /> : null}
        {b.checks.parent ? <Check text={`A parent booking for ${b.minorFirstName ?? "their child"}, and they'll be there`} /> : b.checks.adult ? <Check text="Said they're 18 or older" /> : null}
        <Text style={styles.label}>Fits your rules</Text>
        <Check text={b.proposedTimes.length ? "Times they suggested" : "A time you offered"} />
        <Check text={b.locationMode === "in_person" ? "In person, ID checked" : b.checks.idChecked ? "Video call, ID checked" : "Video call, no ID needed"} />
      </View></Card>
      <Card bold><View style={styles.pad}>
        <View style={styles.money}>
          <View style={styles.flex}><Text style={styles.rowTitle}>You receive</Text><Text style={styles.meta}>{"Their card is held. It's charged only if you accept."}</Text></View>
          <Text style={styles.big}>{usd(b.receiveCents)}</Text>
        </View>
      </View></Card>
      {b.actions.accept || b.actions.decline ? (
        <View style={styles.buttons}>
          {b.actions.decline ? <Button bold="secondary" onPress={() => onSheet("decline")} style={styles.flex} testID="decline">Decline</Button> : null}
          {b.actions.accept ? <Button bold="primary" onPress={() => onSheet("accept")} style={styles.flex} testID="accept">Accept</Button> : null}
        </View>
      ) : null}
      {b.actions.propose ? <Button bold="link" onPress={() => onSheet("propose")} testID="propose">Suggest other times</Button> : null}
    </>
  );
}

function Check({ text }: { text: string }) {
  return <View style={styles.check}><Feather name="check" size={16} color={Bold.ink} /><Text style={styles.body}>{text}</Text></View>;
}

function SessionBlock({ b, join, after, onCancel }: { b: BookingDetailView; join: ((id: string) => void) | null; after: ((id: string) => void) | null; onCancel: () => void }) {
  const inPerson = b.locationMode === "in_person";
  const afterOpen = b.actions.sessionDone || b.actions.noShow;
  return (
    <>
      <View style={styles.block} testID="session-block">
        <Text style={styles.blockEyebrow}>{b.phase === "happening" ? "Happening now" : b.phase === "finished" ? "Finished" : b.startsAt ? fmtDay(b.startsAt) : "Booked"}</Text>
        {inPerson ? (
          <>
            <Text style={styles.blockTitle}>{b.venue ?? "The place in your booking"}</Text>
            <Text style={styles.blockBody}>{b.startsAt ? fmtRange(b.startsAt, b.endsAt) : ""}</Text>
          </>
        ) : (
          <>
            <Text style={styles.blockTitle}>{b.startsAt ? fmtRange(b.startsAt, b.endsAt) : "Video call"}</Text>
            <Text style={styles.blockBody}>{"Join opens 10 minutes before. Nomila doesn't record calls."}{b.meetingLink ? ` Backup link: ${b.meetingLink}` : ""}</Text>
            {join && b.phase !== "finished" ? <Button bold="onHero" onPress={() => join(b.id)} testID="join">Join call</Button> : null}
          </>
        )}
        {after && (afterOpen || b.phase === "finished") ? (
          <Button bold="onHero" onPress={() => after(b.id)} testID="after-session">{b.phase === "finished" ? "Session done · Report a problem" : "Buyer didn't show · Session done"}</Button>
        ) : null}
        {b.athleteDoneAt ? <Text style={styles.blockBody}>We asked {b.buyerLabel.split(" ")[0]} to confirm.</Text> : null}
      </View>
      {b.actions.cancel ? (
        <Pressable style={styles.door} onPress={onCancel} accessibilityRole="button" testID="cancel-door">
          <Text style={[styles.rowTitle, styles.flex]}>Cancel this booking</Text>
          <Feather name="chevron-right" size={18} color={Bold.quiet} />
        </Pressable>
      ) : null}
    </>
  );
}

function PayoutBlock({ b }: { b: BookingDetailView }) {
  const p = b.payout;
  let line: string;
  if (p.state === "paid") line = `Paid to you${p.paidAt ? ` on ${fmtDay(p.paidAt)}` : ""}${p.cardFeeCents ? ` · ${usd(p.receiveCents)} − ${usd(p.cardFeeCents)} card fee` : ""}`;
  else if (p.state === "on_hold") line = "On hold. A person at Nomila is looking at a report. We'll email you.";
  else if (p.state === "refunded" || b.phase === "refunded") line = "Refunded to the buyer.";
  else if (b.phase === "canceled") line = b.canceledBy === "athlete" ? "You cancelled. The buyer gets everything back." : "They cancelled.";
  else if (p.releaseDueAt) line = `You're paid when ${b.buyerLabel.split(" ")[0]} says it happened, or on ${fmtWhen(p.releaseDueAt)} if nothing's reported.`;
  else line = `You're paid when ${b.buyerLabel.split(" ")[0]} says it happened, or 48 hours after the session.`;
  const amount = p.state === "paid" ? p.receiveCents - p.cardFeeCents : p.receiveCents;
  return (
    <Card bold testID="payout-block"><View style={styles.pad}>
      <View style={styles.money}>
        <View style={styles.flex}><Text style={styles.rowTitle}>{p.state === "paid" ? "Paid to you" : "You'll receive"}</Text><Text style={styles.meta}>{line}</Text></View>
        <Text style={styles.big}>{p.state === "refunded" || (b.phase === "canceled" && p.state === "none") ? usd(0) : usd(amount)}</Text>
      </View>
    </View></Card>
  );
}

const TIMELINE: Record<BookingDetailView["timeline"][number]["kind"], (by: string, name: string) => string> = {
  requested: (_b, n) => `${n} asked`, accepted: () => "You accepted", paid: (_b, n) => `${n}'s card was charged`,
  proposed: () => "You suggested other times", picked: (_b, n) => `${n} picked a time`, session_done: () => "You marked it done",
  no_show: (by, n) => (by === "you" ? `You marked that ${n} didn't show` : "Marked as a no-show"), reported: () => "A problem was reported",
  paid_out: () => "Paid to you", declined: () => "You declined", withdrawn: (_b, n) => `${n} withdrew`, expired: () => "Expired",
  canceled: (by) => (by === "you" ? "You cancelled" : "Cancelled"), refunded: () => "Refunded",
};

function Timeline({ b }: { b: BookingDetailView }) {
  if (!b.timeline.length) return null;
  const name = b.buyerLabel.split(" ")[0];
  return (
    <Card bold testID="timeline"><View style={styles.pad}>
      <RuledHead title="Where it's at" />
      {b.timeline.map((t, i) => (
        <View key={i} style={styles.tl}>
          <Text style={[styles.body, styles.flex]}>{TIMELINE[t.kind](t.by, name)}</Text>
          <Text style={styles.meta}>{fmtDay(t.at)}</Text>
        </View>
      ))}
    </View></Card>
  );
}

function Thread({ b, thread }: { b: BookingDetailView; thread: ReturnType<typeof useBookingThread> }) {
  const post = usePostMessage(b.id);
  const [text, setText] = useState("");
  const [line, setLine] = useState<string | null>(null);
  const name = b.buyerLabel.split(" ")[0];
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setLine(null);
    post.mutate(body, { onSuccess: () => { setText(""); haptics.success(); }, onError: (err) => setLine(refusalLine(err, "Couldn't send. Try again.")) });
  };
  return (
    <Card bold testID="thread"><View style={styles.pad}>
      <RuledHead title="Messages" />
      {thread.isLoading ? <Loading testID="thread-loading" /> : null}
      {thread.isError ? <ErrorLine text="Couldn't load messages. Pull down to try again." testID="thread-error" /> : null}
      {thread.data && thread.data.length === 0 ? <Text style={styles.meta} testID="thread-empty">No messages yet.</Text> : null}
      {thread.data?.map((m) => <Message key={m.id} m={m} name={name} />)}
      <Text style={styles.caption}>Messages go through Nomila. {name} {"doesn't see your email or phone."}</Text>
      <TextInput value={text} onChangeText={setText} placeholder={`Write to ${name}`} placeholderTextColor={Bold.quiet} multiline maxLength={2000}
        style={styles.input} accessibilityLabel={`Write to ${name}`} testID="thread-input" />
      {line ? <Text style={styles.body} testID="thread-line">{line}</Text> : null}
      <Button bold="small" onPress={send} disabled={!text.trim()} loading={post.isPending} testID="thread-send">Send</Button>
    </View></Card>
  );
}

function Message({ m, name }: { m: BookingMessageView; name: string }) {
  const who = m.from === "you" ? "You" : m.from === "nomila" ? "Nomila" : name;
  return (
    <View style={styles.msg} testID={`msg-${m.id}`}>
      <Text style={styles.label}>{who} · {fmtDay(m.at)}</Text>
      <Text style={styles.body}>{m.body}</Text>
      {m.held ? <Text style={styles.meta}>Not delivered. {m.heldReason === "contact_details" ? "It included contact details." : m.heldReason === "link" ? "It included a link." : m.heldReason === "off_platform_payment" ? "It asked to pay outside Nomila." : "It's being checked."}</Text> : null}
    </View>
  );
}

// ─── The confirm sheets (her taps) ──────────────────────────────────────────────────────────────────────────────

function AcceptSheet({ b, onClose, onDone }: { b: BookingDetailView; onClose: () => void; onDone: (r: AcceptResultView) => void }) {
  const act = useBookingAction(b.id);
  const [pick, setPick] = useState<string | null>(b.startsAt ?? (b.proposedTimes.length === 1 ? b.proposedTimes[0].start : null));
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const name = b.buyerLabel.split(" ")[0];
  const needsPick = !b.startsAt && b.proposedTimes.length > 1;
  const confirm = () => {
    if (needsPick && !pick) { setError("Pick one of the times first."); return; }
    setError(null);
    act.mutate({ action: "accept", ...(needsPick || !b.startsAt ? { start: pick ?? undefined } : {}), backupLink: link.trim() || null }, {
      onSuccess: (r) => { haptics.success(); onDone(r as AcceptResultView); },
      onError: (err) => setError(bookingRefusal(err)?.code === "CAPTURE_RETRY" ? "Couldn't accept. Nothing was sent. Try again." : refusalLine(err, "Couldn't accept. Nothing was sent. Try again.")),
    });
  };
  return (
    <ConfirmSheet title={`Accept ${name}'s request?`} confirm="Accept and charge" onConfirm={confirm} onClose={onClose} busy={act.isPending} error={error} testID="accept-sheet">
      {needsPick ? (
        <View style={styles.picks}>
          {b.proposedTimes.map((t) => (
            <Pressable key={t.start} onPress={() => setPick(t.start)} style={[styles.pick, pick === t.start && styles.pickOn]} accessibilityRole="radio"
              accessibilityState={{ selected: pick === t.start }} testID={`pick-${t.start}`}>
              <Text style={[styles.body, pick === t.start && styles.pickOnText]}>{fmtWhen(t.start)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={styles.body}>{"We'll charge the"} {usd(b.buyerTotalCents)} held on {name}{"'s card and email them."} {pick ? `${fmtWhen(pick)} is booked.` : ""}</Text>
      {b.locationMode === "virtual" ? (
        <>
          <Text style={styles.label}>Backup video link (optional)</Text>
          <TextInput value={link} onChangeText={setLink} placeholder="Paste a Zoom or Meet link" placeholderTextColor={Bold.quiet} autoCapitalize="none"
            style={styles.input} accessibilityLabel="Backup video link" testID="accept-link" />
          <Text style={styles.caption}>{"Only used if the Nomila call doesn't connect."}</Text>
        </>
      ) : null}
    </ConfirmSheet>
  );
}

function DeclineSheet({ b, onClose, onDone }: { b: BookingDetailView; onClose: () => void; onDone: () => void }) {
  const act = useBookingAction(b.id);
  const [reason, setReason] = useState<"time" | "fit" | "felt_off" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = b.buyerLabel.split(" ")[0];
  const confirm = () => {
    setError(null);
    act.mutate({ action: "decline", reason }, { onSuccess: () => { haptics.success(); onDone(); }, onError: (err) => setError(refusalLine(err, "Couldn't decline. Nothing was sent. Try again.")) });
  };
  return (
    <ConfirmSheet title="Decline this request?" confirm="Decline" onConfirm={confirm} onClose={onClose} busy={act.isPending} error={error} testID="decline-sheet">
      <Text style={styles.body}>{"We'll send"} {name} a kind note and release the hold on their card.</Text>
      <Text style={styles.label}>Reason (only you see this)</Text>
      <View style={styles.picks}>
        {([["time", "Time doesn't work"], ["fit", "Not a fit"], ["felt_off", "Something felt off"]] as const).map(([k, label]) => (
          <Pressable key={k} onPress={() => setReason(k)} style={[styles.pick, reason === k && styles.pickOn]} accessibilityRole="radio" accessibilityState={{ selected: reason === k }} testID={`reason-${k}`}>
            <Text style={[styles.body, reason === k && styles.pickOnText]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {reason === "felt_off" ? <Text style={styles.meta} testID="felt-off">You can block them from this booking after you decline. To report someone, email {b.supportEmail}. A person at Nomila reads every report. In danger? Call 911.</Text> : null}
    </ConfirmSheet>
  );
}

function ProposeSheet({ b, onClose, onDone, now = new Date() }: { b: BookingDetailView; onClose: () => void; onDone: () => void; now?: Date }) {
  const act = useBookingAction(b.id);
  const days = useMemo(() => dayOptions(now, 21), []);   // eslint-disable-line react-hooks/exhaustive-deps
  const times = useMemo(() => timeOptions(), []);
  const [day, setDay] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const name = b.buyerLabel.split(" ")[0];
  const toggle = (iso: string) => setPicked((p) => p.includes(iso) ? p.filter((x) => x !== iso) : p.length >= 3 ? p : [...p, iso]);
  const confirm = () => {
    if (!picked.length) { setError("Pick at least one time."); return; }
    setError(null);
    act.mutate({ action: "propose", times: picked }, { onSuccess: () => { haptics.success(); onDone(); }, onError: (err) => setError(refusalLine(err, "Couldn't send your times. Try again.")) });
  };
  return (
    <ConfirmSheet title="Suggest other times" confirm={`Send ${picked.length || ""} time${picked.length === 1 ? "" : "s"} to ${name}`.replace("  ", " ")} onConfirm={confirm} onClose={onClose} busy={act.isPending} error={error} testID="propose-sheet">
      <Text style={styles.body}>Pick up to 3. {name} chooses one, then you accept it. Their card hold stays in place.</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.picks}>
        {days.map((d, i) => (
          <Pressable key={d.key} onPress={() => setDay(i)} style={[styles.pick, i === day && styles.pickOn]} testID={`propose-day-${i}`}>
            <Text style={[styles.body, i === day && styles.pickOnText]}>{d.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.wrap}>
        {times.map((t) => {
          const iso = startIso(days[day].date, t.minutes);
          const on = picked.includes(iso);
          return (
            <Pressable key={t.minutes} onPress={() => toggle(iso)} style={[styles.pick, on && styles.pickOn]} testID={`propose-time-${t.minutes}`}>
              <Text style={[styles.body, on && styles.pickOnText]}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {picked.length ? <Text style={styles.meta} testID="propose-picked">{picked.map(fmtWhen).join(" · ")}</Text> : null}
    </ConfirmSheet>
  );
}

function CancelSheet({ b, onClose, onDone }: { b: BookingDetailView; onClose: () => void; onDone: () => void }) {
  const act = useBookingAction(b.id);
  const preview = useCancelPreview(b.id, true);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const name = b.buyerLabel.split(" ")[0];
  const confirm = () => {
    setError(null);
    act.mutate({ action: "cancel", reason: reason.trim() }, { onSuccess: () => { haptics.success(); onDone(); }, onError: (err) => setError(refusalLine(err, "Couldn't cancel. Nothing changed. Try again.")) });
  };
  const p = preview.data;
  return (
    <ConfirmSheet title="Cancel this booking?" confirm={`Cancel and refund ${name}`} cancelLabel="Keep the booking" onConfirm={confirm} onClose={onClose} busy={act.isPending || preview.isLoading} error={error} testID="cancel-sheet">
      {preview.isLoading ? <Loading testID="cancel-preview-loading" /> : null}
      {preview.isError ? <ErrorLine text="Couldn't work out the refund. Check your connection." testID="cancel-preview-error" /> : null}
      {p ? (
        <>
          <Text style={styles.body} testID="cancel-refund">{name} gets a full refund of {usd(p.buyerRefundCents)}{". We'll let them know."}</Text>
          {p.firstCancelFree ? (
            <><Text style={styles.rowTitle}>{"This one's on us"}</Text><Text style={styles.meta}>Usually the card fee comes out of your next payout when you cancel. Your first cancellation is free.</Text></>
          ) : <Text style={styles.meta} testID="cancel-fee">The card fee (about {usd(p.estCardFeeCents)}) comes out of your next payout.</Text>}
        </>
      ) : null}
      <Text style={styles.label}>Reason (sent to {name})</Text>
      <TextInput value={reason} onChangeText={setReason} placeholder="I'm sorry, I can't make it because…" placeholderTextColor={Bold.quiet} multiline maxLength={500}
        style={styles.input} accessibilityLabel="Reason" testID="cancel-reason" />
      <Text style={styles.caption}>Buyers can cancel for their price back up to {windowLabel(b.freeCancelHours)} before.</Text>
    </ConfirmSheet>
  );
}

const styles = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: Bold.paper },
  content:     { paddingHorizontal: Bold.gutter, paddingBottom: 48 },
  stack:       { gap: 14 },
  eyebrow:     { ...BoldType.label, color: Bold.blue, marginTop: 8 },
  title:       { ...BoldType.screenTitleSm, color: Bold.ink },
  meta:        { ...BoldType.rowMeta, color: Bold.mute },
  flash:       { ...BoldType.read, color: Bold.ink },
  pad:         { padding: 14, gap: 8 },
  body:        { ...BoldType.body, color: Bold.ink },
  caption:     { ...BoldType.caption, color: Bold.mute },
  label:       { ...BoldType.label, color: Bold.mute, marginTop: 4 },
  check:       { flexDirection: "row", alignItems: "center", gap: 8 },
  money:       { flexDirection: "row", alignItems: "center", gap: 12 },
  big:         { ...BoldType.cellValue, color: Bold.ink },
  rowTitle:    { ...BoldType.rowTitle, color: Bold.ink },
  flex:        { flex: 1 },
  buttons:     { flexDirection: "row", gap: 10 },
  block:       { backgroundColor: Bold.ink, borderRadius: Bold.radius.card, padding: 16, gap: 10 },
  blockEyebrow: { ...BoldType.label, color: Bold.onDarkLabel },
  blockTitle:  { ...BoldType.bannerTitle, color: Bold.onDark },
  blockBody:   { ...BoldType.lede, color: Bold.onDarkSoft },
  door:        { flexDirection: "row", alignItems: "center", minHeight: 48, borderBottomWidth: 1, borderBottomColor: Bold.line },
  tl:          { flexDirection: "row", alignItems: "center", gap: 10 },
  msg:         { gap: 2, paddingVertical: 6, borderTopWidth: 1, borderTopColor: Bold.line },
  input:       { ...BoldType.body, color: Bold.ink, minHeight: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, paddingHorizontal: 12, paddingTop: 12 },
  picks:       { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  wrap:        { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pick:        { minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1.5, borderColor: Bold.line, borderRadius: Bold.radius.control },
  pickOn:      { borderColor: Bold.ink, backgroundColor: Bold.ink },
  pickOnText:  { color: Bold.onDark },
});
