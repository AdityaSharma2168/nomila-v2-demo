/**
 * BriefProposalCard.test — Mila's suggestion card: what changed, hers now beside the suggestion, the sources; Update ·
 * Edit it · Keep mine each answer POST /me/agent/suggestions/:id once and settle the card; nothing is sent until a tap;
 * an answer already given (re-read from history) shows settled with no buttons; a failed answer says so and keeps them.
 */
import React from "react";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderAgent } from "../../test/agentHarness";
import { AgentCard } from "./AgentCard";
import type { AnyChatCard } from "../../lib/agent/types";

jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));
jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("expo-blur", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { BlurView: (p: Record<string, unknown>) => React.createElement(View, p) };
});
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("../../hooks/use-platform-oauth", () => ({ usePlatformOAuth: () => ({ connect: jest.fn(), disconnect: jest.fn(), connecting: false }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});
const apiRequest = jest.fn(async (..._a: unknown[]) => ({ json: async () => ({ ok: true }) }));
jest.mock("../../lib/query-client", () => ({ ...jest.requireActual("../../lib/query-client"), apiRequest: (...a: unknown[]) => apiRequest(...a) }));

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
beforeEach(() => apiRequest.mockClear());

const card = (answered: null | "update" | "keep_mine" | "edit" = null): AnyChatCard => ({
  id: "brief-proposal:d1", kind: "brief-proposal", title: "A suggestion for your positioning", links: [], runId: null,
  payload: {
    decisionId: "d1", reason: "You made the national team.", changed: ["thesis", "positioning"],
    before: { bigIdea: "A conference champion.", statement: "Results first.", from: "", to: "", pillars: [], contentPillars: ["Race days"] },
    after: { bigIdea: "A national-team swimmer.", statement: "From conference champion to national team.", from: "", to: "", pillars: [], contentPillars: ["Team training"] },
    sources: [{ label: "News", url: "https://example.org/news" }], buttons: ["update", "keep_mine", "edit"], answered,
  },
} as AnyChatCard);

test("shows what changed and hers beside the suggestion; nothing is sent until a tap", () => {
  renderAgent(<AgentCard card={card()} />);
  expect(screen.getByTestId("card-brief-proposal")).toBeTruthy();
  expect(screen.getByText("You made the national team.")).toBeTruthy();
  expect(screen.getByText("Results first.")).toBeTruthy();
  expect(screen.getByText("From conference champion to national team.")).toBeTruthy();
  expect(apiRequest).not.toHaveBeenCalled();
});

test("Update answers once and settles", async () => {
  renderAgent(<AgentCard card={card()} />);
  fireEvent.press(screen.getByTestId("suggestion-update"));
  await flush();
  expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/agent/suggestions/d1", { response: "update" });
  expect(screen.getByTestId("suggestion-updated")).toBeTruthy();
  expect(screen.queryByTestId("suggestion-update")).toBeNull();
});

test("Edit it sends her words", async () => {
  renderAgent(<AgentCard card={card()} />);
  fireEvent.press(screen.getByTestId("suggestion-edit"));
  fireEvent.changeText(screen.getByTestId("suggestion-editor"), "National team, student first.");
  fireEvent.press(screen.getByTestId("suggestion-save"));
  await flush();
  expect(apiRequest).toHaveBeenCalledWith("POST", "/api/v1/me/agent/suggestions/d1", { response: "edit", statement: "National team, student first." });
  expect(screen.getByTestId("suggestion-edited")).toBeTruthy();
});

test("Keep mine answers and settles; a failure keeps the buttons and says so", async () => {
  renderAgent(<AgentCard card={card()} />);
  apiRequest.mockRejectedValueOnce(new Error("500: boom"));
  fireEvent.press(screen.getByTestId("suggestion-keep"));
  await flush();
  expect(screen.getByText("That didn't save. Try again.")).toBeTruthy();
  expect(screen.getByTestId("suggestion-keep")).toBeTruthy();
  fireEvent.press(screen.getByTestId("suggestion-keep"));
  await flush();
  expect(apiRequest).toHaveBeenLastCalledWith("POST", "/api/v1/me/agent/suggestions/d1", { response: "keep_mine" });
  expect(screen.getByTestId("suggestion-kept")).toBeTruthy();
});

test("an answer already given shows settled, with no buttons", () => {
  renderAgent(<AgentCard card={card("keep_mine")} />);
  expect(screen.getByTestId("suggestion-kept")).toBeTruthy();
  expect(screen.queryByTestId("suggestion-update")).toBeNull();
});
