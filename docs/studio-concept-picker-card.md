# Card — Agent concept picker (PR 3b)

**Status:** CARD, 22 Sep 2026. **Not built in PR 3**, for three reasons:

1. **The spec does not specify it.** `docs/specs/creative-architecture.md` has no "concept", no picker and no flow. Its Creative
   Director (§4) goes from intent straight to a Creative Spec (§5). This card's design is therefore ours, and needs Mia.
2. **It needs `AgentScreen.tsx` and the planner.** Both are PR 2's until it merges.
3. **"Concept" is already taken, twice.** The narrator's `CampaignConcept` is the deck card (`server/services/narrator.ts:394`,
   `CampaignConceptCard.tsx`). `server/studio/concept.ts` is A3.2's concept image generation, which is not wired. A third
   "concept" needs its own name in code. Proposed: **direction**, as in `proposeDirections()` and `DirectionPicker`.

## Proposed flow (ours, not the spec's)

1. She types her sentence on the Agent tab, and can pick one of her brand profiles.
2. **One text-only call** proposes **3 distinct directions**. Each is a `CampaignBrief` (campaign-brief/1), validated by
   `validateCampaignBrief`. There is no casting, no preview and no video, so it costs about $0.002.
3. She picks one, or mixes lines from several: tone from one, story from another. The mix is also validated.
4. **The chosen brief becomes `PlanAsk.campaign`** (wiring card step 2). Her sentence stays `PlanAsk.prompt`. The planner and the
   Board are unchanged.

## What 3b would touch

- `server/studio/campaign/directions.ts` (the call, strictly validated, fenced like the reference engine) and its PGlite test.
- One route behind `STUDIO_BRAND_PROFILES`.
- `client/…/DirectionPicker.tsx` and `AgentScreen.tsx`. Per DESIGN.md: pill buttons, radius-lg cards, no blur, reanimated only.
  Verify on the iOS Simulator and at phone width in Chrome.

**Size: L.** Most of the work is on the client.
