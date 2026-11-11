import { QueryClient, focusManager, type QueryFunction } from "@tanstack/react-query";
import { AppState, Platform } from "react-native";
import { logger } from "./logger";
import { athleteHeader } from "./athlete-selection";
import { isAccountDeletingResponse, reportAccountDeleting } from "./account-deleting";

async function getToken(): Promise<string | null> {
  const { getFirebaseIdToken } = await import("./firebase-client");
  return getFirebaseIdToken();
}

export function getApiUrl(): string {
  const host = process.env.EXPO_PUBLIC_API_URL;
  if (host) return host.replace(/\/$/, "");
  if (__DEV__) return "http://localhost:8080";
  throw new Error("EXPO_PUBLIC_API_URL is not set");
}

async function throwIfNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    // 410 account_deleting: this account is being deleted (another phone, or this one) — say so app-wide.
    if (isAccountDeletingResponse(res.status, text)) reportAccountDeleting();
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}`, ...athleteHeader() } : {};
}

export async function apiRequest(
  method: string,
  route: string,
  data?: unknown,
  /** "include" only where the server sets a cookie the browser must keep (the OAuth connect start's binding cookie). */
  opts?: { credentials?: RequestCredentials },
): Promise<Response> {
  const url = new URL(route, getApiUrl()).toString();
  logger.log(`[api] ${method} ${url}`);

  const token = await getToken();
  const headers: Record<string, string> = { ...athleteHeader() };   // Phase A Step 3b: the selected athlete, when one was ever needed
  if (data)  headers["Content-Type"]  = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    ...(opts?.credentials ? { credentials: opts.credentials } : {}),
  });

  await throwIfNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";

export function getQueryFn<T>(options: {
  on401: UnauthorizedBehavior;
}): QueryFunction<T> {
  const { on401 } = options;
  return async ({ queryKey }) => {
    const url = new URL((queryKey as string[]).join("/"), getApiUrl()).toString();
    const token = await getToken();
    const headers: Record<string, string> = { ...athleteHeader() };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(url, { headers });

    if (on401 === "returnNull" && res.status === 401) return null as T;
    await throwIfNotOk(res);
    return res.json() as Promise<T>;
  };
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn:              getQueryFn({ on401: "throw" }),
      refetchInterval:      false,
      refetchOnWindowFocus: false,
      staleTime:            Infinity,
      retry:                false,
    },
    mutations: {
      retry: false,
    },
  },
});

// React Native has no window focus: tell react-query, once and app-wide, when the app is in front. A poll with
// refetchIntervalInBackground: false (the Goals tab while a plan runs, a kit's preview) then pauses while the app is
// backgrounded. refetchOnWindowFocus stays off above, so coming back refetches nothing by itself. Web keeps its own
// visibility listener.
if (Platform.OS !== "web") {
  focusManager.setEventListener((setFocused) => {
    const sub = AppState.addEventListener("change", (state) => setFocused(state === "active"));
    return () => sub.remove();
  });
}
