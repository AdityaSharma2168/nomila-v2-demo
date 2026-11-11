// EditHoursSheet — the offer editor's "Edit hours" (flexible hours, Nov 2026): the same hours editor as the new-session
// sheet, for a session that already has times. Saving:
//   1 withdraws her future open times that no longer fall inside the hours — NEVER a time someone booked or asked for
//     (the app leaves those out, and the server's batch withdraw refuses them anyway)
//   2 adds the new times the hours make over the next 4 weeks (none overlapping a time she keeps), ≤ 20 per request
//   3 saves the hours on the offer (offers.availability, 0155) so this sheet reopens them
// The plan is worked out again from fresh times on every tap, so a retry after a refusal part-way through never sends
// a time twice. An offer from before flexible hours opens with hours that hold all of its current times.
import React, { useMemo, useState } from "react";
import { ScrollView, Text, useWindowDimensions } from "react-native";
import { LookButton, LookSheet } from "../look";
import { Look, useLook } from "../../constants/theme";
import { inBatches, slotBatches } from "../../lib/lookLogic";
import {
  HORIZON_DAYS, fromAvailability, hoursFromSlots, hoursProblems, planHoursChange, presetHours, toAvailability, type WeekHours,
} from "../../lib/availabilityLogic";
import { useAddSlots, useSaveOffer, useSlots, useWithdrawSlots } from "../../hooks/use-bookings";
import type { OfferView, SlotView } from "../../lib/bookingsTypes";
import { HoursEditor } from "./HoursEditor";
import { Loading, setupRefusalLine } from "./parts";

/** The most ids one batch-withdraw request names (server/services/bookings/offers.ts MAX_WITHDRAW_PER_REQUEST). */
export const WITHDRAW_PER_REQUEST = 100;

export function EditHoursSheet({ offer, onClose, onSaved, calendarConnected = false, now: nowProp }: {
  offer: OfferView; onClose: () => void; onSaved: (line: string) => void; calendarConnected?: boolean; now?: Date;
}) {
  const L = useLook();
  const slots = useSlots(offer.id);
  return (
    <LookSheet visible onClose={onClose} title="Edit hours" sub="New times appear for fans; booked times always stay." testID="edit-hours">
      {slots.data ? <Body offer={offer} slots={slots.data} refetch={slots.refetch} onSaved={onSaved} calendarConnected={calendarConnected} now={nowProp} />
        : slots.isError ? <Text style={[Look.type.meta, { color: L.actTintInk }]} testID="edit-hours-error">{"Couldn't load your times. Close and try again."}</Text>
          : <Loading testID="edit-hours-loading" />}
    </LookSheet>
  );
}

function Body({ offer, slots, refetch, onSaved, calendarConnected, now: nowProp }: {
  offer: OfferView; slots: SlotView[]; refetch: () => Promise<{ data?: SlotView[] }>; onSaved: (line: string) => void;
  calendarConnected: boolean; now?: Date;
}) {
  const L = useLook();
  const { height } = useWindowDimensions();
  const [now] = useState(() => nowProp ?? new Date());
  const [hours, setHours] = useState<WeekHours>(() => fromAvailability(offer.availability) ?? hoursFromSlots(slots.filter((s) => Date.parse(s.startsAt) > now.getTime())) ?? presetHours("weekday_evenings"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = useAddSlots();
  const withdraw = useWithdrawSlots();
  const save = useSaveOffer();
  const minutes = offer.durationMinutes;
  const problems = hoursProblems(hours, minutes);
  const plan = useMemo(() => planHoursChange(slots, hours, minutes, now), [slots, hours, minutes, now]);

  async function apply() {
    if (problems.length) return;
    setError(null);
    setBusy(true);
    try {
      // Fresh times, so a retry never re-sends what already went through.
      const fresh = (await refetch()).data ?? slots;
      const p = planHoursChange(fresh, hours, minutes, now);
      let kept = p.keptBooked;
      for (const ids of inBatches(p.withdraw, WITHDRAW_PER_REQUEST)) {
        const r = await withdraw.mutateAsync({ offerId: offer.id, slotIds: ids });
        kept += r.booked.length;   // booked in the meantime: the server kept it
      }
      for (const batch of slotBatches(p.add)) await add.mutateAsync({ offerId: offer.id, starts: batch });
      await save.mutateAsync({ id: offer.id, draft: { availability: toAvailability(hours) } });
      onSaved(changeLine(p.add.length, p.withdraw.length, kept));
    } catch (err) {
      setError(setupRefusalLine(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ScrollView style={{ maxHeight: height * 0.55 }} contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <HoursEditor hours={hours} onChange={setHours} minutes={minutes} calendarConnected={calendarConnected} testID="edit-hours-editor" />
      </ScrollView>
      {!problems.length ? <Text style={[Look.type.metaStrong, { color: L.ink }]} testID="edit-hours-plan">{planLine(plan.add.length, plan.withdraw.length, plan.keptBooked)}</Text> : null}
      {error ? <Text style={[Look.type.meta, { color: L.actTintInk }]} testID="edit-hours-refusal">{error}</Text> : null}
      <LookButton onPress={apply} loading={busy} disabled={problems.length > 0} testID="edit-hours-save">Save hours</LookButton>
    </>
  );
}

const times = (n: number) => `${n} ${n === 1 ? "time" : "times"}`;

/** Before she taps: "Adds 12 new times over the next 4 weeks · removes 3 that no longer fit · 1 booked time stays". */
export function planLine(added: number, removed: number, keptBooked: number): string {
  const parts: string[] = [];
  if (added) parts.push(`Adds ${added} new ${added === 1 ? "time" : "times"} over the next ${HORIZON_DAYS / 7} weeks`);
  if (removed) parts.push(`${parts.length ? "removes" : "Removes"} ${removed} open ${removed === 1 ? "time" : "times"} outside these hours`);
  if (keptBooked) parts.push(`${keptBooked} booked ${keptBooked === 1 ? "time stays" : "times stay"}`);
  return parts.length ? parts.join(" · ") + "." : "Your times already match these hours.";
}

/** After: "Hours saved. 12 times added, 3 removed." */
export function changeLine(added: number, removed: number, keptBooked: number): string {
  const bits = [added ? `${times(added)} added` : null, removed ? `${removed} removed` : null].filter(Boolean);
  const booked = keptBooked ? ` ${times(keptBooked)} with a booking stayed.` : "";
  return `Hours saved.${bits.length ? ` ${bits.join(", ")}.` : ""}${booked}`;
}
