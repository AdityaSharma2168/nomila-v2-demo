/**
 * CardChatsScreen.test — Me › Public card › Chats on your card. The hooks are replaced; the screen's own decisions are
 * tested:
 *
 *   H1 empty: one plain line, no dead buttons
 *   H2 the list: the visitor's first message, the door, the count; "Show older" only when there is an older page
 *   H3 a chat: every message labelled Visitor / Mila, the card section Mila answered from, the card Mila showed
 *   H4 delete takes two taps and calls the route with that chat's id; "Keep it" calls nothing
 *   H5 the nav entry opens the screen in either shell
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { CardChatsScreen, CARD_CHATS_COPY } from "./CardChatsScreen";
import { openCardChats } from "../../navigation/meNav";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }) }));
jest.mock("../../lib/haptics", () => {
  const fns = { tap: () => {}, press: () => {}, select: () => {}, success: () => {}, warning: () => {}, error: () => {} };
  return { ...fns, haptics: fns };
});

const state = {
  list: { chats: [] as any[], isLoading: false, isError: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: jest.fn(), refetch: jest.fn() },
  chat: null as any,
  del: { mutate: jest.fn(), isPending: false, isError: false },
};
jest.mock("../../hooks/use-card-chats", () => ({
  useCardChats: () => state.list,
  useCardChat: (id: string | null) => ({ data: id ? state.chat : undefined, isLoading: false, isError: false, refetch: jest.fn() }),
  useDeleteCardChat: () => state.del,
}));

const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id, intent: "ask", startedAt: "2026-10-08T15:30:00.000Z", lastTurnAt: "2026-10-08T15:32:00.000Z", turns: 2, status: "ended", firstMessage: "Who has Kai worked with?", ...over,
});

beforeEach(() => {
  state.list = { ...state.list, chats: [], hasNextPage: false, fetchNextPage: jest.fn() };
  state.del.mutate.mockReset();
});

it("H1 empty: one plain line and nothing to tap", () => {
  render(<CardChatsScreen />);
  expect(screen.getByTestId("chats-empty").props.children).toBe(CARD_CHATS_COPY.empty);
  expect(screen.queryByTestId("chats-older")).toBeNull();
});

it("H2 the list shows the first message, door and count; Show older only with an older page", () => {
  state.list.chats = [summary("c1"), summary("c2", { intent: "book", turns: 1, firstMessage: "When can I book?" })];
  const a = render(<CardChatsScreen />);
  expect(screen.getByText("“Who has Kai worked with?”")).toBeTruthy();
  expect(screen.getByText(/^Book · 1 question · /)).toBeTruthy();
  expect(screen.queryByTestId("chats-older")).toBeNull();
  a.unmount();
  state.list.hasNextPage = true;
  render(<CardChatsScreen />);
  fireEvent.press(screen.getByTestId("chats-older"));
  expect(state.list.fetchNextPage).toHaveBeenCalled();
});

it("H3 a chat shows each message as the visitor typed it and as Mila showed it, with its sources", () => {
  state.list.chats = [summary("c1")];
  state.chat = {
    ...summary("c1"),
    messages: [
      { from: "visitor", text: "Who has Kai worked with?", chapter: null, widget: null, at: "2026-10-08T15:30:00.000Z" },
      { from: "mila", text: "From Kai's Partnerships card: Kai has worked with Example Outfitters.", chapter: "partnerships", widget: null, at: "2026-10-08T15:30:02.000Z" },
      { from: "visitor", text: "Any merch?", chapter: null, widget: null, at: "2026-10-08T15:31:00.000Z" },
      { from: "mila", text: "Here are Kai's picks.", chapter: null, widget: { type: "picks" }, at: "2026-10-08T15:31:02.000Z" },
    ],
  };
  render(<CardChatsScreen />);
  fireEvent.press(screen.getByTestId("chat-row-c1"));
  expect(screen.getAllByTestId("msg-visitor")).toHaveLength(2);
  expect(screen.getAllByTestId("msg-mila")).toHaveLength(2);
  expect(screen.getByText("From your Partnerships card")).toBeTruthy();
  expect(screen.getByText("Mila showed your picks")).toBeTruthy();
});

it("H4 delete takes two taps; Keep it calls nothing", () => {
  state.list.chats = [summary("c1")];
  state.chat = { ...summary("c1"), messages: [] };
  render(<CardChatsScreen />);
  fireEvent.press(screen.getByTestId("chat-row-c1"));
  fireEvent.press(screen.getByTestId("chat-delete"));
  fireEvent.press(screen.getByTestId("chat-delete-keep"));
  expect(state.del.mutate).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId("chat-delete"));
  fireEvent.press(screen.getByTestId("chat-delete-confirm"));
  expect(state.del.mutate.mock.calls[0][0]).toBe("c1");
});

it("H5 openCardChats lands on the screen (Home › CardChats)", () => {
  const nav = (routeNames: string[]) => {
    const navigate = jest.fn();
    return { navigate, getParent: () => undefined, getState: () => ({ routeNames }) };
  };
  const shell = nav(["Tabs", "Brand"]);
  openCardChats(shell);
  expect(shell.navigate).toHaveBeenCalledWith("Home", { screen: "CardChats" });
});
