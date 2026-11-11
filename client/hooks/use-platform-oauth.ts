import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import { logger } from "../lib/logger";
import { invalidateDealQueries } from "../lib/dealQueryKeys";

const OAUTH_CALLBACK = "co.nomila.app://connect/callback";

const CONNECTIONS_KEY = "/api/v1/me/connections";

// Key stored in localStorage before a same-tab OAuth navigation on mobile web.
// Checked on page load to trigger a connections refresh after the user returns.
const OAUTH_PENDING_KEY = "nomila_oauth_pending";

export function usePlatformOAuth(platform: string) {
  const queryClient  = useQueryClient();
  const [connecting, setConnecting] = useState(false);

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [CONNECTIONS_KEY] }),
      invalidateDealQueries(queryClient),
    ]);
  }, [queryClient]);

  // On web: after returning from a same-tab OAuth redirect, invalidate and clear the flag.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    try {
      const pending = localStorage.getItem(OAUTH_PENDING_KEY);
      if (pending) {
        localStorage.removeItem(OAUTH_PENDING_KEY);
        invalidate();
      }
    } catch {}
  }, [invalidate]);

  const connect = useCallback(async (alias?: string, loginHint?: string) => {
    if (connecting) return;
    setConnecting(true);
    try {
      const body: Record<string, string> = {};
      if (alias)              body.alias          = alias;
      if (loginHint)          body.loginHint      = loginHint;
      if (Platform.OS === "web") body.clientPlatform = "web";
      // credentials: the server binds a web connect to this browser with an HttpOnly cookie set on this response.
      const res  = await apiRequest("POST", `/api/v1/me/connect/${platform}`, body, Platform.OS === "web" ? { credentials: "include" } : undefined);
      const data = await res.json() as { redirectUrl?: string };
      if (!data.redirectUrl) return;

      if (Platform.OS === "web") {
        // On mobile web, window.open(_blank) is unreliable: iOS blocks it when called after
        // await, and the popup shares Google's client_id with Firebase — Chrome's postMessage
        // handling can cause Firebase to intercept the Gmail OAuth response and throw a
        // "malformed credential" error that corrupts subsequent sign-in state.
        // Safe fix: navigate the current tab through the OAuth and redirect back.
        const isMobile = typeof navigator !== "undefined" &&
          /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

        if (isMobile) {
          try { localStorage.setItem(OAUTH_PENDING_KEY, platform); } catch {}
          window.location.href = data.redirectUrl;
          return; // page navigates away — no further code runs
        }

        // Desktop: popup is reliable and not blocked after async
        const popup = window.open(data.redirectUrl, "_blank");
        if (!popup) {
          // Blocked — fall back to same-tab
          try { localStorage.setItem(OAUTH_PENDING_KEY, platform); } catch {}
          window.location.href = data.redirectUrl;
          return;
        }
        const onFocus = () => {
          window.removeEventListener("focus", onFocus);
          invalidate();
        };
        window.addEventListener("focus", onFocus);
      } else {
        await WebBrowser.openAuthSessionAsync(data.redirectUrl, OAUTH_CALLBACK);
        await invalidate();
      }
    } catch (err) {
      logger.error("OAuth connect failed:", err);
    } finally {
      setConnecting(false);
    }
  }, [platform, connecting, invalidate]);

  const disconnect = useCallback(async (connectionId: string) => {
    try {
      await apiRequest("DELETE", `/api/v1/me/connect/${connectionId}`);
      await invalidate();
    } catch (err) {
      logger.error("OAuth disconnect failed:", err);
    }
  }, [invalidate]);

  return { connect, disconnect, connecting };
}
