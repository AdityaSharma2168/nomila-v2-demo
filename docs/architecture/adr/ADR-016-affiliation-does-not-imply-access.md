# ADR-016 — Organization affiliation does not imply access to private athlete data

Status: **LOCKED** (10 Sep 2026). Recorded from the product owner's decision; no implementation
requested. Companion to ADR-015.

## Decision

Being affiliated with an athlete through an organization (a school, an agency, a team, a
league, a brand) does **not** by itself grant access to that athlete's private data. Access to
email, DMs, camera roll, connected social data, deal economics, private strategy and similar
must ultimately be governed by explicit permissions, relationship scope and athlete consent.

Example: a school may be permitted to see an athlete's public Marketability intelligence and
portfolio-level analytics without being permitted to see the athlete's private inbox, DMs,
camera roll or personal deal negotiations.

## Data classes this implies

Phase A records must carry enough provenance for a future authorizer to tell these apart
without re-deriving them:

| Class | Examples | Provenance that identifies it today |
|---|---|---|
| Private, athlete-consented | connected social analytics and per-post insights, inbox threads and DMs, camera-roll uploads, deal economics, drafts, strategy | `source_class = connected_verified`; `connected_accounts` rows; `deals`, `inbox_*`, `media_assets.origin = upload` |
| Public or researched | discovery counts, web research evidence, public Trends / GDELT | `source_class = platform_public | web_researched` |
| Derived | scores, rates, features, narratives | Must record the privacy class of their inputs SEPARATELY from authority: `social_features.input_access_class` (`public_only` \| `includes_athlete_private`) is set from the full input lineage, so a derived number from private inputs is never treated as public because its lowest-authority input happened to be public |

## Consequences for Phase A designs

- Every observation, distribution and feature row carries `source_class`, which is evidence
  AUTHORITY (connected > public > web-researched > imputed; `inferred` is derived) and nothing
  else. A feature's `source_class` is the lowest authority among its inputs.
- Authority does not classify access. A feature's privacy is `input_access_class`, derived from
  the complete `inputs.byClass` breakdown: `includes_athlete_private` whenever any input is
  `connected_verified` evidence (the athlete's consented private data), else `public_only`. A
  ratio of connected reach over a public follower count has `source_class = platform_public`
  and `input_access_class = includes_athlete_private`; the two fields answer different questions
  and a future authorizer must read the second, never infer it from the first. (Amended 10 Sep
  2026 at the Step 1a review.)
- Athlete consent is represented by the existence and status of the athlete's own connection
  (`connected_accounts`) and by athlete-asserted facts; designs must not lose that linkage.
- No Phase A design grants any non-athlete user access to anything; the current model has one
  user type acting as the athlete. Nothing here changes runtime behaviour.

## Not decided here

The permission vocabulary, consent records, sharing grants, and which derived outputs count as
"public Marketability intelligence" for a portfolio view.
