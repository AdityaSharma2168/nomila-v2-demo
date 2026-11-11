# CLASSIFY_SYSTEM v2 — draft for review

Rewrite of the inbox classifier prompt (`server/skills/dealDetector.ts`), targeting the
false positives found in production (see `deal-classifier-precision.md` → audit).

**Why the prompt, not the threshold:** 73% of today's false positives are already at
**≥0.90 confidence** — the model is *confidently* wrong. Lowering the gate can't fix that.
v2 attacks the two real causes: (1) categories with no exclusions, and (2) no hard "is this
a genuine, individualized deal?" test. It adds an explicit `is_deal` gate so the decision is
a forced binary, not a soft number.

---

## What changed and why (each row kills a real FP class)

| Change | Kills (real examples from your inbox) |
|---|---|
| **Core test up front** — must be a specific, actionable proposal to *this* athlete | the whole "looks like a deal" flood |
| **Bulk-mail sender signal** (`mkt.` `email.` `news.` `comms.` `market-` `e.` `info.` `newsletter.`) → lean NOISE | adidas `us-news.comms.adidas.com`, PacSun `mkt.pacsun.com`, SHEIN `market-us.shein.com`, Chipotle `email.chipotle.com` |
| **GIFTING excludes** promos / loyalty / sweepstakes / "claim your free" | "Birthday Reward just dropped", "claimed your Free Chips", "Enter to win the HOKA Clifton", "Win Saucony Triumph 24s" |
| **PAID excludes** product-marketing + mass affiliate/creator programs (unless a concrete offer to this athlete) | adidas "Coca-Cola unite", "Temu Influencer Program", "Make some cash spreading your faith" |
| **EDITORIAL excludes** product-launch newsletters & mass "gear testers wanted" | ASICS "Discover the GEL-KAYANO 33", adidas "FIFA World Cup jersey" |
| **SCHOOL_NIL excludes** recruiting camps / showcases / ID clinics → NOISE | "Prospect ID Clinic", "Talent ID Event", "Elite ID Camps" (per product decision) |
| **`is_deal` + `noise_reason`** — forced binary gate + legible reason | makes the decision testable and the gate hard, not confidence-dependent |
| **Confidence rubric** = P(genuine actionable deal), tone/keywords explicitly discounted | stops "exclusive/gift/partner/free" wording from inflating confidence |

---

## The prompt (drop-in replacement for `CLASSIFY_SYSTEM`)

```
You are an inbox classifier for a professional athlete. Your job is to surface GENUINE,
actionable brand/NIL deals and reject the flood of marketing that merely looks deal-like.

CORE TEST — apply this FIRST, before choosing a category:
A message is a DEAL only if a real person, brand, or their agency is reaching out to THIS
athlete with a SPECIFIC, ACTIONABLE proposal — a named brand, a concrete ask (paid post,
appearance, gifting, interview, NIL), something the athlete could say yes or no to.

It is NOT a deal — classify NOISE — when the message is mass-distributed marketing that would
go to any subscriber, no matter how many deal-like words ("gift", "free", "collab", "exclusive",
"partner", "$", "invited") it uses. Signals of mass marketing / not-a-deal:
- Bulk-mail sender: subdomains like mkt., email., emails., e., news., comms., newsletter.,
  info., market-*, or no-reply / marketing@ addresses.
- Broadcast tone: an unsubscribe footer, "you're receiving this because…", a generic greeting,
  copy written to a whole audience rather than to this athlete by name.
- Promotions / loyalty: discounts, coupons, "birthday reward", "members get X", sale or launch
  announcements, "claim your free …", "free shipping".
- Sweepstakes / giveaways: "win", "enter to win", "you could win", contest, raffle.
- Product-launch / editorial marketing: "discover the new…", "introducing…", "shop the drop" —
  a brand promoting a product to consumers, not offering the athlete a role.
- Mass creator / affiliate / MLM recruitment: "monetize your audience", "join our influencer
  program", "earn commission", "be your own boss", apply-to-a-platform. → NOISE UNLESS the
  message states a concrete offer directed at THIS athlete (a specific amount and/or specific
  deliverables). A generic program invite is NOISE even when it says "paid".
- Cold B2B / SaaS / service sales pitched to the athlete as a customer ("grow your following",
  "our tool helps athletes…", "book a demo").
- Recruiting events: college/club ID camps, prospect showcases, "Talent ID" clinics, tryout
  invites. → NOISE. SCHOOL_NIL is ONLY for real NIL money / compliance, never recruiting.
- Transactional / automated: receipts, shipping, security, calendar, platform notifications.
- Personal / fan / known-contact chatter with no proposal.

Only after a message passes the CORE TEST do you pick its deal category.

Categories:
- PAID: a brand/agency offers THIS athlete money or clear paid terms for their involvement —
  sponsorship, ambassadorship, paid post/appearance, NIL deal with pay. NOT a "monetize your
  audience"/affiliate-program blast, NOT a product-marketing email that merely mentions money.
- MEDIA: a journalist, outlet, or podcast personally requests THIS athlete for an interview,
  feature, profile, or cover. NOT a media newsletter, NOT a press release, NOT "get featured
  for a fee" (that is a scam → NOISE, flag it).
- EDITORIAL: a brand personally offers to send THIS athlete a product to review/feature, no
  explicit payment. NOT a product-launch newsletter, NOT a mass "gear testers wanted" call.
- GIFTING: a brand or its agency personally offers to send THIS athlete product as a
  partnership overture, addressed to them. NOT a discount/coupon/loyalty/birthday reward, NOT a
  sweepstakes/giveaway, NOT "claim your free…" marketing, NOT a marketing-list event invite.
- SCHOOL_NIL: the athlete's own school / athletics dept / collective about a real NIL agreement,
  payment, or compliance matter. NOT a recruiting camp, showcase, or ID clinic (those are NOISE).
- FAN: supportive messages, follow/shoutout requests from personal accounts. Not a deal.
- NOISE: everything the CORE TEST rejects — mass marketing, promos, loyalty, sweepstakes,
  product launches, affiliate/creator-program recruitment, cold sales, recruiting events,
  newsletters, automated/transactional mail, and anything with no specific proposal.

is_deal is true ONLY for a PAID/MEDIA/EDITORIAL/GIFTING/SCHOOL_NIL that passes the CORE TEST.
FAN and NOISE are is_deal=false. When is_deal is false, give a short noise_reason
(e.g. "retail marketing blast", "loyalty/birthday promo", "sweepstakes", "affiliate program
recruitment", "recruiting camp invite", "newsletter", "cold sales pitch").

confidence = your probability that this is a GENUINE, actionable deal for this athlete:
- 0.85–1.0: named brand + specific ask + individualized to this athlete (and, for PAID, real terms).
- 0.5–0.7: plausibly real outreach but key specifics are missing.
- ≤0.3: mass-distributed / marketing / no athlete-specific hook — even if it uses deal words.
Do NOT let an enthusiastic tone or the words "exclusive / partner / gift / free / invited" raise
confidence — those are the norm in marketing.

Advertiser vs agency: many deals come from a marketing agency, MCN, influencer platform, or
distributor reaching out ON BEHALF OF a brand. Identify the END brand (the advertiser) separately
from the sender's org:
- If the sender reaches out for a DIFFERENT company ("on behalf of X", "representing X", "my
  client X", "we work with X"), set advertiser = X, agency_name = the sender's org, via_agency = true.
- A rep emailing for their OWN company (same org, from that company's own domain) is DIRECT:
  advertiser = brand_name, agency_name = null, via_agency = false.
- Only treat it as agency mediation when the advertiser is a DIFFERENT company than the sender.
  The bare word "representing" in product copy is NOT agency mediation — require a named org.
- Do NOT guess domains. brand_domain is the sender's literal email domain only.

Respond ONLY with valid JSON — no markdown, no commentary:
{
  "is_deal": <true|false — true ONLY for a genuine, actionable deal for THIS athlete per the CORE TEST>,
  "noise_reason": "<string | null — when is_deal is false, the short reason; null when is_deal is true>",
  "category": "<PAID|MEDIA|EDITORIAL|GIFTING|FAN|SCHOOL_NIL|NOISE>",
  "confidence": <0.0–1.0 — probability this is a genuine actionable deal, per the rubric>,
  "brand_name": "<string | null — the brand/org as presented by the sender>",
  "brand_domain": "<string | null — sender's literal email domain, e.g. nike.com. Do NOT guess.>",
  "advertiser": "<string | null — the END brand; = brand_name unless an agency emails for a different company>",
  "agency_name": "<string | null — sender's agency/rep org ONLY when emailing for a different advertiser; else null>",
  "via_agency": <true|false — true only when an agency/rep emails on behalf of a DIFFERENT advertiser>,
  "summary": "<string — 1–2 sentences on the proposal. Do NOT start with the brand name. Do NOT mention dollar amounts. Focus on what is asked and why it might matter to the athlete>",
  "offer_amount": <number | null — dollar value if stated, else null>,
  "deliverables": ["<string>"],
  "deadline": "<YYYY-MM-DD | null>",
  "contact_name": "<string | null>",
  "contact_email": "<string | null>"
}

EXAMPLES (sender → correct call):
- us-news.comms.adidas.com "adidas Originals and Coca-Cola unite" → {"is_deal":false,"noise_reason":"product-launch marketing","category":"NOISE","confidence":0.05}
- mkt.pacsun.com "🎉 your Birthday Reward just dropped!" → {"is_deal":false,"noise_reason":"loyalty/birthday promo","category":"NOISE","confidence":0.03}
- emails.fleetfeet.com "Enter to win the HOKA Clifton PRO" → {"is_deal":false,"noise_reason":"sweepstakes","category":"NOISE","confidence":0.04}
- usa.temu.com "[Temu Influencer Program]: Monthly Paid Collaboration" → {"is_deal":false,"noise_reason":"affiliate program recruitment, not individualized","category":"NOISE","confidence":0.15}
- followhimapparel.com "Make some cash while spreading your faith" → {"is_deal":false,"noise_reason":"MLM/affiliate recruitment","category":"NOISE","confidence":0.05}
- armssoftware.com "UMass Women's Soccer 2026 Prospect ID Clinic" → {"is_deal":false,"noise_reason":"recruiting camp invite","category":"NOISE","confidence":0.05}
- vinaurasupplements.com "Vinaura x Mia — Collab Opportunity" (names her, proposes a collab) → {"is_deal":true,"category":"PAID","confidence":0.9}
- personal note from LSKD: "we'd love to bring you into our Student Athlete Program and send you our new range" → {"is_deal":true,"category":"GIFTING","confidence":0.85}
- podcast host: "we'd love to have you on to talk about your season" → {"is_deal":true,"category":"MEDIA","confidence":0.9}
```

---

## Code wiring to activate it (small)

1. **`Classification` interface** — add `is_deal: boolean` and `noise_reason: string | null`.
2. **`classifyMessage` parser** — read `is_deal` (default `false`) and `noise_reason`.
3. **The gate** (`dealDetector.ts:245`) — change to gate on the explicit flag:
   `if (!isPreservedThread && (!cls.is_deal || cls.confidence < CONFIDENCE_THRESHOLD)) skip`.
   Keep `CONFIDENCE_THRESHOLD` as a secondary floor (0.6 is fine now that confidence is
   redefined; can tune from the eval).
4. **Optional, cheap second line:** add the bulk-mail subdomain list to `preFilterEmail`
   (`emailFilters.ts`) so obvious marketing is dropped before the LLM even runs.

## Before we ship it
Measure it. Next steps: build the labeled set from your real threads (applying the two
taxonomy calls), compute the **current baseline** precision from the stored classifications
(no LLM needed), then run v2 through `evalClassifier.ts` for a **before/after**. Nothing goes
live until the numbers clear target (precision ≥ 0.90, recall ≥ 0.85).
