import { cachedSource, stableImageKey } from "./imageCache";

describe("imageCache", () => {
  const signed = (sig: string) => `https://storage.googleapis.com/bucket/athletes/a1/p.jpg?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Expires=3600&X-Goog-Signature=${sig}`;

  it("a signed url keys on its path, so tomorrow's re-signed url hits the same cache entry", () => {
    expect(stableImageKey(signed("aaa"))).toBe("https://storage.googleapis.com/bucket/athletes/a1/p.jpg");
    expect(stableImageKey(signed("aaa"))).toBe(stableImageKey(signed("bbb")));
  });

  it("an unsigned url keeps the default key (itself), query and all", () => {
    expect(stableImageKey("https://www.google.com/s2/favicons?domain=tiktok.com&sz=128")).toBeUndefined();
    expect(cachedSource("https://cdn.example/x.jpg")).toEqual({ uri: "https://cdn.example/x.jpg" });
  });

  it("a caller's own id wins over the path", () => {
    expect(cachedSource(signed("aaa"), "asset-1")).toEqual({ uri: signed("aaa"), cacheKey: "asset-1" });
    expect(cachedSource(signed("aaa"))).toEqual({ uri: signed("aaa"), cacheKey: "https://storage.googleapis.com/bucket/athletes/a1/p.jpg" });
  });
});
