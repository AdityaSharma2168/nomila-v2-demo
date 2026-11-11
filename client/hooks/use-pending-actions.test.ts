/**
 * use-pending-actions.test.ts — the client half of the governed send path, pinned.
 *
 *  - every approve carries body_sha256 of the body the athlete was shown, computed with the
 *    SAME shared helper the server re-hashes with (and equal to Node's sha256 over UTF-8);
 *  - a one-tap send is propose → approve on the same body, never the deprecated
 *    /inbox/threads/:id/reply;
 *  - useThreadReply goes through that path and refuses (no request at all) without a deal;
 *  - no client source file POSTs to /inbox/threads/:id/reply any more.
 *
 * Runs the mutationFn bodies directly against a mocked apiRequest; no React rendering.
 */

jest.mock("../lib/query-client", () => ({
  apiRequest:  jest.fn(),
  queryClient: { invalidateQueries: jest.fn() },
}));

const qc = { invalidateQueries: jest.fn(async () => undefined) };
jest.mock("@tanstack/react-query", () => ({
  useQuery:       (o: any) => ({ __opts: o }),
  useMutation:    (o: any) => ({ __opts: o }),
  useQueryClient: () => qc,
}));

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { apiRequest } from "../lib/query-client";
import { bodySha256 } from "../../shared/bodyHash";
import {
  approvePendingAction,
  approveRequestBody,
  proposeAndApproveReply,
  useApprovePendingAction,
} from "./use-pending-actions";
import { useThreadReply, NO_DEAL_FOR_THREAD_ERROR } from "./use-thread";

const api = apiRequest as jest.Mock;
const nodeSha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(async (_m: string, route: string) => ({
    json: async () => (route.endsWith("/pending-actions") ? { id: "pa-1" } : { id: "pa-1", status: "approved" }),
  }));
});

test("the shared hash is sha256 over the exact UTF-8 bytes — no trimming or normalisation", () => {
  for (const s of ["", "Thanks!", "Café — $1,200 ✨ 🏆", "a\r\nb  ", "é vs é"]) {
    expect(bodySha256(s)).toBe(nodeSha(s));
  }
  expect(bodySha256("Hi ")).not.toBe(bodySha256("Hi"));
});

test("approve sends body_sha256 of the displayed body", async () => {
  await approvePendingAction("pa-9", "What she saw");
  expect(api).toHaveBeenCalledWith("POST", "/api/v1/me/pending-actions/pa-9/approve", {
    body_sha256: nodeSha("What she saw"),
  });
  expect(approveRequestBody("x")).toEqual({ body_sha256: nodeSha("x") });
});

test("useApprovePendingAction requires and hashes the body", async () => {
  await (useApprovePendingAction() as any).__opts.mutationFn({ id: "pa-2", body: "Row body", threadId: "t", dealId: "d" });
  expect(api).toHaveBeenCalledWith("POST", "/api/v1/me/pending-actions/pa-2/approve", { body_sha256: nodeSha("Row body") });
});

test("a reviewed approve (ask-terms batch row) carries reviewed: true beside the hash; others never do", async () => {
  await (useApprovePendingAction() as any).__opts.mutationFn({ id: "pa-3", body: "Batch row", reviewed: true });
  expect(api).toHaveBeenCalledWith("POST", "/api/v1/me/pending-actions/pa-3/approve", {
    body_sha256: nodeSha("Batch row"),
    reviewed:    true,
  });
  expect(approveRequestBody("x", { reviewed: false })).toEqual({ body_sha256: nodeSha("x") });
});

test("proposeAndApproveReply proposes the body, then approves THAT body — never /reply", async () => {
  await proposeAndApproveReply({ dealId: "d1", threadId: "t1", body: "Counter at $900", payload: { reply_intent: "negotiate" } });

  expect(api.mock.calls).toEqual([
    ["POST", "/api/v1/me/deals/d1/pending-actions", {
      kind: "send_reply", thread_id: "t1", payload: { reply_intent: "negotiate", body: "Counter at $900" },
    }],
    ["POST", "/api/v1/me/pending-actions/pa-1/approve", { body_sha256: nodeSha("Counter at $900") }],
  ]);
});

test("a propose failure never approves (nothing sends)", async () => {
  api.mockImplementationOnce(async () => { throw new Error("400: {\"error\":\"nope\"}"); });
  await expect(proposeAndApproveReply({ dealId: "d1", threadId: "t1", body: "x" })).rejects.toThrow(/nope/);
  expect(api).toHaveBeenCalledTimes(1);
});

test("useThreadReply goes propose → approve on the thread's deal", async () => {
  await (useThreadReply("t7", "d7") as any).__opts.mutationFn("Sounds good");
  expect(api.mock.calls.map((c) => [c[0], c[1]])).toEqual([
    ["POST", "/api/v1/me/deals/d7/pending-actions"],
    ["POST", "/api/v1/me/pending-actions/pa-1/approve"],
  ]);
  expect(api.mock.calls[1][2]).toEqual({ body_sha256: nodeSha("Sounds good") });
});

test("useThreadReply without a deal refuses and makes no request", async () => {
  await expect((useThreadReply("t7", null) as any).__opts.mutationFn("hi")).rejects.toThrow(NO_DEAL_FOR_THREAD_ERROR);
  expect(api).not.toHaveBeenCalled();
});

test("no client source POSTs to the deprecated /inbox/threads/:id/reply", () => {
  const root = join(__dirname, "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      if (/\/inbox\/threads\/\$\{[^}]+\}\/reply\b/.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});

describe("sendErrorMessage", () => {
  const { sendErrorMessage } = require("./use-pending-actions");
  it("never shows a status code: a changed body asks her to reopen, an in-flight send says so, anything else is the connection line", () => {
    expect(sendErrorMessage(new Error('409: {"error":"BODY_MISMATCH"}'))).toMatch(/changed since you opened it/);
    expect(sendErrorMessage(new Error('409: {"error":"not pending"}'))).toMatch(/already sent or is being sent/);
    expect(sendErrorMessage(new Error("500: boom"))).toBe("Check your Gmail connection and try again.");
  });

  it("an Outlook refusal names Outlook, and a missing send permission says to reconnect", () => {
    const scope = '403: {"error":"Reconnect Outlook to allow sending: ...","code":"SCOPE_MISSING"}';
    expect(sendErrorMessage(new Error(scope))).toMatch(/^Reconnect Outlook in Settings to allow sending\. Nothing was sent/);
    expect(sendErrorMessage(new Error('422: {"error":"... Reply in Outlook."}'))).toMatch(/Outlook connection/);
    expect(sendErrorMessage(new Error(scope))).not.toMatch(/Gmail/);
  });
});
