/**
 * use-athlete-record.test.ts — the record hook's routes, pinned.
 *
 * Why this exists: PR B shipped with "/me/record" and the phone got a 404 ("Couldn't load your
 * record"). apiRequest takes the FULL route including /api/v1 — every other hook does that, and
 * now this one is checked. Runs the queryFn / mutationFn bodies directly against a mocked
 * apiRequest; no React rendering needed.
 */

jest.mock("../lib/query-client", () => ({
  apiRequest: jest.fn(async () => ({ json: async () => ({ ok: true }) })),
}));

const calls: Array<[string, string, unknown]> = [];
const qc = { invalidateQueries: jest.fn(async () => undefined) };
jest.mock("@tanstack/react-query", () => ({
  useQuery: (o: any) => ({ __opts: o }),
  useMutation: (o: any) => ({ __opts: o }),
  useQueryClient: () => qc,
}));

import { apiRequest } from "../lib/query-client";
import { useAthleteRecord, useRecordHistory, useUndoRecordWrite, useWriteRecordField } from "./use-athlete-record";

beforeEach(() => { (apiRequest as jest.Mock).mockClear(); calls.length = 0; qc.invalidateQueries.mockClear(); });

test("every route carries the /api/v1 prefix", async () => {
  await (useAthleteRecord() as any).__opts.queryFn();
  await (useRecordHistory("hometown") as any).__opts.queryFn();
  await (useWriteRecordField() as any).__opts.mutationFn({ field: "hometown", value: "Dublin, Ohio", said: "I'm from Dublin" });
  await (useUndoRecordWrite() as any).__opts.mutationFn({ agentActionId: "abc", field: "hometown" });
  const seen = (apiRequest as jest.Mock).mock.calls.map((c) => [c[0], c[1]]);
  expect(seen).toEqual([
    ["GET", "/api/v1/me/record"],
    ["GET", "/api/v1/me/record/history/hometown"],
    ["PUT", "/api/v1/me/record/hometown"],
    ["POST", "/api/v1/me/agent-actions/abc/undo"],
  ]);
  const putBody = (apiRequest as jest.Mock).mock.calls[2][2];
  expect(putBody).toEqual({ value: "Dublin, Ohio", said: "I'm from Dublin" });
});

test("history is disabled without a field; writes invalidate the record and the field's history", async () => {
  expect((useRecordHistory(null) as any).__opts.enabled).toBe(false);
  const w = (useWriteRecordField() as any).__opts;
  await w.onSuccess({ ok: true }, { field: "goal", value: "" });
  const keys = qc.invalidateQueries.mock.calls.map((c: any) => c[0].queryKey);
  expect(keys).toEqual([["me", "record"], ["me", "record", "history", "goal"], ["me"]]);
});
