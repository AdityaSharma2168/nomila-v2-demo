import { isGroundingRedirect, resolveGroundingRedirect } from "./groundingRedirect";

const R = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQabc";
const res = (status: number, location?: string) => ({ status, headers: { get: (h: string) => (h.toLowerCase() === "location" ? location ?? null : null) }, body: { cancel: jest.fn(async () => {}) } }) as unknown as Response;

describe("grounding redirect resolution (URL only)", () => {
  test("recognises only Google Search grounding redirect links", () => {
    expect(isGroundingRedirect(R)).toBe(true);
    expect(isGroundingRedirect("https://vertexaisearch.cloud.google.com/other/x")).toBe(false);
    expect(isGroundingRedirect("https://news.example.com/story")).toBe(false);
    expect(isGroundingRedirect("not a url")).toBe(false);
  });
  test("a 3xx with Location resolves to the real URL; one request, redirect not followed, body never read", async () => {
    const f = jest.fn(async () => res(302, "https://news.example.com/story?id=1"));
    await expect(resolveGroundingRedirect(R, { fetchImpl: f as any })).resolves.toBe("https://news.example.com/story?id=1");
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as any[])[1]).toMatchObject({ method: "GET", redirect: "manual" });
  });
  test("a relative Location is resolved against the redirect URL", async () => {
    const f = jest.fn(async () => res(301, "/path"));
    await expect(resolveGroundingRedirect(R, { fetchImpl: f as any })).resolves.toBe("https://vertexaisearch.cloud.google.com/path");
  });
  test("non-redirect status, missing Location, a non-http target, a chained grounding redirect, an error, or a non-grounding URL → null", async () => {
    await expect(resolveGroundingRedirect(R, { fetchImpl: jest.fn(async () => res(200)) as any })).resolves.toBeNull();
    await expect(resolveGroundingRedirect(R, { fetchImpl: jest.fn(async () => res(302)) as any })).resolves.toBeNull();
    await expect(resolveGroundingRedirect(R, { fetchImpl: jest.fn(async () => res(302, "ftp://x.example/a")) as any })).resolves.toBeNull();
    await expect(resolveGroundingRedirect(R, { fetchImpl: jest.fn(async () => res(302, R + "2")) as any })).resolves.toBeNull();
    await expect(resolveGroundingRedirect(R, { fetchImpl: jest.fn(async () => { throw new Error("network"); }) as any })).resolves.toBeNull();
    const f = jest.fn();
    await expect(resolveGroundingRedirect("https://news.example.com/x", { fetchImpl: f as any })).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
