import { youtubeOEmbedUrl, youtubeVideoInfo } from "./youtubeOEmbed";

const W = "https://www.youtube.com/watch?v=abcDEF12345";
const res = (status: number, body = "") => ({ status, text: jest.fn(async () => body), body: { cancel: jest.fn(async () => {}) } }) as unknown as Response;

describe("YouTube oEmbed (existence + title; metadata only; fetch injected — never the network)", () => {
  test("one GET to the public oEmbed endpoint for the watch URL; 200 → exists with the video title", async () => {
    const f = jest.fn(async () => res(200, JSON.stringify({ title: "Jane Doe | National TV Interview", author_name: "Example Network", type: "video" })));
    await expect(youtubeVideoInfo(W, { fetchImpl: f as any })).resolves.toEqual({ exists: true, title: "Jane Doe | National TV Interview" });
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as any[])[0]).toBe(youtubeOEmbedUrl(W));
    expect(youtubeOEmbedUrl(W)).toBe("https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DabcDEF12345&format=json");
    expect((f.mock.calls[0] as any[])[1]).toMatchObject({ method: "GET" });
  });
  test("200 with an unreadable body: exists, title unknown", async () => {
    await expect(youtubeVideoInfo(W, { fetchImpl: jest.fn(async () => res(200, "not json")) as any })).resolves.toEqual({ exists: true, title: null });
  });
  test("any non-200 (404 for a video that does not exist, 401, 5xx), an error or a timeout → not available", async () => {
    for (const s of [404, 401, 400, 500, 302]) await expect(youtubeVideoInfo(W, { fetchImpl: jest.fn(async () => res(s)) as any })).resolves.toEqual({ exists: false, title: null });
    await expect(youtubeVideoInfo(W, { fetchImpl: jest.fn(async () => { throw new Error("network"); }) as any })).resolves.toEqual({ exists: false, title: null });
    const hang = jest.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    await expect(youtubeVideoInfo(W, { fetchImpl: hang as any, timeoutMs: 5 })).resolves.toEqual({ exists: false, title: null });
  });
});
