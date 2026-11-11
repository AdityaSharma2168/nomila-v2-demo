# ADR-015 — User identity is distinct from athlete identity

Status: **LOCKED** (10 Sep 2026). Recorded from the product owner's decision; no implementation
requested. ADR-001 to ADR-014 live in the Nomila Product & Intelligence Architecture Blueprint V1
/ Commercial Intelligence Beta.1 specification, which remains the canonical source of truth.

## Decision

A **user** is an authenticated person. An **athlete** is a domain entity. They are different
things. A user may be permitted to act on or view one or more athletes, and an athlete may be
acted on by more than one user. New architecture must not assume one athlete = one user = one
account.

Nomila will ultimately support multiple authenticated user types: athlete, agency
representative, school / college / pro-team representative, brand representative, and Nomila
internal / admin.

## Long-term access model (anticipated, not built)

```
User
  ↓
Membership
  ↓
Organization
  ↓
Role + Permissions + Scope

Organization
  ↓
Portfolio
  ↓
Athletes
```

Organizations may include: agency, school / university, pro team / club, league, brand.

Explicit athlete ↔ organization relationships will eventually be needed, such as
`represented_by`, `enrolled_at`, `plays_for`, `sponsored_by`, `managed_by`.

## Consequences for Phase A designs

Until the access model is built, every Phase A design must:

- Flag any proposed schema or service that assumes the athlete is necessarily the
  authenticated user.
- Keep `athlete_id` as the domain owner of social identities, observations and intelligence
  records; never couple them to auth-user ownership.
- Not add `organization_id` to intelligence tables merely for future-proofing. Organization and
  portfolio access will be handled through relationships and authorization, never by
  duplicating intelligence per tenant.
- Preserve provenance and ownership sufficiently that a future authorizer can decide who may
  access private versus public or derived data (see ADR-016).
- Surface any decision that would make organization memberships, portfolio access, scoped
  permissions or athlete consent harder to add later.

## Current state this ADR is recorded against

Today the `athletes` table doubles as the user table: it carries `auth_id` (the Firebase UID),
`auth_provider`, `email`, `plan`, `stripe_customer_id`, and `account_roles` references
`athletes.id` with roles `athlete | fan | brand | school_admin | admin`. `requireAuth` resolves a
token to `req.athleteId` by `athletes.auth_id`. That is the assumption this ADR retires over
time; it is not changed by this record.

## Not decided here

The membership, organization, portfolio, role and relationship schemas; migration of
`athletes.auth_id` into a user table; how existing `account_roles` map onto memberships.
