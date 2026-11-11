# OAuth Verification Pack — Nomila (Gmail restricted scopes)

**Goal:** remove the "Google hasn't verified this app" warning and the **100-user cap** so Nomila can onboard Gmail users at scale.

**Why it's required:** Nomila requests `gmail.readonly` (a **Restricted** scope). Restricted scopes require full **OAuth app verification** *plus* an annual **CASA security assessment**. `gmail.send` is at least a Sensitive scope; either way, `gmail.readonly` already pulls the whole app into the restricted-scope process.

**Current state (2026-07):** consent screen is **In production**, **unverified**, **7 / 100** users. Tokens are durable (good), but you're capped at 100 users and every user sees the unverified-app warning until this is done.

---

## Part 1 — Scope justifications (Google scrutinizes these most)

For each scope Google asks: *what do you do with it, why is it necessary, and why won't a narrower scope work?* Use these near-verbatim.

### `https://www.googleapis.com/auth/gmail.readonly` — Restricted
**What we do with it:** Nomila reads incoming email in the athlete's inbox to automatically detect brand-partnership / sponsorship / NIL outreach, then classifies and scores each as a deal "Opportunity" surfaced in-app.
**Why it's necessary:** Detection and scoring require the **content** of the email — sender, subject, and body — to distinguish a genuine paid partnership from newsletters, receipts, and mass PR blasts, and to extract deal terms (brand, deliverables, offer amount).
**Why a narrower scope won't work:** `gmail.metadata` exposes only headers (no body), which is insufficient to classify or extract deal terms. We use **read-only** (not `modify`/`mail.google.com`) precisely because we never alter or delete the user's mail — the minimum scope that meets the need.

### `https://www.googleapis.com/auth/gmail.send` — Sensitive/Restricted
**What we do with it:** After the athlete reviews and **explicitly approves** a reply/negotiation draft in Nomila, we send it **from their own Gmail** so the reply threads naturally with the brand from the athlete's address.
**Why it's necessary:** Brands expect to negotiate with the athlete directly; sending from the athlete's own mailbox (in-thread) is core to the product. A relay/no-reply address would break threading and trust.
**Why a narrower scope won't work:** `gmail.compose` only creates drafts and cannot deliver; delivery from the user's account requires `gmail.send`. We do **not** request `modify`/full-mailbox scopes.

**Minimum-necessary statement (include this):** Nomila requests only `gmail.readonly` and `gmail.send` — the least-privileged scopes that support inbox deal detection and in-thread replies. We do not request full-mailbox, delete, or settings scopes.

---

## Part 2 — Submission checklist (OAuth consent screen → verification)

- [ ] **Verified domain ownership** for your primary domain (e.g. `nomila.co`) in Google Search Console, linked to this GCP project.
- [ ] **Homepage URL** — public, on the verified domain, clearly describing what Nomila does. ⚠️ Use the **production** domain (`nomila.co`), **not** the `nomila-dev.web.app` / `api-dev.nomila.co` hosts currently in `cloud-run-v2.yaml`.
- [ ] **Privacy policy URL** — on the same verified domain; must disclose how Google user data is accessed, used, stored, and shared, and include the **Limited Use** statement (Part 3).
- [ ] **App name, logo, support email** on the consent screen match the brand and are consistent with the homepage.
- [ ] **Authorized domains** on the consent screen include the homepage + privacy-policy domain.
- [ ] **Scope list** matches exactly what the app requests (`gmail.readonly`, `gmail.send`, `openid`/`email`/`profile`) with the justifications from Part 1.
- [ ] **Demo video** (Part 4).
- [ ] **CASA assessment** for the restricted scope (Part 5).

---

## Part 3 — Limited Use compliance (required language)

Your privacy policy **and** the verification form must affirm that Nomila's use of Google user data complies with the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including **Limited Use**. Concretely, affirm all of:

- Data is used **only** to provide/improve the user-facing features (deal detection, scoring, in-thread replies).
- **No** transfer/sale to third parties except as needed to provide the service, for security, or to comply with law.
- **No** use for advertising.
- **No** human reads the data unless: user consent, security, legal, or aggregated/anonymized for internal ops.
- If any AI/ML model is trained on Gmail content, disclose it — Google restricts using Gmail data for generalized/AI model training. *(Nomila classifies via a hosted LLM at inference time and does not train models on user mail — state that explicitly.)*

---

## Part 4 — Demo video script (often the blocker)

Record a screen capture (2–4 min) that shows, in one continuous flow:

1. Open Nomila → click **Connect Gmail**.
2. The Google consent screen — **the browser URL bar must clearly show your `client_id`** (`241621020090-…`) and the app name, with the `gmail.readonly` + `gmail.send` scopes visible.
3. Grant consent → return to the app.
4. **Show `gmail.readonly` in use:** a brand email in the inbox appears in Nomila as a scored "Opportunity."
5. **Show `gmail.send` in use:** approve a reply draft → it sends from the athlete's Gmail and threads with the brand.
6. Narrate that data is used only for these features, per Limited Use.

Upload unlisted to YouTube; paste the link in the verification form.

---

## Part 5 — CASA (restricted-scope security assessment)

- **What:** an annual **Cloud Application Security Assessment** by a Google-authorized third-party assessor, required for restricted scopes.
- **Tier:** most apps do **Tier 2** (self-guided scan + assessor verification). Higher-risk apps get Tier 3 (pen test).
- **Cost:** paid to the assessor — historically **~$500–$4,000+** depending on assessor/tier (varies; get quotes).
- **Timeline:** typically **4–8 weeks** end-to-end (scan → remediation → assessor sign-off → Google review). **Start early — this gates public launch.**
- **Assessors:** pick from Google's current authorized list (e.g. Bishop Fox, TAC Security, DEKRA, NCC Group, Leviathan). Confirm the live list in the verification console.

---

## Part 6 — Owner action items (in order)

1. **Stand up production homepage + privacy policy** on `nomila.co` (not the `-dev` hosts). — *Owner/Aaron*
2. **Verify the domain** in Search Console under this GCP project. — *Owner (miabhuta@gmail.com)*
3. **Fill the OAuth consent screen**: authorized domains, scope justifications (Part 1), support email. — *Owner*
4. **Record the demo video** (Part 4). — *Aaron*
5. **Submit for verification** → Google responds with either approval or a request to start **CASA**. — *Owner*
6. **Engage a CASA assessor** in parallel (don't wait for step 5). — *Owner*

**Until this is done:** you're fine up to 100 users with the warning. Do **not** revert the consent screen to "Testing" (that re-introduces the 7-day token death).
