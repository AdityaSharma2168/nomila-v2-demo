/**
 * connectService — the existing OAuth door (POST /api/v1/me/connect/:connector, the same flow Settings and
 * hooks/use-platform-oauth use) for ANY connector id a card names, so a card can start the connector the server chose
 * (a preview's sharpen step, a rate card's sharpenConnectors) without a hook per platform. Resolves true when the
 * connections read afterwards shows that connector active.
 *
 * Web with the dev web switch on (EXPO_PUBLIC_WEB_V2): the provider opens in THIS tab (no popup, so no popup blocker),
 * and the server sends her back to the web app's `/?connected=<connector>` — the same return the Gmail/Instagram flow
 * uses (it opens Settings, where the connection shows). `webReturn: true` asks the server for that return for TikTok and
 * Spotify too, which otherwise keep their older return page. The promise never settles: the page is navigating away.
 * Switch off (native, the production web app): exactly today's flow.
 */
import { Platform } from "react-native";
import type { QueryClient } from "@tanstack/react-query";
import { apiRequest, queryClient as appQueryClient } from "../query-client";
import { webV2On } from "../flags";
import type { Connection } from "../../hooks/use-connections";

const OAUTH_CALLBACK = "co.nomila.app://connect/callback";
const CONNECTIONS_KEY = "/api/v1/me/connections";

/** What the connect call sends: nothing on native; the web marker on web; plus the same-tab return ask with the switch. */
export function connectBody(platformOs: string, webV2: boolean): Record<string, unknown> {
  if (platformOs !== "web") return {};
  return webV2 ? { clientPlatform: "web", webReturn: true } : { clientPlatform: "web" };
}

/** The browser navigation, injectable for tests (jsdom cannot navigate). */
export const webNav = { assign: (url: string) => { window.location.href = url; } };

export async function connectService(connectorId: string, qc: QueryClient = appQueryClient, webV2: boolean = webV2On(Platform.OS)): Promise<boolean> {
  // credentials: the server binds a web connect to this browser with an HttpOnly cookie set on this response.
  const res = await apiRequest("POST", `/api/v1/me/connect/${encodeURIComponent(connectorId)}`, connectBody(Platform.OS, webV2), Platform.OS === "web" ? { credentials: "include" } : undefined);
  const { redirectUrl } = (await res.json()) as { redirectUrl?: string };
  if (!redirectUrl) return false;
  if (Platform.OS === "web" && webV2) {
    // Same tab, always: the server brings her back to /?connected=<connector>.
    webNav.assign(redirectUrl);
    return new Promise<boolean>(() => undefined);
  }
  if (Platform.OS === "web") {
    // Same-tab on mobile web (popups after an await are blocked); a popup on desktop. Either way the read below settles it.
    const popup = window.open(redirectUrl, "_blank");
    if (!popup) { window.location.href = redirectUrl; return false; }
    await new Promise<void>((resolve) => {
      const onFocus = () => { window.removeEventListener("focus", onFocus); resolve(); };
      window.addEventListener("focus", onFocus);
    });
  } else {
    // Loaded on use, so screens that only might connect don't pull the native module in at import time.
    const WebBrowser = await import("expo-web-browser");
    await WebBrowser.openAuthSessionAsync(redirectUrl, OAUTH_CALLBACK);
  }
  try {
    await qc.invalidateQueries({ queryKey: [CONNECTIONS_KEY] });
    const d = await qc.fetchQuery<{ connections: Connection[] }>({ queryKey: [CONNECTIONS_KEY], staleTime: 0 });
    return d.connections.some((c) => c.platform === connectorId && c.status === "active");
  } catch {
    return false;
  }
}
