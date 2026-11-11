/**
 * Provider registry — the single place to register a direct integration.
 *
 * OAUTH  — every connectable platform. Dispatched by connections.ts (getAuthUrl)
 *          and oauthCallback.ts (handleCallback).
 * INBOX  — platforms whose messages feed detectDeal. Dispatched by oauthCallback.ts
 *          (onConnected) and inboxCronSync.ts (syncRecent).
 *
 * Adding a provider = implement the module + add one line here. No switch edits.
 */

import * as instagram from "./instagram";
import * as tiktok    from "./tiktok";
import * as youtube   from "./youtube";
import * as gmail     from "./gmail";
import * as spotify   from "./spotify";
import * as outlook   from "./outlook";
import type { OAuthProvider, InboxProvider } from "./types";

export const OAUTH: Record<string, OAuthProvider> = {
  instagram,
  tiktok,
  youtube,
  gmail,
  spotify,
  outlook,
};

export const INBOX: Record<string, InboxProvider> = {
  gmail,
  outlook,
  instagram, // DM ingestion via onConnected backfill + polling; webhook subscribe pending Meta App Review
};
