import { QueryClient } from "@tanstack/react-query";
import { isDealQueryKey, invalidateDealQueries } from "./dealQueryKeys";

describe("isDealQueryKey", () => {
  it("matches the real URL-string keys the deal screens use", () => {
    for (const k of [
      "/api/v1/me/deals?view=active",
      "/api/v1/me/deals?view=archived",
      "/api/v1/me/deals?id=d1",
      "/api/v1/me/deals/counts",
      "/api/v1/me/opportunities",
      "/api/v1/me/opportunities/o1",
      "/api/v1/me/opportunities/o1/brand",
      "/api/v1/me/inbox/threads/t1",
      "/api/v1/me/pending-actions",
    ]) expect(isDealQueryKey([k])).toBe(true);
    expect(isDealQueryKey(["me", "what-matters-next"])).toBe(true);
    expect(isDealQueryKey(["me", "financials"])).toBe(true);
  });

  it("leaves unrelated queries alone", () => {
    expect(isDealQueryKey(["/api/v1/me/preferences"])).toBe(false);
    expect(isDealQueryKey(["/api/v1/me/dealsomething"])).toBe(false);
    expect(isDealQueryKey(["me", "bookings", "summary"])).toBe(false);
    expect(isDealQueryKey(["/api/v1/me/connections"])).toBe(false);
  });
});

describe("invalidateDealQueries", () => {
  it("marks every deal query stale, which the old prefix key never did", async () => {
    const qc = new QueryClient();
    qc.setQueryData(["/api/v1/me/deals?view=active"], []);
    qc.setQueryData(["/api/v1/me/opportunities"], {});
    qc.setQueryData(["/api/v1/me/preferences"], {});
    await qc.invalidateQueries({ queryKey: ["/api/v1/me/deals"] });
    expect(qc.getQueryState(["/api/v1/me/deals?view=active"])?.isInvalidated).toBe(false);
    await invalidateDealQueries(qc);
    expect(qc.getQueryState(["/api/v1/me/deals?view=active"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["/api/v1/me/opportunities"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["/api/v1/me/preferences"])?.isInvalidated).toBe(false);
    qc.clear();
  });
});
