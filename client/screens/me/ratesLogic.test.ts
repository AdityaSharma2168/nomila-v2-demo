import { barOf, groupsOf, initialText, parseDollars, suggestedLine, writeOf } from "./ratesLogic";
import type { RateRow } from "../../hooks/use-rates";

const row = (over: Partial<RateRow> = {}): RateRow => ({
  rate_type: "ig_reel", group: "content", label: "Instagram Reel",
  suggested: { low: 350, high: 550, currency: "usd", confidence: "medium", drivers: ["Audience size"], based_on: "your onboarding", source: "Onboarding estimate", shown_at: "2026-09-01T00:00:00Z" },
  minimum: null, price: null, guard: null, ...over,
});

describe("Your rates", () => {
  it("groups deal rows and the public booking prices (only while bookings are on)", () => {
    const rows = [row(), row({ rate_type: "appearance_in_person_hour", group: "time" }), row({ rate_type: "booking_video_call_30", group: "booking" })];
    expect(groupsOf(rows, true).map((g) => g.title)).toEqual(["Deals · content", "Deals · time", "Bookings · public prices"]);
    expect(groupsOf(rows, false).map((g) => g.key)).toEqual(["content", "time"]);
  });

  it("the suggested line; a rough range says so", () => {
    expect(suggestedLine(row())).toBe("Suggested $350–550 · medium confidence");
    expect(suggestedLine(row({ suggested: { ...row().suggested!, confidence: "low" } }))).toBe("Suggested $350–550 · low confidence, a rough first pass");
    expect(suggestedLine(row({ suggested: null }))).toBe("");
    expect(suggestedLine(row({ suggested: null, minimum: { value: 1000, source: "earlier" } }))).toBe("From your earlier settings");
  });

  it("the bar fits the range and her minimum on one scale", () => {
    const b = barOf(row(), 400)!;
    expect(b.from).toBeCloseTo(350 / 660);
    expect(b.to).toBeCloseTo(550 / 660);
    expect(b.tick).toBeCloseTo(400 / 660);
    expect(barOf(row(), 900)!.tick).toBeCloseTo(1 / 1.2);
    expect(barOf(row({ suggested: null }), 400)).toBeNull();
  });

  it("dollars: a clear is null, junk is invalid", () => {
    expect(parseDollars("$1,200")).toBe(1200);
    expect(parseDollars("")).toBeNull();
    expect(Number.isNaN(parseDollars("about 5") as number)).toBe(true);
    expect(Number.isNaN(parseDollars("0") as number)).toBe(true);
  });

  it("writes only what she changed: minimums in dollars (clearable), booking prices in cents", () => {
    const rows = [
      row({ minimum: { value: 400, source: "set" } }),
      row({ rate_type: "ig_post", minimum: { value: 250, source: "earlier" } }),
      row({ rate_type: "booking_video_call_30", group: "booking", price: { cents: 9000, offer_id: "o", duration_minutes: 30, status: "published" } }),
      row({ rate_type: "ig_story" }),
    ];
    expect(initialText(rows[2])).toBe("90");
    const w = writeOf({ ig_reel: "400", ig_post: "", booking_video_call_30: "120", ig_story: "abc" }, rows);
    expect(w.body).toEqual({ minimums: { ig_post: null }, prices: { booking_video_call_30: 12000 } });
    expect(w.invalid).toEqual(["ig_story"]);
  });
});
