/**
 * use-studio-media.test — the picker's list hook restarts from page 1 when the server refuses the
 * cursor it sent (PR 12, ruling 5). The order can change under her (the server's flag flips); the
 * pages she holds are then in an order the list no longer serves, and page N+1 in the old order
 * would repeat and skip rows.
 *
 * ⚠️ MUTATION "stale cursor strands the picker": drop the reset effect in useStudioMedia, or make
 * `isStaleCursor` return false — the hook sits in error with its stale pages; reds by name.
 */
import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("../lib/query-client", () => ({
  getApiUrl: () => "https://example.test",
  getAuthHeaders: async () => ({}),
}));

import {
  useStudioMedia,
  StaleCursorError,
  fetchStudioMediaPage,
} from "./use-studio-media";

const PARAMS = {
  kind: "photos" as const,
  origins: ["upload"] as const,
  still: false,
  pageSize: 2,
};
const photo = (id: string) => ({
  kind: "photo",
  assetId: id,
  imageUrl: "i",
  thumbUrl: "t",
  origin: "upload",
});

type Reply = { status: number; body: unknown };
let replies: ((url: string) => Reply)[] = [];
const calls: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  (globalThis as any).fetch = async (input: any) => {
    const url = String(input);
    calls.push(url);
    const next = replies.shift();
    const r = next
      ? next(url)
      : { status: 200, body: { items: [], nextCursor: null } };
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  };
});
afterAll(() => {
  (globalThis as any).fetch = realFetch;
});

const wrap = (qc: QueryClient) => {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return Wrapper;
};

it("fetchStudioMediaPage names a refused cursor, and only that", async () => {
  replies = [
    () => ({
      status: 400,
      body: {
        error: "that cursor isn't one this list handed out",
        field: "cursor",
      },
    }),
  ];
  await expect(fetchStudioMediaPage(PARAMS, "stale")).rejects.toBeInstanceOf(
    StaleCursorError,
  );
  replies = [() => ({ status: 400, body: { error: "limit", field: "limit" } })];
  await expect(
    fetchStudioMediaPage(PARAMS, "stale"),
  ).rejects.not.toBeInstanceOf(StaleCursorError);
  replies = [
    () => ({ status: 400, body: { error: "cursor", field: "cursor" } }),
  ];
  await expect(fetchStudioMediaPage(PARAMS, null)).rejects.not.toBeInstanceOf(
    StaleCursorError,
  );
});

it("a stale cursor on page 2 restarts the list from page 1 — the stale pages are gone, the new first page is held", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replies = [
    () => ({
      status: 200,
      body: { items: [photo("a"), photo("b")], nextCursor: "c1" },
    }), // page 1, old order
    () => ({
      status: 400,
      body: {
        error: "that cursor isn't one this list handed out",
        field: "cursor",
      },
    }), // page 2: refused
    () => ({
      status: 200,
      body: { items: [photo("z"), photo("y")], nextCursor: "c2" },
    }), // page 1 again, new order
  ];
  const { result } = renderHook(() => useStudioMedia(PARAMS), {
    wrapper: wrap(qc),
  });
  await waitFor(() =>
    expect(result.current.data?.pages[0]?.items.map((r) => r.assetId)).toEqual([
      "a",
      "b",
    ]),
  );

  await act(async () => {
    await result.current.fetchNextPage();
  });

  await waitFor(() =>
    expect(
      result.current.data?.pages.map((p) => p.items.map((r) => r.assetId)),
    ).toEqual([["z", "y"]]),
  );
  expect(result.current.isError).toBe(false);
  // Three requests: page 1, the refused page 2 with our cursor, page 1 again with none.
  expect(calls.map((u) => new URL(u).searchParams.get("cursor"))).toEqual([
    null,
    "c1",
    null,
  ]);
});
