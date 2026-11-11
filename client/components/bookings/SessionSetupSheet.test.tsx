/**
 * SessionSetupSheet.test — "Publish this session" with a preset that makes more open times than one request may carry.
 *
 *   T1 Weekday evenings over two weeks is 24 times: they go in batches of ≤ 20, then the offer is published
 *   T2 a retry after a refusal part-way through sends only the times not yet added (no self-overlap refusal)
 *   T3 a refusal is spelled out (never "check the highlighted fields": this sheet has none)
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { SessionSetupSheet } from "./SessionSetupSheet";
import { SLOTS_PER_REQUEST } from "../../lib/lookLogic";
import { hoursStarts, presetHours, type WeekHours } from "../../lib/availabilityLogic";

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), getParent: () => undefined, getState: () => ({ routeNames: [] }) }),
  useRoute: () => ({ params: undefined }),
}));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
// The native time wheel (iOS): a stand-in the tests turn like the real one (onChange(event, date)).
jest.mock("@react-native-community/datetimepicker", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { __esModule: true, default: (p: any) => React.createElement(View, { testID: p.testID, onChange: p.onChange }) };
});
jest.mock("expo-web-browser", () => ({ openBrowserAsync: jest.fn(async () => ({ type: "opened" })) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const hooks = {
  save: jest.fn(async (_v: unknown) => ({ offer: { id: "offer-1" } })),
  addSlots: jest.fn(async (_v: { offerId: string; starts: string[] }): Promise<unknown> => ({ slots: [] })),
  publish: jest.fn(async (_v: unknown) => ({ offer: { id: "offer-1" } })),
};
jest.mock("../../hooks/use-bookings", () => {
  return {
    // As the real one reads a refused request ("400: {json}"); the real module pulls in the app's query client.
    bookingRefusal: (err: unknown) => {
      const m = /^(\d{3}): ([\s\S]*)$/.exec((err as Error)?.message ?? "");
      if (!m) return null;
      let body: any = null;
      try { body = JSON.parse(m[2]); } catch { /* not JSON */ }
      return { status: Number(m[1]), code: body?.code ?? null, error: body?.error ?? null, detail: body?.detail ?? null };
    },
    useStartPayouts: () => ({ mutate: jest.fn(), isPending: false }),
    useQuote: () => ({ data: { priceCents: 5000, serviceFeeCents: 953, buyerTotalCents: 5953, athleteReceivesCents: 5000, currency: "usd" } }),
    useSaveOffer: () => ({ mutateAsync: hooks.save, isPending: false }),
    useAddSlots: () => ({ mutateAsync: hooks.addSlots, isPending: false }),
    useOfferAction: () => ({ mutateAsync: hooks.publish, isPending: false }),
  };
});

// Sunday 1 Nov 2026, 9 am local: the next 4 weeks hold sixteen Mon–Thu evenings × 6 half-hour starts (6:00–9:00 pm) = 96.
const NOW = new Date(2026, 10, 1, 9, 0, 0);

function open(onDone = jest.fn()) {
  render(<SessionSetupSheet visible onClose={jest.fn()} onDone={onDone} onOpenEditor={jest.fn()} now={NOW} />);
  fireEvent.press(screen.getByTestId("session-setup-next"));
  fireEvent.press(screen.getByTestId("session-setup-next"));
  return onDone;
}

beforeEach(() => {
  hooks.save.mockClear();
  hooks.addSlots.mockReset();
  hooks.addSlots.mockImplementation(async () => ({ slots: [] }));
  hooks.publish.mockClear();
});

const EVENINGS = () => hoursStarts(presetHours("weekday_evenings"), 30, NOW);

it("T1 sends Weekday evenings' 96 times in batches of at most 20, then publishes", async () => {
  const expected = EVENINGS();
  expect(expected).toHaveLength(96);
  expect(expected.length).toBeGreaterThan(SLOTS_PER_REQUEST);
  const onDone = open();
  fireEvent.press(screen.getByTestId("session-setup-done"));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  const sent = hooks.addSlots.mock.calls.map(([v]) => v.starts);
  expect(sent.length).toBe(5);
  expect(sent.every((b) => b.length > 0 && b.length <= SLOTS_PER_REQUEST)).toBe(true);
  expect(sent.flat()).toEqual(expected);
  expect(hooks.publish).toHaveBeenCalledWith({ id: "offer-1", action: "publish" });
});

it("T2 a retry sends only the times not yet added", async () => {
  hooks.addSlots
    .mockImplementationOnce(async () => ({ slots: [] }))
    .mockImplementationOnce(async () => { throw new Error("500: {\"error\":\"failed\"}"); });
  const onDone = open();
  fireEvent.press(screen.getByTestId("session-setup-done"));
  await waitFor(() => expect(screen.getByTestId("session-setup-error")).toBeTruthy());
  const firstBatch = hooks.addSlots.mock.calls[0][0].starts;
  hooks.addSlots.mockClear();
  fireEvent.press(screen.getByTestId("session-setup-done"));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  const resent = hooks.addSlots.mock.calls.flatMap(([v]) => v.starts);
  expect(resent.some((s) => firstBatch.includes(s))).toBe(false);
  expect([...firstBatch, ...resent]).toEqual(EVENINGS());
});

describe("T4 who it's for (group sessions)", () => {
  it("defaults to just one fan: sends audience one, max_people 1, and the 1:1 copy", async () => {
    const onDone = open();
    fireEvent.press(screen.getByTestId("session-setup-done"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(hooks.save.mock.calls[0][0]).toMatchObject({ draft: { audience: "one", max_people: 1, title: "1:1 video call · 30 min" } });
  });

  it("a fan + friends: 4 people to start, the stepper changes it, price is per person, and the save sends both", async () => {
    const onDone = jest.fn();
    render(<SessionSetupSheet visible onClose={jest.fn()} onDone={onDone} onOpenEditor={jest.fn()} now={NOW} />);
    expect(screen.queryByTestId("people-count")).toBeNull();
    fireEvent.press(screen.getByTestId("audience-private_group"));
    expect(screen.getByTestId("people-count").props.children).toBe("Up to 4");
    fireEvent.press(screen.getByTestId("people-plus"));
    fireEvent.press(screen.getByTestId("people-plus"));
    expect(screen.getByTestId("people-count").props.children).toBe("Up to 6");
    expect(screen.getByText("Group video call")).toBeTruthy();
    fireEvent.press(screen.getByTestId("session-setup-next"));
    expect(screen.getByText("Price per person")).toBeTruthy();
    fireEvent.press(screen.getByTestId("price-3000"));
    expect(screen.getByText("You get $30 per person")).toBeTruthy();
    expect(screen.getByText("Up to $180 per session · 100% of your price")).toBeTruthy();
    expect(screen.getByTestId("fans-see").props.children.join("")).toMatch(/per person, including the Nomila fee\.$/);
    fireEvent.press(screen.getByTestId("session-setup-next"));
    fireEvent.press(screen.getByTestId("session-setup-done"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(hooks.save.mock.calls[0][0]).toMatchObject({ draft: { audience: "private_group", max_people: 6, price_cents: 3000, title: "Group video call · 30 min" } });
  });

  it("the stepper stays within 2–20", () => {
    render(<SessionSetupSheet visible onClose={jest.fn()} onDone={jest.fn()} onOpenEditor={jest.fn()} now={NOW} />);
    fireEvent.press(screen.getByTestId("audience-private_group"));
    for (let i = 0; i < 5; i++) fireEvent.press(screen.getByTestId("people-minus"));
    expect(screen.getByTestId("people-count").props.children).toBe("Up to 2");
    fireEvent.press(screen.getByTestId("audience-open_group"));
    expect(screen.getByTestId("people-count").props.children).toBe("Up to 10");
    for (let i = 0; i < 15; i++) fireEvent.press(screen.getByTestId("people-plus"));
    expect(screen.getByTestId("people-count").props.children).toBe("Up to 20");
  });

  it("an open group has no 'Only when I say' (it needs set times) and sends open_group with set times", async () => {
    const onDone = jest.fn();
    render(<SessionSetupSheet visible onClose={jest.fn()} onDone={onDone} onOpenEditor={jest.fn()} now={NOW} />);
    fireEvent.press(screen.getByTestId("session-setup-next"));
    fireEvent.press(screen.getByTestId("session-setup-next"));
    expect(screen.getByTestId("preset-only_when_i_say")).toBeTruthy();
    fireEvent.press(screen.getByTestId("preset-only_when_i_say"));
    fireEvent.press(screen.getByText("Back"));
    fireEvent.press(screen.getByText("Back"));
    fireEvent.press(screen.getByTestId("audience-open_group"));
    fireEvent.press(screen.getByTestId("session-setup-next"));
    fireEvent.press(screen.getByTestId("session-setup-next"));
    expect(screen.queryByTestId("preset-only_when_i_say")).toBeNull();
    fireEvent.press(screen.getByTestId("session-setup-done"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(hooks.save.mock.calls[0][0]).toMatchObject({ draft: { audience: "open_group", max_people: 10, scheduling_mode: "slots" } });
    expect(hooks.addSlots).toHaveBeenCalled();
  });
});

describe("T5 approve each spot (0154)", () => {
  it("shows only for an open group, off by default (spots confirm on their own); on sends approve_each_spot", async () => {
    const onDone = jest.fn();
    render(<SessionSetupSheet visible onClose={jest.fn()} onDone={onDone} onOpenEditor={jest.fn()} now={NOW} />);
    expect(screen.queryByTestId("approve-on")).toBeNull();
    fireEvent.press(screen.getByTestId("audience-private_group"));
    expect(screen.queryByTestId("approve-on")).toBeNull();
    fireEvent.press(screen.getByTestId("audience-open_group"));
    expect(screen.getByTestId("approve-off").props.accessibilityState.selected).toBe(true);
    expect(screen.getByText("Fans each book and pay for their own spot. Booked spots confirm on their own.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("approve-on"));
    expect(screen.getByTestId("approve-on").props.accessibilityState.selected).toBe(true);
    expect(screen.getByText("Fans each book and pay for their own spot. Each spot waits for your OK, like a request.")).toBeTruthy();
    fireEvent.press(screen.getByTestId("session-setup-next"));
    fireEvent.press(screen.getByTestId("session-setup-next"));
    fireEvent.press(screen.getByTestId("session-setup-done"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(hooks.save.mock.calls[0][0]).toMatchObject({ draft: { audience: "open_group", approve_each_spot: true } });
  });

  it("anything but an open group sends it off, even after toggling it on first", async () => {
    const onDone = jest.fn();
    render(<SessionSetupSheet visible onClose={jest.fn()} onDone={onDone} onOpenEditor={jest.fn()} now={NOW} />);
    fireEvent.press(screen.getByTestId("audience-open_group"));
    fireEvent.press(screen.getByTestId("approve-on"));
    fireEvent.press(screen.getByTestId("audience-private_group"));
    fireEvent.press(screen.getByTestId("session-setup-next"));
    fireEvent.press(screen.getByTestId("session-setup-next"));
    fireEvent.press(screen.getByTestId("session-setup-done"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(hooks.save.mock.calls[0][0]).toMatchObject({ draft: { audience: "private_group", approve_each_spot: false } });
  });
});

it("T3 a refusal says what's wrong, never 'check the highlighted fields'", async () => {
  hooks.addSlots.mockImplementation(async () => {
    throw new Error("400: " + JSON.stringify({ error: "check the highlighted fields", code: "INVALID", detail: [{ field: "starts", problem: "overlap" }] }));
  });
  open();
  fireEvent.press(screen.getByTestId("session-setup-done"));
  const line = await screen.findByTestId("session-setup-error");
  const text = String(line.props.children);
  expect(text).toMatch(/overlap times you already offer/);
  expect(text).not.toMatch(/highlighted/i);
  expect(hooks.publish).not.toHaveBeenCalled();
});

describe("T5 flexible hours (step 3)", () => {
  const hm = (h: number, m = 0) => h * 60 + m;
  const at = (h: number, m = 0) => new Date(2000, 0, 1, h, m);
  const turnWheel = (d: Date) => fireEvent(screen.getByTestId("time-wheel"), "change", { type: "set" }, d);
  const selected = (id: string) => screen.getByTestId(id).props.accessibilityState?.selected;
  const summary = () => screen.getByTestId("hours-summary").props.children;

  it("a quick start fills the editor below (days, From / Until, summary) and doesn't lock it", () => {
    open();
    expect(selected("preset-weekday_evenings")).toBe(true);
    expect(screen.getByTestId("hours-count").props.children).toBe("96 open times over the next 4 weeks.");
    fireEvent.press(screen.getByTestId("preset-weekends"));
    expect(selected("day-6")).toBe(true);
    expect(selected("day-0")).toBe(true);
    expect(selected("day-1")).toBe(false);
    expect(screen.getByTestId("hours-from-value").props.children).toBe("10:00 am");
    expect(screen.getByTestId("hours-until-value").props.children).toBe("4:00 pm");
    expect(summary()).toBe("Sat, Sun 10:00 am–4:00 pm");
    fireEvent.press(screen.getByTestId("day-5"));                       // her own change: no quick start matches now
    expect(selected("preset-weekends")).toBe(false);
    expect(summary()).toBe("Fri–Sun 10:00 am–4:00 pm");
  });

  it("From / Until open a 15-minute wheel; Until before From is refused in the sheet", () => {
    open();
    fireEvent.press(screen.getByTestId("hours-from"));
    turnWheel(at(17, 30));
    expect(screen.getByTestId("block-from-value").props.children).toBe("5:30 pm");
    fireEvent.press(screen.getByTestId("block-until"));
    turnWheel(at(17, 15));
    expect(screen.getByTestId("block-problem").props.children).toBe("Until must be after From.");
    expect(screen.getByTestId("block-sheet-done").props.accessibilityState.disabled).toBe(true);
    turnWheel(at(20, 0));
    fireEvent.press(screen.getByTestId("block-sheet-done"));
    expect(screen.getByTestId("hours-from-value").props.children).toBe("5:30 pm");
    expect(summary()).toBe("Mon–Thu 5:30–8:00 pm");
    expect(screen.getByTestId("hours-count").props.children).toBe("80 open times over the next 4 weeks.");
  });

  it("different hours on some days, two blocks on a day, the summary, and exactly those times sent in batches", async () => {
    const onDone = open();
    fireEvent(screen.getByTestId("hours-different"), "valueChange", true);
    expect(screen.queryByTestId("hours-from")).toBeNull();
    // Tuesday: 7:00–8:15 am, and a second block 5:30–8:00 pm.
    fireEvent.press(screen.getByTestId("block-2-0"));
    turnWheel(at(7, 0));
    fireEvent.press(screen.getByTestId("block-until"));
    turnWheel(at(8, 15));
    fireEvent.press(screen.getByTestId("block-sheet-done"));
    fireEvent.press(screen.getByTestId("add-hours-2"));
    fireEvent.press(screen.getByTestId("block-2-1"));
    turnWheel(at(17, 30));
    fireEvent.press(screen.getByTestId("block-until"));
    turnWheel(at(20, 0));
    fireEvent.press(screen.getByTestId("block-sheet-done"));
    expect(summary()).toBe("Mon, Wed, Thu 6:00–9:00 pm · Tue 7:00–8:15 am, 5:30–8:00 pm");
    // Thursday off, Saturday on (with the shared hours).
    fireEvent.press(screen.getByTestId("block-4-0-remove"));
    fireEvent.press(screen.getByTestId("another-day"));
    fireEvent.press(screen.getByTestId("another-day-6"));
    expect(summary()).toBe("Mon, Wed, Sat 6:00–9:00 pm · Tue 7:00–8:15 am, 5:30–8:00 pm");

    const want: WeekHours = {
      1: [{ start: hm(18), end: hm(21) }], 3: [{ start: hm(18), end: hm(21) }], 6: [{ start: hm(18), end: hm(21) }],
      2: [{ start: hm(7), end: hm(8, 15) }, { start: hm(17, 30), end: hm(20) }],
    };
    const expected = hoursStarts(want, 30, NOW);
    expect(screen.getByTestId("hours-count").props.children).toBe(`${expected.length} open times over the next 4 weeks.`);
    fireEvent.press(screen.getByTestId("session-setup-done"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const sent = hooks.addSlots.mock.calls.map(([v]) => v.starts);
    expect(sent.every((b) => b.length > 0 && b.length <= SLOTS_PER_REQUEST)).toBe(true);
    expect(sent.flat()).toEqual(expected);
    const draft = (hooks.save.mock.calls[0][0] as any).draft;
    expect(draft.scheduling_mode).toBe("slots");
    expect(draft.availability).toEqual({ version: 1, preset: null, blocks: [
      { day: 1, start: hm(18), end: hm(21) }, { day: 2, start: hm(7), end: hm(8, 15) }, { day: 2, start: hm(17, 30), end: hm(20) },
      { day: 3, start: hm(18), end: hm(21) }, { day: 6, start: hm(18), end: hm(21) },
    ] });
  });

  it("a block shorter than the session is refused in the sheet; overlapping blocks block publishing, with the reason", () => {
    open();
    fireEvent(screen.getByTestId("hours-different"), "valueChange", true);
    fireEvent.press(screen.getByTestId("block-1-0"));
    turnWheel(at(20, 45));                                               // 8:45–9:00 pm: shorter than 30 min
    expect(screen.getByTestId("block-problem").props.children).toBe("8:45–9:00 pm is shorter than a 30-min session.");
    expect(screen.getByTestId("block-sheet-done").props.accessibilityState.disabled).toBe(true);
    fireEvent.press(screen.getByTestId("block-until"));
    turnWheel(at(22, 0));
    fireEvent.press(screen.getByTestId("block-sheet-done"));             // Mon 8:45–10:00 pm
    fireEvent.press(screen.getByTestId("add-hours-1"));                  // + 11:00 pm–12:00 am
    fireEvent.press(screen.getByTestId("block-1-1"));
    turnWheel(at(21, 30));                                               // 9:30 pm: inside 8:45–10:00 pm
    fireEvent.press(screen.getByTestId("block-sheet-done"));
    expect(screen.getByTestId("hours-problem").props.children).toBe("Mon: 8:45–10:00 pm and 9:30 pm–12:00 am overlap.");
    expect(screen.getByTestId("session-setup-done").props.accessibilityState.disabled).toBe(true);
  });

  it("switching 'different hours' off gives every day the shared hours again", () => {
    open();
    fireEvent(screen.getByTestId("hours-different"), "valueChange", true);
    fireEvent.press(screen.getByTestId("add-hours-2"));
    expect(screen.getByTestId("block-2-1")).toBeTruthy();
    fireEvent(screen.getByTestId("hours-different"), "valueChange", false);
    expect(summary()).toBe("Mon–Thu 6:00–9:00 pm");
  });

  it("Only when I say: no hours, request mode, no times sent", async () => {
    const onDone = open();
    fireEvent.press(screen.getByTestId("preset-only_when_i_say"));
    expect(screen.queryByTestId("day-1")).toBeNull();
    fireEvent.press(screen.getByTestId("session-setup-done"));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(hooks.addSlots).not.toHaveBeenCalled();
    expect(hooks.save.mock.calls[0][0]).toMatchObject({ draft: { scheduling_mode: "request", availability: null } });
  });
});
