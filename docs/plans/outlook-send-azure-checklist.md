# Outlook sending: the Azure checklist (what changes when `Mail.Send` is added)

**Status (4 Nov 2026):** the code to send Outlook replies is built and merged behind `OUTLOOK_SEND`. The flag is
off in dev and prod, and the prod flag guard lists it. The live OAuth request still asks for **read only**
(`openid profile email offline_access User.Read Mail.Read`). Nobody has changed anything in Azure.

## What the athlete sees

- **Today, flag off:** an Outlook reply card shows her draft and says *"Can't send from here: replies to Outlook
  mail are sent from Outlook for now. Copy it into Outlook to send."* No Send button is shown, and nothing can be
  sent.
- **Flag on, but her Outlook grant has no `Mail.Send` yet:** the card says *"Can't send from here: Outlook hasn't
  given Nomila permission to send yet; reconnect Outlook in Settings to allow it. Copy it into Outlook to send."*
  If a send is attempted anyway, it is refused before any Microsoft call: `403 SCOPE_MISSING`, "Reconnect Outlook
  to allow sending…".
- **Flag on, and she reconnected with `Mail.Send`:** the card offers Send. Her tap sends exactly her text as a
  reply in the same Outlook conversation, from the inbox that received it. Outlook saves it in her Sent Items.

## How the send works (for the review)

- `POST https://graph.microsoft.com/v1.0/me/messages/{id}/reply` with `{ message: { body: { contentType: "Text",
  content } } }`. This needs **`Mail.Send` only**. `createReply` + `send` would need `Mail.ReadWrite` and a
  native draft in her mailbox, so we don't use it.
- Graph sets In-Reply-To and References, and keeps the `conversationId`, so the reply threads on both sides.
  Graph addresses it to the original sender, or to the Reply-To address when the message has one.
  (Gmail replies go to the stored sender address and ignore Reply-To, so the two can differ when a brand sets one.)
- With `message.body` set, the body is exactly our text, with no quoted history. That quoting is what `comment`
  does, and Graph rejects a request that sets both.
- Graph returns `202` with **no id**, so no sent Message-ID is stored. The Sent Items sync brings the copy back,
  and the body-fingerprint echo gate adopts it onto the row the send wrote.
  - Unverified until a live test: whether Outlook's plain-text Sent copy hashes the same after trimming. If it
    doesn't, the thread shows one duplicate outbound row. That is cosmetic: it does not send again.
- Sending happens only from an approved `send_reply` pending action: her tap, `body_sha256` checked against the
  stored body, claim-once, and zero retention (only the fingerprint is kept). A guard test fails if anything
  else references `sendOutlookReply`.

## Checklist when the scope is added (in this order)

### 1. Engineering (one PR, reviewed alongside the Azure steps)

1. **Split the scope lists in `server/lib/integrations/outlook.ts`.** Add `Mail.Send` to the **authorize** request
   only.
   - Today `msRefresh` sends the same `SCOPES` string. If `Mail.Send` were simply appended, every refresh for an
     existing connection that never consented to it would fail (`AADSTS65001` consent required). Outlook ingest
     would then stop for every current Outlook user.
   - The refresh already asks for what the row was **granted**: `refreshScopesFor` adds `Mail.Send` to the read
     set only when `connected_accounts.scopes` carries it (independent review, PR #1212). So appending `Mail.Send`
     to the authorize request alone is safe for existing connections; keep `msRefresh` on `refreshScopesFor`.
2. Make reconnect request `Mail.Send` (incremental consent). Microsoft shows only the new permission on the
   consent screen. Existing users keep reading until they choose to reconnect.
3. Turn on `OUTLOOK_SEND` in dev only. Then do the live checks below with a test Outlook account. Never use an
   athlete's mailbox.
4. Prod: the owner runs `gcloud run services update … --update-env-vars OUTLOOK_SEND=true`. Then the YAML is set
   to match (the prod flag guard refuses a deploy that would switch it on).

### 2. Azure / Entra app registration (owner, in the portal)

1. **API permissions:** add Microsoft Graph → Delegated → `Mail.Send`.
   - Microsoft marks it "admin consent required: No". A tenant's own policy can still require it.
2. **Publisher verification:** this is the priority, and it is required before work or school users can consent
   to a multi-tenant app registered after Nov 2020.
   - Link a Microsoft AI Cloud Partner Program (Partner Center) ID.
   - Set a verified publisher domain (nomila.co).
   - The app must be owned through an Entra **work** account, not a personal MSA. If it isn't, it has to be
     re-registered, and the client ID changes.
3. Confirm the registration is still multi-tenant + personal accounts (`common`), and that the redirect URI is
   unchanged.
4. Optional: Publisher Attestation (Microsoft 365 App Compliance). Microsoft has no app review for delegated
   Graph mail permissions, and no CASA equivalent.

### 3. What changes for the person connecting

- **Consent screen:** a new line, roughly *"Send mail as you"*, under the existing read permissions. Personal
  accounts (@outlook, @hotmail) consent themselves.
- **Work and university tenants:** the outcome depends on the tenant's user-consent policy.
  - The Microsoft-managed default blocks user consent to mail permissions. Those users get "Need admin approval"
    or the admin-consent request workflow.
  - Tenants that allow consent for verified publishers let them through once step 2.2 is done.
  - Prepare the admin-consent URL for IT: `https://login.microsoftonline.com/{tenant}/v2.0/adminconsent?client_id=…&scope=https://graph.microsoft.com/Mail.Send …&redirect_uri=…`.
    It needs an admin-consent landing route registered as a redirect URI. That route is not built yet.
  - Escalate to a university's IT only when its policy actually requires it.
- **Existing Outlook connections:** nothing changes until they reconnect. Their cards keep saying "reconnect
  Outlook to allow sending".

### 4. Live checks before prod (dev, test account)

- [ ] A reply sent from the app lands in the same conversation in Outlook and in the recipient's client (Gmail
      and Outlook recipients).
- [ ] The body arrives exactly as approved, with no quoted history and no extra signature.
- [ ] The Sent copy comes back through sync without a duplicate outbound row (the fingerprint matches).
- [ ] A message moved to another folder before sending gives "isn't in your Outlook inbox any more… Reply in
      Outlook". Mutable ids change when a message is moved.
- [ ] A grant without `Mail.Send` gives the reconnect card and error, and nothing is sent.
- [ ] Ingest keeps working for a connection that never reconnected (the refresh scopes from step 1.1).
