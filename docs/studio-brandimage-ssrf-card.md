# Card — SSRF in `server/lib/brandImage.ts` (for PR 5 hardening)

> **PR 4 (C4), 22 Sep 2026 — FIXED for `fetchPage` and `fetchImageBytes`.** `server/lib/safeFetch.ts`: https
> only; refuses `metadata.google.internal` / `metadata` / `localhost` / `*.internal` by name and any host
> that is or resolves to loopback, RFC 1918, CGNAT, link-local (169.254/16, fe80::/10), ULA, 0/8,
> multicast or reserved; `redirect: "manual"` with every hop re-checked, 5 hops. Tests stub DNS and fetch
> (`safeFetch.test.ts`, 26); mutations "redirect allowed", "redirect: follow" and "metadata host
> allowed" each red by name. One behaviour change: an `http://` image a page names is now refused.
>
> **STILL OPEN (this card):** (1) the three other sites below — `mediaStore.ts:37` `rehostFromUrl`,
> `studio/adapters/vertex.ts:133`, `scripts/rate/validateRateCitations.ts:65` — each a caller of the
> same helper once audited for what it legitimately fetches (the rehost reads Instagram/TikTok CDN
> URLs, which are https and public, so it should pass unchanged); (2) **DNS rebinding** — the address
> is checked, then fetch resolves again; closing it means connecting to the checked address, which
> needs an undici `dispatcher` with a pinned `connect.lookup` (undici is not a direct dependency —
> a dependency ask).

**Status:** CARD, 22 Sep 2026. Found during brand-profiles (PR 3) recon, and not fixed there: `server/lib/` is shared code outside that lane.
**Verified:** by reading the code at `origin/main` 3e121d1. **Not exploited or tested live.** What follows is read from the code
plus the metadata server's documented header rule.

## The path

`server/skills/researchBrand.ts:157` → `fetchBrandImages(domain)` → `fetchPage` → `collectImageRefs` → `fetchImageBytes`:

1. **The domain is not ours.** `candidateDomains(brandName, domain)` builds `https://www.<d>` and `https://<d>` from a brand's
   domain. That domain can come from an **inbox-detected brand**: a sender's domain, which is attacker-chosen. `resolveBrand` (`server/lib/brandResolver.ts`) stores it "when we have a real sender domain". It can also be
   athlete-added, or a slug of the brand name plus `.com`.
2. **`fetchPage` follows redirects.** `server/lib/brandImage.ts:239` is a raw `fetch(pageUrl, { redirect: "follow" })`.
   It has no host check at any hop, so an https page can redirect anywhere, including plain http on an internal address.
3. **The attacker's HTML chooses the next URLs.** `collectImageRefs` (`:286`) takes every `<img src>` or `srcset` from that page,
   and `fetchImageBytes` (`:382`) GETs each one, again with `redirect: "follow"` and no host check.

Given that, a hostile page can point `<img src>` at:

- **The metadata server:**
  `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`,
  or the same path on `http://169.254.169.254/`.
- Any other internal or link-local address reachable from Cloud Run.

## What stops the worst case today, and why that is luck, not design

- **The metadata server requires the `Metadata-Flavor: Google` header.** `fetchImageBytes` sends only a `User-Agent`, so a direct
  token read should be refused.
- **`fetchImageBytes` keeps only `image/(jpe?g|png|webp)` responses of 3 kB to `MAX_IMAGE_BYTES`**, so a JSON token body would be
  dropped and never stored.

**Both are incidental.** One header added to that `fetch`, or a mime check loosened, turns this into service-account token theft.
And today's code is still a **blind SSRF**: the attacker picks internal URLs that Cloud Run then requests. That allows port and
host probing through timing and success signals, and a GET on any internal endpoint that acts on a GET.

**Same pattern, not audited here:** `server/lib/mediaStore.ts:37` `rehostFromUrl`, `server/studio/adapters/vertex.ts:133`,
and `server/scripts/rate/validateRateCitations.ts:65` also `fetch` URLs they did not choose, with no guard.

## The fix (one shared helper, then every caller)

`safeFetch(url, opts)` in `server/lib/`, used by all four sites:

- `https:` only. `http:` only behind an explicit allow flag, if ever.
- Resolve the host, and refuse loopback, private (RFC 1918 and ULA), link-local (`169.254.0.0/16`, `fe80::/10`), CGNAT, and
  `metadata.google.internal` by name.
- Connect to the address that was checked, which closes the DNS-rebinding window. Handle redirects manually (`redirect: "manual"`)
  and re-run every check at each hop, with a small hop cap.
- Keep the existing timeout, byte caps and mime checks.

**Tests:** a PGlite-free unit suite. Each refused class reds by name, a redirect to `169.254.169.254` is refused at the hop, and
a normal public https image still passes. Stub DNS, never the network.

## Flags from PR 3, for PR 5's flag list

| Flag / knob | Default | What it gates |
|---|---|---|
| `STUDIO_BRAND_PROFILES` | **off** (`=== "true"`) | `decomposeReference`. Off means no row is read, no model is called and nothing is written. The future profile routes are gated on it too. |
| `STUDIO_REFERENCE_MODEL` | `gemini-3.5-flash` | The engine's pinned model, recorded on every analysis row |
| `STUDIO_REFERENCE_THINKING_BUDGET` | `0` | Thinking for the one call |
| `STUDIO_REFERENCE_TIMEOUT_MS` | `30000` | The one call's ceiling |

All four are read at call time in `server/studio/config.ts`. No default was changed, and no deploy config was touched.
