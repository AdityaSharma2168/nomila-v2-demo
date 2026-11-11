# Card — a URL as a reference source (out of PR 3)

**Status:** CARD, 22 Sep 2026. Not built. It was decided out of PR 3 because no SSRF guard exists anywhere in `server/`
(see `docs/studio-brandimage-ssrf-card.md`).

**What it would be.** `decomposeReference` would take a third source, `{ kind: "url", url }`. It would fetch the URL to bytes, store them as HER
`media_assets` row (`origin: "upload"`), and then decompose the image exactly as today. The analysis row's
`source_asset_id` points at the stored asset, and a `source_url` column records provenance. So migration 0060's one-source CHECK
does not widen. That was the reason for its shape.

**Prerequisites, in order:**

1. **The SSRF guard lands first** (PR 5 hardening). It resolves the host, refuses private, loopback, link-local and metadata
   addresses, and re-checks at every redirect hop, or refuses redirects altogether. No reference URL is fetched before it exists.
2. **An image URL only.** It must be a direct `image/*` of bounded size. A page URL (an Instagram profile, a brand homepage) is not a
   reference: there is no scraping in v1 (the old card §2.3), and a page's pixels are its chrome.
3. **The fetched bytes are external content.** The engine already fences a reference as data, and refuses URLs, handles and hashtags
   in what comes back. Nothing new is needed there.
4. `source_url` column: an additive migration with Mia's approval. `source_kind` has no CHECK, so `url` needs none.

**Cost.** Unchanged per decomposition (about $0.002 measured), plus one storage write.
