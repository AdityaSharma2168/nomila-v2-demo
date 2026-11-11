/**
 * connections.webReturn.test — the same-tab web return for TikTok and Spotify (the dev web build, EXPO_PUBLIC_WEB_V2).
 *
 *   - TikTok and Spotify sign clientPlatform "web" into their OAuth state ONLY when the client sent webReturn: true, so
 *     the callback sends her back to the web app's /?connected=<platform>; today's clients (no webReturn) keep today's
 *     return page exactly
 *   - every other connector is unchanged: its clientPlatform passes through as before
 *
 * No provider is reached: getAuthUrl only builds a URL.
 */
process.env.TIKTOK_CLIENT_KEY = "test-tiktok-key";
process.env.SPOTIFY_CLIENT_ID = "test-spotify-id";
process.env.SESSION_SECRET = "test-session-secret";

jest.mock("../db", () => ({ db: {} }));
jest.mock("../lib/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { returnPlatformFor } from "./connections";
import * as tiktok from "../lib/integrations/tiktok";
import * as spotify from "../lib/integrations/spotify";
import { verifyOAuthState } from "../lib/oauthState";

const stateOf = (url: string) => verifyOAuthState(new URL(url).searchParams.get("state") ?? undefined);

describe("returnPlatformFor", () => {
  it("TikTok/Spotify: web only with webReturn: true (today's web client sends no webReturn → unchanged)", () => {
    expect(returnPlatformFor("tiktok", "web", undefined)).toBeUndefined();
    expect(returnPlatformFor("spotify", "web", undefined)).toBeUndefined();
    expect(returnPlatformFor("tiktok", "web", "true")).toBeUndefined();
    expect(returnPlatformFor("tiktok", "web", true)).toBe("web");
    expect(returnPlatformFor("spotify", "web", true)).toBe("web");
  });

  it("every other connector passes clientPlatform through as before", () => {
    expect(returnPlatformFor("gmail", "web", undefined)).toBe("web");
    expect(returnPlatformFor("youtube", "web", undefined)).toBe("web");
    expect(returnPlatformFor("instagram", undefined, true)).toBeUndefined();
  });
});

describe("TikTok and Spotify auth URLs", () => {
  it("sign clientPlatform into the state when given, and nothing when not (native and today's web)", () => {
    expect(stateOf(tiktok.getAuthUrl("ath-1"))).toEqual({ athleteId: "ath-1", alias: undefined, clientPlatform: undefined, nonce: expect.any(String) });
    expect(stateOf(tiktok.getAuthUrl("ath-1", undefined, undefined, "web"))?.clientPlatform).toBe("web");
    expect(stateOf(spotify.getAuthUrl("ath-2"))?.clientPlatform).toBeUndefined();
    expect(stateOf(spotify.getAuthUrl("ath-2", undefined, undefined, "web"))?.clientPlatform).toBe("web");
  });
});
