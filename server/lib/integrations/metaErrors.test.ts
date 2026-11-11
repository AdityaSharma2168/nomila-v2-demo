/**
 * metaErrors.test.ts — only OAuthException 190/102 is `auth`; every other Meta error, and a bare
 * 403, keeps the connection (Step 1b design §8, review item R2).
 */

import { classifyMetaError, isAuthClass } from "./metaErrors";

const err = (code: number, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, type: "OAuthException", ...extra } });

describe("classifyMetaError", () => {
  it("190 with any subcode and 102 are auth", () => {
    for (const sub of [undefined, 458, 460, 463, 467]) expect(classifyMetaError(err(190, "Invalid OAuth access token", sub ? { error_subcode: sub } : {}), 401).class).toBe("auth");
    expect(classifyMetaError(err(102, "Session has expired"), 400).class).toBe("auth");
    expect(isAuthClass("auth")).toBe(true);
  });

  it("permission scoping (200–299) and generic code 10 are permission, never auth", () => {
    expect(classifyMetaError(err(200, "Permissions error"), 403).class).toBe("permission");
    expect(classifyMetaError(err(230, "Requires instagram_business_manage_insights"), 403).class).toBe("permission");
    expect(classifyMetaError(err(10, "Application does not have permission for this action"), 403).class).toBe("permission");
  });

  it("code 10 'Not enough viewers' is its own class", () => {
    const c = classifyMetaError(err(10, "(#10) Not enough viewers for the media to show insights"), 400);
    expect(c.class).toBe("not_enough_viewers");
    expect(c.code).toBe(10);
  });

  it("code 100 naming a metric is unsupported_metric and extracts the metric", () => {
    const c = classifyMetaError(err(100, "The Media Insights API does not support the reposts metric for this media product type."), 400);
    expect(c).toMatchObject({ class: "unsupported_metric", metric: "reposts" });
    expect(classifyMetaError(err(100, "metric[0] must be one of the following values: reach, views"), 400)).toMatchObject({ class: "unsupported_metric" });
    expect(classifyMetaError(err(100, "metric[0] must be one of the following values: reach, views"), 400).metric).toBeUndefined();
  });

  it("rate limits, 5xx and unknown", () => {
    for (const code of [4, 17, 32, 613, 80002]) expect(classifyMetaError(err(code, "throttled"), 400).class).toBe("rate_limited");
    expect(classifyMetaError({ error: { code: 1, message: "An unknown error occurred" } }, 500).class).toBe("transient");
    expect(classifyMetaError(null, 502).class).toBe("transient");
    expect(classifyMetaError({ error: { code: 1, message: "An unknown error occurred" } }, 400).class).toBe("unknown");
  });

  it("a bare 403 without code 190/102 never expires the connection", () => {
    expect(classifyMetaError({ error: { message: "Forbidden" } }, 403).class).toBe("unknown");
    expect(classifyMetaError({}, 403).class).toBe("unknown");
    expect(classifyMetaError({ error: { code: 3, message: "permission denied by the token" } }, 403).class).toBe("unknown");
  });
});
