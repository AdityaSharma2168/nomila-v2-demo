import { Platform, Linking } from "react-native";

// Fallback used only if no body is supplied by the caller.
const DEFAULT_BODY = "";

/**
 * Open a reply compose window pre-filled with `bodyText` (e.g. an
 * LLM-generated draft).
 *
 * - Web: hands a `mailto:` link to the OS/browser mail handler (Apple Mail,
 *   Outlook, Gmail-in-browser — whatever the user has configured).
 * - Native: tries to open the Gmail app via its `googlegmail://` scheme, and
 *   falls back to the default mail app (`mailto:`) if Gmail isn't installed.
 *   NOTE: inside Expo Go the Gmail scheme may not be whitelisted, so it can
 *   fall back to the default mail app there; it works in a dev/standalone build.
 */
export async function openReply(to?: string | null, bodyText?: string | null): Promise<void> {
  const recipient = to ?? "";
  const body = encodeURIComponent(bodyText ?? DEFAULT_BODY);

  if (Platform.OS === "web") {
    const url = `mailto:${recipient}?body=${body}`;
    if (typeof window !== "undefined") {
      window.location.href = url;
    } else {
      await Linking.openURL(url);
    }
    return;
  }

  const gmailUrl = `googlegmail://co?to=${encodeURIComponent(recipient)}&body=${body}`;
  const mailtoUrl = `mailto:${recipient}?body=${body}`;

  try {
    await Linking.openURL(gmailUrl);
  } catch {
    await Linking.openURL(mailtoUrl);
  }
}
