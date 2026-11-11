/**
 * deleteAthleteTraces — find her traces by userId and delete them. The Langfuse API is a mocked fetch: no
 * provider is reached.
 */

jest.mock("../../logger", () => ({ createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) }));

import { deleteAthleteTraces } from "./langfuseTraces";

const ENV = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
  process.env.LANGFUSE_BASE_URL = "https://langfuse.example/";
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const ATHLETE = "11111111-2222-3333-4444-555555555555";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("deleteAthleteTraces", () => {
  it("does nothing when the Langfuse keys are not configured", async () => {
    delete process.env.LANGFUSE_SECRET_KEY;
    const fetchImpl = jest.fn();
    expect(await deleteAthleteTraces(ATHLETE, fetchImpl)).toEqual({ outcome: "not_configured", traces: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pages through her observations by userId, dedupes trace ids, and deletes them", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(json({ data: [{ traceId: "t1" }, { traceId: "t2" }, { traceId: "t1" }], meta: { cursor: "c2" } }))
      .mockResolvedValueOnce(json({ data: [{ traceId: "t3" }, { traceId: null }], meta: {} }))
      .mockResolvedValueOnce(json({ message: "Traces deleted successfully" }));
    expect(await deleteAthleteTraces(ATHLETE, fetchImpl)).toEqual({ outcome: "deleted", traces: 3 });

    const first = new URL(fetchImpl.mock.calls[0][0]);
    expect(first.origin + first.pathname).toBe("https://langfuse.example/api/public/v2/observations");
    expect(first.searchParams.get("userId")).toBe(ATHLETE);
    expect(first.searchParams.get("cursor")).toBeNull();
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Basic " + Buffer.from("pk-lf-test:sk-lf-test").toString("base64"));
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("cursor")).toBe("c2");

    const [delUrl, delInit] = fetchImpl.mock.calls[2];
    expect(delUrl).toBe("https://langfuse.example/api/public/traces");
    expect(delInit.method).toBe("DELETE");
    expect(JSON.parse(delInit.body)).toEqual({ traceIds: ["t1", "t2", "t3"] });
  });

  it("reports none_found without calling delete", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(json({ data: [], meta: {} }));
    expect(await deleteAthleteTraces(ATHLETE, fetchImpl)).toEqual({ outcome: "none_found", traces: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports failed on an API error or a network error, never throws", async () => {
    expect(await deleteAthleteTraces(ATHLETE, jest.fn().mockResolvedValueOnce(json({}, 401))))
      .toMatchObject({ outcome: "failed", detail: "langfuse list 401" });
    const delFails = jest.fn().mockResolvedValueOnce(json({ data: [{ traceId: "t1" }], meta: {} })).mockResolvedValueOnce(json({}, 500));
    expect(await deleteAthleteTraces(ATHLETE, delFails)).toMatchObject({ outcome: "failed", traces: 1 });
    expect(await deleteAthleteTraces(ATHLETE, jest.fn().mockRejectedValue(new Error("ETIMEDOUT"))))
      .toMatchObject({ outcome: "failed", detail: "ETIMEDOUT" });
  });
});
