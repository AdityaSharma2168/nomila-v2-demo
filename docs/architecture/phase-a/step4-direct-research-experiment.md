# Step 4 — Direct structured research: A/B experiment design

Status: **APPROVED with modifications (13 Sep 2026)**; probes done (§7a); implementation and the four-athlete direct run authorized. Execution rule: every call in this experiment runs in Research / Fact Mode — grounding/search ON — per cross-system principle P-1 (`../intelligence-architecture-principles.md`). The factual prose Gemini returns in the hybrid format exists only to preserve native citation lineage; it is research/evidence prose, never a precedent for downstream creative generation, which runs with grounding OFF by default.

The question: does Nomila need `search AI → extraction AI → Nomila`, or can production be `search/research AI → Nomila`
with a second model used only for verification or recovery? This document designs the experiment that answers it
without changing what Nomila researches (`research-spec/1`) or how M.I.A. is calculated (frozen Beta.1).

---

## 1. Can the existing four saved responses test the direct path?

**No.** The saved Gemini and OpenAI responses were produced under the frozen §5 instructions, which ask for prose
findings per item followed by a status line. Turning that prose into structured claims requires an extraction step,
which is path A by definition. Re-parsing the saved answers into the new contract would either be Kimi again or an
in-house parser, and neither is "the provider produced structured cited evidence". The saved responses also carry no
per-claim citation binding: Gemini's grounding supports attach to spans of prose, OpenAI's annotations attach to link
tokens, so a claim-level lineage cannot be reconstructed after the fact without inference.

So a valid B test needs **fresh direct-research calls**: the same four athletes, the same anchors, the same as-of
semantics (a new as-of date, recorded), both providers, six queries each. The A results already on disk (partitioned
re-extraction of the saved envelopes) remain the A arm. B is not "equivalent evidence"; it is a different run on a
later date, which the comparison must state. To keep the two arms as close as possible, B reuses every request element
of A byte-for-byte (anchor line, athlete line, as-of line, minor line, the numbered item text) and changes only the
output instruction: structured evidence instead of prose plus status lines.

---

## 2. What is preserved (unchanged)

`research-spec/1` (nine sections, 55 items, four outcomes, six queries Q1→S1/S2, Q2→S4, Q3→S5/S6, Q4→S7, Q5→S8,
Q6→S3/S9); the identity anchors and the execution cohort file; the evaluation-only gold and targets files; the holdout
guard; the provenance requirements (URL, domain, date, quote, lineage); `claim-canonicalization/1` and the strict fact
registry; `minor-evidence-policy/2` and its activation rule; unknown / conflicting / not_applicable semantics; follower
counts as evidence only; the Beta.1 methodology (still blocked on parameters); no provider-specific scoring; the four arm
states and the rule that only a valid, parsed extraction can carry a semantic abstention.

Kimi and path A stay in the repository as experimental infrastructure and as the candidate fallback/verifier.

---

## 3. Direct evidence contract — `direct-evidence/1` (provider-neutral)

The same semantics as cited-claims/3, emitted by the research provider itself. One response per query; it covers only
that query's sections and items.

```json
{
  "contract": "direct-evidence/1",
  "query": "Q1",
  "identity": {
    "anchor_match": "matched | uncertain | not_resolved",
    "confidence": 0.0,
    "namesakes": [ { "description": "who else this name refers to in the sources", "source_url": "..." } ]
  },
  "sections": {
    "S1": {
      "status": "found_cited | not_found | conflicting | not_applicable",
      "items": { "full_name": "found_cited | not_found | conflicting | not_applicable", "...": "..." },
      "reason": "not_applicable only",
      "conflicts": [ { "item": "hometown", "values": [ { "value": "...", "source_url": "..." } ] } ]
    }
  },
  "claims": [
    {
      "section": "S1", "item": "full_name",
      "kind": "profile_attribute | affiliation | achievement | press_mention | brand_mention | social_handle | nil_mention | identity_signal | career_event | reputation_event | social_metric_claim | representation | venture | crossover_appearance | narrative_claim",
      "factKey": "fact-bearing kinds only, registry key",
      "value": { "the registry value shape (same examples as cited-claims/3)" },
      "descriptive fields": "exactly the cited-claims/3 claim fields (timeframe, league, market, category, outlet, outletContext, topic, brand, type, startDate, endDate, renewal, campaign, publishedValue, platform, handle, verified, metric, metricValue, statedOn, statedBy, eventKind, event, date, stage, outcome, agency, agent, name, ventureKind, title, medium, text)",
      "statement": "one sentence stating the fact as the source states it",
      "sources": [ { "url": "https://...", "title": "...", "published_at": "YYYY-MM-DD or null", "quote": "≤ 300 chars copied from the source as the provider saw it" } ],
      "confidence": 0.0
    }
  ]
}
```

Rules carried into the instruction text (§5): every claim needs at least one source URL that the provider actually
retrieved; prefer NOT FOUND over invention; no tiers, scores, rankings of importance, strength or safety judgements;
follower counts only as `social_metric_claim`; reputation events must carry a stage; a reported allegation is not a
finding; identity `not_resolved` with zero claims is a valid, expected response.

`confidence` is extraction/identity confidence only. It never enters scoring.

---

## 4. Citation integrity for the direct path

Structured JSON from a model is not trusted by itself. Each claim's lineage is established downstream, deterministically,
against the provider's **native** citation metadata, which is preserved raw in the artifact:

| Provider | Native citation metadata kept | Lineage check per claim |
|---|---|---|
| Gemini Grounded | `groundingMetadata.groundingChunks` (uri, title, domain), `groundingSupports` (segment spans of the answer text with chunk indices and confidence), `webSearchQueries`, the full answer text | `cited_native` when the claim's `sources[].url` resolves (after redirect normalization, see below) to a grounding chunk AND a grounding support covers the span of the answer JSON where that claim is serialized; `cited_asserted` when the URL is only in the claim text; `uncited` otherwise |
| OpenAI web search | `url_citation` annotations (url, title, start/end index over the output text), `web_search_call` actions, the full output text | `cited_native` when the URL is among the annotations AND an annotation span falls inside the claim's serialized span; `cited_asserted` / `uncited` as above |

Only `cited_native` claims can become registry candidates for a canonical fact. `cited_asserted` claims are kept as
evidence with a distinct lineage status, counted separately (that is the "hallucinated citation" measure), and never
resolve into a fact. Gemini grounding URIs are redirect URIs (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`);
the adapter records both the redirect URI and, where the `domain` field gives it, the source domain, and the match is
made on the redirect URI the model was given. If a provider's structured mode drops native citation metadata (a known
risk, §7), that arm is recorded as `lineage_unavailable` and the experiment reports it rather than trusting the JSON.

The same downstream stack then runs unchanged: sanitization, `claim-canonicalization/1`, strict registry, the resolver,
item coverage (reported vs derived), identity fidelity against the gold sheet, `minor-evidence-policy/2`, the ledger.

---

## 5. Exact request design

### 5.1 System instruction (all providers; §5.1 of the spec, plus the output rule; the only per-provider difference remains the tool name)

```
<research-spec/1 system instruction, verbatim>
Return your findings ONLY as a single JSON object following the direct-evidence/1 contract given in the request. Every
claim must carry at least one source you actually retrieved (URL; title and publication date where visible; a short
verbatim quote). If you cannot attach a retrieved source to a claim, omit the claim and mark the item NOT FOUND. Prefer
NOT FOUND over invention. If the identity anchor cannot be matched with confidence, set anchor_match to not_resolved,
return no claims, and mark every item NOT FOUND.
```

### 5.2 Request (one per query; byte-identical for every provider)

```
Athlete identity anchor: <anchor>
Athlete: <full name> — <sport>
As-of date: <YYYY-MM-DD>
<minor line, only for a minor — unchanged>

<the query's numbered item text, unchanged from research-spec/1 §5.2>

Output contract (direct-evidence/1):
<the JSON contract of §3, with this query's section ids and item ids filled in, and the cited-claims/3 value examples>
```

### 5.3 Per-provider compilation (transport only)

- **Gemini**: `systemInstruction` = §5.1 compiled with "Google Search"; `tools: [{ googleSearch: {} }]`; the contract
  is requested in the prompt text (structured output mode combined with the search tool is the risk in §7); temperature
  and thinking budget as the substrate adapter; `groundingMetadata` retained raw.
- **OpenAI**: `instructions` = §5.1; `tools: [{ type: "web_search", search_context_size: "medium" }]`;
  `text.format = { type: "json_schema", name: "direct_evidence_v1", schema, strict: false }` if the API accepts it with
  the tool, else the contract in the prompt text; `output[].content[].annotations` retained raw.
- Model tier unchanged: `gemini-3.5-flash` and `gpt-5.4-mini`. No Kimi call in path B.

---

## 6. Comparison design (four paths)

| Path | Search | Extraction | Status today |
|---|---|---|---|
| A-G | Gemini Grounded | Kimi cited-claims/3, partitioned | done (four athletes, reprocessed) |
| A-O | OpenAI web search | Kimi cited-claims/3, partitioned | done (four athletes, reprocessed; OpenAI chunk-text limitation noted) |
| B-G | Gemini Grounded | Gemini itself, direct-evidence/1 | proposed |
| B-O | OpenAI web search | OpenAI itself, direct-evidence/1 | proposed |

Measures, all from the existing benchmark modules plus two additions (`cited_asserted` share; per-query provider
latency including synthesis):

identity fidelity (anchor agreement, namesakes, internal conflicts, conflation vs the gold sheet); section and item
coverage (reported vs derived); claims recovered; citation coverage (claims with ≥ 1 source) and lineage validity
(`cited_native` share); registry accepted / canonicalized / refused; conflicts; appropriate abstention; unsupported and
asserted-only claims (the hallucination proxy); latency; tokens and cost; implementation complexity (adapters, prompts,
parsers, failure modes, calls per athlete).

The report adds one table per athlete with the four paths side by side and an aggregate over the four athletes,
provisional and labelled as such (different as-of dates for A and B).

---

## 7. Risks to state before running

1. **Structured mode versus search tool.** Gemini's JSON response mode has historically not been combinable with
   Google Search grounding on some model generations; OpenAI's `json_schema` format with `web_search` is documented
   as supported but unverified here. The design therefore requests the contract in prompt text for Gemini and treats
   OpenAI's schema mode as optional. Two probe calls (one per provider, a single short query, ≈ $0.10 total) would settle
   both before the run; they are counted in the estimate below and need the same approval.
2. **Lineage in JSON answers.** Gemini's grounding supports are computed over the answer text; when the answer is JSON,
   supports should still cover spans of it, but coverage may be coarser than over prose. The `cited_native` rule in §4
   is deliberately strict; if native coverage proves too coarse the report will show it as low lineage validity, not as
   a pass.
3. **Provider JSON quality.** Malformed or truncated JSON is `extraction_degenerate` for that partition, exactly as in
   path A, and eligible for one deterministic retry of the same request (counted).
4. **Different as-of.** B runs on a later date than A; the report labels every A/B comparison provisional and lists the
   dates.

---

## 7a. Probe findings (13 Sep 2026) and the resulting lineage rule

| Probe | Search | JSON | Native metadata | Lineage |
|---|---|---|---|---|
| Gemini JSON mode + Google Search | 5 queries | valid, 13 claims | 0 chunks, 0 supports | asserted_only |
| OpenAI JSON mode + web search | refused (400 "Web Search cannot be used with JSON mode") | — | — | — |
| Gemini contract-in-prompt + Google Search | 7 queries | valid, 14 claims | 0 chunks, 0 supports | asserted_only |
| OpenAI contract-in-prompt + web search | 1 search | valid, 14 claims | 0 annotations | asserted_only |
| OpenAI + `include: web_search_call.action.sources` | 1 search | valid, 14 claims | 29 retrieved sources; 14/14 claim URLs exact matches | **native_retrieved** |
| Gemini JSON schema + Google Search | 12 queries | valid, 14 claims | 0 chunks, 0 supports | asserted_only |
| Gemini hybrid (factual prose + marker + JSON, quotes copied from the prose), default thinking | 9 queries | valid, 14 claims | 14 chunks, 16 supports on the prose | **native_supported** 14/14 by exact quote occurrence + support index containment |

Lineage levels (evidence about provenance, never a provider score): `native_supported`, `native_retrieved`, `asserted_only`,
`unsupported`. Only `native_supported` resolves under the **strict** policy; `native_supported` + `native_retrieved` resolve
under the **retrieved-source** policy (claim has a URL, that URL matches a natively retrieved source exactly or after
conservative deterministic normalization, the value passes canonicalization and the strict registry, no unresolved conflict).
`asserted_only` and `unsupported` never resolve. No semantic or LLM matching promotes a level. Gemini binds by the API's
index ranges (the support segment text omits closing punctuation the quote keeps; index containment absorbs that); the
bound grounding chunk is the authoritative source record, not the model-written redirect URI. OpenAI matches URLs exact
first, normalized second, and records exact / normalized / unmatched; per-support confidence stays null where Gemini
does not expose it. Both providers keep one call per query; neither needs Kimi, a second provider call, independent
URL fetching or another retrieval provider.

Probe evidence on coverage: each single direct call covered all requested items of its query (14/14 for Q1), which is
the basis for the later, separate test of consolidating six queries to three or fewer.

## 8. Calls and cost for the four-athlete direct run (B only, no Kimi)

| Arm | Calls | Retries (max) | Probe | Tokens per call (measured A search calls, plus JSON output) | ≈ USD |
|---|---|---|---|---|---|
| B-G gemini-3.5-flash | 24 | 48 | 1 | in ≈ 1.5k, out ≈ 4k JSON; grounding $0.035/call assumed | 24 × (0.035 + 0.002 + 0.036) ≈ 1.75 |
| B-O gpt-5.4-mini | 24 | 48 | 1 | in ≈ 12k (search content, measured), out ≈ 4k JSON; tool $0.01/call | 24 × (0.010 + 0.009 + 0.018) ≈ 0.90 |

Total ≈ **$2.70 expected, ≈ $7 worst case** with every retry. Latency: A search calls averaged 19 s (Gemini) and 12 s
(OpenAI) for prose; JSON answers of the same content are expected in the same range, so each arm is about 2–3 minutes per
athlete, no extraction stage. Writes: none to any database; artifacts under `calibration/runs/<as-of>-direct/`.

---

## 9. Implementation plan (after approval; no calls until the run is separately authorized)

1. `spec/directEvidenceV1.ts` (pure): the contract text per query, the parser into the existing `ExtractedClaimV3` +
   section outcomes shape, the `cited_native | cited_asserted | uncited` lineage check against native citation metadata,
   degenerate detection reused.
2. Adapters: `geminiDirect.ts` and `openaiDirect.ts` under `lib/research/providers/` — same retry/reservation/usage
   contract as the search adapters; raw native citation metadata retained.
3. Harness: `--mode direct` writing artifacts with `extractionMode: "provider_direct"`, the same downstream derivation,
   minor policy and metrics; report: four-path tables.
4. Tests: contract parse, lineage check on synthetic native metadata (Gemini and OpenAI shapes), degenerate, no-classification
   guard on the request text, minor line unchanged.

---

## 10. Decisions requested

1. Approve `direct-evidence/1` (§3) and the strict `cited_native` rule (§4) as the lineage standard for the direct path.
2. Approve the two probe calls and the 48-call four-athlete direct run (§8) on the same four athletes, both providers.
3. Confirm the A arm stays as reprocessed (no new Kimi runs) and that A/B comparisons are labelled provisional across
   dates.
