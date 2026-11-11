# Payments — brand commission engine

**Status:** proposal / build plan. Greenfield — nothing payments-related exists
on `main` yet (base `ed63ede`).
**What this is:** an **account-less portal for brands to pay athletes through
Nomila**, where Nomila **escrows the funds and takes a flat 10% commission**,
releasing to the athlete only on delivery. It is **not** a paywall and **not** a
subscription product — there is no gating of app features behind a plan.

Related workstream: the Opportunities launch fixes live in
[`docs/plans/opportunities-launch-fixes.md`](./opportunities-launch-fixes.md);
this plan **depends on** that work (§11) rather than re-adopting it.

---

## 1. Goal & non-goals

**Goal.** Turn detected brand deals into money that actually moves — safely.
A brand emails an athlete, Nomila detects the deal, and Nomila provides the rails
to (a) let the brand signal seriousness with a deposit and (b) pay the athlete
through an escrow that only releases on confirmed delivery. Nomila's cut is a
**flat 10%**, charged on top and paid by the brand.

The product is a **commission portal**, not a subscription: the value is trusted
escrow + done-for-you money movement, monetized per-deal.

**Non-goals (explicitly deferred — see §12).** App subscription tiers / a
`plan` paywall, fan (Patreon-style) subscriptions, and à-la-carte one-time
purchases. None of these are in scope; the commission engine is the whole build.

---

## 2. Architectural principles (non-negotiable)

1. **Brands are not app users.** A deal is auto-detected from the athlete's
   inbox; the brand is an external email sender with **no Nomila account**. Every
   brand-facing money action (deposit, payment, delivery confirmation) is an
   **account-less hosted flow reached via a signed link** — there is no
   logged-in brand session, ever.
2. **Payout is gated on delivery → use Separate Charges & Transfers (SCT)**, not
   destination charges. Funds are captured to **Nomila's platform balance**,
   held, then **transferred** to the athlete on confirmation. The commission is
   collected by transferring **less** than was charged — **never**
   `application_fee_amount` / `transfer_data.destination`. (Destination charges
   settle into the athlete's account immediately and therefore **cannot** support
   hold-until-delivered — SCT is required, not preferred.)
3. **Athletes must complete Connect onboarding before any payout.** Hard gate on
   the connected-account `stripe_transfers` capability.
4. **Webhooks are the source of truth** for every state transition — never trust
   the synchronous API response alone.
5. **Accounts v2 recipient accounts** — `POST /v2/core/accounts` with
   `configuration.recipient` requesting `stripe_transfers`; not legacy
   `type: 'express' | 'standard'`. *Build note:* confirm v2 recipient accounts
   are enabled on the Stripe account and supported by the installed SDK version.
   If not, SCT works fine on a **classic connected account** too, so this is a
   forward-looking default, **not a blocker** (see §14.4).

---

## 3. Current state & what to reuse

**Greenfield.** On `main` there is **zero** payments code — no `stripe.ts`, no
payment routes, no Connect, no payment tables. The only relevant thing that
exists is `deals.pending_action` (jsonb, currently schema-only / unimplemented),
which §9 repurposes.

**Do not merge the old stack.** A prior Stripe stack (commit `d9ff780`) sits on
the **unmerged** `feat/stripe-payments` branch. It is **architecturally
superseded** by this design — it used destination charges + `application_fee`,
legacy `type: 'express'` accounts, a deposit coupled to the deal charge,
immediate payout, and a 15% carve-out. Merging it would fight every principle in
§2. Treat it as a **donor**, not a base.

**Donor map — cherry-pick these architecture-neutral pieces** (`git show
feat/stripe-payments:<path>`), not the money-movement logic:

| Reuse | From | For |
|---|---|---|
| The `getStripe` / `isTestMode` / `constructWebhookEvent` seam (lazy init, single vendor touch-point; tests mock the seam) | `server/lib/stripe.ts` | §13 Phase 1 |
| The `stripe_events` insert-or-ignore idempotency ledger pattern | schema + webhook | our `payment_events` (§9) |
| Raw-body webhook mount + signature verification | webhook route + `server/index.ts` | §10 |
| Env-overridable numeric config-knobs pattern (`PAYMENTS`, `envInt`) | `server/services/payments/config.ts` | fee/floor/window knobs |
| `notification_log` `payment_event` integration (row first, best-effort email, never throw) | webhook handlers | notifications |
| Deposit **re-auth cron** scaffolding (hourly sweep via `x-cron-secret`) | offers cron | §13 Phase 5 day-6 re-auth |

Everything that moves money is **rebuilt** to the SCT / dual-confirmation model.

---

## 4. Money model

Commission is **flat 10%, charged on top, paid by the brand** — never carved out
of the athlete's value. The brand also **covers Stripe's processing fees**, so
Nomila nets the **full 10%**. **Deal floor: $50** (below this, fixed fees eat the
margin).

Brand's total is grossed up so `total − stripe_fee = deal_value × 1.10`:

| Deal value | Commission (10%) | Processing (card) | **Brand pays (card)** | Athlete gets | Nomila net |
|---|---|---|---|---|---|
| $50 (floor) | $5 | ~$1.95 | **~$56.95** | $50 | $5 |
| $100 | $10 | ~$3.59 | **~$113.59** | $100 | $10 |
| $500 | $50 | ~$16.73 | **~$566.73** | $500 | $50 |

**Gross-up formula (card):** `total = (deal_value × 1.10 + 0.30) / (1 − 0.029)`.
The brand always sees an itemized total (deal + platform fee + processing).

**How SCT collects exactly 10% (the crux).** Charge the brand `total` to the
platform. Stripe's fee comes out of `total`, leaving **`deal_value × 1.10`** on
the platform balance. Transfer **`deal_value`** to the athlete. Nomila keeps
`deal_value × 0.10` = the 10%. Worked for $100: charge $113.59 → Stripe takes
$3.59 → $110.00 on platform → transfer $100 → keep $10. ✓ Because the brand
covered the fee, the commission is untouched.

### Settlement rails

Payment methods are **not restricted** (omit `payment_method_types`) so Stripe
surfaces the best option dynamically. For **large deals, bank/wire is
dramatically cheaper for the brand**:

- Card: ~2.9% + $0.30.
- ACH / bank transfer: **0.8% capped at $5**.

Example — $500 deal: ~$16.73 card vs ~$4.44 bank; a $5,000 deal: ~$145 card vs
the **$5 cap** on bank. (Bank total is grossed up the same way against the 0.8%,
capped, fee.)

Rail caveats baked into the design:

- Bank rails **cannot do holds** — irrelevant, because the *deal payment* is a
  capture, not a hold (only the *deposit* in §5 needs a hold, and it's card-only).
- Bank rails **settle slower** (ACH ~4 business days; wire ~same-day, manual).
  With a bank payment the escrow is **"funded pending"** until money lands; the
  athlete should not start work until it's confirmed funded (§6 step 6).

---

## 5. The two payment mechanisms

They are **independent** — the deposit is a pure trust signal, **not** a down
payment on the deal.

| | **Seriousness deposit** | **Deal payment (escrow)** |
|---|---|---|
| Initiated by | Brand, self-serve | Athlete / Mila, at agreement |
| Surface | Athlete's public page **+** auto-appended link in the thread | Checkout link in the thread |
| Mechanism | **Auth hold** (`capture_method: manual`) + **one re-auth** at ~day 6 (~14-day window) | **Capture** → hold on platform → **transfer** to athlete |
| Amount | Any (auth handles all sizes) | Deal value + 10% + processing gross-up |
| Purpose | Boost inbox ranking + "✓ Verified serious" badge | Actual settlement |
| Rail | Card only (holds are card-only) | Card **or** bank/wire (dynamic methods) |
| If deal proceeds | **Released on accept** — never captured | Held in escrow, released on delivery |
| If deal dies | Auth canceled / expires — zero fees | Refunded to brand |

**Seriousness deposit → inbox ranking.** A placed deposit is a new input to the
`dealDetector` scoring/ranking pipeline: a deposited deal **jumps in sort order**
and renders a "✓ Verified serious" badge. The boost (and badge) are removed the
moment the athlete accepts or declines and the hold is released.

---

## 6. End-to-end lifecycle

1. Brand emails → **deal detected** (existing pipeline).
2. *(optional, brand's move)* Brand places a **seriousness deposit** via link →
   **auth hold** → deal boosted in ranking + badge; one re-auth at ~day 6 keeps
   the hold alive across the ~14-day window.
3. **Negotiation** (existing Mila draft / negotiate flow).
4. **Both parties agree** → deal accepted → **seriousness deposit auth released**
   (never charged).
5. Deal formalized → athlete / Mila sends a **payment request** → brand pays
   (card or wire) = deal value + 10% + processing.
6. Funds **captured and held on Nomila's platform balance** (escrow). Once
   **confirmed funded** (immediate for card; after settlement for bank), the
   athlete may safely begin work.
7. Deliverable produced → **both athlete AND brand confirm the deal is done**
   (see §7).
8. On dual confirmation → **transfer** the deal value to the athlete's Connect
   account; Nomila retains the 10% commission.
9. Athlete paid out to their bank on Stripe's schedule (instant-to-debit at a
   ~1% premium is a future option — §14.3).

### Payment state (on `deals` + `payments`, not new `deals.status` enum values)

```
accepted → payment_requested → funded (escrow held)
        → delivered_pending_confirmation → settled (transferred / paid out)
```

Terminal branches: **`refunded`** (deal died pre-delivery) and **`disputed`**
(confirmation stalemate — §7).

---

## 7. Dual confirmation of delivery

Release happens **only when both parties confirm** the deal is done.

- **Athlete** confirms **in-app** (Opportunities screen / deal detail).
- **Brand** is not an app user → confirms via an **emailed link → hosted confirm
  page** (same account-less pattern as the payment link, §8).

**Open sub-decision — confirmation stalemate.** What if one side never confirms?

- (a) auto-release to the athlete after N days if the brand goes silent
  post-delivery;
- (b) hold + manual / dispute review;
- (c) auto-refund to the brand if the athlete never confirms delivery.

**Recommendation:** **auto-release to the athlete after a delivery-confirmation
window** (protects the athlete, who is the adoption driver), with a **dispute
flag the brand can raise before the window closes**. This must be locked before
building the Phase-4 release step (§13).

---

## 8. Brand-facing hosted surfaces (account-less)

Principle §2.1 means three hosted, login-less pages, each reached by a **signed,
single-purpose link** (deal-scoped token; no session):

1. **Deposit page** — place the seriousness hold (card). Linked from the
   athlete's public profile **and** auto-appended into the detected email thread.
2. **Payment page** — pay the deal (card or bank), itemized total. Linked from
   the thread when the athlete/Mila sends the payment request.
3. **Confirm-delivery page** — the brand's half of §7.

**Net-new capability: link injection into threads.** Outbound sending
(`sendGmailReply` / `sendInstagramDM`) is **plain-text today** and must now embed
these links. Scope this alongside the payment-request action (§11).

---

## 9. Data model additions (`shared/schema.ts`)

- **`connect_accounts`** — `athlete_id` → Stripe connected-account id, capability
  status (`stripe_transfers` active?), onboarding state. 1:1 with athletes.
- **`payments`** — one row per payment attempt: `deal_id`, `type`
  (`deposit` | `deal_payment`), `stripe_payment_intent_id`, `amount`,
  `commission_amount`, `processing_fee`, `rail` (`card` | `bank`), `status`,
  `hold_state`, `transfer_id`, `refund_id`.
- **`payment_events`** — raw Stripe webhook log for idempotency + audit (reuse the
  `d9ff780` `stripe_events` insert-or-ignore pattern; §3).
- Extend **`deals`** with escrow/payment fields (or a 1:1 join to `payments`)
  plus a **`deposit_status`** driving the §5 ranking boost.
- **`deals.pending_action`** (jsonb, already present, unimplemented) — the natural
  home for "awaiting brand payment" / "awaiting brand confirmation" prompts.

---

## 10. Webhooks

Add **`POST /api/webhooks/stripe`** to `server/routes/webhooks.ts` (currently
Gmail / Instagram only), signature-verified via `STRIPE_WEBHOOK_SECRET` on the
**raw body** (reuse the §3 mount pattern). Idempotency via `payment_events`
insert-or-ignore. Handle at minimum:

- `checkout.session.completed`, `payment_intent.succeeded` / `.canceled` /
  `.payment_failed` — fund escrow / release the deposit.
- `charge.refunded` — deal-died refund path.
- `transfer.created` — athlete settlement confirmation.
- `account.updated` — Connect capability transitions (payout eligibility).

---

## 11. Athlete UI additions (Opportunities screen)

The screen is already functional; payments add:

- **Public-profile deposit surface** + auto-appended deposit link in detected
  brand threads.
- **"✓ Verified serious" badge** and ranking boost for deposited deals (§5).
- **"Request payment"** action at agreement (Checkout link into the thread — the
  net-new link-injection capability, §8).
- **Payment status chips** (Deposit held / Awaiting payment / Funded / Delivered
  / Paid out).
- **In-app "confirm delivered"** control for the athlete; hosted confirm page for
  the brand (§7).
- **Connect onboarding banner** blocking the first payout until onboarding
  completes.
- `MoneyHero` graduates from "sum of detected offer amounts" to real
  **earned / in-escrow / paid-out** figures.

**Dependency, not scope.** The Opportunities P0 bugs (blank empty-state,
FanMessageCard crash, draft-endpoint hang, Gmail-token silent death) are owned by
[`opportunities-launch-fixes.md`](./opportunities-launch-fixes.md). This plan
**assumes that surface is stabilized** and does not re-adopt those fixes.

---

## 12. Explicitly deferred

- ❌ App subscriptions / tiers / a `plan` paywall — **out of scope**, not built.
- ❌ Fan subscriptions (Patreon-style recurring).
- ❌ À-la-carte one-time purchases.
- ✅ **In scope:** Connect onboarding, seriousness deposits, escrowed deal
  payments + 10% commission, athlete payout — the whole commission engine.

---

## 13. Build phases

1. **Foundation** — `server/lib/stripe.ts` (restricted key), data model
   (`connect_accounts`, `payments`, `payment_events`), Stripe webhook endpoint +
   signature verification.
2. **Connect onboarding** — v2 recipient accounts, hosted/embedded onboarding UI,
   capability gating, `account.updated` handling.
3. **Deal payment (escrow)** — payment-request Checkout (card + bank),
   capture-and-hold, link injection into threads, funded-pending handling for
   bank rails.
4. **Dual confirmation + release** — in-app athlete confirm, hosted brand confirm
   page, stalemate window, transfer-on-confirmation, payout.
5. **Seriousness deposit** — auth hold, day-6 re-auth job, release on
   accept/decline, ranking boost + badge in `dealDetector`.
6. **Hardening** — refund / dispute paths, idempotency, reconciliation,
   negative-balance / dispute-liability handling (§14.5).

---

## 14. Open decisions

1. **Confirmation stalemate** rule (§7) — recommend auto-release to the athlete
   after a window, with a brand dispute flag.
2. **Re-auth automation** — cron at ~day 6 (reuse the existing
   `INTERNAL_CRON_SECRET` / `x-cron-secret` infra) vs. event-driven.
3. **Payout timing** — Stripe-scheduled bank payout (default) vs. instant-to-debit
   (~1% premium) as an athlete option.
4. **Accounts v2 vs. classic** — confirm v2 recipient accounts are enabled + SDK
   supports them; classic connected accounts are the fallback (SCT works on
   either), so this shouldn't block Phase 2.
5. **Dispute liability (SCT).** Because Nomila is the merchant of record holding
   funds, a brand card-dispute **after** the athlete has been transferred lands on
   the **platform**. Decide the mitigation: hold a rolling reserve, delay the
   transfer window past the dispute risk, or simply absorb rare disputes at
   launch. Must be settled in Phase 6.
6. **Stranded `d9ff780` branch** — cherry-pick donors only (§3) and formally close
   `feat/stripe-payments`, so it isn't mistaken for the base later.
