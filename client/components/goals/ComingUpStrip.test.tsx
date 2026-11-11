/**
 * ComingUpStrip.test — Home's "Coming up" (AGENT_V3 + AGENT_PLAN) over typed GET /me/agent/goals `comingUp` fixtures,
 * through the in-memory AgentApi (no provider reached), plus the small date and horizon rules it shares with Goals.
 */
import React from "react";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react-native";
import { renderAgent } from "../../test/agentHarness";
import { GOALS_PLAN_FIXTURE } from "../../lib/agent/goalsFixtures";
import { ComingUpStrip, COMING_UP_COPY, HomeComingUp } from "./ComingUpStrip";
import { beforeLine, dateLeaf, eventDateWords, horizonLabel, readyWords } from "../../lib/agent/goalsLogic";

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("../../lib/auth-context", () => ({ useAuth: () => ({ athlete: { id: "ath-1" } }) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }), useIsFocused: () => true }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(60_000);

const ITEMS = GOALS_PLAN_FIXTURE.comingUp;
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

describe("the rules", () => {
  it("dates at their precision, never ISO", () => {
    expect(eventDateWords("2026-10-18", "day")).toBe("Sun 18 Oct");
    expect(eventDateWords("2026-12-01", "month")).toBe("December");
    expect(eventDateWords("2027-01-01", "year")).toBe("2027");
    expect(dateLeaf("2026-10-18", "day")).toEqual({ day: "18", month: "Oct" });
    expect(dateLeaf("2026-12-01", "month")).toEqual({ day: "Dec", month: "2026" });
    expect(beforeLine({ label: "[Event A]", date: "2026-10-18", precision: "day" })).toBe("Before [Event A] on 18 Oct");
    expect(beforeLine({ label: "[Event C]", date: "2026-12-01", precision: "month" })).toBe("Before [Event C] in December");
  });

  it("horizons read This month · This quarter · This year", () => {
    expect([horizonLabel("now"), horizonLabel("next"), horizonLabel("later"), horizonLabel(null)]).toEqual(["This month", "This quarter", "This year", null]);
  });

  it("ready words", () => {
    expect(readyWords(2)).toEqual({ ready: true, text: "2 ready" });
    expect(readyWords(0)).toEqual({ ready: false, text: "Nothing to prepare yet" });
  });
});

describe("ComingUpStrip", () => {
  it("the next three events: date leaf, label, date in words, ready state", () => {
    renderAgent(<ComingUpStrip items={ITEMS} onOpen={jest.fn()} />);
    expect(screen.getByText(COMING_UP_COPY.heading)).toBeTruthy();
    const a = within(screen.getByTestId("coming-up-fact-event-a"));
    expect(a.getByText("[Event A]")).toBeTruthy();
    expect(a.getByText("Sun 18 Oct")).toBeTruthy();
    expect(a.getByText("2 ready")).toBeTruthy();
    expect(screen.getByTestId("coming-up-ready-fact-event-a")).toBeTruthy();
    const b = within(screen.getByTestId("coming-up-fact-event-b"));
    expect(b.getByText("Nothing to prepare yet")).toBeTruthy();
    expect(screen.queryByTestId("coming-up-ready-fact-event-b")).toBeNull();
    // A month-only date reads its month, never "1 Dec".
    const c = within(screen.getByTestId("coming-up-fact-event-c"));
    expect(c.getByText("December")).toBeTruthy();
    expect(c.getByText("1 ready")).toBeTruthy();
    expect(c.queryByText(/1 Dec/)).toBeNull();
  });

  it("never more than three", () => {
    const more = [...ITEMS, { ...ITEMS[0], factId: "fact-event-d", label: "[Event D]" }];
    renderAgent(<ComingUpStrip items={more} onOpen={jest.fn()} />);
    expect(screen.queryByTestId("coming-up-fact-event-d")).toBeNull();
  });

  it("a tap anywhere on a row opens it", () => {
    const onOpen = jest.fn();
    renderAgent(<ComingUpStrip items={ITEMS} onOpen={onOpen} />);
    fireEvent.press(screen.getByTestId("coming-up-fact-event-a"));
    expect(onOpen).toHaveBeenCalledWith(ITEMS[0]);
  });

  it("nothing coming up: nothing drawn", () => {
    renderAgent(<ComingUpStrip items={[]} onOpen={jest.fn()} />);
    expect(screen.queryByTestId("home-coming-up")).toBeNull();
  });
});

describe("HomeComingUp (Home's strip over the Goals read)", () => {
  it("draws the served events and opens Goals at the timed goal", async () => {
    const onOpen = jest.fn();
    renderAgent(<HomeComingUp enabled onOpen={onOpen} />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await tick();
    await waitFor(() => expect(screen.getByTestId("home-coming-up")).toBeTruthy());
    fireEvent.press(screen.getByTestId("coming-up-fact-event-c"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ goalId: "goal-3" }));
  });

  it("route dark (AGENT_PLAN off): nothing, so Home is unchanged", async () => {
    const { api } = renderAgent(<HomeComingUp enabled onOpen={jest.fn()} />);
    await tick();
    await waitFor(() => expect(api.readGoals).toHaveBeenCalled());
    await tick();
    expect(screen.queryByTestId("home-coming-up")).toBeNull();
  });

  it("flag off: never reads", async () => {
    const { api } = renderAgent(<HomeComingUp enabled={false} onOpen={jest.fn()} />, { opts: { plan: GOALS_PLAN_FIXTURE } });
    await tick();
    expect(api.readGoals).not.toHaveBeenCalled();
    expect(screen.queryByTestId("home-coming-up")).toBeNull();
  });
});
