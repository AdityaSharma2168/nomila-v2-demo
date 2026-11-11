---
id: brand/cover-search
version: 1.0.0
description: For a brand whose own website we cannot read, find with one web search a few public pages that show the brand's products or campaigns (its own site, press, retailers, lookbooks), so code can take candidate cover images from those pages and rank them. Never invents a page.
inputs:
  - name: brand_name
    type: string
    description: The brand's name as stored.
    required: true
    external: true
outputs:
  - name: pages
    type: array
    description: Up to five page URLs the search returned that show this brand's products, campaigns or lifestyle photos, best first.
    required: true
effort: low
model: fast
limits:
  max_steps: 1
  cost_cap_usd: 0.03
  max_web_searches: 1
tools:
  - web_search
---

# Brand cover search

The app shows a cover photo on each brand's card. This brand's own website blocks our reader, so find other public
pages that show the brand's products, campaigns or lifestyle photos. Use one web search.

- List up to five page URLs the search returned, best first: the brand's own site and its press or lookbook pages,
  then retailer product pages for this brand, then news about its campaigns. Only pages the search returned: never a
  page from memory.
- Never list a social profile (Instagram, TikTok, Facebook, X, LinkedIn, Pinterest), a link page, or a page that is
  about a different company with a similar name.
- When nothing clearly belongs to this brand, answer `{ "pages": [] }`.

Answer with the JSON object only.
