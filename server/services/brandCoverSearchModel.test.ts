/**
 * brandCoverSearchModel.test.ts — which pages the brand/cover-search skill may hand lib/brandImage. A fake Responses
 * transport stands in for OpenAI: no test reaches a provider.
 */
import { setResponsesTransport } from "../agent/research/llm";
import { fakeResponses } from "../testUtils/agentModel";
import { take } from "../lib/publicRateCounters";
import { brandCoverSearchDailyCap, searchBrandCoverPages } from "./brandCoverSearchModel";

jest.mock("../lib/publicRateCounters", () => ({ take: jest.fn(async () => true) }));
const takeMock = take as jest.MockedFunction<typeof take>;

const usage = { input: 500, cached: 0, output: 80, reasoning: 0 };

afterEach(() => { setResponsesTransport(null); takeMock.mockReset(); takeMock.mockResolvedValue(true); delete process.env.BRAND_COVER_SEARCH_DAILY_CAP; });

test("keeps only pages the model chose that the search saw, as the clean URL, never a social profile", async () => {
  setResponsesTransport(fakeResponses(() => ({
    json: { pages: [
      "https://acme.example.com/lookbook?utm_source=openai",
      "https://www.instagram.com/acme",
      "https://never-searched.example.com/x",
      "http://insecure.example.com/acme",
    ] },
    sources: [
      { url: "https://acme.example.com/lookbook?utm_source=openai" },
      { url: "https://www.instagram.com/acme" },
      { url: "http://insecure.example.com/acme" },
      { url: "https://unlisted-similar-name.example.net/" },
    ],
    queries: ["acme"],
    usage,
  })));
  expect(await searchBrandCoverPages("Acme")).toEqual(["https://acme.example.com/lookbook"]);
});

test("an empty list is an answer: the search's other sources are not a fallback", async () => {
  setResponsesTransport(fakeResponses(() => ({
    json: { pages: [] },
    sources: [{ url: "https://acme-plumbing.example.org/" }],
    queries: ["acme"],
    usage,
  })));
  expect(await searchBrandCoverPages("Acme")).toEqual([]);
});

describe("the global daily brand cover search cap", () => {
  test("clamps: unset or junk is 100, never above 1,000", () => {
    expect(brandCoverSearchDailyCap({} as any)).toBe(100);
    expect(brandCoverSearchDailyCap({ BRAND_COVER_SEARCH_DAILY_CAP: "abc" } as any)).toBe(100);
    expect(brandCoverSearchDailyCap({ BRAND_COVER_SEARCH_DAILY_CAP: "0" } as any)).toBe(100);
    expect(brandCoverSearchDailyCap({ BRAND_COVER_SEARCH_DAILY_CAP: "5000" } as any)).toBe(1_000);
    expect(brandCoverSearchDailyCap({ BRAND_COVER_SEARCH_DAILY_CAP: "20" } as any)).toBe(20);
  });

  test("each search counts one against the day's global counter, at the configured cap", async () => {
    process.env.BRAND_COVER_SEARCH_DAILY_CAP = "7";
    setResponsesTransport(fakeResponses(() => ({ json: { pages: [] }, sources: [], queries: ["acme"], usage })));
    await searchBrandCoverPages("Acme");
    expect(takeMock).toHaveBeenCalledWith(["brand_cover_search"], 7, "day", expect.any(Date));
  });

  test("over the cap: no search runs, no pages", async () => {
    takeMock.mockResolvedValue(false);
    const transport = jest.fn();
    setResponsesTransport(transport as any);
    expect(await searchBrandCoverPages("Acme")).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  test("fail closed: a count that cannot be read runs no search", async () => {
    takeMock.mockRejectedValue(new Error("db down"));
    const transport = jest.fn();
    setResponsesTransport(transport as any);
    expect(await searchBrandCoverPages("Acme")).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });
});
