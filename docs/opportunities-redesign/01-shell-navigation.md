# WS1 — Shell & Navigation

**Goal:** Opportunities becomes a 3-tab container (Brief / The Week / Files) without deleting the
existing screen. Cheapest stream; lands first; unblocks the others.

**Branch:** `feat/opps-ws1-shell` · **Depends on:** nothing · **Blocks:** visual home for WS2/WS5.

---

## Scope

**In:** the top-tab shell inside `OpportunitiesScreen`, the tab bar, routing the three views,
preserving the current list as a fallback view.
**Out:** the content of Brief / Week / Files (those are WS2 / WS5). WS1 delivers empty-but-wired tab
shells + the existing list living under one of them.

## Reuse

- **Pattern:** `BrandScreen.tsx:103` (`const [activeTab, setActiveTab] = useState<...>("overview")`)
  + tab bar at `:172-182` (label + underline, `styles.tabUnderlineActive`) + conditional render.
  Copy this pattern verbatim — no new tab library, no `react-navigation` top tabs.
- **Existing screen:** `client/screens/OpportunitiesScreen.tsx` (574 lines) — keep it. Its
  `MoneyHero` + `CategoryFilter` + list becomes the **"Classic" fallback view**, initially the default
  until Brief is proven, then demoted.
- **Nav:** `OpportunitiesStackParamList` (`MainTabNavigator.tsx:48-51`) — currently
  `{ OpportunitiesList, Thread }`. We add pushed routes over the course of WS2/WS4/WS5; WS1 only
  touches the in-screen tab state.

## Tasks

- [ ] Add `activeTab: "brief" | "week" | "files" | "classic"` state to `OpportunitiesScreen`.
- [ ] Build the tab bar row (reuse `BrandScreen` tab styles; 3 primary tabs + a temporary "Classic"
      access while building).
- [ ] Extract the current list body into a `ClassicOpportunitiesView` component (pure move, no logic
      change) so the screen can switch views cleanly.
- [ ] Render placeholders for `Brief`, `The Week`, `Files` (simple "coming soon" panels wired to real
      data counts, so the shell is testable before content lands).
- [ ] Default tab = `classic` for now (flip to `brief` at the end of WS2). Add a build-time flag /
      constant so the default is a one-line change.
- [ ] Preserve deep-links: cross-tab "Tailor & send" (`OpportunitiesScreen:60-65`) and the `Thread`
      route must still work from whichever view is active.

## Server changes

None.

## Client changes

- `client/screens/OpportunitiesScreen.tsx` — add tab state + bar; wrap existing body in
  `ClassicOpportunitiesView`.
- `client/components/deals/OpportunitiesTabs.tsx` (new) — the tab bar (or inline, matching BrandScreen).
- No `MainTabParamList` change (Opportunities stays one bottom tab).

## Test plan

- [ ] **Manual (`/verify`):** launch app, open Opportunities, switch all three tabs + Classic; confirm
      no crash, state persists on tab switch, Classic still shows real deals and can still reply.
- [ ] **Regression:** the existing reply-from-list flow still sends (drive one real reply from Classic).
- [ ] **Deep-link:** trigger "Tailor & send" from a brand and confirm it still lands correctly.
- [ ] Typecheck + existing tests green.

## Acceptance criteria

- Opportunities shows a working 3-tab bar matching the Brand screen's look.
- The current experience is fully intact under "Classic" — zero regression.
- Switching tabs is instant and preserves scroll/filter state where the view is unchanged.

## Risks

- Low. The only real risk is accidentally regressing the existing list during the extract-to-component
  move — mitigated by driving a real reply in the test plan.
