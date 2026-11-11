# Phase A · Step 2a — Research substrate foundations (build record)

**Status:** implemented against the approved design (`step2-research-canonical-profile-design.md`, R1–R8); awaiting code review. `RESEARCH_SUBSTRATE_WRITE` is `"false"` in both environments; the backfill is dry-run by default and has not been applied.
**Migration:** `migrations/0046_research_substrate.sql` — six tables + `pg_trgm` + two trigram indexes; IF NOT EXISTS; nothing dropped or altered. Applied only by the deploy.

## What the athlete experiences

Nothing. The research pipeline, the snapshot blob, the score, the rates, athletes_current and every reader are byte-for-byte what they were. No reader of the six new tables exists.

## What happens underneath (only when the flag is on)

After `researchAthlete` has finished every legacy write, it hands the same Gemini responses (now
with their grounding supports preserved), the Trends and GDELT results, and one additional cited
extraction (Kimi) to `persistResearchRun`, which writes: a `research_runs` row with cost telemetry;
one sanitized `research_source_payloads` row per envelope; one `research_evidence` row per claim
with its citation validated (`cited` / `uncited` / `conflicting`), its source type classified from
the cited chunk's domain and an injection check; resolved `athlete_facts` by the source-authority
policy (origin + canonical source_class, `inferred`/`imputed` barred by CHECK); `athlete_inferences`
for the story arc; per-domain statuses and the lifecycle state in `athlete_research_state`
(connection status never stored).

## 1. Files

| Area | Files |
|---|---|
| Migration / schema | `migrations/0046_research_substrate.sql`; `scripts/db-migrate.sh` (0031–0046); `shared/schema.ts` §18c (six tables, CHECKs mirrored) |
| Registries | `server/services/intelligence/research/registries.ts` (evidence kinds, domains, states, origins, source-type tiers, lineage statuses); `factRegistry.ts` (**Fact Registry v1**, 16 keys with zod schemas, cardinality, normalizer, resolver, freshness family, scoring eligibility, blocking, display) |
| Contracts | `research/providers.ts` (Chunk / Support / SearchEnvelope / ExtractionEnvelope / SignalEnvelope, provider interfaces, IdentityHints) |
| Lineage | `research/lineage.ts` (`validateCitation`); `research/injection.ts` (untrusted-data fencing, suspect patterns, domain policy) |
| Resolution | `research/resolve.ts` (`resolveFacts`: rules 1–7, `classYearValidity`); `research/state.ts` (domain statuses, `deriveResearchState`) |
| Service | `research/persist.ts` (`persistResearchRun`, `recomputeState`); `research/config.ts` (`researchSubstrateWriteEnabled`, policy over `research_policy` + `research_freshness` params, `classifySourceType`) |
| Adapters | `server/lib/research/providers/geminiGrounded.ts` (grounding chunks + supports → envelope), `kimiExtract.ts` (cited extraction over fenced chunks), `signals.ts` (Trends, GDELT) |
| Wiring | `server/skills/researchAthlete.ts` (additive: `groundingSupports` captured; flag-gated `dualWriteResearch` after the last legacy write); `server/skills/researchDualWrite.ts` (hints from the ledger, assertions from `athlete_asserted`) |
| Scripts / params | `server/scripts/backfillResearchSubstrate.ts` (dry-run default; uncited lineage); `seedModelParams.ts` `research_policy v0.1-alpha` draft; `PARAM_FAMILIES` + `research_policy` |
| Config | `RESEARCH_SUBSTRATE_WRITE "false"` in `gcp/cloud-run-dev.yaml` and `gcp/cloud-run-prod.yaml` |
| Tests | `research/{factRegistry,lineage,injection,state,resolve,persist}.test.ts`, `lib/research/providers/kimiExtract.test.ts` (CI path added) |

## 1b. Review revisions (11 Sep, second round)

| Revision | Built as |
|---|---|
| Runtime secrets for sanitization | `server/lib/research/secrets.ts` `collectResearchSecrets()` gathers provider credentials by env NAME (known keys, any `*_API_KEY / *_TOKEN / *_SECRET / PRIVATE_KEY`, the service-account private key) and hands them only to the sanitizer; `researchDualWrite` and the backfill pass them; every stored research payload and request passes sanitize + leak detection with them as exact-value secrets; nothing logs them |
| Transactional persist | `persist.ts`: the run row is inserted outside the transaction (telemetry survives), then payloads, evidence, facts + supersedes, inferences and the state upsert run in ONE `db.transaction`; any failure rolls all of them back and the run closes `failed` with the normalized error |
| Gemini grounding semantics | `Chunk.textKind` (`provider_answer_segments` for Gemini grounding; `source_excerpt` only for a provider that returns page text); citation validation returns `quoteKind`; stored evidence support carries `quoteKind` (`provider_answer` \| `source_excerpt` \| `provider_record`) and `sourceExcerpt: null`; the extraction prompt labels grounding text as the provider's answer attributed to a source, not a page excerpt; no source quotation is ever reconstructed |
| SourceClass distinction | comments in `0046` and `shared/schema.ts`; test asserts the canonical five-value vocabulary is global (`SOURCE_CLASSES` = `SOCIAL_SOURCE_CLASSES`), `research_evidence` admits all five, and `athlete_facts` admits only `connected_verified \| platform_public \| web_researched \| NULL` by design |

New tests: `lib/research/secrets.test.ts`; `persist.test.ts` — a supplied live secret is redacted from request and payload, an unsupplied secret-like value refuses the run with nothing stored; a failure at the last write (state upsert) rolls back payloads, evidence, facts, inferences and state while the run row records the failure; stored support is `provider_answer` with no source excerpt; the SourceClass distinction; `lineage.test.ts` and `kimiExtract.test.ts` — grounding chunks are `provider_answer_segments`, the prompt says so, and a page-text chunk yields `source_excerpt`.

## 1c. Review revision (11 Sep, third round: canonical path secret safety)

`persist.ts` sanitizes each extraction claim ONCE (`claimClean`, then `assertNoSecrets`) and uses only that copy for the evidence row, the dedupe key, the citation quote and the resolver candidate, so `athlete_facts.value` / `value_text` can never receive an unsanitized provider value. Provider, parse and sub-call messages are redacted with the live secrets before they enter `research_runs.error` (`redactErrorRecord`: the Step 1a closeSyncRun rule, withheld if anything secret-like survives); a thrown persist error is redacted the same way before the failed-run record and before the research logger line (`redactMessage`); the dual-write's warning log is redacted too. Tests: a fact-bearing claim carrying a supplied secret yields a redacted fact and evidence; a provider/sub-call error carrying a secret is redacted in `research_runs.error`; a thrown error carrying a secret (test seam `__onBeforeCommit`) is redacted in the failed run and absent from every captured logger call; `redactMessage` withholds surviving secret-like content.

## 1d. Review revision (11 Sep, fourth round: signal claims and inference values)

The same sanitize → assertNoSecrets → persist invariant now covers the remaining provider-derived canonical values: the Trends/GDELT signal claim (`research_evidence.claim`, `source_domain`, dedupe key) is sanitized once and asserted clean before insert; the inference value (`athlete_inferences.value`) likewise. A surviving leak in either throws inside the transaction and rolls every canonical write of the run back. Tests: a supplied secret in a signal claim and in an inference value is redacted in the canonical rows; a surviving leak in either rolls back facts, evidence, payloads and inferences with the run closed `sanitizer_leak`.

## 2. 2a boundary: what the substrate does NOT touch yet

- `athlete_affiliations`, `athletes.school/division/conference`, `athletes_current`, `athlete_snapshots` — unchanged. A rule-7 established affiliation is recorded as an `affiliation` fact (`athlete_facts`, `value.primary`); merging it into the ledger and the current-only projection is 2d.
- No reader: Record screen, context, Mila, kit, scoring and rates keep reading the legacy blob and projection.
- Backfilled evidence is uncited by construction; its facts land `disputed` and the athlete's state is `research_partial` until a first cited refresh (design §9).

## 3. Gates (11 Sep 2026)

| Gate | Result |
|---|---|
| Registry validation | `factRegistry.test.ts`: 16 keys, schema/cardinality/resolver/freshness/scoring/blocking; strict schemas refuse extra keys; unknown keys refused; `story_arc` is not a fact key |
| Lineage cited / uncited / conflicting | `lineage.test.ts`: url and domain only from the cited chunk; conflicting when the provider supports the quote elsewhere; six uncited cases |
| Authority tier + displacement / dispute | `resolve.test.ts`: best tier wins with the rest disputed; newer + higher confidence never displaces a higher tier; better tier or tier ≤ 2 displaces; lower tier displaces only a stale value with two domains; confirmation supersedes with merged provenance; uncited → disputed; multi keys |
| Public-athlete affiliation establishment | `resolve.test.ts`: tier ≤ 2 + season establishes current primary; two tier ≤ 3 domains establish; one regional source, undated or uncited → propose; athlete said/proof → propose; a newer org turns the older affiliation historical |
| Assertion / proof override | `resolve.test.ts` + `persist.test.ts`: assertion supersedes current and disputed researched rows, origin `athlete_asserted`, `source_class NULL`, confidence 1; proof → `athlete_proof` |
| Refusal of inferred / imputed | resolver refuses both (and suspect, unregistered, off-schema); the CHECK refuses both at the database; assertion ⇔ NULL source_class enforced |
| Class-year dating | `classYearValidity`: season current only in its season (August roll-over); `validFrom`/`validTo` set; dated achievements historical |
| Injection / sanitizer | `injection.test.ts` (patterns, fencing, marker neutralisation, deny list); `kimiExtract.test.ts` (prompt fences every chunk); `persist.test.ts` (secret never stored in payload or request; suspect flagged and refused) |
| Migration dry run (dev, BEGIN … ROLLBACK) | six tables, `pg_trgm`, both trigram indexes created in-transaction; none after rollback |
| Drift gate (dev, 0046 not deployed) | reports exactly the six new tables as missing; no other drift |
| Typecheck / CI | `tsc --noEmit` clean; 18 suites, 183 tests |
| Byte-for-byte | no diff on `scoringService`, `rateService`, `athletesCurrentWriter`, `researchMerge`, `refreshScores`, `fetchSocialData`, `snapshotAdapter`; `researchAthlete.ts` has no removed lines — the additions are the `groundingSupports` capture (unread by the legacy path) and the flag-gated hook after the last legacy write. With the flag off the pipeline executes exactly the previous statements, so snapshot research, displayed MIA, score and rate outputs are unchanged by construction |

## 4. Dev evidence after the flag flip (to be appended after review)
