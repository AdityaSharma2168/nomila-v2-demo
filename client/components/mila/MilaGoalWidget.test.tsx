/**
 * MilaGoalWidget.test — Mila's goal confirm card (Goals PR §3f). Nothing is written until she taps the primary button;
 * the tap calls the SAME goal routes the app's sheets call; "Change it" writes nothing and hands back to the composer.
 */
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { MilaGoalWidget } from "./MilaGoalWidget";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const create = { mutate: jest.fn(), isPending: false, isError: false };
const decide = { mutate: jest.fn(), isPending: false, isError: false };
jest.mock("../../hooks/use-objectives", () => ({ useCreateObjective: () => create, useDecideObjective: () => decide }));

const base = { goalId: null, goal: "Land a paid deal with a skincare brand this year", domain: "commercial", byWhen: "next_12_months", howSheKnows: null, removeAs: null, currentGoal: null } as const;

beforeEach(() => { create.mutate.mockReset(); decide.mutate.mockReset(); });

describe("Mila's goal card", () => {
  it("add: the goal, the domain and the horizon; nothing is written until Add goal; then it says so and the buttons go", () => {
    render(<MilaGoalWidget data={{ ...base, change: "add" }} />);
    expect(screen.getByText("Add this goal?")).toBeTruthy();
    expect(screen.getByText("Commercial")).toBeTruthy();
    expect(screen.getByText("Next 12 months")).toBeTruthy();
    expect(screen.getByText("Mila never changes your goals without your tap.")).toBeTruthy();
    expect(create.mutate).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId("mila-goal-confirm"));
    expect(create.mutate.mock.calls[0][0]).toEqual({ desiredState: base.goal, domain: "commercial", horizon: { kind: "period", period: "next_12_months", why: "she chose this horizon" }, observableCondition: undefined });
    act(() => { create.mutate.mock.calls[0][1].onSuccess(); });
    expect(screen.getByTestId("mila-goal-done")).toBeTruthy();
    expect(screen.queryByTestId("mila-goal-confirm")).toBeNull();
  });

  it("Change it writes nothing", () => {
    render(<MilaGoalWidget data={{ ...base, change: "add" }} />);
    fireEvent.press(screen.getByTestId("mila-goal-change"));
    expect(screen.getByText("Tell Mila what to change.")).toBeTruthy();
    expect(create.mutate).not.toHaveBeenCalled();
  });

  it("edit and remove go through the decision route: modify, achieve, abandon", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const a = render(<MilaGoalWidget data={{ ...base, change: "edit", goalId: id, currentGoal: "An older wording" }} />);
    expect(screen.getByText("Now: An older wording")).toBeTruthy();
    fireEvent.press(screen.getByTestId("mila-goal-confirm"));
    expect(decide.mutate.mock.calls[0][0]).toEqual({ id, action: "modify", desiredState: base.goal, horizon: { kind: "period", period: "next_12_months", why: "she chose this horizon" } });
    a.unmount();
    const b = render(<MilaGoalWidget data={{ ...base, change: "remove", goalId: id, removeAs: "achieved" }} />);
    fireEvent.press(screen.getByTestId("mila-goal-confirm"));
    expect(decide.mutate.mock.calls[1][0]).toEqual({ id, action: "achieve" });
    b.unmount();
    render(<MilaGoalWidget data={{ ...base, change: "remove", goalId: id, removeAs: "not_for_me" }} />);
    fireEvent.press(screen.getByTestId("mila-goal-confirm"));
    expect(decide.mutate.mock.calls[2][0]).toEqual({ id, action: "abandon" });
  });
});
