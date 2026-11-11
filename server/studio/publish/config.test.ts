/**
 * config.test.ts — STUDIO_PUBLISH_MODE, the one switch.
 *
 * REVERT CHECKS, red by name:
 *   RC-M1  case-fold or accept truthy values   → "anything that is not exactly dry or live is OFF…"
 *   RC-M2  default to anything but off         → "is OFF when the variable is not set"
 *   RC-M3  maySendLive ignores the row         → "a live send needs BOTH keys…"
 *   RC-M4  maySendLive ignores the process     → "a live send needs BOTH keys…"
 */
import { isPublishPlatform, leaseMs, maySendLive, publishMode } from "./config";

const before = process.env.STUDIO_PUBLISH_MODE;
const set = (v: string | undefined) => {
  if (v === undefined) delete process.env.STUDIO_PUBLISH_MODE;
  else process.env.STUDIO_PUBLISH_MODE = v;
};
afterEach(() => {
  set(before);
});

describe("publishMode", () => {
  /** RC-M2. */
  it("is OFF when the variable is not set", () => {
    set(undefined);
    expect(publishMode()).toBe("off");
  });

  it("reads off, dry and live", () => {
    for (const m of ["off", "dry", "live"] as const) {
      set(m);
      expect(publishMode()).toBe(m);
    }
  });

  /** RC-M1. A typo must never be a post. */
  it("anything that is not exactly dry or live is OFF — no case-folding, no truthiness", () => {
    for (const v of [
      "Live",
      "LIVE",
      "DRY",
      "1",
      "true",
      "on",
      "yes",
      "enabled",
      "live!",
      "li ve",
      "",
      "  ",
    ]) {
      set(v);
      expect(publishMode()).toBe("off");
    }
  });

  /** A trailing newline is how a secret gets stored, not a statement of intent. */
  it("trims whitespace and nothing else", () => {
    set(" live\r\n");
    expect(publishMode()).toBe("live");
    set("\tdry ");
    expect(publishMode()).toBe("dry");
  });
});

describe("maySendLive — the two keys", () => {
  /** RC-M3 and RC-M4. */
  it("a live send needs BOTH keys: the process says live AND the row says live", () => {
    const table: [string | undefined, string | null | undefined, boolean][] = [
      ["live", "live", true],
      ["live", "dry", false],
      ["dry", "live", false],
      ["off", "live", false],
      [undefined, "live", false],
      ["live", null, false],
      ["live", undefined, false],
      ["live", "LIVE", false],
      ["dry", "dry", false],
    ];
    for (const [env, row, want] of table) {
      set(env);
      expect([env, row, maySendLive(row)]).toEqual([env, row, want]);
    }
  });
});

describe("the rest", () => {
  it("accepts instagram and nothing else as a platform", () => {
    expect(isPublishPlatform("instagram")).toBe(true);
    for (const v of ["tiktok", "Instagram", "", null, undefined, 3, {}])
      expect(isPublishPlatform(v)).toBe(false);
  });

  it("a lease outlasts one claim's worth of calls", () => {
    expect(leaseMs()).toBeGreaterThanOrEqual(180_000);
  });
});
