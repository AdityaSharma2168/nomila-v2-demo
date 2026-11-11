/**
 * EditHoursSheet.test — the offer editor's "Edit hours" for a session that already has times (flexible hours).
 *
 *   H1 the offer editor shows her saved hours on the "Edit hours" row and opens the sheet on them
 *   H2 saving withdraws the open times outside the new hours (in one batch request), NEVER a booked one, adds the new
 *      times in batches of ≤ 20 (none overlapping a time she keeps), then saves the hours on the offer
 *   H3 the plan line before she taps; the same hours change nothing
 *   H4 a retry after a refusal part-way through works from fresh times (nothing sent twice)
 *   H5 an offer from before flexible hours opens with hours that hold all its times (nothing withdrawn)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { EditHoursSheet, changeLine, planLine } from "./EditHoursSheet";
import { OfferEditorScreen } from "../../screens/bookings/OfferEditorScreen";
import { SLOTS_PER_REQUEST } from "../../lib/lookLogic";
import { hoursStarts, presetHours, toAvailability } from "../../lib/availabilityLogic";
import { offerFixture, summaryFixture } from "../../test/bookingFixtures";
import type { SlotView } from "../../lib/bookingsTypes";

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames: [] }) }),
  useRoute: () => ({ params: { offerId: "o1" } }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn() }));
jest.mock("@react-native-community/datetimepicker", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { __esModule: true, default: (p: any) => React.createElement(View, { testID: p.testID, onChange: p.onChange }) };
});
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

// Sunday 1 Nov 2026, 9 am local.
const NOW = new Date(2026, 10, 1, 9, 0, 0);
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
let n = 0;
const slot = (startsAt: string, over: Partial<SlotView> = {}): SlotView => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, startsAt, endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
  taken: false, capacity: 1, spotsTaken: 0, spotsLeft: 1, ...over,
});

const q = (data: any, over: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, refetch: jest.fn(async () => ({ data })), ...over });
const hooks = {
  slots: [] as SlotView[],
  slotsQuery: null as any,
  add: jest.fn(async (_v: { offerId: string; starts: string[] }): Promise<unknown> => ({ slots: [] })),
  withdraw: jest.fn(async (v: { offerId: string; slotIds: string[] }): Promise<{ withdrawn: string[]; booked: string[]; slots: SlotView[] }> => ({ withdrawn: v.slotIds, booked: [], slots: [] })),
  save: jest.fn(async (_v: unknown) => ({ offer: offerFixture() })),
  offer: offerFixture(),
};
jest.mock("../../hooks/use-bookings", () => ({
  bookingRefusal: (err: unknown) => {
    const m = /^(\d{3}): ([\s\S]*)$/.exec((err as Error)?.message ?? "");
    if (!m) return null;
    let body: any = null;
    try { body = JSON.parse(m[2]); } catch { /* not JSON */ }
    return { status: Number(m[1]), code: body?.code ?? null, error: body?.error ?? null, detail: body?.detail ?? null };
  },
  useSlots: () => hooks.slotsQuery ?? q(hooks.slots, { refetch: jest.fn(async () => ({ data: hooks.slots })) }),
  useAddSlots: () => ({ mutateAsync: hooks.add, isPending: false }),
  useWithdrawSlots: () => ({ mutateAsync: hooks.withdraw, isPending: false }),
  useSaveOffer: () => ({ mutateAsync: hooks.save, isPending: false }),
  useBookingsSummary: () => q(summaryFixture()),
  useOffer: () => q(hooks.offer),
  useQuote: () => q(undefined),
  useOfferAction: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useStartPayouts: () => ({ mutate: jest.fn(), isPending: false }),
}));

const EVENINGS = presetHours("weekday_evenings");
const WEEKENDS = presetHours("weekends");

beforeEach(() => {
  hooks.slots = []; hooks.slotsQuery = null;
  hooks.add.mockReset(); hooks.add.mockImplementation(async () => ({ slots: [] }));
  hooks.withdraw.mockClear(); hooks.save.mockClear();
  hooks.offer = offerFixture({ availability: toAvailability(EVENINGS) });
});

function openSheet(onSaved = jest.fn()) {
  render(<EditHoursSheet offer={hooks.offer} onClose={jest.fn()} onSaved={onSaved} now={NOW} />);
  return onSaved;
}

describe("H1 the offer editor", () => {
  it("shows her saved hours on the Edit hours row and opens the sheet on them", () => {
    render(<OfferEditorScreen />);
    expect(screen.getByTestId("offer-hours-summary").props.children).toBe("Mon–Thu 6:00–9:00 pm");
    fireEvent.press(screen.getByTestId("offer-edit-hours"));
    expect(screen.getByTestId("edit-hours")).toBeTruthy();
    expect(screen.getByTestId("hours-summary").props.children).toBe("Mon–Thu 6:00–9:00 pm");
    expect(screen.queryByTestId("preset-only_when_i_say")).toBeNull();   // request mode is the editor's own choice
  });

  it("an offer in request mode has no Edit hours row", () => {
    hooks.offer = offerFixture({ schedulingMode: "request", availability: null });
    render(<OfferEditorScreen />);
    expect(screen.queryByTestId("offer-edit-hours")).toBeNull();
  });
});

describe("H2 + H3 saving new hours", () => {
  it("withdraws open times outside the hours, never a booked one; adds the new ones in batches; saves the hours", async () => {
    const insideOpen = slot(local(2, 18));                                                   // Mon 6 pm (withdrawn: weekends only now)
    const outsideOpen = slot(local(3, 19));                                                  // Tue 7 pm (withdrawn: weekends only now)
    const outsideBooked = slot(local(4, 18), { taken: true, spotsLeft: 0, spotsTaken: 1 }); // Wed 6 pm, booked (kept)
    const groupSpot = slot(local(5, 18), { capacity: 10, spotsTaken: 3, spotsLeft: 7 });    // Thu 6 pm, 3 in it (kept)
    const weekendOpen = slot(local(7, 10));                                                  // Sat 10 am (kept, already inside)
    hooks.slots = [insideOpen, outsideOpen, outsideBooked, groupSpot, weekendOpen];
    const onSaved = openSheet();
    fireEvent.press(screen.getByTestId("preset-weekends"));
    const want = hoursStarts(WEEKENDS, 30, NOW).filter((s) => s !== weekendOpen.startsAt);
    expect(screen.getByTestId("edit-hours-plan").props.children)
      .toBe(`Adds ${want.length} new times over the next 4 weeks · removes 2 open times outside these hours · 2 booked times stay.`);
    fireEvent.press(screen.getByTestId("edit-hours-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    expect(hooks.withdraw).toHaveBeenCalledTimes(1);
    expect(hooks.withdraw.mock.calls[0][0]).toEqual({ offerId: "o1", slotIds: [insideOpen.id, outsideOpen.id] });
    const withdrawn = hooks.withdraw.mock.calls.flatMap(([v]) => v.slotIds);
    expect(withdrawn).not.toContain(outsideBooked.id);
    expect(withdrawn).not.toContain(groupSpot.id);
    const sent = hooks.add.mock.calls.map(([v]) => v.starts);
    expect(sent.every((b) => b.length > 0 && b.length <= SLOTS_PER_REQUEST)).toBe(true);
    expect(sent.flat()).toEqual(want);
    expect(hooks.save).toHaveBeenCalledWith({ id: "o1", draft: { availability: toAvailability(WEEKENDS) } });
    expect(onSaved).toHaveBeenCalledWith(`Hours saved. ${want.length} times added, 2 removed. 2 times with a booking stayed.`);
  });

  it("the same hours change nothing but saving them", async () => {
    hooks.slots = hoursStarts(EVENINGS, 30, NOW).map((s) => slot(s));
    const onSaved = openSheet();
    expect(screen.getByTestId("edit-hours-plan").props.children).toBe("Your times already match these hours.");
    fireEvent.press(screen.getByTestId("edit-hours-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("Hours saved."));
    expect(hooks.withdraw).not.toHaveBeenCalled();
    expect(hooks.add).not.toHaveBeenCalled();
    expect(hooks.save).toHaveBeenCalled();
  });

  it("a time booked between opening the sheet and the server's withdraw stays, and she's told", async () => {
    const tue = slot(local(3, 19));
    hooks.slots = [tue];
    hooks.withdraw.mockImplementationOnce(async () => ({ withdrawn: [], booked: [tue.id], slots: [] }));
    const onSaved = openSheet();
    fireEvent.press(screen.getByTestId("preset-weekends"));
    fireEvent.press(screen.getByTestId("edit-hours-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaved.mock.calls[0][0]).toMatch(/1 time with a booking stayed\.$/);
  });

  it("invalid hours can't be saved", () => {
    openSheet();
    for (const d of [1, 2, 3, 4]) fireEvent.press(screen.getByTestId(`day-${d}`));
    expect(screen.getByTestId("hours-problem").props.children).toBe("Pick at least one day.");
    expect(screen.getByTestId("edit-hours-save").props.accessibilityState.disabled).toBe(true);
  });
});

describe("H4 a retry", () => {
  it("works from fresh times: what already went through is not sent again", async () => {
    hooks.offer = offerFixture({ availability: toAvailability(WEEKENDS) });
    hooks.slots = [];
    const all = hoursStarts(WEEKENDS, 30, NOW);
    hooks.add
      .mockImplementationOnce(async (v) => { hooks.slots = [...hooks.slots, ...v.starts.map((s) => slot(s))]; return { slots: [] }; })
      .mockImplementationOnce(async () => { throw new Error("500: {\"error\":\"failed\"}"); });
    const onSaved = openSheet();
    fireEvent.press(screen.getByTestId("edit-hours-save"));
    await waitFor(() => expect(screen.getByTestId("edit-hours-refusal")).toBeTruthy());
    const first = hooks.add.mock.calls[0][0].starts;
    hooks.add.mockClear();
    hooks.add.mockImplementation(async () => ({ slots: [] }));
    fireEvent.press(screen.getByTestId("edit-hours-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const resent = hooks.add.mock.calls.flatMap(([v]) => v.starts);
    expect(resent.some((s) => first.includes(s))).toBe(false);
    expect([...first, ...resent]).toEqual(all);
  });
});

describe("H5 an offer from before flexible hours", () => {
  it("opens with hours that hold all its times, so saving withdraws nothing", async () => {
    hooks.offer = offerFixture({ availability: null });
    hooks.slots = [slot(local(2, 18)), slot(local(3, 7, 30))];
    const onSaved = openSheet();
    expect(screen.getByTestId("hours-summary").props.children).toBe("Mon 6:00–6:30 pm · Tue 7:30–8:00 am");
    fireEvent.press(screen.getByTestId("edit-hours-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(hooks.withdraw).not.toHaveBeenCalled();
  });
});

describe("words", () => {
  it("plan and result lines", () => {
    expect(planLine(1, 0, 0)).toBe("Adds 1 new time over the next 4 weeks.");
    expect(planLine(0, 3, 1)).toBe("Removes 3 open times outside these hours · 1 booked time stays.");
    expect(changeLine(0, 0, 0)).toBe("Hours saved.");
    expect(changeLine(5, 0, 0)).toBe("Hours saved. 5 times added.");
  });
});
