# Her picks — the athlete's product shelf

Status: design for PR 1–3 (7 Oct 2026). Owner decisions are binding (listed in §9). The public page that shows the
shelf to fans is designed in a separate session; this design gives it one clean read (§5.4) and builds nothing public
except the click redirect.

---

## 1. In plain words: what she sees and does

**What it is.** "My Picks" is a short list of products she actually uses, each with **her own** link: her Amazon
Associates tag, her LTK or ShopMy link, a brand's affiliate link or code, or any shop link. When a fan buys through
her link, the store or network pays **her** directly. Nomila holds no affiliate account, takes 0%, moves no money and
files nothing.

**Where it lives.** Me › **My Picks** (a door on the Me screen, behind the `SHOP_V1` flag).

**Before the first pick (once).** Two questions, answered by her, never guessed:
1. "I'm 18 or older." Shop is for adults only. If Nomila already holds a birth year that makes her under 18, or her
   level is high school or youth, the shelf stays closed and says why.
2. "Are you an international student on a visa (like F-1)?" If she says yes, she sees a plain warning ("Earning
   from US promotion can affect your visa status. Check with your school's international student office before you
   publish") and must tap **I understand** before anything can go live. We never guess nationality.

**Adding a pick.** She pastes her link (or taps **Paste** to take it from the clipboard). Nomila reads the page's
public preview (title, picture, price) and shows what it detected: "Amazon · your tag mia-20", "Shopify store",
"LTK". If the page can't be read, she types the title herself. A new pick is always a **draft**.

**Making it hers.** She opens the pick and can:
- edit the title;
- write a line in **her own words** ("In your words"). If Mila suggested a line, it shows as a suggestion with
  **Use this**. Nothing Mila writes is ever shown to fans unless she put it in her own field and saved it;
- add a discount code;
- pick the category (Nomila suggests one);
- see the **preview** exactly as fans will see it, with the **PAID LINK** label already on it (she can't turn it off);
- **Publish**, **Hide** or **Delete**; move it up or down the list.

**Warnings before she publishes** (she confirms, Nomila never blocks silently):
- **Your signed deals.** If she has a signed deal with a brand and this product looks like a competitor ("Your deal
  with Brand X has an exclusivity clause: 'no competing footwear'"), she sees it and must confirm before publishing.
- **Your school's apparel sponsor.** If she told us her school's apparel/footwear sponsor and this is competing
  apparel or footwear: "Promoting it is usually allowed, but you can't wear it in competition or training. Check
  your school's NIL policy."
- **Supplements are off by default.** A pick in the supplements category can't go live until she turns supplements
  on, after a warning about banned substances ("You're responsible for anything you endorse under NCAA drug-testing
  rules. Prefer products certified for sport.").

**NIL Go reminder (a reminder, not a filing).** On My Picks, a card adds up her **signed brand deals** and says which
brand totals reach **$600** (deals with the same brand counted together) and should be reported to NIL Go **within
5 business days of signing**. It says plainly: "Your own affiliate earnings from these links are not counted here.
Whether they must be reported is an open question we are checking with counsel. Ask your compliance office." Shown
to college athletes only.

**Clicks.** Each pick shows "12 clicks this week". That is all: a daily count per pick. No fan IP, no referrer,
nothing about who clicked.

**Mila.** She can say "add these shoes to my picks" with a link. Mila reads the page and shows a card (picture,
title, what it detected, any warning, an optional suggested line) with **Add as a draft**. Nothing is added until she
taps; nothing is published until she publishes it on My Picks. Mila can also tell her what's on her shelf and how
it's doing.

---

## 2. What it is not (model A only)

- No Nomila Amazon tag anywhere, no sub-IDs, no Nomila affiliate account, no reconciliation, no commissions table,
  no payouts. Her link is stored and redirected **exactly as she gave it**.
- No product search ("select, don't paste") at MVP: Amazon's catalog API needs an account with 10 qualifying sales
  in 30 days, which Nomila does not have and must not borrow from an athlete. She shares or pastes her own link.
- No scraping beyond the page's public preview tags (Open Graph) or a Shopify store's public product JSON.
- **Model C (brand-funded campaigns)** — Shopify Collabs invitations, brand affiliate apps (UpPromote, Refersion,
  GoAffPro and similar), Amazon Creator Connections — are brand deals: they arrive as opportunities on her board and
  count toward NIL Go. That is a later PR, not this one. A pasted Collabs/brand link still works on her shelf today
  (it is just her link).
- **A catalog-only Nomila Shopify app** (`read_products`, brand-approved, no money) is in scope as PR 4 (§12). A
  Shopify app that reads orders, attributes sales or moves money through Nomila is a later phase with its own design,
  counsel and the payments work.

---

## 3. Data model (migration 0096, hand-written, idempotent)

Names are `shop_*`: "product" already means the Studio product photo, the Studio edit op and product-as-compensation.

**`shop_items`** — one row per pick.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| athlete_id | uuid not null → athletes | tenancy key |
| code | text not null unique | opaque redirect code (12 chars base62), never an id |
| url | text not null | **her link exactly as given** (http/https only, ≤ 2048) |
| url_host | text not null | lowercased host, for display |
| source | text not null | `amazon` · `shopify` · `ltk` · `shopmy` · `link` — display only, **no CHECK** (grows) |
| network_tag | text | her Amazon tag when the link carries one (display only) |
| title | text not null | from the page, or hers |
| image_url | text | https only |
| price_cents / currency | int / text | a snapshot from the page; may be null |
| merchant | text | the store name the page gives |
| category | text | **no CHECK** (grows); the route validates |
| blurb | text | **her words only** — the only line fans see |
| blurb_suggestion | text | Mila's suggestion; never public |
| discount_code | text | her code, shown with the pick |
| status | text not null default 'draft' | CHECK `draft` · `live` · `hidden` (a stable lifecycle) |
| position | int not null default 0 | her order |
| warnings_ack_at | timestamptz | when she confirmed the warnings shown at publish |
| published_at | timestamptz | first time it went live |
| metadata_fetched_at, created_at, updated_at | timestamptz | |

Unique `(athlete_id, url)`: pasting the same link twice returns the existing pick. Index `(athlete_id, position)`.

**`shop_click_days`** — `(item_id → shop_items ON DELETE CASCADE, day date, clicks int)`, primary key
`(item_id, day)`. One upsert per click. Nothing else is stored.

**`shop_settings`** — one row per athlete (`athlete_id` pk → athletes): `adult_confirmed_at`,
`international_student` (bool, null = not answered), `international_ack_at`, `supplements_opt_in_at`,
`school_apparel_sponsor` (text she typed, optional), `created_at`, `updated_at`.

**Manifest** (same PR): `shop_click_days` via `item_id → shop_items`, then `shop_items` and `shop_settings` by
athlete, category `profile` (her public profile content), exported as whole rows. Deleted with her account.

---

## 4. Reading her link (server/services/shop/linkMeta.ts)

1. Accept `http:` / `https:` only; ≤ 2048 chars; no credentials in the URL.
2. Fetch with the existing `safeFetch` (https only — an `http:` link is fetched as https; refuses private,
   link-local, metadata and loopback addresses at every redirect hop, pins DNS). 6-second budget per request, body
   read capped (HTML 512 KB, JSON 1 MB), at most 5 redirects.
3. **robots.txt is respected** for every path fetched (RFC 9309 rules: 4xx = allowed; 5xx or unreachable = not
   allowed; longest match wins; `*` and `$`). Cached per host for an hour.
4. **Shopify first** when the path is `/products/<handle>`: GET `https://<host>/products/<handle>.json` (public, no
   auth). A valid product payload is the fingerprint → `source = shopify`; title, vendor, first image, first variant
   price, currency from `presentment_prices` when present.
5. Otherwise **Open Graph**: `og:title` (else `<title>`), `og:image`, `og:site_name`, `product:price:amount` /
   `og:price:amount` and currency.
6. **Network detection** (display only): Amazon hosts (incl. short links, read after redirects) → the `tag`
   parameter; LTK hosts; ShopMy hosts; Shopify (step 4); anything else `link`. An Amazon link without a tag gets an
   info note ("you won't earn on this link").
7. Nothing fetched is trusted as instruction: titles are one-lined, clipped, and reach Mila inside
   `<external_content>`.

Tests mock the fetch (no test reaches the network).

---

## 5. API

All under `/api/v1/me`, `requireAuth`, every query filtered by `req.athleteId`, mounted only when `SHOP_V1=true`.

| route | does |
|---|---|
| `GET /shop` | settings + eligibility, her picks (each with clicks last 7 / 30 days), the NIL Go reminder |
| `PUT /shop/settings` | `adult_confirmed`, `international_student`, `international_ack`, `supplements_opt_in`, `school_apparel_sponsor` |
| `POST /shop/preview` | `{url}` → what Nomila read + the warnings. Writes nothing. Per-athlete limiter. |
| `POST /shop/items` | `{url, suggested_blurb?}` → a **draft** (re-reads the page server-side). Same link again → the existing pick. |
| `PATCH /shop/items/:id` | title, blurb, category, discount_code, status. `status: live` runs the gates (§6); a warning answers 409 `needs_confirmation` until she resends with `confirm_warnings: true` |
| `POST /shop/items/order` | `{ids}` → positions (every id must be hers) |
| `DELETE /shop/items/:id` | removes the pick and its click days |
| `GET /shop/public-preview` | exactly what the public read returns, for her preview |

### 5.1 The click redirect

`GET /go/:code` at the **root** (like `/c/:shareId`), per-IP in-memory limiter, `Cache-Control: no-store`,
`X-Robots-Tag: noindex`. A live pick of an eligible athlete → `302` to her link and one `+1` on today's row. Anything
else → the same plain 404. The response carries nothing else. No IP, user agent or referrer is stored.

### 5.4 The read for the public page

`publicShelf(athleteId)` in `server/services/shop/publicShelf.ts` returns, only when the flag is on and she is
eligible, her live picks in her order: `{title, imageUrl, merchant, price, blurb (hers), discountCode, href:
<base>/go/<code>, disclosure: "Paid link"}` plus `amazonStatement` ("As an Amazon Associate I earn from qualifying
purchases.") when any live pick is an Amazon link. The disclosure is part of the data **and** of the card component
(`client/components/shop/PickCard.tsx`, which has no prop to hide it).

---

## 6. Guardrails (server-enforced at publish)

1. **Eligible**: adult confirmed; international question answered, and acknowledged if yes; not a known minor
   (`athlete_facts.birth_year` current and `year − birth_year ≤ 17`, or segment `high_school` / `youth`).
2. **Category set**; `supplements` needs `supplements_opt_in_at`.
3. **Exclusivity**: her **signed** deals. `deals.signed_at` (#824, branch work "brand-page-deals") is not on main yet,
   so the seam `signedDeals()` reads `status = 'accepted'` (plus `completed` whose term has not ended) and is the one
   place to switch to `signed_at IS NOT NULL` when #824 lands. Each deal brings its brand (name, domain, category)
   and its contract's exclusivity (`raw_data.contract.exclusivity`, her confirmation). A small model reads the item
   against those brands and her school sponsor and answers per brand `competes` / `maybe` / `no` (model, not a
   keyword table: the model-vs-deterministic rule). Same domain as the brand = her sponsor's own product, no warning.
   Model down → warn for every signed deal whose contract says exclusivity exists (never silent).
4. **School apparel sponsor**: from her own answer in settings (no list of schools or brands in code); the same model
   call flags competing apparel/footwear.
5. Warnings 3–4 need `confirm_warnings: true`; Nomila records `warnings_ack_at`. Never a silent block, never a silent
   pass.
6. **Her words only**: `blurb` is written only by her PATCH. Mila's tool writes nothing; a suggestion lands in
   `blurb_suggestion`, which no public read returns.

---

## 7. Mila tools (PR 2, flag-gated group `shopTools()`)

- **`get_shop`** (read): eligibility, her picks (title in `<external_content>`, host, status, clicks 7/30 d), counts.
- **`propose_shop_item`** `{url, suggested_blurb?}`: reads the page and runs the checks, **writes nothing**, returns a
  confirm card (`shop_item` widget): picture, title, host, detected network, warnings, the suggested line labelled
  "Suggested by Mila". Its button calls `POST /shop/items` (a draft) — her tap. The description tells the model:
  never claim she uses or loves a product unless she said so; a suggestion is in her voice, from her words.
- No tool publishes, hides, deletes or edits her words.

---

## 8. Flags

- Server `SHOP_V1` (routes, redirect, Mila tools, capability line). **Off in prod yaml** (explicit `"false"`). Dev
  yaml: off by default — turning it on for the owner preview is a follow-up.
- Client `EXPO_PUBLIC_SHOP_V1` (the Me door, the screen, the chat card). Off by default; eas.json preview unchanged.

---

## 9. Owner decisions (binding) and where each lands

| decision | where |
|---|---|
| Model A only, 0%, no money | §2; no money tables |
| Adults only; F-1 warning, self-declared | §1, §6.1, `shop_settings` |
| Supplements off by default, opt-in after warning | §6.2 |
| "Paid link" on every item, can't be skipped | §5.4, `PickCard` |
| Her words only | §6.6, §7 |
| Exclusivity vs signed deals; school sponsor | §6.3–6.4 (seam for #824) |
| NIL Go reminder, not filing; affiliate income not counted | §1, `nilGo.ts` |
| Light analytics: daily clicks, no IP/referrer | §3, §5.1 |
| Paste/share, OG only, robots, SSRF-safe, bounded | §4 |

---

## 10. PR plan

1. **PR 1 — backend**: this doc; migration 0096 + schema + db-migrate line + migration test; manifest entries;
   `server/services/shop/*` (linkMeta, checks, eligibility, nilGo, items, publicShelf); routes; `/go/:code`; flags;
   tests (link reading with mocked fetch, routes against PGlite incl. tenancy, redirect).
2. **PR 2 — Mila**: `get_shop`, `propose_shop_item`, the `shop_item` widget (server + client card, with `PickCard`), capability line.
3. **PR 3 — athlete screens**: My Picks (eligibility, add by paste, edit, her words, category, reorder, hide, delete,
   warnings, disclosure preview, supplements and sponsor settings, NIL Go card), the Me door.
4. **PR 4 — Shopify catalog app** (§12): install, catalog sync, brand approvals, "From your brands". Stacked on PR 1.

**Share sheet.** Receiving a link from another app's share sheet needs a native share extension (the
`expo-share-intent` config plugin + a new EAS build); it can't ship as an OTA update. PR 3 ships paste + clipboard;
the share extension is a follow-up that needs a native build.

## 11. Open questions

1. Whether her own affiliate income counts toward NIL Go reporting (counsel / CSC).
2. Dev flag on for the owner preview (and eas.json preview) — owner's call.
3. Share-sheet native build timing.
4. Switch `signedDeals()` to `signed_at` when #824 merges.
5. Rehosting product images (today the page's own image URL is stored, like `inbox_brands.logo_url`).
6. robots.txt is checked for the link's own host; a short link's landing host is reached through its redirect without
   a second robots check (safeFetch follows the hops). Acceptable for a preview; revisit if a store objects.

---

## 12. The Shopify catalog app (PR 4) — "From your brands"

**In plain words.** A brand she works with runs its store on Shopify. The brand installs Nomila's app on its store
(from a private install link). The app reads the brand's product list and nothing else. The brand opens the app from
its Shopify admin and approves which athletes may feature its products, and can give each one a code. On My Picks
she sees **From your brands**, picks a product from the catalog instead of pasting a link ("select, don't paste"),
and it lands as a draft like any other pick, linking to the brand's product page with **her** code. Nomila still
takes 0% and moves no money: the brand pays her however their deal says.

**Install (custom distribution first).** One app in the owner's Shopify Partner account, distributed by a **custom
install link** per store (no App Store review for the pilot). Non-embedded. OAuth authorization-code grant for an
**offline** token, scope **`read_products` only**: no orders, no customers, no protected-customer-data request.
- `GET /shopify/app` (the App URL Shopify opens) verifies Shopify's HMAC on the query and its timestamp (≤ 5 min).
  Not installed → redirect to `https://<shop>/admin/oauth/authorize` with `client_id`, `scope=read_products`,
  `redirect_uri` and a `state` that is an HMAC-signed 10-minute token bound to the shop. Installed → the brand page.
- `GET /shopify/callback` verifies the HMAC, the `state` and the shop domain (`<name>.myshopify.com`), exchanges the
  code, and **seals the token with the existing KMS envelope** (`tokenCrypto`, `kms1:`) — always, whatever
  `TOKEN_KMS` says. The install is refused if KMS is not configured; the column's CHECK refuses anything that is not
  `kms1:`. Then it registers the product and `app/uninstalled` webhooks, runs the first sync, and links the shop to
  `inbox_brands` by its primary domain (installing on its own domain is strong identity evidence; logos come from
  the existing brand imagery pipeline).

**Catalog sync.** Admin GraphQL at a pinned `SHOPIFY_API_VERSION`: products → `shop_catalog_products` (title, handle,
vendor, product URL on the primary domain, first image, first variant price and currency, available, status). Runs on
install, on `products/create|update|delete` webhooks, and in a daily reconcile
(`POST /api/internal/shopify-reconcile-cron`, cron-secret guarded, mounted in `index.ts` like `archive-stale-cron`,
plus a `provision-schedulers.sh` line).

**Webhooks** at `POST /api/shopify/webhooks` (raw body, mounted before `express.json`). `X-Shopify-Hmac-Sha256` is
verified as the base64 HMAC-SHA256 of the raw body under the API secret, in constant time. Topics:
- `products/*`: upsert or delete the catalog row;
- `app/uninstalled`: delete the token, mark the shop uninstalled, delete its catalog (her picks keep their plain links);
- the mandatory compliance three: `customers/data_request` and `customers/redact` (Nomila holds no customer data, so
  they are acknowledged with nothing to return or delete) and `shop/redact` (everything about the shop is deleted).

**Brand control: the simplest safe option.** The brand page is the app's own page, opened from the brand's Shopify
admin. Shopify signs that launch (HMAC + timestamp), so only a store admin can open it; Nomila then sets a 30-minute
HttpOnly, HMAC-signed session cookie for that one shop. The page lists **only athletes who asked** to feature the
brand (her display name), with Approve / Decline / Revoke and a per-athlete code. Why this one: no App Bridge or
session-token JavaScript, no email infrastructure, Shopify's own signature is the authentication, and no athlete
directory is ever shown to a brand. (Approve-by-email needs a reliable brand contact Nomila doesn't have; an
embedded admin needs App Bridge.)

**Athlete side.**
- `GET /me/shop/brands`: installed shops whose brand is one of hers (a deal or an opportunity), with her approval state.
- `POST /me/shop/brands/:shopId/request`: she asks the brand.
- Approved → `GET /me/shop/brands/:shopId/products?q=` (the catalog, **visible only to approved athletes**) and
  `POST /me/shop/items { catalog_product_id }` → a draft whose link is the product page with her code applied
  (`https://<domain>/discount/<code>?redirect=/products/<handle>`), or the plain product page when the brand gave no
  code (she can paste the referral link the brand gave her instead). Auto-created discount codes (`write_discounts`)
  are post-MVP.

**Data (migration 0100).** `shopify_shops` (shop domain, primary domain, name, `brand_id → inbox_brands`, sealed
token, scopes, status installed|uninstalled, dates) and `shop_catalog_products` (per shop; unique per Shopify product)
are brand data → `NOT_ATHLETE_DATA` (shared). `shop_brand_approvals` (shop, athlete, status
pending|approved|declined|revoked, code, dates; unique per shop + athlete) is hers → manifest. `shop_items` gains a
nullable `catalog_product_id` (SET NULL when the catalog row goes).

**Routes as built.** `GET /shopify/app`, `GET /shopify/callback`, `GET /shopify/brand` and `POST /shopify/brand/decide`
(the session cookie is scoped to `/shopify`, and the form carries a CSRF token derived from the session). The callback
refuses any grant other than exactly `read_products`. A code the brand sets applies to picks added after it; a pick
she already added keeps the link it was made with.

**Flag** `SHOP_SHOPIFY_APP` (server) + `EXPO_PUBLIC_SHOP_SHOPIFY_APP` (client), off by default; needs `SHOP_V1`.

**Model C stays separate.** Shopify Collabs invitations and brand affiliate apps (UpPromote, Refersion, GoAffPro)
are brand-funded campaigns: they arrive as opportunities on her board (a later PR). A Shopify app that moves money
or reads orders through Nomila is a later phase with its own design.

**Owner's Shopify setup checklist.**
1. Create a Shopify Partner account (partners.shopify.com) and, in it, an app created manually ("Nomila").
2. Distribution: **Custom distribution**; enter the brand's `*.myshopify.com` domain to get its install link.
3. App URL `https://<api host>/shopify/app`; allowed redirection URL `https://<api host>/shopify/callback`;
   embedded app **off**.
4. Access scopes: `read_products` only. Don't request protected customer data.
5. Compliance webhooks (customers/data_request, customers/redact, shop/redact) →
   `https://<api host>/api/shopify/webhooks`.
6. Secret Manager: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`. Env: `SHOPIFY_APP_URL` (the api host), optionally
   `SHOPIFY_API_VERSION`. Add the secret refs to `gcp/cloud-run-dev.yaml` and to `scripts/setup-dev-env.sh`.
   `KMS_TOKEN_KEY` must be set (it already is wherever `TOKEN_KMS` runs).
7. Turn on `SHOP_V1` and `SHOP_SHOPIFY_APP` on dev; create the Cloud Scheduler job for the daily reconcile.
8. Send the install link to the brand; the brand opens the app from its admin to approve her.
