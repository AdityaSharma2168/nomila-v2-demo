# Voice grant rollout (launch blocker, 7 Oct 2026)

**What it fixes.** The 17 internal voice routes (`/api/internal/voice/athletes/:id/...`) took the
athlete from the URL and checked only the shared `x-voice-secret`. Anyone holding that secret could
read or write any athlete by changing `:id`. Now each voice session carries an athlete-bound grant,
and every route checks that the path athlete is the session's athlete.

**How it works.**

- `POST /voice/token` (server/voice/webTokenRoute.ts) mints `grant = v1.<claims>.<HMAC-SHA256>` over
  `{athleteId, conversationId, exp}` with `VOICE_GRANT_SECRET`. `athleteId` is `req.athleteId` from
  `requireAuth`, nothing else. `exp` = now + 60 min session ceiling + 5 min buffer.
- The grant rides in the LiveKit dispatch metadata (`{athleteId, conversationId, grant}`), which is
  signed by LiveKit. The worker (nomila-co/mila-voice) reads it and sends it as `x-voice-grant` on
  every `/api/internal/voice/*` call, alongside `x-voice-secret`.
- `voiceAuthorized(req, req.params.id)` (server/voice/auth.ts) is the only guard on every route:
  - secret missing or wrong: **401**, always;
  - grant missing, invalid, expired or unconfigured: logged; **401** when `VOICE_GRANT_ENFORCE=true`;
  - grant valid but for another athlete: logged; **403** when `VOICE_GRANT_ENFORCE=true`.
- With the flag unset (default) the server is in **observe mode**: it logs
  `"Voice grant check failed"` with `reason` and `enforced:false` and lets the request through.
- `brand-knowledge` returns shared brand data that `:id` does not scope; the secret alone would be
  safe there. It goes through the same guard anyway, so there is one rule for all routes.

## Rollout order

0. **Create the secret** `VOICE_GRANT_SECRET` in Secret Manager (`gamechanger-pocket-agent`), 32+
   random bytes, and grant the Cloud Run runtime service account `secretAccessor`. Do this BEFORE the
   server PR deploys: `gcp/cloud-run-dev.yaml` references it as a `secretKeyRef`, and a missing
   secret stops the revision from starting. Server only; the worker never needs it. Add it to
   `gcp/cloud-run-prod.yaml` the same way when prod is stood up.
1. **Deploy the worker first** (mila-voice PR). It sends `x-voice-grant` whenever the metadata has
   one, and nothing changes while the server ignores the header. An older server sends no grant; the
   worker then sends only the secret, exactly as before.
2. **Deploy the server in observe mode** (`VOICE_GRANT_ENFORCE` unset). New sessions now get a
   grant.
3. **Check the logs show 0 failures** over real voice sessions (at least a day of use). In Cloud
   Logging: `jsonPayload.msg="Voice grant check failed"` (module `voice/auth`). Expect zero
   `reason="athlete_mismatch"`. A `missing` only from sessions that started before step 2 is fine;
   a steady stream means the worker is not sending the header.
4. **Turn on** `VOICE_GRANT_ENFORCE=true` on the Cloud Run service (a config change, no deploy). To
   roll back, unset it.
5. **Later:** stop relying on the secret alone. Rotate `VOICE_SERVICE_SECRET` and treat the grant as
   the athlete boundary. The secret stays as the "this is our worker" check.

## Limits (on purpose)

- A session that runs longer than 65 minutes loses its tools once enforcement is on (401). No hard
  session cap exists today; 60 minutes is the ceiling chosen here (`VOICE_SESSION_MAX_MS`).
- The grant is readable by the browser that holds the LiveKit token (it is in the JWT payload). It
  only names that browser's own athlete and is useless without the service secret.
- The grant's `conversationId` is signed but not compared against request bodies. Conversation
  ownership is already checked per athlete in each write path (see server/voice/tenancy.test.ts).

## State and the deletion fence (10 Nov 2026)

- **Dev:** `VOICE_GRANT_ENFORCE=true` since 2 Nov (gcp/cloud-run-dev.yaml; the live revision carries it).
  mila-voice main sends `x-voice-grant` on every internal call, with the path athlete taken from the same
  dispatch metadata as the grant.
- **Prod:** off, and in the prod flag guard. Before prod voice is switched on, prod needs: the
  `VOICE_GRANT_SECRET` secret (prod's own, created in Secret Manager and referenced in
  gcp/cloud-run-prod.yaml — it is not there today), a deploy in observe mode, a clean log check, then
  the owner's `--update-env-vars VOICE_GRANT_ENFORCE=true` and the YAML set to match.
- **Deletion fence:** `voiceAuthorized` also checks the account-deletion fence (lib/privacy/deletionFence.ts)
  after the secret and grant, on every route. An athlete being deleted, or one whose row is gone, gets
  **410** `{error:"account_deleting", message}` and the route reads and writes nothing. This does not
  depend on `VOICE_GRANT_ENFORCE`.
