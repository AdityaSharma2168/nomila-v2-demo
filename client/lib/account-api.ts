/**
 * account-api — Settings › Account's two server calls: download your data (GET /api/v1/me/export) and delete your
 * account (DELETE /api/v1/me/account), plus the Sign in with Apple re-confirm the delete needs.
 *
 * EXPORT. The server answers one JSON file at once (no email, no zip). Native: it is written to the cache and handed to
 * the system share sheet (expo-sharing; Save to Files, Drive, Mail, AirDrop). Web: the browser downloads it. Two steps
 * (prepare, then deliver) so the caller can close its own sheet before the system one opens — iOS will not present a
 * share sheet over a React Native Modal that is still up.
 *
 * DELETE. Answers: 202 the account is closed now (receipt id) · 409 a payment is held (with the deal) · 410 it is already
 * being deleted · anything else, or no network: nothing happened (the request is safe to send again).
 *
 * APPLE. When the athlete signed in with Apple (iOS), the app asks Apple once more at delete time; the fresh
 * authorization code goes with the delete so the server can revoke the Sign in with Apple grant.
 */
import { Platform } from "react-native";
import { getApiUrl, getAuthHeaders } from "./query-client";
import { isAccountDeletingResponse, reportAccountDeleting } from "./account-deleting";

// The native modules (and Firebase) load on first use, so Settings can import this without them.

// ─── Export ─────────────────────────────────────────────────────────────────────

export interface PreparedExport { name: string; uri?: string; text?: string }

/** The file name the server gave (Content-Disposition), else nomila-data-<today>.json. */
export function exportFileName(disposition: string | null, today = new Date()): string {
  const m = disposition?.match(/filename="?([A-Za-z0-9._-]+\.json)"?/);
  return m ? m[1] : `nomila-data-${today.toISOString().slice(0, 10)}.json`;
}

/** Fetch the export and get it ready to hand over. Throws on any failure (the sheet shows its error state). */
export async function prepareExport(signal?: AbortSignal): Promise<PreparedExport> {
  const res = await fetch(new URL("/api/v1/me/export", getApiUrl()).toString(), { headers: await getAuthHeaders(), signal });
  const text = await res.text();
  if (!res.ok) {
    if (isAccountDeletingResponse(res.status, text)) reportAccountDeleting();
    throw new Error(`export ${res.status}`);
  }
  const name = exportFileName(res.headers.get("content-disposition"));
  if (Platform.OS === "web") return { name, text };
  const FileSystem = await import("expo-file-system/legacy");
  const uri = `${FileSystem.cacheDirectory}${name}`;
  await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
  return { name, uri };
}

/** Hand the file over: the share sheet on a phone, a download on web. */
export async function deliverExport(file: PreparedExport): Promise<"shared" | "downloaded"> {
  if (Platform.OS === "web") {
    const href = URL.createObjectURL(new Blob([file.text ?? ""], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = href; a.download = file.name; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);   // revoking at once cancels the download in Safari
    return "downloaded";
  }
  const Sharing = await import("expo-sharing");
  await Sharing.shareAsync(file.uri!, { mimeType: "application/json", UTI: "public.json", dialogTitle: "Your Nomila data" });
  return "shared";
}

// ─── Delete ─────────────────────────────────────────────────────────────────────

export type DeleteOutcome =
  | { kind: "closed"; receiptId: string }
  | { kind: "blocked"; dealId: string | null }
  | { kind: "deleting" }
  | { kind: "error" };

export async function deleteMyAccount(appleAuthorizationCode?: string | null): Promise<DeleteOutcome> {
  try {
    const res = await fetch(new URL("/api/v1/me/account", getApiUrl()).toString(), {
      method: "DELETE",
      headers: { ...(await getAuthHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify(appleAuthorizationCode ? { apple_authorization_code: appleAuthorizationCode } : {}),
    });
    const text = await res.text();
    const body = (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })();
    if (res.status === 202 && typeof body.receipt_id === "string") return { kind: "closed", receiptId: body.receipt_id };
    if (res.status === 409) return { kind: "blocked", dealId: typeof body.deal_id === "string" ? body.deal_id : null };
    if (isAccountDeletingResponse(res.status, text)) return { kind: "deleting" };
    return { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

/** The receipt id as the success screen shows it: 7f3c…e21a. */
export const shortReference = (receiptId: string): string =>
  receiptId.length > 10 ? `${receiptId.slice(0, 4)}…${receiptId.slice(-4)}` : receiptId;

// ─── Sign in with Apple ─────────────────────────────────────────────────────────

/** True on iOS when the signed-in user came in with Apple: the delete asks Apple to confirm first. */
export async function needsAppleConfirm(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  const { auth } = await import("./firebase-client");
  return !!auth.currentUser?.providerData?.some((p) => p?.providerId === "apple.com");
}

export type AppleConfirm = { code: string } | { cancelled: true } | { failed: true };

/** Ask Apple to confirm it's them (no name or email asked for). */
export async function confirmWithApple(): Promise<AppleConfirm> {
  try {
    const AppleAuthentication = await import("expo-apple-authentication");
    const c = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    return c.authorizationCode ? { code: c.authorizationCode } : { failed: true };
  } catch (err: any) {
    return err?.code === "ERR_REQUEST_CANCELED" ? { cancelled: true } : { failed: true };
  }
}
