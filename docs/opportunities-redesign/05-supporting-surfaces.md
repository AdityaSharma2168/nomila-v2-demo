# WS5 — Supporting surfaces

**Goal:** the surfaces the Brief routes into — Files, The Week, Gifting, From People, In Flight,
Couldn't-read. Each is a 20-second glance or a place-you-go; none is a second inbox.

**Branch:** `feat/opps-ws5-surfaces` (or split per surface) · **Depends on:** WS3 (parse gate,
archived write path, voice), WS1 (shell for Files/Week tabs).

---

## The surfaces

### 5A · Files (top tab — the cabinet)
- **Organized by brand, not time.** 224 threads → ~60 brand files. Search over extractions + raw text.
- Each row: logo · brand (+ "via {agency}") · **disposition stamp** (In play / Asked terms / Waiting
  on them / You passed / Done / Can't read / Lapsed) · one sentence of Mila's filing note · thread
  count + last date.
- **No badges, no unread counts, no notifications — ever.** That's what stops it being inbox #2.
- Opening a file = dossier first (what they wanted / money / the story), raw thread behind a
  disclosure. "Pull it back" → re-briefs it (one pink action).
- **Needs the `archived` write path** — see engine dependency.

Tasks:
- [ ] `FilesView` (top tab) — brand-grouped list, disposition chips, filing notes (`composeDealVoice`
      short form), search.
- [ ] Filter chips (Has a number / No number / You passed / Can't read).
- [ ] File detail (dossier + raw thread disclosure + "Pull it back").
- [ ] **`archived` write path:** `PATCH /inbox/threads/:id { status }` endpoint (none exists today);
      wire "file"/"archive" actions to it. (Or repurpose the `deals` status + a new value — decide in WS3.)

### 5B · The Week (top tab — the receipt)
- Sunday accountability. Sections: Arrived · You moved · **Set aside by Nomila** (itemized, each line
  `Undo`/`Wrong?`) · Still waiting · The Bar (0-great reframed as "held your line at $835") · Track
  record ("reopened 2 of last 214 · 99.1%").
- **24-hour hold** before any auto-decline actually sends (so same-day undo = brand never saw a "no").
- `Wrong?` feeds the eval-fixture pipeline (Phase-2 learning seed).

Tasks:
- [ ] `TheWeekView` (top tab) rendering the receipt from an `agent_actions` log (new table — see below).
- [ ] `agent_actions` table (action, dealId, reason, reversible, held_until, undone_at) feeding the
      receipt. (Also the co-pilot audit trail.)
- [ ] Undo (bulk PATCH) + `Wrong?` (write eval fixture).
- [ ] Track-record computation (reopened / total filed).

### 5C · Couldn't-read (pushed screen)
- Real brands whose emails didn't parse. **Human eyes before robot apologies:** "Look at the original"
  (WebView of stored HTML) → "Yes I read it" (capture sheet feeds pipeline, `humanRead:true`) OR
  "it's blank" (resend draft framed as an email glitch). Never scored (WS3 parse gate).
- Six-Star-style timestamp-only threads: Mila declines to draft.

Tasks:
- [ ] `CouldntReadView` — cards for `unreadable` threads (WS3 flag).
- [ ] Raw-email WebView modal (render stored HTML).
- [ ] Capture sheet (offer? / what they want? / notes) → re-run classify+score for that thread
      (needs the **reclassify endpoint**).
- [ ] Resend draft (email-glitch framing).

### 5D · Gifting (sheet)
- 38 offers, **silence = pass** (no "pass" button). Tap "Want it" only. Promotion to a real ask keys
  on brand tier / wishlist (not product value). 14-day lapse computed at render (no scheduler).

Tasks:
- [ ] `GiftingSheet` — "Want it"-only rows; Mila's one-line note; promoted-gifting exception.
- [ ] Lapse-at-render (no job).

### 5E · From People (pushed screen)
- Her "fan" pile is mostly newsletters/noise. Default state **quiet**; warmth only when real fan mail
  exists. Strata: **Might be business** (recovery → reclassify), **A real question** (Open the DM,
  she types), **Filed without you** (count + examples + "Mute senders like these").
- **Never auto-reply to fans, any level.**

Tasks:
- [ ] `FromPeopleView` — 3 strata; reuse `FanMessageCard`.
- [ ] "Treat as a deal" → reclassify endpoint (shared with 5C).
- [ ] "Mute senders like these" (sender-level filter).

### 5F · In Flight (pushed screen)
- Deals where **she's waiting on them** (turn = brand) + a **Committed** section (accepted MEDIA/
  EDITORIAL). Turn is mechanical (can't go stale). Negotiation timeline (amounts sequence).
- **No calendar** — Mila says the limitation out loud: "I can't hold a calendar for you yet."

Tasks:
- [ ] `InFlightView` — turn-based cards + timeline (from `amounts[]` / status transitions).
- [ ] Committed section (accepted time-commitments; honest no-calendar line).

## Shared server changes (WS5)

- [ ] **`PATCH /inbox/threads/:id { status }`** (archive/file) — does not exist today.
- [ ] **Reclassify endpoint** — one-shot re-run of classify+score for a thread id (5C + 5E).
- [ ] **`agent_actions`** table + writes (5B).

## Test plan

- [ ] **Unit:** disposition-stamp derivation; filing-note composition; sender-type mute filter.
- [ ] **Integration:** archive a thread → status flips, leaves Brief, appears in Files under the right
      stamp; "Pull it back" re-surfaces it.
- [ ] **Integration:** reclassify a "fan" DM → becomes a deal, enters the pipeline, shows in Brief/Files.
- [ ] **Integration:** The Week renders from `agent_actions`; Undo reverses a filing; `Wrong?` writes a
      fixture.
- [ ] **Manual (`/verify`) on real data:** Files shows Mia's real brand files (Playermaker IN PLAY,
      adidas CAN'T READ, Hisense WAITING ON THEM); From People shows the real student-pitch recovery;
      Couldn't-read shows adidas/lululemon and the WebView renders the stored HTML.

## Acceptance criteria

- Files is brand-grouped, badge-free, searchable; archive round-trips.
- The Week itemizes every auto-action with Undo + Wrong?, 24h decline hold, track-record number.
- Couldn't-read never shows a score; human-eyes-first flow works.
- Gifting disposes by silence; From People stays quiet without real fan mail; In Flight turn state is
  mechanical and honest about the missing calendar.

## Risks

- **Filing notes are generated** — a wrong note on a "Can't read" file is stickier than a wrong inbox
  subject; notes on unreadable files must visibly hedge.
- `agent_actions` is new schema; keep it append-only and reversible.
