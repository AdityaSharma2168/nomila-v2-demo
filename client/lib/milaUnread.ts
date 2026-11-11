/**
 * lib/milaUnread.ts — messages Mila started that the athlete has not seen (design "Mila on watch", step 4; server
 * agent/proactive/unread.ts). Behind EXPO_PUBLIC_MILA_PROACTIVE: with it off nothing is fetched and the count stays 0.
 *
 *   useMilaUnread()            the count (the Mila tab's dot); asks the server when the app comes to the front and
 *                              once a minute while it is open
 *   markConversationSeen(id)   the athlete opened that chat: its Mila-started messages are seen, the dot refreshes
 *   refreshMilaUnread()        ask again now (after a push arrives, after marking seen)
 *
 * Never throws: a failed request leaves the last count.
 */
import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * lib/flags.ts MILA_PROACTIVE, read at call time (Expo inlines EXPO_PUBLIC_* wherever it is read; tests can switch it).
 * query-client loads on first use, so the tab bar that imports this never pulls storage in at import.
 */
const on = () => process.env.EXPO_PUBLIC_MILA_PROACTIVE === "true";
const api = async () => {
  const { getApiUrl, getAuthHeaders } = await import("./query-client");
  return { url: getApiUrl(), headers: await getAuthHeaders() };
};

export const UNREAD_POLL_MS = 60_000;

let count = 0;
const listeners = new Set<(n: number) => void>();
const set = (n: number) => { if (n === count) return; count = n; listeners.forEach((fn) => fn(n)); };

export async function refreshMilaUnread(): Promise<number> {
  if (!on()) return 0;
  try {
    const { url, headers } = await api();
    const res = await fetch(`${url}/api/v1/me/mila/unread`, { method: "GET", headers: { ...headers } });
    if (res.ok) {
      const body = (await res.json()) as { count?: unknown };
      set(typeof body.count === "number" && body.count > 0 ? Math.floor(body.count) : 0);
    }
  } catch { /* keep the last count */ }
  return count;
}

export async function markConversationSeen(conversationId: string): Promise<void> {
  if (!on()) return;
  try {
    const { url, headers } = await api();
    await fetch(`${url}/api/v1/me/conversations/${conversationId}/seen`, { method: "POST", headers: { ...headers } });
  } catch { /* the dot clears on the next look */ }
  await refreshMilaUnread();
}

/** The unread count for the Mila tab's dot (0 while the flag is off). */
export function useMilaUnread(): number {
  const [n, setN] = useState(count);
  useEffect(() => {
    if (!on()) return undefined;
    listeners.add(setN);
    void refreshMilaUnread();
    const timer = setInterval(() => { if (AppState.currentState === "active") void refreshMilaUnread(); }, UNREAD_POLL_MS);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void refreshMilaUnread(); });
    return () => { listeners.delete(setN); clearInterval(timer); sub.remove(); };
  }, []);
  return n;
}

/** Tests only. */
export function __resetMilaUnread(): void { count = 0; listeners.clear(); }
