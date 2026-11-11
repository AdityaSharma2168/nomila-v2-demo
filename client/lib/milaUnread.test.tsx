/**
 * milaUnread.test — the Mila tab's unread dot (EXPO_PUBLIC_MILA_PROACTIVE): off ⇒ no request at all and 0; on ⇒ the
 * count from /me/mila/unread, refreshed when the app comes to the front, and opening a chat marks it seen then refreshes.
 */
import { act, renderHook } from "@testing-library/react-native";
import * as m from "./milaUnread";

jest.mock("./query-client", () => ({ getApiUrl: () => "https://api.test", getAuthHeaders: async () => ({ Authorization: "Bearer t" }) }));

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
  m.__resetMilaUnread();
});
afterEach(() => { delete process.env.EXPO_PUBLIC_MILA_PROACTIVE; });


it("off: nothing is asked, the count is 0", async () => {
  const { result } = renderHook(() => m.useMilaUnread());
  expect(await m.refreshMilaUnread()).toBe(0);
  await m.markConversationSeen("c1");
  expect(result.current).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("on: the server's count; opening a chat marks it seen and refreshes", async () => {
  process.env.EXPO_PUBLIC_MILA_PROACTIVE = "true";
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ count: 2, latest: null }) });
  const { result } = renderHook(() => m.useMilaUnread());
  await act(async () => { await m.refreshMilaUnread(); });
  expect(result.current).toBe(2);
  expect(fetchMock).toHaveBeenCalledWith("https://api.test/api/v1/me/mila/unread", expect.objectContaining({ method: "GET" }));

  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, seen: 2 }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ count: 0 }) });
  await act(async () => { await m.markConversationSeen("c1"); });
  expect(fetchMock.mock.calls[0][0]).toBe("https://api.test/api/v1/me/conversations/c1/seen");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  expect(result.current).toBe(0);
});

it("on: a failed request keeps the last count", async () => {
  process.env.EXPO_PUBLIC_MILA_PROACTIVE = "true";
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ count: 1 }) });
  const { result } = renderHook(() => m.useMilaUnread());
  await act(async () => { await m.refreshMilaUnread(); });
  fetchMock.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await m.refreshMilaUnread(); });
  expect(result.current).toBe(1);
});
