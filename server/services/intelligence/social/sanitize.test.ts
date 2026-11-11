/**
 * sanitize.test.ts — the sanitization contract, one case per place a secret can appear
 * (Step 1 design §3), plus the refuse-on-leak gate.
 */

import { assertNoSecrets, requestRecord, sanitizePayload, SanitizerLeakError, SANITIZER_VERSION } from "./sanitize";

const ACCESS = "IGQVJ" + "x".repeat(60) + "SECRETACCESS";
const REFRESH = "rft_" + "y".repeat(40) + "SECRETREFRESH";
const META = "EAA" + "M".repeat(150);
const secrets = [ACCESS, REFRESH];

describe("sanitizePayload", () => {
  it("drops Graph paging objects (the token rides in paging.next) and keeps the bare cursor", () => {
    const { out, report } = sanitizePayload({ data: [{ name: "reach", total_value: { value: 5 } }], paging: { cursors: { after: "QVFIU" }, next: `https://graph.facebook.com/v24.0/1/insights?access_token=${ACCESS}` } }, secrets) as any;
    expect(out.paging).toBeUndefined();
    expect(out.paging_cursors).toEqual({ after: "QVFIU" });
    expect(report.droppedPaging).toBe(1);
    expect(JSON.stringify(out)).not.toContain(ACCESS);
  });

  it("strips the query string of a signed CDN URL, including TikTok's refresh_token parameter", () => {
    const url = "https://p19-common-sign.tiktokcdn-us.com/tos/o8icoDTz~tplv-tiktokx-cropcenter-q:300:400:q70.jpeg?dr=8596&refresh_token=abc123&x-expires=1782864000&x-signature=cD5e%3D&t=bacd";
    const { out, report } = sanitizePayload({ recent_media: [{ thumbnail_url: url }] }) as any;
    expect(out.recent_media[0].thumbnail_url).toBe("https://p19-common-sign.tiktokcdn-us.com/tos/o8icoDTz~tplv-tiktokx-cropcenter-q:300:400:q70.jpeg");
    expect(report.strippedUrls).toBe(1);
  });

  it("leaves a URL without secret-like parameters untouched", () => {
    const url = "https://www.instagram.com/p/ABC123/?img_index=1";
    const { out, report } = sanitizePayload({ permalink: url }) as any;
    expect(out.permalink).toBe(url);
    expect(report.strippedUrls).toBe(0);
  });

  it("redacts secret-named keys at any depth and exact secret values anywhere in a string", () => {
    const { out, report } = sanitizePayload({ a: { b: { access_token: ACCESS, Authorization: `Bearer ${ACCESS}`, note: `token was ${REFRESH} here` } } }, secrets) as any;
    expect(out.a.b.access_token).toBe("<redacted:secret>");
    expect(out.a.b.Authorization).toBe("<redacted:secret>");
    expect(out.a.b.note).toBe("token was <redacted:secret> here");
    expect(report.redactedKeys).toBe(2);
    expect(JSON.stringify(out)).not.toMatch(/SECRET(ACCESS|REFRESH)/);
  });

  it("redacts known token shapes even when not passed as live secrets", () => {
    const { out } = sanitizePayload({ error: { message: `bad token ${META}` }, k: "AIza" + "k".repeat(35), g: "ya29." + "g".repeat(40) }) as any;
    expect(out.error.message).toBe("bad token <redacted:secret>");
    expect(out.k).toBe("<redacted:secret>");
    expect(out.g).toBe("<redacted:secret>");
  });

  it("does not mutate the input and survives arrays, nulls and numbers", () => {
    const input = { n: 1, z: null, arr: [{ access_token: ACCESS }, 2, "plain"] };
    const copy = JSON.parse(JSON.stringify(input));
    const { out } = sanitizePayload(input, secrets) as any;
    expect(input).toEqual(copy);
    expect(out.arr[0].access_token).toBe("<redacted:secret>");
    expect(out.arr[1]).toBe(2);
    expect(out.arr[2]).toBe("plain");
  });

  it("property: no injected secret survives at random depth and key placement", () => {
    for (let i = 0; i < 200; i++) {
      const depth = 1 + (i % 6);
      let node: any = i % 2 ? { leaf: `x${ACCESS}y` } : { some_key: ACCESS };
      for (let d = 0; d < depth; d++) node = i % 3 ? { [`k${d}`]: node } : [node, "pad"];
      const { out } = sanitizePayload(node, secrets);
      expect(JSON.stringify(out)).not.toContain(ACCESS);
    }
  });
});

describe("assertNoSecrets", () => {
  it("refuses a paging URL, a Bearer header echo, a nested error and a live secret", () => {
    expect(() => assertNoSecrets({ paging: { next: "https://x/?access_token=abc" } })).toThrow(SanitizerLeakError);
    expect(() => assertNoSecrets({ headers: { auth: `Bearer ${ACCESS}` } })).toThrow(SanitizerLeakError);
    expect(() => assertNoSecrets({ error: { detail: { message: `client_secret leaked` } } })).toThrow(SanitizerLeakError);
    expect(() => assertNoSecrets({ note: `plain ${REFRESH}` }, secrets)).toThrow(SanitizerLeakError);
  });
  it("passes a sanitized payload", () => {
    const { out } = sanitizePayload({ paging: { next: `https://x/?access_token=${ACCESS}` }, headers: { Authorization: `Bearer ${ACCESS}` } }, secrets);
    expect(() => assertNoSecrets(out, secrets)).not.toThrow();
  });
});

describe("requestRecord", () => {
  it("keeps only allow-listed parameters", () => {
    const r = requestRecord({ path: "/me/media", params: { fields: "id,caption", limit: 25, access_token: ACCESS, key: "AIza", after: "cur" }, pageIndex: 2 });
    expect(r).toEqual({ path: "/me/media", params: { fields: "id,caption", limit: 25, after: "cur" }, pageIndex: 2 });
    expect(JSON.stringify(r)).not.toContain(ACCESS);
  });
  it("carries the contract version", () => { expect(SANITIZER_VERSION).toBe("v1"); });
});

describe("Story payloads (Step 1b)", () => {
  it("strips signed CDN parameters from a Story listing and refuses a payload carrying the token", () => {
    const { sanitizePayload, assertNoSecrets } = require("./sanitize");
    const token = "IGQVJ" + "t".repeat(64);
    const listing = { data: [{ id: "s1", media_type: "IMAGE", timestamp: "2026-09-09T01:00:00+0000", media_url: "https://scontent.cdninstagram.com/v/t51/1.jpg?stp=dst&oh=abc123&oe=66F0&_nc_sid=8b3546&_nc_ht=x" }] };
    const { out } = sanitizePayload(listing, [token]);
    expect(out.data[0].media_url).toBe("https://scontent.cdninstagram.com/v/t51/1.jpg");   // a URL carrying a signed param loses its whole query string
    expect(() => assertNoSecrets(out, [token], "stories_list")).not.toThrow();
    const leaky = sanitizePayload({ data: [{ id: "s1", note: `token ${token} inline` }] }, []).out;   // not passed as a live secret
    expect(() => assertNoSecrets(leaky, [token], "stories_list")).toThrow();
  });
});
