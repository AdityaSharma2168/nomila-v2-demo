# WS4 — Ask-for-Terms batch

**Goal:** one control that turns the ~77 unpriced threads into replies-with-numbers, safely, without
making the athlete look like a bot. The highest-leverage control in the product — and the
highest-risk surface.

**Branch:** `feat/opps-ws4-batch` · **Depends on:** WS3 (`request_terms` + bulk PATCH + `pending_action`).
**Build LAST.** Ship "fresh only" first.

---

## Scope

**In:** the Brief entry card, the review screen (segmented, per-row editable, exclusions, rate
toggle), the send plan + confirm, the drip mechanism, the running tile, priced-reply return handling.
**Out:** autopilot batch send (Phase 2 — v1 is always previewed/co-piloted).

## Reuse

- `request_terms` intent + `composeDealVoice` + bulk PATCH + `pending_action` (all WS3).
- The reply send route (per-thread replies, threaded). The batch is N `pending_action`s, each an
  ordinary threaded reply — **no new send path**.
- Draft streaming for the per-message edit sheet.

## The model (from the design)

- **Segment by thread age × sender type**, NOT brand tier. adidas and a no-name both get asked for a
  budget; tier snobbery in copy insults the small brand that would've paid.
  - A — Fresh (<30d), direct brand
  - B — via an agency
  - C — Gone quiet (30–90d), copy owns the slow reply lightly
  - D — Old (90+d), **off by default**
- **Four copy variants** (A/B/C/D). All ask for **budget + deliverables + timeline**; none names her
  rate unless the toggle is on (`rate at render`, WS3).
- **Rate toggle** "Include my rate ($835)" — off by default ("I'd rather hear their number first").
- **Exclusions** hard-excluded from the pool: unreadable threads (→ WS5), passed-on threads (asking
  reopens a killed deal).
- **Drip:** newest-first, ~15/day, stated in plain words. Each is a `pending_action`.
- **Co-pilot:** "Approve the batch" only at the user's mandate level; the cautious default is
  "Show me each one before it goes."

## Tasks

- [ ] Brief entry card ("77 brands never named a price → Review & send").
- [ ] Review screen: segments (age × sender-type), per-row toggle, per-row preview, edit sheet.
- [ ] Sender-type classification (agency vs direct brand) from domain — deterministic, no LLM.
- [ ] The 4 copy templates + the render-time rate injection (only when toggle on).
- [ ] Same-agency collapse: shared-domain detection → one message per agency, not per brand
      (reduces the "template shows" smell).
- [ ] Exclusion logic (unreadable, passed) + the "set aside (N)" summary.
- [ ] Send plan screen: count, drip schedule, "stop the rest any time," confirm.
- [ ] Execute as N `pending_action`s on a drip (WS3 lifecycle). Respect mandate level.
- [ ] Running tile pinned to Brief: "Terms asked · X of Y sent · Z replies · [Stop the rest]".
- [ ] Priced-reply return: when a reply comes back with a number, it becomes a normal Brief
      `negotiate` card ("UGREEN came back: $400/post…").

## Server changes

- Batch creation endpoint (creates N `pending_action`s with drip timestamps) — but **no scheduler
  exists** (see risks). v1: either send-now-in-a-throttled-loop, or require the app foreground to
  advance the drip. Decide explicitly; do not fake "sends Friday."
- Reuse bulk PATCH for exclusions / stop-the-rest.

## Test plan

- [ ] **Unit:** segmentation (age buckets, agency-domain detection); exclusion of unreadable/passed;
      same-agency collapse.
- [ ] **Unit:** copy variant selection + rate injection only when toggle on; assert no rate leaks when off.
- [ ] **Integration:** approve a 3-item batch → 3 `pending_action`s → 3 threaded replies sent, each in
      its own thread, recorded outbound. Stop-the-rest cancels the remainder.
- [ ] **Integration:** a priced reply returns → surfaces as a `negotiate` Brief card.
- [ ] **Manual (`/verify`) — SANDBOXED:** run against **≤3 test threads only**, never the full 77, and
      confirm real threaded sends. Bulk email from a real athlete identity is not to be load-tested on
      real brands.
- [ ] Deliverability sanity: confirm each is a threaded reply from her mailbox (not a new cold email).

## Acceptance criteria

- The batch produces per-brand, per-thread, per-variant replies — no two identical, all threaded.
- Nothing sends without approval at the current mandate level.
- Exclusions and stop-the-rest work; priced replies re-enter the Brief.
- **Ships "fresh only" (~18) first** as the initial rollout, not all 77.

## Risks (highest of any stream)

- **Bulk email from the athlete's identity.** Threaded + per-brand wording reduces but doesn't remove
  the smell. Same-agency collapse is required.
- **Self-inflicted reply flood:** 61 asks → 15–25 replies into a product premised on her not
  answering. The running tile + priced-reply cards must absorb it. **Mitigation: launch fresh-only.**
- **No scheduler.** "Drip over 4 days / nudge Friday" cannot be honestly rendered until a scheduler
  exists (Phase 2). v1 drip must be real (throttled send / foreground-advanced) or the copy must not
  promise future timing.
- **Reputational, not technical** — 15 threaded replies/day is well under spam heuristics.
