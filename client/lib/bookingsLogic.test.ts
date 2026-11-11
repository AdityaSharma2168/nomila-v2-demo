/**
 * bookingsLogic.test — the words and numbers her Bookings screens show: money in her words ("You receive $150 · buyers
 * pay $177.96"), concrete dates, the deadline chip, what was checked (never "verified"), Stripe's missing items in
 * plain words, the editor's dollars → cents, and the time picker.
 */
import {
  usd, fmtWhen, fmtRange, receiveLine, offerMeta, checkBadges, respondChip, phaseLine, whenLine, payoutNeedsLine,
  dayOptions, timeOptions, startIso, dollarsToCents, windowLabel, BOOKINGS_COPY, payoutsOf, setupRefusalText,
  defaultPeople, clampPeople, partyTag, groupGetLine, groupCardLine, namesLine, attendeeLine, groupCancelLine, withoutOpenGroupSpots, bookedEntries,
} from "./bookingsLogic";
import { offerFixture, listItemFixture, groupItemFixture } from "../test/bookingFixtures";

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo, d, h, mi).toISOString();

describe("money and time, in her words", () => {
  it("dollars: whole without cents, cents when there are some", () => {
    expect(usd(15_000)).toBe("$150");
    expect(usd(17_796)).toBe("$177.96");
    expect(usd(118_465)).toBe("$1,184.65");
    expect(receiveLine({ athleteReceivesCents: 15_000, buyerTotalCents: 17_796 })).toBe("You receive $150 · buyers pay $177.96");
  });
  it("dates are concrete, in her own time zone", () => {
    expect(fmtWhen(at(2026, 9, 15, 16))).toBe("Thu 15 Oct, 4:00 pm");
    expect(fmtRange(at(2026, 9, 15, 16), at(2026, 9, 15, 16, 30))).toBe("Thu 15 Oct, 4:00–4:30 pm");
    expect(fmtRange(at(2026, 9, 15, 11, 30), at(2026, 9, 15, 12, 30))).toBe("Thu 15 Oct, 11:30 am–12:30 pm");
    expect(fmtWhen(at(2026, 9, 15, 0, 5))).toBe("Thu 15 Oct, 12:05 am");
  });
  it("her cancellation window choices", () => {
    expect([24, 48, 168].map(windowLabel)).toEqual(["24 hours", "48 hours", "7 days"]);
  });
});

describe("rows", () => {
  it("an offer row says what she receives, and the state in words", () => {
    expect(offerMeta(offerFixture())).toBe("30 min · You receive $150 · 6 times open");
    expect(offerMeta(offerFixture({ status: "draft" }))).toBe("30 min · You receive $150 · Draft");
    expect(offerMeta(offerFixture({ status: "paused", pausedReason: "no_show_review" }))).toBe("30 min · You receive $150 · Paused by Nomila");
    expect(offerMeta(offerFixture({ schedulingMode: "request", locationMode: "in_person" }))).toBe("30 min · In person · You receive $150 · Buyers suggest times");
  });
  it("what was checked — never 'verified'", () => {
    expect(checkBadges({ email: true, phone: true, idChecked: true, adult: true, parent: false })).toEqual(["Email ✓", "Phone ✓", "ID checked"]);
    expect(JSON.stringify(BOOKINGS_COPY)).not.toMatch(/verified|escrow|commission|KYC|onboarding/i);
  });
  it("the deadline chip: hours inside a day, the weekday beyond", () => {
    const now = new Date(2026, 9, 8, 12);
    expect(respondChip(new Date(2026, 9, 9, 6).toISOString(), now)).toBe("18h left");
    expect(respondChip(new Date(2026, 9, 10, 12).toISOString(), now)).toBe("Reply by Sat");
    expect(respondChip(new Date(2026, 9, 8, 11).toISOString(), now)).toBe("Expired");
    expect(respondChip(null, now)).toBeNull();
  });
  it("phase lines and when lines", () => {
    expect(phaseLine(listItemFixture({ phase: "paid" }))).toBe("Paid to you");
    expect(phaseLine(listItemFixture({ phase: "on_hold" }))).toBe("On hold · a person at Nomila is looking");
    expect(phaseLine(listItemFixture({ phase: "booked", startsAt: at(2026, 9, 15, 16) }))).toBe("Booked · Thu 15 Oct, 4:00 pm");
    expect(whenLine(listItemFixture({ startsAt: null, endsAt: null, proposedTimes: [{ start: at(2026, 9, 15, 16), tz: null }, { start: at(2026, 9, 16, 9), tz: null }] }))).toBe("Thu 15 Oct, 4:00 pm + 1 more");
    expect(whenLine(listItemFixture({ startsAt: null, endsAt: null, proposedTimes: [] }))).toBe("Time to be agreed");
  });
  it("Stripe's missing items, in plain words", () => {
    expect(payoutNeedsLine([])).toBeNull();
    expect(payoutNeedsLine(["external_account", "individual.verification.document"])).toBe("Stripe still needs your bank account, a photo of your ID before it can send you money.");
  });
});

describe("the editor and the time picker", () => {
  it("dollars text → whole cents, or nothing", () => {
    expect(dollarsToCents("150")).toBe(15_000);
    expect(dollarsToCents("$1,000.5")).toBe(100_050);
    expect(dollarsToCents("12.345")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
  });
  it("30 days from tomorrow; half-hour starts 6 am – 10 pm; a picked day + time is a local ISO", () => {
    const days = dayOptions(new Date(2026, 9, 8, 15), 30);
    expect(days).toHaveLength(30);
    expect(days[0].label).toBe("Fri 9 Oct");
    const times = timeOptions();
    expect(times[0]).toEqual({ minutes: 360, label: "6:00 am" });
    expect(times.at(-1)).toEqual({ minutes: 1320, label: "10:00 pm" });
    expect(new Date(startIso(days[0].date, 16 * 60 + 30)).getHours()).toBe(16);
  });
});

describe("payoutsOf", () => {
  it("reads a missing or partial payouts block as not set up (the Sessions tab must never crash on it)", () => {
    expect(payoutsOf(undefined)).toEqual({ hasAccount: false, ready: false, requirementsDue: [] });
    expect(payoutsOf({} as never)).toEqual({ hasAccount: false, ready: false, requirementsDue: [] });
    expect(payoutsOf({ payouts: { hasAccount: true, ready: true, requirementsDue: ["x"] } })).toEqual({ hasAccount: true, ready: true, requirementsDue: ["x"] });
  });
});

describe("setupRefusalText (the new-session sheet)", () => {
  it("spells out the server's field detail instead of 'check the highlighted fields'", () => {
    expect(setupRefusalText({ status: 400, code: "INVALID", error: "check the highlighted fields", detail: [{ field: "starts", problem: "1 to 20 times" }] }))
      .toBe("Open times: 1 to 20 times. It's saved as a draft.");
    expect(setupRefusalText({ status: 400, code: "INVALID", error: "x", detail: [{ field: "starts", problem: "too_soon" }] })).toMatch(/too soon/);
  });
  it("names what blocks publishing, and the server's own words otherwise", () => {
    expect(setupRefusalText({ status: 409, code: "NOT_READY", error: "this offer isn't ready to publish", detail: ["payouts"] })).toBe("Set up payouts first. It's saved as a draft.");
    expect(setupRefusalText({ status: 409, code: "CONNECT_REQUIRED", error: "set up payouts first", detail: null })).toBe("Set up payouts first. It's saved as a draft.");
  });
  it("a server fault or no answer: try again", () => {
    expect(setupRefusalText(null)).toMatch(/^Couldn't publish just now/);
    expect(setupRefusalText({ status: 500, code: null, error: "failed", detail: null })).toMatch(/^Couldn't publish just now/);
  });
});

describe("group sessions (0153): per-person money and one item per open-group time", () => {
  it("people: 4 for friends, 10 for an open group, always 2–20", () => {
    expect([defaultPeople("one"), defaultPeople("private_group"), defaultPeople("open_group")]).toEqual([1, 4, 10]);
    expect([clampPeople(1), clampPeople(7), clampPeople(25)]).toEqual([2, 7, 20]);
  });
  it("money is per person: 'You get $25 per person · up to $250 per session'", () => {
    expect(groupGetLine(2500, 10)).toBe("You get $25 per person · up to $250 per session");
    expect(offerMeta(offerFixture({ audience: "open_group", maxPeople: 10, priceCents: 2500 }))).toMatch(/Open group of up to 10 · You receive \$25 per person/);
    expect(offerMeta(offerFixture())).not.toMatch(/per person/);
  });
  it("a private group's rows say how many people; 1:1 and parties of one say nothing", () => {
    expect(partyTag({ audience: "private_group", partySize: 3 })).toBe(" · 3 people");
    expect(partyTag({ audience: "private_group", partySize: 1 })).toBe("");
    expect(partyTag({ audience: "one", partySize: 1 })).toBe("");
  });
  it("an open-group card and its names", () => {
    expect(groupCardLine(groupItemFixture({ startsAt: at(2026, 10, 14, 10) }))).toBe("Group clinic · Sat 14 Nov, 10:00 am · 4 of 10 booked");
    expect(namesLine(["Jordan", "Sam"])).toBe("Jordan, Sam");
    expect(namesLine(["A", "B", "C", "D", "E"])).toBe("A, B, C + 2 more");
    expect(namesLine([])).toBe("No one yet");
  });
  it("attendee state and the cancel preview in plain words", () => {
    expect(attendeeLine({ status: "confirmed", joined: true, inRoom: true, partySize: 1 })).toBe("In the call");
    expect(attendeeLine({ status: "confirmed", joined: false, inRoom: false, partySize: 2 })).toBe("Booked · 2 people");
    expect(groupCancelLine({ bookings: 1, pending: 0, buyerRefundCents: 2500 })).toBe("1 person gets a full refund of $25. We'll let everyone know.");
    // people, not bookings: one booking that covers three people is three people refunded
    expect(groupCancelLine({ bookings: 1, people: 3, pending: 0, buyerRefundCents: 7500 })).toBe("3 people get a full refund of $75. We'll let everyone know.");
    expect(groupCancelLine({ bookings: 2, people: 2, pending: 0, buyerRefundCents: 5000 })).toMatch(/^2 people get a full refund of \$50\./);
    expect(groupCancelLine({ bookings: 0, pending: 0, buyerRefundCents: 0 })).toMatch(/^No one has paid yet/);
  });
  it("the Booked list drops open-group spots and shows each time once, in time order", () => {
    const spot = listItemFixture({ id: "spot", audience: "open_group", startsAt: at(2026, 10, 14, 10) });
    const one = listItemFixture({ id: "one", startsAt: at(2026, 10, 13, 9) });
    const late = listItemFixture({ id: "late", audience: "private_group", partySize: 3, startsAt: at(2026, 10, 15, 9) });
    expect(withoutOpenGroupSpots([spot, one]).map((b) => b.id)).toEqual(["one"]);
    const g = groupItemFixture({ startsAt: at(2026, 10, 14, 10) });
    const ids = (order: "asc" | "desc") => bookedEntries([spot, late, one], [g], order).map((e) => (e.kind === "group" ? e.g.slotId : e.b.id));
    expect(ids("asc")).toEqual(["one", "slot1", "late"]);
    expect(ids("desc")).toEqual(["late", "slot1", "one"]);
  });
});
