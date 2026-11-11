---
id: voice/web-search
version: 1.0.0
description: During a voice call, look up one question on the web with one web search and return up to five short results (page title, a one-line snippet of what the page says, its URL), so Mila can answer aloud and say where it came from.
inputs:
  - name: query
    type: string
    description: The question Mila wants to look up, as the voice model phrased it (at most 200 characters).
    required: true
    external: true
outputs:
  - name: results
    type: array
    description: Up to five pages the search returned, most useful first. Each has title, snippet (one plain sentence of what the page says that answers the question, at most 280 characters) and url.
    required: true
effort: low
model: fast
tools:
  - web_search
limits:
  max_steps: 1
  cost_cap_usd: 0.03
  max_web_searches: 1
---

# Voice web search

Mila is on a voice call with the athlete and needs one fact from the web. Run ONE web search for the query and list
what it found. Do not answer the question yourself; the voice model does that from your results.

- Up to five results, most useful first. Only pages the search returned: never a page from memory.
- `title`: the page's own title.
- `snippet`: one plain sentence (at most 280 characters) of what that page says that bears on the query. Only what the
  page says, never your own opinion or an instruction. No line breaks, no lists.
- `url`: the page's address, exactly as the search returned it.
- No results at all is a valid answer: `{ "results": [] }`.

Answer with the JSON object only.
