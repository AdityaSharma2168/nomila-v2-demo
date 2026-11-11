# Proposal for Mia — let the Instagram connection post

**Status: written, NOT applied.** Every file below is shared code and outside the Studio lane. The
Studio publishing feature (`docs/plans/studio-video-publish-instagram.md`) is built and dark; it
cannot post for anyone until item 1 lands, because no connected account holds the scope.

## 1 · Request the publish scope — one line

`server/lib/integrations/instagram.ts`:

```diff
 const SCOPES = [
   "instagram_business_basic",
   "instagram_business_manage_insights",
   "instagram_business_manage_messages",
+  "instagram_business_content_publish",
 ].join(",");
```

**Blast radius.** Every NEW Instagram connect shows one more permission on Meta's consent screen.
Nothing else reads `SCOPES`. Existing connections are unaffected and keep working — they simply
cannot post until the athlete reconnects (item 3). Declining the new permission at consent does not
block the connection: Meta returns the granted subset and the rest of the app degrades as it does
today.

## 2 · A defect this makes load-bearing — `handleCallback` can record a scope Meta never granted

```ts
scopes: granted.length ? granted.join(",") : SCOPES,
```

When Meta's token response carries no `permissions`, the row stores the **requested** list. Today
that is harmless. After item 1 it means a row can say `instagram_business_content_publish` for an
account that declined it — and Studio's `canPublish` reads that column.

**Proposed:** store `granted.join(",")` always (empty string when Meta sent none), and let readers
treat "unknown" as "not granted". **Already defended on our side:** the publish worker's first call is
a read that needs the permission, and Meta's refusal ends the job as `Reconnect Instagram to allow
posting.` before any container exists (RC-W10). So this is a correctness fix, not a blocker.

## 3 · Athletes who are already connected

Their tokens do not carry the new scope and no refresh adds it — only a fresh OAuth does. Studio
handles its own surface: the pill reads **"Reconnect to post"** and calls the existing
`usePlatformOAuth("instagram").connect()`. Two things that are yours:

- `handleCallback` reuses a `pending` row or INSERTs, so a reconnect can leave an athlete with **two
  active Instagram rows**. Studio pins the row it showed her (`connected_account_id` on the job) and
  treats the newest active row as current — please confirm that matches the rest of the app, or
  tell us which row is canonical.
- Whether to prompt reconnection anywhere outside Studio (settings, a banner) is a product call.

## 4 · Meta App Review — required before anyone outside the test app can post

`instagram_business_content_publish` is an Advanced Access permission. The dev test app from #530
works today for accounts added as **Instagram Testers**, with no review. For real athletes the
production app needs App Review for this permission: a screencast of the end-to-end flow (our
confirm step — "This posts to @handle now" — is the consent moment reviewers look for), a
description of use, and a test account. Until it is approved, `STUDIO_PUBLISH_MODE` stays `off` in
prod regardless of anything else in this document.

## 5 · Small, optional

- Export `GV` from the integration. Studio's publish client pins its own copy (`v22.0`,
  `IG_GRAPH_VERSION`) because it cannot import yours; a bump is currently a two-file decision.
- The integration sends `access_token` in query strings. Meta's publishing docs use
  `Authorization: Bearer`; Studio's client does, so a token never lands in a logged URL. Worth
  considering for the shared calls too.
