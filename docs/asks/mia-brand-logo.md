# For Mia — brand logo placement in ads

**From:** Adi, via the wave-C session · **Date:** 2026-09-18 · **Status:** the data is measured, and it
decides most of this. Question 1 is the live one; question 2 no longer blocks.

A brand-attached ad now carries the brand's look, tone, audience and recent campaigns (wave C card 3).
It carries **no brand mark**. Adding one is small on our side — and we are not going to, because we
measured the data first and it is not there.

**The measurement, 2026-09-18.** 178 brands, 139 with a `logo_url` — 78.1%, which looks fine and is
misleading:

- **106 of those 139 are Google favicons** (`google.com/s2/favicons?domain=…`), 16–64px. Not renderable.
  31 are a logo CDN, 2 are Clearbit. **None is hosted by us.**
- Of the **14 brands the product lets her name** — adidas, nike, puma, Under Armour, New Balance,
  Reebok, Jordan, Umbro, Kappa, Castore, Hummel, Mizuno, ASICS, Fila — **2 have a row at all**, and
  **1 has a usable logo** (adidas). ASICS' is a favicon. The other twelve are simply not in the table.
- `enrichment` holds no logo, logo_url, brand_assets or wordmark on any brand — **zero**. There is no
  second source to fall back to.

So the card shrank to a single honest sentence on the preview, and that is what we are building.

---

## The two questions

### 1. Where do brand logos come from? ← **the live question**

Today `inbox_brands.logo_url` is a **third-party source URL** — Clearbit via brandResolver — not a
binary we host. `server/lib/brandImage.ts` already flags the problem in its own comment:

> we store SOURCE URLs, not the binary — cheap and correct for a card. GCS-rehosting the binary is the
> durable upgrade (a third-party URL can rot, redirect, or hotlink-block).

Correct for a brand card. For a **render** it means a paid generation depends on a third party being up
and not hotlink-blocking us, and on the logo at that URL still being the current one.

**This is no longer "rehost or upload".** Rehosting cannot fix an absent row, and twelve of the fourteen
brands she can name have no row. Three quarters of what we do hold are favicons scraped as a stand-in
for a logo, which is correct for a 24px brand card and useless for anything rendered.

**So: where would a usable brand logo come from at all?** An upload at brand-connect, a licensed asset
source, or a deliberate decision that we do not carry brand marks. We have not touched any of it —
rehosting and the brand catalog are shared code and outside our lane.

### 2. May we render a brand's mark at all, and where? ← **no longer blocking, still worth your answer**

This was the question that decided whether the card exists. The data decided it first: for thirteen of
the fourteen brands there is nothing to render either way. We are asking anyway, because the answer
sets the ceiling for whatever question 1 turns up — there is no point sourcing logos we may not use.

The precedent is yours. `HEADLINE_TAGLINES` exists because of your call — _"no trademarked taglines
until she clears them"_ — so a suggested headline may never carry a brand's slogan, and the guard holds
(the model offered Puma's "FOREVER FASTER" in five of five recordings; it is refused and dropped every
time). **Placing a brand's actual logo is the larger version of the same question**: it is about cleared
rights, not about whether we can draw it.

Three sub-questions if the answer is yes:

- **Only for a brand she has a relationship with**, or any brand she can name? The ad path today accepts
  a named brand with no row at all.
- **Corner lockup only?** That is what we would build. On-garment is already handled by the kit swap,
  which changes the item to the brand and lets the model render the mark; a second literal logo aimed at
  a jersey would fight it and risks two marks on one garment.
- **Does a rendered mark need a different approval or disclosure** before she can post it?

---

## What we would build if you say yes — and what we would not

**Would (all small):** the logo into the reference slot that renders literally; corner lockup only; a
pre-spend line when no logo is on file, mirroring the existing _"We don't have adidas' brand guidelines
on file, so none are applied."_; and her own Product/Object photos always keeping their slot — the logo
takes one only if a slot is free, and the disclosure says so when it is bumped.

**Would not, and it is deliberate:** never draw a mark from the brand's NAME. We measured that the model
invents a plausible but _different_ object when it has no reference, and an invented brand mark is a
publicity-rights defect rather than a cosmetic one. No logo on file means no mark and a sentence saying
so.

**Deferred, not dropped:** a QA check that the rendered mark matches the supplied logo. Our marks check
is a paired before/after comparison and cannot answer "is this the logo we supplied"; that needs a new
comparison against the reference. Until there is a live incident, Adi's eye is the check.

---

## Where this lands

The card is **already** one honest sentence on the preview saying the ad carries no brand mark — not
because you said no, but because the assets do not exist. Nothing else is built and nothing else is
scheduled.

If question 1 produces a real source AND question 2 is yes, the small parts above are ready and are
about a day. If either is no, the sentence is the feature, and that is a fine outcome.
