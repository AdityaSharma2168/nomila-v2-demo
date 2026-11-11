# Create Anything threads — session persistence plan v2 (APPROVED; server half built as S.1–S.3, client half as C.1–C.7)

> **[S.4] Moved into docs/ with the server half (studio/sessions-server, 2026-09-15).** Approved by Adi on
> 2026-09-14, all eleven decisions as recommended (below). The only edits since approval are marked **[S.4]**:
> this note, the decisions block, and **§11 — As built: the server half**, which records every decision taken
> during the build and what is known to remain. The plan body is as it stood at approval, including its
> references to the planning sessions' scratchpads (plan v1 is not in the repo).
>
> **[C.8] The client half (studio/sessions-client, 2026-09-15)** adds only **§12 — As built: the client half**, and this
> line. The plan body above it is unchanged.

## [S.4] Decisions, as approved (2026-09-14)

- **D1 (a)** Make it opens as a sheet over the thread.
- **D2 (a)** Many threads; the door resumes the latest open one.
- **D3 (a)** "+" leaves the old thread open.
- **D4 (a)** Tombstone; cascade only on ownership.
- **D5 (a)** Edit this pre-fills nothing; the placeholder reads "What should change?". And yes: "Not what I meant"
  puts her sentence back in the composer.
- **D6 (a)** Status is derived at read. The job row is the status.
- **D7 (a)** History plus a fresh composer; the unsent tray is not persisted.
- **D8 (a)** Archive only.
- **D9** Adi's for dev: the migration, schema.ts, the db-migrate.sh line and the mount ship as planned. The
  shared-schema change is flagged to Mia at merge time as a courtesy, not a blocker.
- **D10 (a)** Split, server half first; its merge makes deploy-dev create the tables.
- **D11** Defaults: `STUDIO_SESSIONS` / `EXPO_PUBLIC_STUDIO_SESSIONS` off; tables `studio_sessions` /
  `studio_session_entries`; branches `studio/sessions-server`, then `studio/sessions-client`.

---

This is a plan only: no branch, no code. The recon cost $0 (no DB, no model calls). It read the main checkout at **c4951e2**. origin/main is **18b36ca**, whose only change is `docs/runbooks/beta-launch-checklist.md`, so the recon is current.

It supersedes v1 (be9c933e's scratchpad), which was written on 7bbe608, before the interpreter merged. v1 had no in-thread output, no edit-from-chat, and a video-blind entry model.

---

## 1. Recon

### 1a. What the screen holds, and what dies

`CreateAnythingScreen` is component state only.

- **`turns: Turn[]`.** Each turn is `{ id, who: "you" | "mila", text, card: "product" | "photo" | "ready" | "frame" | null }`. The list is not append-only:
  - cards are filtered out when they're answered or dismissed;
  - `say()` drops any "ready" card before it appends.
- **The tray.** `attachments: PickedAttachment[]` holds library picks only (`MediaLibraryView`), so every item already has a `media_assets` id. Its `uri` is the signed thumbnail.
- **Other state:** `frameAssetId`, `pendingFrame`, `carriedOn`, `gated`, `draft`.
- **In Make it:** `correctedRegions`, the preview mutation, and `runError` / `runNote`.

That state dies on:

- **Made it → back.** This is `navigate("StudioHome")`, which pops the stack. It's the normal end of every generation.
- the back chevron;
- **a web reload.** App.tsx has no `linking` and no persisted nav state, so she lands on home;
- an app kill;
- **Threads → "+".** A new `threadKey` remounts the screen, by design.

It survives pushing Make it (Create anything stays mounted underneath) and a trip to Threads and back.

Existing stubs:

- `useStudioThreads` returns `[]` (use-studio-pending.ts:310).
- `PENDING` already names "Studio threads persisted + GET/POST /studio/threads".
- ThreadsScreen is complete except for its data source.
- Both screen headers say "SESSION-ONLY … the LAST phase".

**The thread has never shown an output, even while it was alive.**

### 1b. The completion flow today

**Where the work happens.** There is no polling and no push. Generation runs inside `POST /studio/generate`, and the HTTP request stays open for the whole run: about 25 s, plus about 4 s when QA is on.

**Order of operations inside `runStudioGeneration`** (generate.ts:833):

1. Re-derive the verdict from the frozen brief.
2. `createGenerationJob`, status `pending`.
3. **`consumePreview`**, which writes `consumed_at` and `consumed_by_job_id` onto the preview row (:911).
4. `claimJob`, status `running`.
5. The model call.
6. `storeAsset` and `recordGeneratedAsset`, which write a `media_assets` row: origin `generated`, approval `draft`, `generation_job_id`, `derived_from_asset_id` on edits, and a thumbnail written at record time.
7. `succeedJob`.

**Where she lands.** `MakeItRoute.onMake` awaits the response. It takes the first asset that has a url and calls `navigate("StudioMade", { heroUri, assetId, … })`.

- MadeItScreen shows "It is made", a download row that only flips local state, and a schedule stub.
- Its back button goes to StudioHome, which unmounts the thread.
- On `already_running` or an empty result, she stays on Make it with a `runNote`.

**If she leaves mid-run, nothing aborts the job.**

- The route passes no signal.
- Express doesn't cancel handlers.
- Both Cloud Run configs set `cpu-throttling: "false"` and `timeoutSeconds: 3600`.

So the job finishes and lands on the shelf; she just never sees it arrive.

**The reconnect route is unused.** `GET /studio/jobs/:jobId` already exists ("reconnect and refresh only"; tested at studio.generate.test.ts:365), but no client calls it. The client has no polling precedent: `refetchInterval` is `false` globally.

### 1c. What already exists as rows

| What the thread needs                                  | Where it already lives                                                                                                                      | Plan                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| her words                                              | `brief.job.direction.statement`, but only for sends that reached a preview. Gated prompts and client-classifier asks mint no row.           | **new**: entry text                       |
| the interpreter card                                   | `brief.job.interpretation.lines`: the exact lines she was shown (routes/studio.ts:834). Beside them: `canonical`, `askReason`, `outcome`.   | reference by preview_id                   |
| the verdict                                            | preview columns `status`, `cost_usd`, `unpriced`, `expires_at`, `consumed_*`. "Not what I meant" is `plan->>'interpretation_rejected_at'`.  | reference                                 |
| her corrected mask                                     | a re-check mints a new preview, and its brief carries the regions                                                                           | reference                                 |
| the output                                             | `consumed_by_job_id` → `generation_jobs` (status, started_at) → `media_assets` (generation_job_id, media_type, approval_status, deleted_at) | **derived at read, zero writes at spend** |
| attached photos                                        | `media_assets` ids                                                                                                                          | reference                                 |
| image bytes                                            | GCS objects, signed at serve (~1h)                                                                                                          | never copied                              |
| the session: identity, order, grouping, title, archive | nothing                                                                                                                                     | **new**                                   |

- There are no "interpretation rows". The record lives inside the preview's brief and is reached through `preview_id`.
- Only one datum is duplicated: her sentence (≤ 2000 chars). It has to be, because gated and asked prompts have nowhere else to live.

### 1d. Tenancy

- **Previews, jobs and assets** all have `athlete_id NOT NULL … ON DELETE CASCADE`.
- **Reads put `athlete_id` in the predicate** (`loadPreview`, `readJob`, `assetsForJob`), so not-found and not-yours give the same answer.
- **`media_assets.generation_job_id` is a bare uuid**, so content.ts puts `athlete_id` on the join as well.
- **`readOwnedImage` is the one predicate for any source frame or reference.** It checks athlete, `status = stored` and `deleted_at IS NULL`. It accepts generated drafts, so the server already allows edit chains.
- **Sessions follow the same shape.** They are athlete-scoped and cascade from athletes. A composite FK means an entry cannot land in another athlete's session.

### 1e. Deletion and expiry today

- **Nothing deletes** a preview, job or asset row, except the athlete cascade.
- **Nothing writes `media_assets.deleted_at`.** content.ts and readOwnedImage read it, but no code (and no script or migration) sets it.
- **Previews expire but are never swept.** Their TTL is 30 minutes. The schema calls them "disposable history", and `idx_studio_previews_expiry … WHERE consumed_at IS NULL` anticipates a sweep of unconsumed rows.
- **Recommendation: tombstone** (§5).

### 1f. Re-attaching to an in-flight job

**Server: already possible.**

- The job id is on the preview row before the model is called.
- Job status is truthful.
- Outputs are rows.
- The job route exists.

**Client: not possible.**

- The approved previewId lives only in Make it's state, and dies with it.
- Nothing records which preview a conversation approved.
- There is no watcher.

**New plumbing needed:**

1. Persist the plan entry's `preview_id`.
2. Derive the job and its outputs at read.
3. Add a client poll on the **existing** job route.

None of this is a new write in the spend path.

**Gap: no reaper.** A job whose instance dies stays `running` forever. The fix is to derive a "stalled" state after 10 minutes, at read time, with no write.

### 1g. Lane check

The style-vocab worktree (`/Users/adi/nomila-v2-worktrees/style-vocab`) is **clean at c4951e2**, with nothing committed. So this check is against its approved design, not a diff.

That design touches:

- classify.ts;
- compile/looks.ts, plus templates;
- interpret/menu, prompt, core, eligibility, plus fixtures;
- the `look_unknown` copy, which would land in `client/lib/studio-contract.ts` `askCopyFor`.

**Shared files: none.**

- This plan imports from studio-contract.ts and never edits it.
- It doesn't edit routes/studio.ts either; the sessions router builds its own gate.
- The nearest neighbour is server/studio/config.ts. Ours is one function beside `studioEnabled` at :584. The style-vocab design adds no flag.

**Why Mila's `conversations` table was rejected again:**

- its turns are text-only;
- it carries a summary/fold machine Studio doesn't need;
- `chat_messages.athlete_id` has no cascade;
- it's Ask Mila's lane.

---

## 2. Schema: two tables, additive

```sql
-- migrations/0054_studio_sessions.sql  (the next free number at build time)
CREATE TABLE IF NOT EXISTS studio_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- normally client-minted, claimed on first append
  athlete_id  uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  title       text,                                        -- her first prompt, one line, ≤ 80
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),          -- bumped per append: list + resume order
  CONSTRAINT studio_sessions_id_athlete_uniq UNIQUE (id, athlete_id)
);
CREATE INDEX IF NOT EXISTS idx_studio_sessions_athlete_updated
  ON studio_sessions (athlete_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS studio_session_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- client-minted: a retried append is a no-op
  seq         bigint GENERATED ALWAYS AS IDENTITY,         -- insertion order IS thread order
  session_id  uuid NOT NULL,
  athlete_id  uuid NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  kind        text NOT NULL,                               -- prompt | plan | ask   (writer-enforced, no CHECK)
  text        text,                                        -- prompt only
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,          -- ids + closed codes only
  preview_id  uuid REFERENCES studio_generation_previews(id) ON DELETE SET NULL,  -- plan only
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_session_entries_session_fk FOREIGN KEY (session_id, athlete_id)
    REFERENCES studio_sessions (id, athlete_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_studio_session_entries_session
  ON studio_session_entries (session_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_session_entries_preview
  ON studio_session_entries (preview_id) WHERE preview_id IS NOT NULL;
```

| kind     | whose  | text              | payload                                                                  | preview_id                |
| -------- | ------ | ----------------- | ------------------------------------------------------------------------ | ------------------------- |
| `prompt` | hers   | her words, ≤ 2000 | `{ stoppedFor?: "product" \| "photo" }`                                  | —                         |
| `plan`   | Mila's | —                 | `{ promptEntryId, sent: Ref[] ≤ 12, frameAssetId, carriedOn, format }`   | the preview she was shown |
| `ask`    | Mila's | —                 | `{ promptEntryId, reason: code, sent, frameAssetId, carriedOn, format }` | —                         |

`Ref = { assetId, role: "source-frame" | "product" | "object" }`

**Payload rules.**

- **Ids and closed codes only; unknown keys are rejected.** This is voice_context's invariant.
- **`reason` must match `^[a-z_]{1,40}$`.** It renders through `askCopyFor`, whose default covers any code the client doesn't know.
- **No CHECK on `kind`.** The precedent is chat_messages.source: widening a CHECK needs a DROP + ADD pair, which raced and broke two deploys.

**What is derived, not stored.**

- **Role comes from `kind`.** Storing both would give them a way to disagree.
- **Status is not stored** (D6). It is derived at read from the preview and job rows.
- **The output is not an entry.** It is reached as plan → preview → `consumed_by_job_id` → job → assets, so the spend path does zero writes.
- **Not stored at all:** transient UI (the frame question, "That is what I was missing") and the unsent tray (D7). The carry-on is `carriedOn` on the plan; the gate stop is `stoppedFor` on the prompt.

**Superseded plans.** A mask correction or "Check again" appends a new plan for the same `promptEntryId`. An **unconsumed** plan that has a later sibling renders collapsed. A consumed plan always renders in full.

**Ordering.** `seq` is an identity column. The client serialises appends per session, so insertion order equals conversation order.

**Claims.** The session row is created by its first append, so a thread that was opened and abandoned leaves no row.

**Caps.**

- 1000 entries per session (then 409, "start a new thread")
- 12 refs per entry
- 50 entries per page
- 30 sessions per list page
- 80-character titles
- A per-athlete limiter on POST: express-rate-limit, 60/min, local to the router.

**Video-agnostic.** Nothing in the model names an image. Refs are asset ids, and outputs arrive as `media_assets` rows carrying `media_type`.

- The renderer switches on that type. IMAGE shows the picture and **Edit this**.
- Anything else shows a generic tile that opens MediaDetail, with no Edit this, because edits are stills-only.
- Nothing video-specific is built.

**Migration: one commit** containing the SQL file, the `shared/schema.ts` declarations and the `scripts/db-migrate.sh` step-3 line. It can't be split, because of the HARD drift gate.

- It's additive and uses `IF NOT EXISTS`.
- On merge, deploy-dev applies it to nomila-v2-db.
- On promote, deploy-prod applies it to nomila-prod-db, DB-first. That's backward-compatible, because the old image never reads these tables.
- It takes a brief lock on `studio_generation_previews` for the FK, which is negligible.
- **Rollback** is turning the switch off. There is never a DROP.

**Retention.**

- Rows are kept until she archives, and archived rows are kept too. There's no TTL and no cron.
- URLs are signed at read only.
- A standing constraint is written on the new table: **a future preview sweep must spare previews that entries reference**, or accept tombstones.

---

## 3. Server

**New files:**

- `server/studio/sessions.ts`, with a PGlite suite;
- `server/routes/studioSessions.ts`, with a route suite;
- the migration.

**Edits:**

- `shared/schema.ts`
- `scripts/db-migrate.sh`
- `server/index.ts`: one mount
- `server/studio/config.ts`: `studioSessionsEnabled()`

**The gate.** `requireSessions` 404s unless both `studioEnabled()` and `studioSessionsEnabled()` are true. It is followed by `requireAuth` and a local `requireAthlete`, so routes/studio.ts gets no diff.

| Route                                            | What it does                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /studio/sessions?archived=&limit=30`        | The list: id, title, updatedAt, archived, thumbUrl (the latest output's thumbnail). Read only.                                                               |
| `GET /studio/sessions/:id?before=<seq>&limit=50` | The entries, hydrated, plus one asset map for the page. Read only.                                                                                           |
| `POST /studio/sessions/:id/entries`              | Appends one entry. The first append claims the session (Mila's `resolveVoiceConversation` pattern). Idempotent by entry id. Returns the effective sessionId. |
| `PATCH /studio/sessions/:id`                     | `{ archived }`                                                                                                                                               |

**Re-attach adds no route.** Hydration returns `run.jobId`, and the client polls the existing `GET /studio/jobs/:jobId`.

**Hydration**, per plan entry. There's an athlete predicate on every join: sessions, entries, previews, jobs and assets.

```
preview: { status, costUsd, unpriced, expired, rejected, lines, askReason, blockingNote } | null
run:     { jobId, state: "making" | "made" | "failed" | "stalled", outputIds[] } | null
assets:  { [assetId]: { mediaType, thumbUrl, url (outputs only), approvalStatus, state: "ok" | "removed" } }
```

**Card state, checked in order:**

1. **The preview is gone** → `gone`.
2. **The preview was consumed** → go by the job:
   - succeeded → `made`;
   - failed or canceled → `failed`;
   - pending or running, under 10 min old → `making`;
   - pending or running, 10 min or older → `stalled`.
3. **Not consumed** → take the first that applies:
   - rejected → `not_meant`;
   - blocked → `blocked`, with `askReason` when the interpreter asked;
   - expired → `expired`;
   - otherwise → `checked`.

**Never returned:** `brief`, `plan`, gcs paths, `last_error`.

**Writes validate ownership, never structure.**

- The session (through the claim), the `previewId`, and every asset id are each checked with an athlete-scoped select.
- A dangling `promptEntryId` is tolerated and renders ungrouped.
- `ON CONFLICT DO NOTHING` makes a retry a no-op.
- The title is the first prompt, one-lined. A COALESCE keeps the first one.
- `updated_at` is bumped on every append.

**No spend surface.** sessions.ts imports nothing from generate, router, adapters, interpret or compile, and makes no model call.

---

## 4. Client (the shape D1 recommends)

**The route.** `StudioCreateAnything: { sessionId?: string }` replaces `threadKey`, and it is still the React key.

- **With no param**, the route resolves the latest open session (D2), or else mints one with `Crypto.randomUUID()` (expo-crypto, already a dependency).
- **If the server answers 404**, the thread runs session-only: today's lifetime, with the new lifecycle.
- **If the read fails**, the screen says "Couldn't load this thread" with a retry. It never shows an empty thread.

**History.** History hydrates into **inert** items (`threadLogic.toItems`). Only items created in this mount are live. There's a "Load earlier" control, 50 entries per page.

**Appends.**

- They are optimistic and go through a serialised queue, with 3 retries.
- They never block a send or the spend.
- After a final failure, one quiet "Not saved" line appears.

**`make()` opens the Make it sheet over the thread.**

- The sheet is the same `MakeItScreen` component, rendered by a thread-owned container, `ThreadMakeIt`, that runs `useGenerationPlan` and `useRejectInterpretation`.
- Nothing navigates.
- When a preview lands, a plan entry is appended; `uq_…_preview` dedupes StrictMode and retries.
- An ask appends an ask entry.

**Approve.**

- The sheet closes, and the plan card shows an inline loading tile.
- `useThreadRuns` calls `useGenerate().mutateAsync({ previewId })`: the same hook with the same body.
- **Success:** the image replaces the tile in place, straight from the response.
- **A 409:** the server's sentence appears, with "Check again".
- **`already_running`:** the thread watches that jobId.

**Resume mid-run.** Hydration says `making`, so `useJobWatch(jobId)` polls every 3 s while the thread is focused. It stops on a terminal state or after 10 min, then swaps the image in place.

**"Check again"** appears on checked, expired, failed and stalled history cards. It mounts a fresh `ThreadMakeIt` from the stored plan (her words, the sent refs, the frame), which asks for a **fresh preview**. A Generate button never sits over a preview this mount didn't render.

- Her corrected mask isn't carried into it: the server re-derives the area, and she re-marks if she needs to.

**"Not what I meant"** closes the sheet. The card shows the rejection, derived from the preview row. Pre-filling the composer is D5.

**The output card.**

- The image; a tap opens `AssetViewer`.
- An **Edit this** pill.
- "On your Made shelf".
- Tombstone tiles have no Edit this and no viewer.

**Edit-from-chat.**

- **Where:** Edit this appears on any IMAGE in the thread, both outputs and the "Built from" thumbs. `AssetViewer` gains an optional `onEdit` prop, and existing callers are unchanged.
- **What it does:** it puts the image in the tray as `source-frame` and sets it as **the** frame explicitly. There's no "which one?" question, because the tap is the answer. Then it focuses the composer.
- **What follows:** the next send's preview is an edit of that asset, and its plan card and result land below.
- **Testing:** the transition is the pure function `editFromChat(tray, frame, asset)`, with its own test.
- **With a waiting gate:** it satisfies a gate that is waiting for a photo, through `resolveAfterAttach`, exactly as attaching does.

**New thread.**

- A "+" sits in the topbar, beside the list button. It mints a new uuid and remounts. The old thread stays open (D3).
- In Threads, rows open their `sessionId` and "+" mints a new one. Archive and restore work there, and each row shows a relative time and a thumbnail.

**Phone width.**

- A single column.
- An output is capped at the thread width and at 55% of the window height (GenerationResult's bound).
- Thumbnail strips are 56px.
- The sheet is full-screen.
- Edit this is a pill of at least 120px.
- DESIGN.md: cards use radius `lg`, Feather icons only, no blur, and a reanimated fade.

**Left untouched:**

- **MadeItScreen and MakeItRoute.** The brand and personal flows still use them.
- **MakeItScreen.tsx**, except for an `export` on `InterpretationCard`: history renders the same card with `onReject={null}`.

**Tripwires.**

- Persisted roles render through `ROLE_LABELS`, which is a total map.
- The Exclude maps in AttachSheet and SetupScreen stay, and so do their comments. They remain true, because the tray still isn't persisted.
- Three stale notes get rewritten:
  - the two SESSION-ONLY headers;
  - use-studio-pending.ts's note about a deploy.yml DDL block.

**Flag.** With `EXPO_PUBLIC_STUDIO_SESSIONS` off, today's flow is byte-identical.

**Files.**

- New:
  - `client/hooks/use-studio-sessions.ts`
  - `client/screens/studio/threadLogic.ts`, with a test
  - `client/screens/studio/ThreadMakeIt.tsx`
  - `client/screens/studio/ThreadCards.tsx`
- Edited:
  - `CreateAnythingScreen.tsx`
  - `ThreadsScreen.tsx`
  - `use-studio-pending.ts` (the `useStudioThreads` body and the `PENDING` entry)
  - `MainTabNavigator.tsx` (the param type)
  - `flags.ts`
  - `AssetViewer.tsx`
  - `MakeItScreen.tsx` (one `export`)

---

## 5. Tombstone or cascade (recommendation: tombstone)

**Cascade is for ownership only.** Deleting an athlete removes both tables; deleting a session removes its entries.

**Everything else tombstones at render time, with no write:**

- **The preview row is gone.** The FK sets `preview_id` to NULL, and the card says "That check is no longer available".
- **The preview expired without being used.** The card says "That check expired" and offers Check again.
- **An asset has `deleted_at` set, or isn't `stored`.** It shows as a "Removed" tile: no Edit this, no viewer.
- **An asset is rejected.** It is still shown, with a label.
- **A GCS object is missing.** The image's `onError` shows the same tile.

**Why:**

- Her words and Mila's answers still happened. Cascading from an asset would silently delete her conversation.
- The refs are jsonb ids. Cascading from them would need a join table that nothing else reads.

---

## 6. Conversational memory: the interface, named but not built

```ts
// server/studio/sessions/prior.ts. The memory PR; NOT this one.
export interface PriorTurn {
  canonical: string; // brief.job.interpretation.canonical ?? brief.job.direction.statement
  steps: EditStep[]; // brief.job.editIntent.steps: what actually ran
  assetId: string; // the output that "make it blue" would edit
  previewId: string;
  jobId: string;
}
export function priorTurn(
  athleteId: string,
  sessionId: string,
): Promise<PriorTurn | null>;
```

**Which turn it returns.** The latest plan entry whose preview was consumed and whose job succeeded, with at least one stored, non-deleted output.

**Fed server-side only.**

- The preview request gains `sessionId`.
- The preview route resolves `PriorTurn`, sets `InterpretationInput.prior = { canonical, steps }` (reserved in v2 §14.2, not in core.ts yet), and defaults the frame to `assetId`.
- That is the preview route and the interpreter, which is their lane, so it belongs to the memory PR.

**Nothing extra needs storing now.**

**For acceptance.** Until the memory PR lands, "make it blue" after Edit this still has no referent for "it", so it asks. Use explicit words.

---

## 7. Proof

### Headless ($0, PGlite, written before any wiring)

1. **`server/studio/sessions.test.ts`**
   - **Tenancy:**
     - athlete B can't read, append to or archive A's session;
     - B can't reference A's preview or A's assets;
     - the list is own-only;
     - a not-yours id gets the same answer as a missing one.
   - **Writes:**
     - the claim race: two concurrent first appends make one session;
     - an idempotent append;
     - `seq` order;
     - caps;
     - payload validation: unknown keys, prose in code fields, closed roles;
     - title and COALESCE;
     - archive and restore;
     - the `updated_at` bump.
   - **Hydration:**
     - checked, expired, blocked and rejected;
     - making, stalled, made and failed;
     - a deleted asset tombstones;
     - an asset pointing at a foreign job never shows;
     - a preview row deleted to SET NULL gives `gone`;
     - the response never contains `brief`, `plan`, gcs paths or `last_error`.
2. **Migration test.** Apply the .sql file twice to a fresh PGlite, then check the columns match the schema.ts declarations. The precedent is `generationGuards.sql` in approval.test.ts.
3. **`server/routes/studioSessions.test.ts`**
   - Either flag off → 404.
   - Auth is required.
   - Bad bodies → 400.
   - Not-yours → the same 404 as not-found.
4. **`client/screens/studio/threadLogic.test.ts`**
   - entries → items: inert history versus live items;
   - every card state;
   - the collapse of superseded plans;
   - the resume rule;
   - the 10-minute stall rule;
   - the poll stop conditions;
   - the role fallback;
   - `editFromChat`: the frame moves explicitly, with no question.
   - The existing `handOff` tests stay unchanged and green.
5. **Lane.** The diff names none of: classify.ts, `compile/`, `interpret/`, nativeIntent.ts, preview.ts, routes/studio.ts or studio-contract.ts. The compile goldens stay byte-identical.
6. **Spend.**
   - The only new generate call site uses the same `useGenerate` with the same `{ previewId }` body.
   - The sessions code makes no model call.
   - sessions.ts has no spend-path imports.
7. **Gates.**
   - `check:types` and `lint`.
   - `check:format` on the touched files only, because main is ~728 files red.
   - The scoped suite via `npm test -- <paths> --runInBand`, since PGlite needs vm-modules.
   - Holds are proved with `--json`.

### Needs your eyes

- the in-sheet → in-thread handoff;
- the loading tile and the swap in place;
- edit-from-chat;
- the nested Modal: ItemisationSheet inside the sheet, on iOS and on web;
- phone width on both surfaces.

### Acceptance script

**Before starting.**

1. Prove the server runs the branch head: `lsof` cwd and `git rev-parse`.
2. Make sure the tables exist on nomila-v2-db (D10).
3. Set `STUDIO_ENABLED`, `STUDIO_SESSIONS` and `EXPO_PUBLIC_STUDIO_SESSIONS`.
4. Run Metro on `:8083`, and test in Chrome (not Safari) and in the iOS Simulator.

**The steps:**

- a) Send with a photo; the sheet opens with a free preview. Close it without approving; the card says "Checked · $0.13". Leave to StudioHome, then come back through the door: the same thread, with "Check again".
- b) Reload the web page or kill the app. Same result.
- c) **Real generation.** Approve; the sheet closes, the tile loads inline, and the image replaces it in place. Nothing navigates to Made it.
- d) **Real generation.** Approve, then go straight to StudioHome and come back through the door: "making…", then the image. Also try a web reload mid-run.
- e) **Real generation.** Tap Edit this on the output and type "make the sky pink". The new plan and result land below. Then tap Edit this on a Built-from thumb.
- f) "+" gives an empty thread. The old one is in Threads with its scrollback and thumbnail. Archive it and restore it.
- g) Server flag off with the client flag on: the lifecycle works, nothing is persisted, and there are no errors. Client flag off: today's flow, exactly.
- h) Repeat a, c and e at phone width in Chrome and in the Simulator.

**Spend:** three real generations at about $0.13 each, capped at four (≈ $0.54).

---

## 8. Sizing and the split

| Half       | Contents                                                                   | Size (with tests) | Stop                    |
| ---------- | -------------------------------------------------------------------------- | ----------------- | ----------------------- |
| **Server** | migration, schema, sessions.ts, router, mount, flag, three suites          | ~1.4k LOC         | stop for tenancy review |
| **Client** | hooks, threadLogic, ThreadMakeIt, ThreadCards, screens, AssetViewer, flags | ~1.9k LOC         | stop for acceptance     |

**If it's split, ship the server half first.**

- It's inert: the flag is off and nothing calls it.
- It can be proved fully headless.
- **Merging it makes deploy-dev create the tables on nomila-v2-db**, so the client half's acceptance needs no manual psql.

The other possible cut is lifecycle first: the client ships the sheet, the in-thread output and edit-from-chat, session-only and with no DDL. Persistence follows.

---

## 9. Decisions needed

- **D1. Where approval happens.**
  - (a) _Recommended:_ Make it as a sheet over the thread, opened on send. It's the same component as today, and approving drops her back into the thread with the loading tile.
  - (b) Card first: Mila answers inline with a plan card, and "Review and make it" opens the sheet. One extra tap.
  - (c) Fully inline, no sheet. That makes a second spend surface built from MakeItScreen's parts.
- **D2. What a thread is.**
  - (a) _Recommended:_ many sessions, which is what the Threads screen is built for. The door resumes the latest open one.
  - (b) The same, but only if it was touched in the last 24h (v1's rule).
  - (c) One rolling thread per athlete.
- **D3. What "+" does to the old thread.**
  - (a) _Recommended:_ it stays open in Threads, untouched.
  - (b) It's auto-archived.
- **D4. Tombstone or cascade.** _Recommended:_ tombstone, per §5. Cascade only on ownership.
- **D5. What gets pre-filled.**
  - _Recommended:_ Edit this pre-fills nothing. The placeholder reads "What should change?" and the image sits in the tray marked EDITING.
  - Alternatives: her last prompt, or suggestion chips.
  - "Not what I meant" refills the composer with her sentence. _Recommended:_ yes.
- **D6. Status.**
  - _Recommended:_ derived at read, with no stored column.
  - The alternative is a status the client writes.
  - Why derived:
    - The only writer that knows "done" is the generate request, and this plan doesn't touch it.
    - The client is absent in exactly the case this feature exists for.
    - So a stored status would be wrong precisely when it matters. The job row already is the status.
  - This departs from your brief, which listed a status field.
- **D7. Unsent state on resume.**
  - _Recommended:_ not persisted; she gets a fresh composer.
  - The alternative persists the tray, draft and frame.
- **D8. Delete.**
  - _Recommended:_ archive only in v1.
  - The alternative is a hard delete, which removes her words too.
- **D9. Shared-schema sign-off.** The change is `shared/schema.ts`, `scripts/db-migrate.sh` and the `server/index.ts` mount. Is that yours to approve, or Mia's?
- **D10. Split and DDL timing.**
  - _Recommended:_ split it, and ship the server half first; its merge creates the tables.
  - Or: one PR, and you run `! psql "$DATABASE_URL" -f migrations/0054_studio_sessions.sql` before acceptance.
- **D11. Defaults, unless you say otherwise.**
  - Flags `STUDIO_SESSIONS` and `EXPO_PUBLIC_STUDIO_SESSIONS`, both off.
  - Tables named `studio_sessions` and `studio_session_entries`; the UI keeps saying "threads".
  - Branches `studio/sessions-server`, then `studio/sessions-client`, in worktrees off origin/main.

---

## 10. What the pre-push review will flag

**Outside Studio proper:**

- `shared/schema.ts` (+2 tables)
- `scripts/db-migrate.sh` (+1 line; the prod schema path)
- `server/index.ts` (+1 mount)
- `client/navigation/MainTabNavigator.tsx` (a param type)

**Destructive surface:** one additive migration, applied by the deploy on merge.

**Not surfaced today, and still not surfaced here:** `failedTargets` on partial edits. `GenerationRun` doesn't carry it, so it's a follow-up.

---

## 11. As built: the server half [S.4]

Branch `studio/sessions-server`, off main **655ea36** (#467 merged). Commits: S.1 migration + schema + db-migrate.sh
(one commit, the drift gate), S.2 the store, S.3 the routes + mount + flag, an S.2 follow-up (three guards the
revert checks found unpinned), S.4 this document.

**The lane, re-checked against #467 as merged (not its design).** #467 touched classify, compile/looks + templates,
interpret/_, brief.ts, nativeIntent.ts, keepVocab/lookVocab, routes/studio.ts (A3b's card), studio-contract.ts,
use-studio(-pending).ts and MakeItScreen.tsx. The server half touches none of them. routes/studio.ts has no diff:
the sessions router builds its own gate, and nothing in studio.ts matches `/studio/sessions_` (it has no
router-level middleware). The one semantic dependency is below.

**Departures from the plan, each for a reason:**

- **The preview hydration returns `card: { lines, refusable } | null`, not `lines`.** A3b (#467) added a second
  card source: `BriefJob.card`, the rules' lines when her keep froze beside their steps, which are not refusable.
  The read mirrors the client's `previewCard`: the interpreter's lines when present (refusable), else the rules'
  (not refusable). A keep-bearing preview's history card shows what she was shown.
- **`blockingNote` covers gap-borne blockers only.** Routing blockers (`previewGeneration`'s own) are not on the
  preview row, and re-deriving them would import the provider router, a spend-path module. With none, the note
  is null and the client says the generic thing. The engine's no-mask note is skipped too, because the preview
  route rewrites it for the surface (`humanize`) and the history card should not show the engine's words.
- **`askReason` is the interpreter's own code (`interpretation.askReason`) or null.** The route's
  `routed.reason` fallback is not stored on the brief. An ask entry carries its own code in the payload.
- **The migration's index is `updated_at DESC NULLS LAST`.** That is Drizzle's spelling of `.desc()`. The
  migration test compares the file's shape with schema.ts's and caught the plain `DESC` on its first run. The
  list query orders by exactly this.
- **Unplanned but needed:**
  - `before` that isn't a seq is a 400, because ignoring it would answer "load earlier" with the newest page
    again, and a client would loop on it.
  - A retry into another athlete's thread id replays rather than minting a second fresh thread.

**Shapes as built:**

- `POST …/entries` body: `{ id, kind, text? (prompt), previewId? (plan), payload }`. The payload is a closed shape
  per kind; unknown keys are refused everywhere.
  - Answers: 201 (written) or 200 (replayed), both `{ sessionId, entryId, seq }`; 409 when the thread is full or
    the entry id is taken; 404 `{ field }` for an id she doesn't own.
- `GET …/sessions/:id` → `{ session, entries (oldest first), assets, earlier }`.
  - A plan entry carries `state`, `preview`, `run: { jobId, state, outputIds }`.
  - `assets` is one map per page: `{ mediaType, thumbUrl, url (outputs only), approvalStatus, state }`.
- `GET …/sessions` → `{ sessions: [{ id, title, archived, createdAt, updatedAt, thumbUrl }] }`, newest 30. There is
  no cursor. Add one only if the Threads screen needs more than 30.
- `PATCH …/sessions/:id` `{ archived }` → `{ session }`. It does not bump `updated_at`, and keeps the first archive
  time.
- An append to an archived thread is allowed and does not un-archive it. Whether it should is the client half's
  product call.

**Proof ($0, PGlite):**

- Suites: sessions.migration.test.ts (10), sessions.test.ts (85), routes/studioSessions.test.ts (27).
- Revert checks: 39, with 98 red against 100 predicted (38 of 39 exact). The record is in the PR body.
- Scoped Studio suite (serial, via `npm test`): main `655ea36` 70 / 2202 / 0 → branch `9c37499` 73 / 2324 / 0,
  with 0 failed-to-run. All 2202 baseline tests pass by name, and the 122 new ones are the three suites above.
- Two properties are prod-only, and no PGlite suite can show them. The cap is counted per append, not locked,
  because the client serialises a thread's appends. A concurrent first append in Postgres waits on the winner's
  row, then takes the loser's path. The deterministic test pins that path.

**Known to remain (the client half and later):**

- The client half (plan §4) starts only on Adi's word, after this merges and deploy-dev creates the tables.
- `failedTargets` on a partial edit is still not surfaced (§10).
- The memory interface (§6) is named, not built.

---

## 12. As built: the client half [C.8]

Branch `studio/sessions-client`, off main **c86bace** (#471 merged). Commits: C.1 threadLogic (the pure core and
its tests, written before any screen read it) · C.2 the data layer (inert) · C.3 the lifecycle (session-only) · C.4
persistence, resume and history · C.5 edit-from-chat · C.6 Threads · C.7 the server's un-archive · C.8 this section.
Two follow-ups: a C.3 follow-up (the keyboard goes down when the sheet comes up — nothing navigates any more)
and a C.1 follow-up (two pins the revert-check predictions showed were missing, written before any mutation ran).

**The re-check on fresh main, before building.** Since c4951e2 the only client drift was #467: `previewCard` and
`card` on the plan view (A3b), and `look_unknown`'s copy. The server half hydrates `card: { lines, refusable }` to
match, so a history card renders MakeItScreen's own InterpretationCard with `onReject={null}`, whatever
`refusable` says. The thread never offers "Not what I meant": she answered it in the sheet, or the card is
history. CreateAnything, Threads, the navigator,
AssetViewer and flags were exactly as §4 assumed.

**The three product calls from the server half, as built:**

- **An append to an archived thread un-archives it.** Server-side (C.7): one field in `appendEntry`'s existing
  bump, so it is atomic with the entry. A refused append (a full thread) un-archives nothing, and a replay never
  reaches it. A client PATCH before the append would have been two requests, non-atomic, and only as correct as
  every client that remembered it.
- **The list is the newest 30, no paging.** Threads shows open, then archived, 30 of each.
- **The 1000-cap is client-disciplined.** The append queue sends one entry at a time per thread, in the order she
  made them. `seq` is insertion order, and the cap is counted per append rather than locked (§11).

**Departures from §4, each for a reason:**

- **"Not what I meant" puts back her sentence AND the photos it was about** (`composerAfterReject`), unless she has
  put something in the tray since. Refusing a reading is not refusing the request: she will say it another way,
  about the same photo, and a composer that came back without it turns a rephrased edit into a generate from
  nothing. D5 named only the sentence.
- **Two 404s, read differently** (`listReadFor` / `threadReadFor`). On the list, a 404 is the gate: the server has
  threads off, the thread runs session-only, and nothing is said. On one thread, a 404 is an id nobody has appended
  to yet (a "+" or a fresh door), which is genuinely empty. Anything else that fails is "Couldn't load this thread"
  with a retry, never an empty thread.
- **The door pins its answer into the route params.** The list is read fresh on every mount (the app's default
  staleTime is Infinity), and a later read that found another thread newer must not move her out of the one she is
  in.
- **The queue holds entries while the server's answer is unknown**, and drains once it says on. A send in a
  thread's first second is kept, not dropped. A thread that read back 200 proves the server keeps threads, even
  when the list failed.
- **A dropped connection mid-generate is "lost", not "failed"** (`generateFailure`, `recoverLost`; not in §4).
  Nothing aborts a run on a disconnect (§1b), so "it didn't come out" could send her to pay twice. The tile stays,
  and 2 s later the thread re-reads its own plan entry. A spent preview is watched on its job. An unspent one
  "didn't go through", with Check again. Nothing readable says where to look.
- **Edit this on a Built-from thumbnail is in the viewer.** A 56px tile has no room for a pill of DESIGN.md's
  120px, so a tap opens AssetViewer, whose new optional `onEdit` is the pill. Outputs carry the pill inline as
  well.
- **Check again refuses when a photo it was built from is removed**, rather than quietly dropping it. Dropping it
  would check a different job: an edit of a photo that is gone comes back as a generate from nothing.
- **The client's ask stays in the sheet, as Make it always showed it,** and is recorded in the thread as Mila's
  reply (the ask entry). The interpreter's ask is a blocked plan, and its card says the ask's own copy.
- **ThreadMakeIt's hooks live outside the Modal.** Closing the sheet hides it without unmounting the check, so a
  preview that answers after she closed it still becomes a card, and a plan entry, rather than a preview row no
  thread names.
- **The watch is a plain interval, not a query.** Each answer is a decision (`pollOutcome`), not data to cache.
  Ticks never overlap, and the ten-minute clock survives focus changes within a mount.
- **The thread follows its tail only while she is at it.** Load earlier, or an image landing above, doesn't yank her
  down. With the flag off, every content change still scrolls to the end.
- **The hooks import the thread's policy and types from `screens/studio/threadLogic.ts`** (use-studio-sessions,
  and a type in use-studio-pending). No hook imported from screens/ before. The policy is the thread's, and tested
  there; a copy in the hook would be the one that drifts.

**Continuation, the follow-up after acceptance.** In a thread, the next send is about the last thing it made. With
nothing in the tray, her next send's frame defaults to the thread's latest image she can still edit
(`continuationFrame`). The screen puts it in the tray through `editFromChat`, the same plumbing and wire as Edit this.
A quiet "Editing your last image" line, with its thumbnail and an ×, sits above the input, and the placeholder asks
"What should change?". Before this, "make it warmer" after a result became a brand-new image from her words alone:
with no photo, the classifier allows GENERATE and nothing else. And "put the cap on me" was stopped to ask for a
photo of her that was on screen. Anything in the tray turns the default off. If a gate stops the prompt, the frame
waits in the tray as a chip. The × sends that one fresh, and nothing older stands in for the image she declined.
Client-only: the preview request's shape is Edit this's, so the preview route, classify and the interpreter have no
diff. What "it" means in "make it blue" is still not resolved; that is the memory PR's `InterpretationInput.prior`
(§6). One gap it does not close: "make the jersey blue" still stops at the product gate, because `whatIsMissing`
reads "the jersey" as a named product even with her photo in the tray. That is pre-existing, and outside a frame
default.

**Left as §4 said, and now slightly stale:** AttachSheet's and SetupScreen's Exclude-map comments stay (the tray
still isn't persisted), but their parenthetical "useStudioThreads is a stub" is no longer true. Fixing it is a
comment edit in two files §4 said to leave; it is flagged here rather than made.

**The lane, re-checked on the branch:** the diff names none of classify.ts, compile/, interpret/, nativeIntent.ts,
preview.ts, routes/studio.ts or studio-contract.ts. The compile goldens (server/studio/compile/golden.test.ts)
run in the scoped suite and pass by name; nothing under compile/ is in the diff. The one new generate call site is
`useGenerate().mutateAsync({ previewId })` in CreateAnythingScreen: the same hook, the same body. MakeItScreen.tsx
gets `export` on InterpretationCard, plus the rewrite of its session-only note §4 asked for.

**Proof ($0):**

- **Suites:** `client/screens/studio/threadLogic.test.ts` (79): every card state, the collapse, the resume rule, the
  stall and poll-stop rules, the role fallback (own-property, so `constructor` reads "Attachment"), `editFromChat`,
  the append policy, the door, Check again, `recoverLost`, and the append bodies' key sets pinned by hand against
  `parseEntry`'s. `server/studio/sessions.test.ts` +2 (the un-archive, and a refused append un-archiving nothing).
  The existing `handOff` tests (createAnythingLogic.test.ts) are untouched and green.
- **Scoped Studio suite** (serial, jest direct — `npm test` drops `--json` since #469): main `c86bace` 73 / 2324 / 0
  → branch `7cdf61c` 74 / 2405 / 0, 0 failed-to-run. All 2324 baseline tests pass by name; the new ones are threadLogic's and
  the store's two.
- **Revert checks:** 29, each predicted by name before it ran — 32 red, 29 of 29 exact, every named hold read
  passing from the run's json. Two pins were added while the predictions were drawn up, before any mutation: without
  them one check would have read 1 red instead of 2, and one 0 instead of 1. The record is in the PR body.
- **Gates:** tsc 0. eslint: every new file 0/0; every edited file equals base (MainTabNavigator's one error and
  use-studio-pending's one warning are main's; the store suite's 8 warnings are the jest.mock-before-imports class).
  New files are prettier-clean; every added line in the edited files, which main leaves unformatted, matches
  prettier.
- **Flag off:** with `EXPO_PUBLIC_STUDIO_SESSIONS` unset, `make()` pushes StudioMakeIt exactly as before
  (`git diff -w` shows the navigate block unmoved), useStudioThreads returns the stub's own value, no new request is
  made, and nothing new renders. Server flag off with the client on is session-only: the list's 404 turns saving
  off, and nothing is said.

**Known to remain:**

- **Signed URLs expire in about an hour.** A thread left open that long shows an image that no longer loads as
  "Removed" (§5's onError tombstone) until the thread is reopened and re-signed. The copy says "Removed" for both.
- **No renderer in jest** (`testMatch` is `.test.ts`), so the screens' proof is the device pass and your
  acceptance. Every decision a screen makes is a pure function with a test.
- **New copy is placeholder wording, a Mia review item:** the card headlines, "That didn't go through…", "We lost
  the connection…", "Threads aren't kept here yet", "Couldn't load this thread".
- **The effective-id re-home** (the server answers another athlete's minted id with a fresh thread of hers) is
  followed by the queue, but not by the read side: that thread reads as its minted id until the next door.
  Reaching it needs a uuid collision.
- `failedTargets` on a partial edit is still not surfaced (§10). The memory interface (§6) is still named, not
  built.
