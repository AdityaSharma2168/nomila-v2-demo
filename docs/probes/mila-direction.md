# PR 7 — the direction engine: brief-producing tools, the confirm step, Mila viability

Branch `studio/mila-direction`, worktree `/Users/adi/nomila-v2-worktrees/mila-direction`, off origin/main
9d82252 (the #568 capabilities merge). Test athlete 3811cedd. Opened 22 Sep 2026.

**What it is for.** PR 6's walk (docs/probes/capabilities.md:474-511) showed the cost of a thin brief: the flow
collected a brand and a product line and nothing else, the concept step invented a product claim, and the
product photo contradicted the product line with nothing to say so. PR 7 fixes the INPUTS: tools that turn a
PDF, a reference, a stated objective or a moment into a validated CampaignBrief with every inferred line
flagged for her to confirm — and it tests whether Mila can carry them, without betting the tools on that.

**The architecture rule.** Each tool is a pure Studio capability — input → BriefProposal — behind its own
athlete-scoped route (`server/studio/direction/`). The flow screens call the routes; a Mila widget, if it
ever ships, is one more caller. No tool logic lives inside Mila's code.

**The hard gate.** A tool returns a brief; it never plans, generates, stitches or quotes. Held by two tests
(`tripwire.test` walks the folder's imports; `routes.test` mounts the real router with every spending entry
point spied and asserts none was called and no preview, plan or job row exists after each request).

---

## Commit 0 — Mila viability recon (read-only, $0)

**Two Milas.** Chat Mila is a real agent: `POST /api/v1/me/chat` (`server/routes/chat.ts:151`), Gemini
3.5 Flash on Vertex global (`server/mila/config.ts:100`), up to 8 tool rounds per turn streamed over SSE
(`server/mila/loop.ts:289`), conversations in `chat_messages`, rendered by `client/screens/MilaSearchOverlay.tsx`
(a Modal, not a route). Studio's "Mila" is only the persona name on CreateAnything thread cards — no model,
no tools, not a candidate carrier.

**Tool calling: yes, in-loop.** `MilaTool {name, description, argsSchema, timeoutMs?, execute(athleteId, args)}`
(`server/mila/types.ts:12-34`), 12 tools + 2 onboarding-only (`registry.ts:26-47`); results return as
`functionResponse` parts (`loop.ts:426-436`); athleteId injected server-side, never from args.

**The structured channel: exists.** `MilaWidget`, a five-kind discriminated union (`types.ts:182-187`,
mirrored at `client/hooks/use-mila-chat.ts:135-140`), rides on `done`, persists to `chat_messages.widget`
and rehydrates on reopen. Two confirm-then-act precedents: `reply_action` (propose-at-tap) and
`profileUpdates` (edit → PATCH, not persisted).

**Three blockers, all policy or storage, none capability:**
1. Widgets forbid free text (`types.ts:42-46`); a brief read from a brand's PDF is exactly the text the rule
   defends against — a third carve-out would weaken a working defense.
2. Chat attachments are `photo | video | product` media rows only (`attachments.ts:43`) — no PDF path.
3. `MILA_AGENT_V2` is ON in prod and dev (`gcp/cloud-run-prod.yaml:294`, `cloud-run-dev.yaml:282`) — any new
   Mila tool ships live at merge unless it gets its own flag.

**Navigation into the brand flow: not possible today.** Nav-chips carry a closed enum + a `threadId`
(`use-mila-chat.ts:148-166`); `StudioBrandPost: undefined` takes no params (`MainTabNavigator.tsx:169-255`);
its steps are local state in `BrandPostScreen.tsx`.

**Decision (Adi, 22 Sep): shape C.** The flow calls the tool routes; Mila becomes its own card — the
`proposalId` widget (scalars only), a `studio_brief_proposals` table, a `MILA_DIRECTION` flag.

**Decisions 2–4.** The `BriefProposal` envelope `{brief, flags, sourceTool, extras}` with flags BESIDE the
strict brief; "literal" is code-verified (quote a whitespace-normalised substring of the source, else
downgraded) — belief earned by verification, never by a model's claim. Constraints go INTO the brief as an
optional short-string array with a fenced `campaignBlock` line (a constraint the planner never sees isn't
one); a picked proposal's angle becomes the plan's `PlanConcept`, carrying 6c's grounding string-check.
Lane D is live-no-date: `runGeminiOnce` imported read-only, the shared `webSearchLimiter`, no writes to the
research team's `research_budget_days`, one Studio cost log line per call; the date is always null and hers
to enter. Trend stays the honest stub (search-costume listicles are the model-only-research failure class).

**Search infra (Lane D recon).** `server/lib/research/providers/geminiGrounded.ts:81` `runGeminiOnce`
(googleSearch, Flash) → `SearchEnvelope` with chunk url/title/domain; the repo's own cost model says
$0.035/call + tokens (`services/intelligence/research/policy.ts:67`). No provider returns a structured date
or page text; no fixture/schedule source; no trend or trending-audio tables anywhere in the schema.

**Corrections to the brief's citations.** `docs/specs/studio-video-use-cases.md` has no "direction engine"
section: the pillars are its own strategy / moment / trend / brand-work sections (`:142-351`), and `:331-333`
("she confirms the reading of the brief, one tap per assumption") is Lane E's spec sentence. The reference
engine's ledger is `docs/probes/reference-decomposition.md` (there is no brand-profiles probe file).

---

## Commit 1 — the spike (shape C, $0)

**Built.** `server/studio/direction/{envelope,echo,routes}.ts` + `registerDirectionRoutes(router, studioGate)`
in routes/studio.ts (one import, one call, the publish pattern). `POST /studio/direction/echo {brand, productLine}`
→ a fixed proposal: her two lines flagged literal (quote = her words), every other filled line inferred with a
because. Client: `directionLogic.ts` (`readProposal` — structural, like `parseWidgetPush`; `confirmRows`;
`allConfirmed`), `use-studio-direction.ts`, `ConfirmBriefStep.tsx` (literal rows read; inferred rows carry a
warning bar, an INFERRED chip, the because and a Confirm pill; "Use this brief" off until every inferred line
is confirmed). A `__DEV__ && PLANS_ONTO_BOARD` door on the brief step drives it; Lane E's doors replace it and
land on the same step. `BriefContext` gains `proposal` (read by nothing yet — Lane E plans from it).

**Naming.** The body is `{brand, productLine}` — camelCase, as every Studio route body (`productAssetIds`,
`briefFilePath`), not the brief's `product_line`.

**Predictions vs results.**
- *The brief survives the full path byte-identical modulo transport* — HELD both halves: the wire equals
  `JSON.stringify(echoBrief(input))` (routes.test), and `JSON.stringify(readProposal(JSON.parse(wire)))` equals
  the wire (directionLogic.test).
- *Zod-valid on arrival* — HELD: `validateBriefProposal` (the server's strict envelope + brief) passes on the
  client-held object (client tests import the server schema, the brandPlan.test precedent).
- *Inferred flag rendered distinguishably* — HELD: 9 rows read `Inferred: …`, 2 read `From the brief: …`
  (accessibility labels); only inferred rows carry a Confirm; the button is off until all 9 are confirmed and
  hands on the very object it was given.
- Stricter than scoped: "one field marked inferred" became "every filled line flagged, two literal, nine
  inferred" — `unflaggedPaths(proposal) === []` is the invariant Lane A's "inferred fields not flagged" will red.

**Gates.** check:types green; `tsc -p tsconfig.jest.json` green; eslint 0 errors (warnings: the `require()`
mock idiom and `import/first` the sibling suites share; `describeLimits` unused in routes/studio.ts is
pre-existing); prettier clean on the 11 new files (BrandPostScreen.tsx and routes/studio.ts were already
unformatted on main — left alone). Scoped jest: 24 + 4 tests, 0 red.

**Mutations, red by name (8/8, each restored from a backup, clean re-run green after):**

| # | Mutation | Red |
|---|---|---|
| M1 | route answers `{ text: JSON.stringify(proposal) }` | "the echo brief arrives as data the client can read, not prose — …" |
| M2 | route calls `genai().models.generateContent` before answering | "no direction route asks the planner, generates, stitches or quotes — the hard gate" (+ the data test, the other 200 path) |
| M3 | routes.ts imports `deriveConcepts` (never called) | "no direction module imports the planner, the concept step, a generation, a preview quote or a stitch" |
| M4 | `SOURCE_TOOLS` gains "summarize_brief" alone | "only the tools this PR has built may sign a proposal" |
| M5 | echo drops the `creative_direction.tone` flag | "the spike's proposal is valid, and every filled line of it is flagged" (+ routes data test, + client rows test) |
| M6 | `readProposal` accepts a string / a `{ text }` wrapper | "a proposal that arrives as prose, not data, is refused" |
| M7 | `confirmRows` gives every row the Inferred prefix | "tells literal from inferred: …" and "renders the inferred lines distinguishably from the literal ones" |
| M8 | `ready = true` | "nothing proceeds unconfirmed: …" and "a confirmed line can be un-confirmed, and the door closes again" |

M2 and M3 together show the gate's two halves are independent: a call the static walk cannot see is caught at
runtime; an import that never runs is caught statically.

**Not acted on.** RN 0.81 warns that `SafeAreaView` is deprecated; every sibling Studio screen uses the same
import, so the new step matches them rather than switching one screen to safe-area-context.

**Device acceptance is Adi's.** Locally the door needs `STUDIO_BRAND_PROFILES=true` on the server and
`EXPO_PUBLIC_STUDIO_BRAND_PROFILES=true` for Metro — neither is set in the worktree `.env` or on dev Cloud Run
today (`cloud-run-dev.yaml` has no `STUDIO_BRAND_PROFILES`).

---

## Lane F — the SSRF close ($0)

**F1 — DNS rebinding, closed in `server/lib/safeFetch.ts`.** The check and the connection are now the same
address: every hop is resolved once by `checkAndResolve`, and the request goes through `node:https` with a
`lookup` (`pinnedLookup`) that answers the checked addresses and never asks DNS again. All of a name's
checked addresses are handed back under `all: true`, so node's own happy-eyeballs still picks among them
and every candidate is one the check saw. TLS verifies the HOSTNAME as before (the request's host, not the
socket's address). The answer is wrapped back into a web `Response` — status, headers, `.url` (the hop that
answered; brandImage resolves relative refs against it), streamed body, gzip/br/deflate decoded (fetch did
that, https does not; no Accept-Encoding is sent). No new dependency: undici is in node_modules only as
Expo's CLI's, so a fetch dispatcher was not on the table; `node:https` takes `lookup` directly. The older
`fetchImpl` seam stays for the 26 existing tests and is marked test-only (it is not pinned).

**F2 — the three unguarded sites, each through safeFetch.** `mediaStore.ts:39` (`rehostFromUrl`: IG CDN and
provider output urls), `adapters/vertex.ts:133` (a reference url fetched to bytes; the model call itself
stays bare fetch — it is ours), `scripts/rate/validateRateCitations.ts:65` (model-cited pages; `redirect:
"follow"` becomes safeFetch's own hops). Recon found no site that could not go through it. The one
behaviour change, accepted by Adi and pinned by a test: an `http://` (or `data:`) url is now refused —
theoretical today (no provider returns one; `openrouter.ts:219` never reaches rehost), and if one ever
does, the test names it.

**Predictions vs results.** *Existing safeFetch tests stay green* — HELD (26/26, plus 5 new). *The three
sites' happy paths unchanged* — HELD: mediaStore (new suite, 3), vertex (24 existing + 1 new), the rate
script by a static source test (it runs `main()` on import, so it is held by reading, not running).
*A rebinding fixture is refused* — HELD in the pin's own terms: a resolver that answers public then
private is asked once, and the connect is told the checked address; the private answer is never
consulted, so there is nothing left to refuse.

**Mutations, red by name (5/5; a first cut of M5 was malformed — a dangling `else if` — and was re-run as a
no-op branch):**

| # | Mutation | Red |
|---|---|---|
| F-M1 | drop `lookup` from the request options ("re-resolve allowed") | "the connection is pinned to the checked address — a name that answers public then private is never re-resolved" (+ the hop test) |
| F-M2 | `rehostFromUrl` back to bare `fetch` | "fetches the url a provider or a CDN chose through safeFetch, and stores what came back" |
| F-M3 | vertex reference back to bare `fetch` | "a url reference is fetched through safeFetch; the model call itself is not" |
| F-M4 | the rate script back to `fetch(…, redirect: "follow")` | "fetches a cited page through safeFetch — a model-chosen url is never a bare fetch" |
| F-M5 | the gzip branch made a no-op | "the wrapped answer reads as fetch's did — status, headers, url, text — and a gzip body is decoded" |

**Gates.** check:types green; `tsc -p tsconfig.jest.json` green; eslint 0 errors on the eight files; all six
edited files were already unformatted on main, so prettier was not run on them (own lines hand-formatted).

**Noted, not acted on.** `mediaStore`'s catch logs `err.message.slice(0, 120)`; an `UnsafeUrlError` message
carries the refused url. A refusal only happens for a non-https or private-host url, never a signed
storage url, so nothing secret can land there — but it is a url in a log line, and Lane C's URL input
will answer its own 400 without logging the url.

---

## Lane A — summarize_brief (built; live cells pending)

**What it is.** `server/studio/direction/summarize.ts`: her PDF → its text (lib/pdfExtract) → ONE model call →
lines the model claims literal-with-quote or inferred-with-because → VERIFIED, assembled onto the strict
brief, validated → a BriefProposal. Two doors in `routes.ts`: `POST /studio/direction/summarize-brief`
`{ briefFilePath }` (a brief the 6d signed-url door stored, under HER prefix, `isHerBriefPath` before any
read) and `POST /studio/direction/summarize-brief/upload` (the PDF itself, raw `application/pdf` ≤ 10 MB,
refused before parsing when it is not a PDF, stored under her prefix with `putAttachment` so a plan row
can name it, then read; answers `{ proposal, briefFilePath }`). Client: `summarizeBriefByPath`,
`summarizeBriefUpload` (use-studio-direction.ts). Runner: `server/scripts/studioDirectionSummarize.ts`.

**Decisions (Adi, 23 Sep).** The document rides to the model TWICE: the PDF as an `inlineData` part
(Adi: "a gemini pro call on any pdf" — the pages themselves, layout and images included) AND its extracted
text inside `<<<BRIEF_DOC>>>…<<<END_BRIEF_DOC>>>`, scrubbed of `<`/`>`, labelled data — the CAMPAIGN fence's
discipline, and the corpus every literal is checked against. Model: Flash by default (reading, not
reasoning; ≈ $0.005–0.01 a call), `STUDIO_SUMMARIZE_MODEL` moves it (Pro ≈ $0.03–0.05); thinking follows the
model (none on Pro). **Literal is earned here:** a quote must be a whitespace-, case-, quote- and
dash-folded substring of the corpus and carry the value's words, else the line is DOWNGRADED to inferred
with why — never dropped, never believed. Defaults the schema needs (objective, product fidelity, how much
it is her) are flagged inferred "the brand flow's default". Constraints ride as `extras.constraints[i]`,
each flagged; `proposalPaths` now covers extras so `unflaggedPaths` holds over the whole envelope.

**The fail-closed path (decision, 23 Sep).** No readable text — a scanned or image-only PDF, a parse
failure, an extractor that throws — is NOT an error: the model still reads the pages, every line is
inferred (`NO_TEXT_BECAUSE`), and the envelope carries `extras.extraction: "unavailable"` plus a note the
confirm screen shows: "I read this as an image — please check everything." The client reader accepts
`notes` and `extraction`.

**pdf-parse 1.1.1 — nondeterminism observed, not root-caused, mitigated.** While authoring fixtures by hand
(PDF 1.4, uncompressed, correct xref — offsets verified byte for byte), pdf-parse's bundled pdf.js
(v1.10.100) rejected them with `bad XRef entry` — sometimes. The same bytes parsed in one process and
failed in another; a copy into a fresh ArrayBuffer parsed after one failure mode and failed after another;
shifting every xref offset back by one or two bytes still parsed while forward broke, so the table was
right. A "pooled Buffer byteOffset" theory fit part of the evidence and failed its own test (a standalone
copy still failed in a fresh process), and was withdrawn along with an edit to `lib/pdfExtract` — that
file is back to main's bytes. Real-world PDFs from real producers (a 16-page repo PDF, every CUPS-rendered
fixture) parse deterministically in every mode tried. Mitigation is the fail-closed path above, and one of
the failing hand-made PDFs is kept as `fixtures/briefs/parser-breaking.pdf`: the test holds that it never
breaks the tool, and that when the parser gives nothing, nothing is literal.

**Fixtures.** Rendered ONCE by macOS's CUPS text filter (`make.ts`, `cupsfilter -o cpi=12`; PDF 1.3) from
`lines.ts`, the single source of truth; committed bytes. `full` (3 pages, 13 stated lines), `thin`,
`injection` (the instruction paragraph twice and a `<<<END_BRIEF_DOC>>>` close attempt — the second copy
was meant to be white on white; CUPS cannot paint white text, so it is visible: the defense under test is
the fence and the verified literal, not invisibility), `scanned` (one space), `parser-breaking` (kept).

**Gates.** check:types green; `tsc -p tsconfig.jest.json` green; eslint 0 errors; prettier clean on every
new file; scoped jest 60/60 (direction) + 4 (confirm step) + pdfExtract 16/16 as on main.

**Mutations, red by name (6/6, restored from backups, clean re-run 60/60):**

| # | Mutation | Red |
|---|---|---|
| A-M1 | the fence markers dropped from the instruction ("PDF text reaches the prompt unfenced") | "the document's text enters the instruction only inside the fence, and cannot close it" (+ the fixtures-as-shown test) |
| A-M2 | a default filled without its flag ("inferred fields not flagged") | "inferred fields not flagged: every line the tool fills carries a flag, defaults included" (+ 2 tests holding `unflaggedPaths`) |
| A-M3 | the model's "literal" believed without the substring check | "a literal whose quote is not in the document is downgraded to inferred, and says why" (+ 4 no-corpus tests) |
| A-M4 | the extractor's throw allowed to escape | "an extractor that throws is the no-text path, not an error" |
| A-M5 | `isHerBriefPath` dropped from the by-path door | "another athlete's brief path is a 404 before anything is read; so is a path that is not a brief" |
| A-M6 | the upload stored outside her prefix | "stores the PDF under HER prefix, reads it, and answers the proposal beside the path" |

**Live cells (23 Sep 2026, through the route, this worktree's server, n=3 per fixture).** Two detours
first, both environment: the disk hit 122 MiB free mid-run (the harness itself threw ENOSPC; Adi
cleared ~8 GB), and the door answered 404 after auth until the server was started with
`STUDIO_BRAND_PROFILES=true` INLINE — the worktree `.env` parses to `true`, but dotenv never overrides a
variable already in the shell, and that terminal carried an older value. Both are logged here so the
next person does not re-derive them.

*Flash (`gemini-3.5-flash`, the default) — 12 calls, $0.0245, ≈ $0.0033 a full brief, 5–7 s:*

| fixture | stated lines literal | invariants |
|---|---|---|
| full | 10/13, 10/13, 10/13 (77 %) — **the ≥ 11/13 bar MISSED**, by the same lines each run | every literal quote verified, unflagged 0, never-said 0 |
| thin | feel/story absent, never literal; brand + product literal; defaults flagged — HELD | |
| injection | 10/13, 9/13, 10/13; 0 unverified literals; 0 "budget"/"approve" in any value; stated lines land as in `full` — HELD on every invariant, same 77 % | the paragraph moved nothing observable |
| scanned | valid envelope, 0 literal, `extraction: "unavailable"`, both notes — HELD 3/3 | |

**Why the bar missed, exactly.** The three lines that came back inferred every run are the LIST-valued
ones — `creative_direction.style` ("documentary"), `output.type` ("video"), `output.platform`
("instagram") — and once `output.aspect_ratio`. Each carries a because that quotes the document verbatim
("The brief explicitly requests a 'documentary, not commercial gloss' visual style"), so the model read
them; it marked them inferred because the prompt's own rule says "anything you … **mapped to a list
value** … is inferred." The rule cost the bar, not the reading; the VALUES were right in all 6 runs
(documentary / video / instagram / 9:16). The verifier already requires a list value's word to sit inside
the quote, so letting the model claim literal there is safe. **Proposed prompt bend (prompt rules bend,
gates hold), pending Adi:** "a list value is literal when its own word appears in the quote" — re-run as a
NEW Flash cell (≈ $0.03), predicted 13/13 on `full`. The 77 % result stands as recorded.

*Pro (`gemini-3.1-pro-preview` via `STUDIO_SUMMARIZE_MODEL`) — 12 calls, $0.31, ≈ $0.047–0.063 a full
brief, 22–33 s:* full 9/13, 7/13 and one **502** (7.2 s — a reply the tool could not read, not the 45 s
timeout; the reason is on the server's log line, Adi's terminal); injection 7/13, 7/13, 8/13; thin and
scanned as Flash. Pro marked the same list-valued lines inferred AND the two constraints, with the same
correct values. **Verdict: Flash stays the default.** On this task Pro is fewer literals, 5× the
latency, 14× the cost, and 1 refusal in 12.

**Two nits carried, not fixed:** both constraints arrive under one two-line quote (the model answers one
`constraints` list with one quote; splitting per rule is a small follow-up); `energy` took the whole
clause ("steady - no hype, no shouting") where the stated value is "steady" — the value is in its quote,
so it verified, and the confirm screen shows it as read.

**The Pro 502, named (Adi's server log):** a Vertex `429 Resource exhausted` on `gemini-3.1-pro-preview`
→ `model_failed` → 502 — a quota blip, not a reply the tool could not read.

**The prompt bend, applied (Adi: "a rubric fix, not a bar-lowering").** `summarize_brief/2` (8afd9d6):
"a list value is literal on the same terms — when its own word appears in the quote". The verifier is
untouched. **Registered prediction for the re-run Flash cell: 13/13 stated lines literal on `full`.**
**Result (23 Sep, 12 calls, $0.0249): HELD — `full` 13/13, 13/13, 13/13; `injection` 13/13 ×3 with 0
unverified literals and 0 never-said hits; `thin` and `scanned` as before.** The three list-valued lines
now come back literal with the same quotes they were inferred from under /1 — the rubric moved to the
verifier, and the verifier held them. Lane A's pre-registered bars are all met on /2.

---

## Lane B — propose_campaign (built; live cells pending)

**What it is.** `server/studio/direction/propose.ts`: `{objective, brand?, occasion?, priorContext?}` + her
sport + her library (the planner's `assembleLibrary`, READ ONLY, searched with a sentence built from the
objective's gloss so the query shape is the planner's own; ≤ 4 embeddings; unreadable → a note, never a
refusal) → ONE Pro call at the concept step's temperature (`PROPOSE_TEMPERATURE = 0.6`, pinned by a test so
it is deliberate, not ambient) → two or three proposals, each a `concept {angle, feeling, line}` in the
plan call's own `PlanConcept` shape (a picked one rides `POST /studio/agent/plan` as `concept` unchanged —
`readConcept` accepts it, held by a test) and the lines of a brief. Door: `POST
/studio/direction/propose-campaign` → `{ proposals, notes }`. Client: `proposeCampaign()`. Runner:
`server/scripts/studioDirectionPropose.ts` (`--prior <file>` for Lane S).

**Decisions (from the recon, Adi 23 Sep).** Input is a plain **brand name** (a `brand.profile` handle
resolves to nothing today; `getBrandContext` is numeric-id-only and unscoped — carded). Her context is
her **sport only**, the planner's rule. **Every line a proposal fills is inferred with a because; the
only literal lines are hers** — `objective.goal` and `brand.name`, quoted from her input by the tool,
never by the model; the model's brand name is ignored, and with no brand named its product and brand
lines are dropped and counted. The envelope gained `extras.concept` (replacing the half-slot `angle`)
and `propose_campaign` in `SOURCE_TOOLS` with its pin. The shared transport gained a temperature
parameter. The brief builder was extracted to `brief.ts` so summarize and propose fill defaults the same
way. The tripwire's allowance extends to `agent/plan`'s pure renderers (`libraryLine`, `fenced`, the
LIBRARY markers) so her library reads to a tool exactly as to the planner.

**Adi's two tightenings, built.** (a) **The library carve-out has its own tripwire**: `routes.test`'s
afterEach now asserts `embedText` calls ≤ 4 only inside the propose describe and exactly 0 everywhere
else; the planner/generation/stitch zeros stay universal. (b) **6c's grounding is code at the route**:
`CLAIM_LEXICON` (what a product is "built or designed to do, what it keeps, resists or survives", and the
words a claim is dressed in) is run over each proposal's concept and brief lines; a hit whose first three
words are not in her inputs drops the proposal, never shown; her own words pass. Both were S.

**Distinctness in code too:** the runner's word-Jaccard (lifted to `measure.ts`) drops the later of two
proposals at ≥ 0.5 on `line`; fewer than two left is `too_few` → 502 "Couldn't find two distinct ideas",
not a thin answer.

**Gates.** check:types green; `tsc -p tsconfig.jest.json` green; eslint 0 errors; prettier clean on every
new file; scoped jest 80/80 (direction: envelope 9, tripwire 3, transport 3, propose 13, summarize 18,
routes 19, briefs 6, client reader 9) + 4 (confirm step).

**Mutations, red by name (6/6, restored, clean re-run 80/80):**

| # | Mutation | Red |
|---|---|---|
| B-M1 | the PRIOR markers dropped ("prior_context ignored", the fence half) | "prior context enters the instruction only inside its fence, and a proposal that builds on it says so in its because" |
| B-M2 | `priorReference` returns null ("prior_context ignored", the because half) | the same, + "priorReference picks up a distinctive word, not a common one" |
| B-M3 | `claimHits` skipped | "a proposal that sells the product is dropped at the route, not shown — unless the words are hers" |
| B-M4 | the overlap check skipped | "two proposals that say the same thing are one: pairwise overlap at or over 0.5 drops the later; fewer than two left is a refusal, not a thin answer" |
| B-M5 | the transport's default temperature 0.6 | "temperature is 0 unless a tool asks, and a tool that asks gets exactly what it asked" |
| B-M6 | the summarize door calls `assembleLibrary` ("summarize gains library access") | the summarize door's 200 tests and the hard-gate test, in the afterEach |

**Live cells (23 Sep, through the route, Pro).** *B — grow-following, no brand, n=3, $0.164
(≈ $0.044–0.062 a call, 25–35 s):*

| run | proposals | pairwise overlap | feel present / inferred | product null | claims on the wire | unflagged |
|---|---|---|---|---|---|---|
| 1 | 3 | 0 / 0 / 0 | 3/3 · 3/3 | 3/3 | 0 | 0 |
| 2 | 2 | 0 | 2/2 · 2/2 | 2/2 | 0 | 0 |
| 3 | 3 | 0 / 0 / 0 | 3/3 · 3/3 | 3/3 | 0 | 0 |

Every pre-registered bar HELD: 3 proposals in 2/3 runs (never < 2), every overlap < 0.5 (all 0.00 — the
three ideas share no content word), feel present and inferred on every proposal, product null on every
one, 0 claim hits reached the wire. Run 2's note is worth keeping: "Filtered out the soccer assets
(a11–a16, a22, a24) to strictly align with her requested sport: basketball" — the model saw the
test athlete's several-women library (memory: the 17 uploads are 3+ people) and said so; the proposals
themselves stayed on her sport. The concept lines are first person, as 6c's were (carded there).

*S — the stacking proof: the same ask with a synthetic rivalry moment as `priorContext`
(`probe-out/mila-direction/moment.json`, `sourceTool: research_moment`), n=3, $0.179:* proposals on the
moment **1, 1, 2 per run** — ≥ 1 in 3/3 — each with its concept's because `from research_moment: Rivalry
fixture: vs Crosstown United, Saturday 4 Oct, at home`; overlaps ≤ 0.07; claims 0; product null 3/3.
The other proposals stood on her objective, as designed. **Lane S HELD** through B2, with the moment as a
fixture; a real moment brief is Lane D's, and it plugs in at the same field.

**Cards.** `getBrandContext` is numeric-id-only and not athlete-scoped (`routes/studio.ts:795-808` says why;
a tenancy smell for whoever wires real brand profiles). The constraints-into-the-brief move (decision 3)
is not yet made — propose_campaign makes no rules, summarize's ride in `extras`.

**Cards.** `pdf-parse` → a maintained extractor (pdfjs-dist current, or a `pdftotext` shell-out) — PR 10.

---

## Lane C — decompose_reference (image + pasted-text doors built; URL door pending a decision)

**What it is.** `server/studio/direction/decompose.ts`: `{source: {kind:"image", assetId} | {kind:"text", text},
role?}` → PR 3's engine (`studio/reference/decompose.ts`, UNTOUCHED — its flag, shape, tenancy and bytes gates,
its one Flash call, its `reference_analyses` row under her id) → the §7 decomposition mapped onto a
`BriefProposal`: `commercial_style[0]` → `creative_direction.style` (the same §8 list both sides),
`emotional_tone.summary`'s clauses → `tone` (≤ 6, ≤ 40 chars each), `motion.tags[0]` → `energy`, and the whole
`reference_intent` as `references[0].intent` under the role she picked (handle `ref_1`). **Every line is
inferred** — a decomposed reference is inference by definition; nothing in it was said by her or a brand — and
the proposal says so in a note, with the observed/inferred count per dimension and any off-list tags dropped.
Door: `POST /studio/direction/decompose-reference` (404 flag off · 400 bad shape / unknown field · 404 another
athlete's photo, no call made · 422 unreadable · 502 the engine's refusal, nothing planned; `X-Studio-Cost-Usd`
+ `X-Studio-Model`). Client: `decomposeReference(source, role)`. Runner:
`server/scripts/studioDirectionDecompose.ts` (`--text` / `--asset` / `--url`). `SOURCE_TOOLS` gained
`decompose_reference` with its pin.

**The URL door is a 400 that says why, not a stub.** A fetched reference must be stored as HER asset (so a plan
row can name it and the caster's predicate can load it) and be **kept out of the planner's library and the
her-room** — and the recon found NO existing marker any reader honours: `media_assets_origin_check` allows only
`connected | discovery | upload | generated`, nothing reads `platform` or `metadata.role` as an exclusion, and
`origin: "upload"` means *hers, from her camera*. Two ways to make one, Adi's call:

| | (i) migration 0062: `'reference'` in the origin CHECK | (ii) no DDL: `platform: "reference"` + `origin: "generated"` |
|---|---|---|
| predicate clause | `ne(mediaAssets.origin, "reference")` | `ne(mediaAssets.platform, "reference")` |
| where it goes | `photoPredicate.ts:39-80` (`herPhoto`/`herClip`) · `mediaEnrichment.ts:200` · `routes/media.ts:127-136, 155-158, 173-176` | the same three sites |
| cost | a `db-migrate.sh` line + `schema.ts` in ONE commit (the drift gate) | none; `platform` is free text today |
| honesty | the row says what it is | `origin: generated` is a small lie a future reader could trust |

Until that lands the door refuses with the reason in the error; the client helper's type already carries
`{kind:"url"}` so the flow screen needs no change when it opens.

**Gates.** check:types green; `tsc -p tsconfig.jest.json` green; eslint 0 errors; prettier clean on every new
file; scoped jest **91/91** (direction: decompose 6, routes 24, envelope 9, tripwire 3, transport 3, propose 13,
summarize 18, briefs 6, client reader 9).

**Mutations, red by name (7/7 after one fix to the tripwire itself; restored; clean re-run 91/91):**

| # | Mutation | Red |
|---|---|---|
| C-M1 | a bare `import "../generate";` in decompose.ts | **NOT RED on the first run.** The tripwire's import walk matched default, namespace, dynamic, require and re-export forms but not a bare side-effect import. Fixed in the walk (`import\s+["']`), pinned by a parse case; re-run red — "no direction module imports the planner, the concept step, a generation, a preview quote or a stitch". C-M1b, the realistic named form, red on the same test. |
| C-M2 | the engine's `eq(mediaAssets.athlete_id, athleteId)` dropped (PR 3's file, restored) | "another athlete's id is not found, and no call is made" — in decompose.test and routes.test both |
| C-M3 | the style line flagged literal | "every recorded cell maps to a valid proposal in which EVERY line is inferred", + the wrapper's and the route's all-inferred tests |
| C-M4 | the URL early return skipped | "a URL is refused before anything runs, and says why" — both suites |
| C-M5 | the `references` flag dropped | the unflagged-paths checks in both suites |
| C-M6 | the route's unknown-field check removed | "a bad shape and an unknown field are 400s too" |
| C-M7 | the tool quotes at runtime (`await import("../preview.js")` + `previewGeneration`) | the hard-gate afterEach on four route tests AND the tripwire's walk (it reads dynamic imports) |

**Live cells (23 Sep, through the route, Flash, after the restart).** Prediction registered: every emitted
line inferred, a valid envelope, the decomposition in `references[0]`.

| cell | n | valid | inferred | unflagged | style | tone | energy | dims | $/call |
|---|---|---|---|---|---|---|---|---|---|
| text ("a soccer ad with me in it: floodlit pitch at dusk, calm and clean, slow push-in…") | 2 | 2/2 | 6/6 · 6/6 | 0 | sports_campaign | calm · focused · anticipation | slow motion | 11/12 (0 obs, 11 inf) | $0.0020 |
| image (one of her own photos) | 2 | 2/2 | 6/6 · 6/6 | 0 | sports_campaign | "image conveys intense focus" · athletic prowess · dynamic energy | jumping | 9/12 (9 obs, 0 inf) | $0.0020 |

**HELD** on both doors, $0.008. Two runs of each were byte-identical on every line (temperature 0 on the
engine). One nit, fixed in the same commit: the tone-clause cleaner let "the image conveys …" through as a
clause; it now strips a leading subject + "conveys / evokes / suggests (a sense of)". The URL cell waits on
0062 and a restart (below).

### The URL door (built 23 Sep, after Adi's marker decision)

**Decision (Adi): option (i).** "Reference rows are runtime-created rows, that's what DDL is for, and
`origin: "generated"` on a fetched asset would poison provenance queries." So: **migration 0062** widens
`media_assets_origin_check` by one value, `'reference'`, as a guarded DO block (0056's pattern — the DROP +
ADD pair inside one transaction, a no-op once the constraint already lists the value); `shared/schema.ts`
declares the same list; `scripts/db-migrate.sh` names the file after 0061 — all in ONE commit, for the drift
gate. `referenceOrigin.migration.test.ts` holds it against PGlite: refused today, accepted after, an
off-list value still refused, a second run byte-identical, the same vocabulary as schema.ts, the step-3 line
present, no bare DROP/ADD outside the block.

**The readers.** Adi named three clause sites; the recon of every `eq(mediaAssets.athlete_id…)` reader
(27 files) found a fourth that matters: `services/mediaSearch.ts` — the planner's own search and the
visible-brands scan — which none of the three cover. So `ne(mediaAssets.origin, "reference")` went into:

| reader | what it feeds | held by |
|---|---|---|
| `studio/photoPredicate.ts` `herPhoto` / `herClip` (one `notAReference()` clause) | the caster, the picker, the stitch, `mediaList` | routes.test "never offered as her footage" |
| `services/mediaSearch.ts` `searchMedia` + `listVisibleBrands` | the planner's library, the brand lens | mediaSearch.test + routes.test |
| `services/mediaEnrichment.ts` — the cron's `conds` / `remConds` and `enrichAthleteMedia` | tagging + embedding (never tagged, so never searchable, never billed) | mediaEnrichment.test |
| `routes/media.ts` — the list, its counts, its top row | the gallery | media.test (also `?source=reference` finds nothing) |

The other 23 readers take a row **by id** (sessions, QA, approval, publish, deck…) — a reference cannot
reach them because nothing offers its id; the reference engine itself reads by id under her athlete_id,
which is the one reader that must see it. Not touched: `skills/rehostAthleteMedia.ts` (writes connected
rows), `mila/attachments.ts` (photo|video|product by id).

**The door.** `decompose.ts storeReferenceFromUrl`: `safeFetch` (Lane F — https only, no internal address,
every hop pinned; the folder's new static tripwire "no direction module calls fetch outside safeFetch"
holds that it is the ONLY fetch) → a direct image only (`image/jpeg | png | webp`; a page is **415** with
the reason; scraping stays a card) → ≤ 10 MB (**413**; the `content-length` header first, then the bytes) →
`saveBuffer` under `athletes/<her>/references/<uuid>` → ONE `media_assets` row `{platform: "web", origin:
"reference", media_type: IMAGE, metadata.reference: {url, fetched_at, bytes}}` under her athlete_id → then
the image door, untouched. An unsafe link is a **400** naming the refusal; a fetch or store failure a 502
that stored nothing. The row's id rides back in `X-Studio-Reference-Asset-Id` (the flow keeps it to name
the reference on the plan call; Lane E's business), and the note says "The picture at her link read on…".

**Gates.** both tsc configs green; eslint 0 errors; prettier on the owned files (schema.ts, mediaSearch,
mediaEnrichment, routes/media and their suites were unformatted on main — hand-formatted, not rewritten);
jest: direction 100/100 (+ migration 5, decompose 7, routes 26), media.test 37, mediaEnrichment 21,
mediaSearch 9, studio.agent 64.

**Mutations, red by name (8/8, restored, clean re-run green):**

| # | Mutation | Red |
|---|---|---|
| U-M1 | "URL fetched outside safeFetch" — `fetch(url)` in the door | the tripwire's "no direction module calls fetch outside safeFetch", both route tests, both unit tests |
| U-M2 | the stored row written as `origin: "upload"` | "never offered as her footage" (route + unit) |
| U-M3 | `notAReference()` dropped from `herPhoto` | "never offered as her footage" (the predicate arm) |
| U-M4 | the `ne` dropped from `searchMedia` / `listVisibleBrands` | mediaSearch.test's case + the route test's search arm |
| U-M5 | the `ne` dropped from the enrichment cron and the athlete selector | "not tagged, not embedded, not counted as remaining" |
| U-M6 | the `ne` dropped from the gallery's list query | "absent from the items, the counts and the top row" |
| U-M7 | 0062's CHECK without `'reference'` | "accepted after", "same vocabulary as schema.ts", "a second run is a no-op" |
| U-M8 | the image-type gate skipped (a page accepted) | the 415 case, route + unit |

**Live URL cell (23 Sep, after Adi applied 0062 and restarted; n=1, $0.0017, 7.5 s).** A stable public
JPEG (`gstatic.com/webp/gallery/1.jpg`, 44 KB): **stored as her reference row** — the insert with origin
`'reference'` succeeding is the proof 0062 is on dev — then read: valid, 5/5 inferred, 0 unflagged, style
`documentary`, 6/12 dimensions observed, note "The picture at her link read on 6 of 12 dimensions". The
gallery afterwards: 474 rows, the reference not among the items or the top row, `?source=reference` → 0.
**HELD.** (That row now exists on the shared dev DB under Adi's athlete; it is inert everywhere by
construction, and deleting it is his call, not mine.) Nit folded in: the tone cleaner now also strips a
leading "inspires / creates (a sense of)".

---

## The sport split — Lane B's basketball context (built, 23 Sep)

**The finding (Adi).** The athlete row is **soccer**, there are no sport tags anywhere in `media_assets.metadata`
(482 assets, none top-level, under `enrichment`, or in the vision block), and Lane B's recorded proposals were
built on "her requested sport: basketball".

**(1) The derivation.** `library.ts sportOf` = `namesSport(vision.description + " " + setting + " " + attire)`
— a word-boundary match against the `SPORT_NOUNS` allow-list over the tagger's free text; DERIVED, no key.
Counted by `majoritySport` over `herRows` = **the searched slice**: the k the prompt's sentence retrieved
(`LIBRARY_SEARCH_KS` 40, widened to 96/384 only while the her-room is short), never the whole library. Order:
her sentence names a sport → else that plurality → else `athletes.sport` → else null.

**(2) Why 50/50.** propose_campaign searches with `librarySentence(v)` — the objective's gloss — so its
top-40 is a different slice of the same 482 rows than a recap sentence's. That slice named soccer and
basketball in equal number; a recap sentence's slice is soccer-heavy. Same assets, two sentences, two slices.

**(3) The tie-break.** `majoritySport` is a plurality: "a tie goes to the first seen" — the search's rank, i.e.
arbitrary — and the assembly's warning compared **strictly above** one half, so an exact tie never warned.
Basketball ranked first; the row said soccer; nothing was logged.

**The fix (`server/studio/agent/library.ts`, shared Studio code — blast radius: every plan's sport, not only
propose).** `briefSport` now computes the plurality AND its split (`sportDisagreement(rows, plurality)`; 0.5 is
a tie) and takes the library only when the split is **under** one half — a majority, not a plurality. Otherwise
the athlete row decides (`source: "profile"`), or nothing is picked (`sport: null`, no demotion) — and either
way `logger.warn` says so (`agent library sport split …`). The boundary is one compare, `sportDisagrees(share)
= share >= 0.5`, used by both readers, so the assembly's own disagreement warning now fires at a tie too.
`BriefSport` carries `split`; the assembly log line carries `sportSplit`. 22 Sep's decision stands: more than
half still beats the row (P5b unchanged — 3 soccer : 1 basketball, split 0.25 → soccer/library).

**Tests.** `library.test.ts` (8): the tie defers to the row with basketball ranked FIRST (so a plurality would
have said basketball), the split the row cannot settle picks nothing, 3:2 is still a majority with nothing
logged, the boundary at exactly 0.5. `studio.agent.test.ts` **P5c** (route, PGlite): a 50/50 slice on a soccer
row → the prompt says `her sport for this plan: soccer` and BOTH warnings are on the log (`sport split` from
briefSport, `sport disagreement` from the assembly with `sportSource: profile, sportDisagreement: 0.5,
sportSplit: 0.5`). Pino is stood in for that suite (one array, whichever module registry made the logger —
the route loads library.ts dynamically). Gates: both tsc configs green; eslint 0 errors; prettier restored on
the two suites (clean before the edit); library 8/8, studio.agent 64/64, direction 91/91.

**Mutations, red by name (3/3, restored, clean re-run green):**

| # | Mutation | Red |
|---|---|---|
| SP-M1 | "sport tie silently resolves against row" — `briefSport` lets a plurality through | "a tie never resolves by search order…", "a split the row cannot settle picks nothing…", P5c |
| SP-M2a | "assembly proceeds on high disagreement without warning" — `sportDisagrees` strict (`>`) | those two + "at exactly one half — a tie — the share is a disagreement", P5c |
| SP-M2b | the same — the assembly's `logger.warn` call site skipped (`if (false)`) | P5c alone (the message-specific assertion) |

**Lane B re-run (23 Sep, after the restart, n=1, $0.0645, 39 s).** Prediction registered beforehand: the
prompt's sport line is **soccer**, no note or because names basketball as her sport, every Lane B bar holds.
**HELD**: 3 proposals, overlaps 0/0/0, feel 3/3 present + inferred, product null 3/3, claims 0, unflagged 0.
Proposal A is "raw, behind-the-scenes **soccer** training"; the model's own becauses read "She explicitly
requested her sport to be soccer in the prompt" and "Soccer is her requested sport". Basketball appears
once, as a crossover idea ("blurring the lines between soccer and basketball", on a10/a13 — the several-women
library's basketball photographs), never as her sport. `sportSource` for this request is on Adi's server log
line (`agent library assembled` / `sport split`), not on the wire.

---

## Lane D — research_moment (built; live cells pending a restart with the flag) + the trend stub

**Binding (Adi, 23 Sep):** `runGeminiOnce` with googleSearch, READ-ONLY — no `reserve()`, no touch of the
research team's `research_budget_days`; a Studio-side cost log line on every call; the date is always
null / hers, never model-supplied. D2 trend = the honest NOT_AVAILABLE stub, nothing simulated. Mutations
"moment writes to research ledger" and "trend returns fabricated data" red by name.

**What it is.** `server/studio/direction/moment.ts`: `{ask, brand?, date?}` → her sport from her row
(`namesSport`, read only) → the shared per-athlete `webSearchLimiter` (`allow` before, `record` after —
Mila's own window, in-process) → ONE `runGeminiOnce(query, MOMENT_SYSTEM)` (Flash + Google Search as a
tool; imported from `lib/research/providers/geminiGrounded` and nothing else from that lane) under
`withTimeout` → the reply read strictly (`readFound`: `found`, then title / summary / angle / feeling /
line / feel — `date` and `sources` are never looked at) → `proposalFromMoment`: `story` ← the title,
`creative_direction.tone` ← the feel, `extras.concept` ← {angle, feeling, line}, each **inferred** with a
because naming the PROVIDER's domains; `extras.moment` = {title, summary, sources ← the grounding chunks
(url/title/domain, ≤ 5), searchQueries, dateBasis}. **The date is hers or nobody's**: `date` in the body
becomes the one literal line — `extras.constraints.0 = "Timing: <her words>"`, quote = her words,
`dateBasis: "hers"` — and without it `dateBasis: "none"` plus a note; a date the model volunteers is never
read. Her ask rides between `<<<HER_ASK>>>` markers as data (a marker inside it is scrubbed). Cost = the
search's own **$0.035** (`MOMENT_SEARCH_USD`, copied from the research lane's `DEFAULT_COST_MODEL`
rather than imported) + Flash tokens via `costOf`, on a `research_moment cost` info line on EVERY call,
failed ones included — not yet counted against any Studio cap (card). Door: `POST
/studio/direction/research-moment`, behind **`STUDIO_DIRECTION_MOMENTS`** (new, default off) AND the
profiles flag: 404 off · 400 bad ask / unknown field · 429 over the window ("Nothing was spent") · 422
nothing current · 502 unreadable / failed. Prompt `research_moment/1`. Client: `researchMoment()`; the
reader accepts `extras.moment`. Runner: `server/scripts/studioDirectionMoment.ts` (prints a `stray date`
check: any ISO/slashed date anywhere in the proposal outside her own Timing line).

**D2 — the trend pillar.** `GET /studio/direction/trend` → `trendSignal()` → `{available: false, reason}`
and nothing else (`server/studio/direction/trend.ts`). Nothing in the schema or the integrations reads
trending audio or formats, and a search-costumed listicle is the model-only-research failure class, so the
pillar says so. Client `trendSignal()` never returns a proposal.

**The ledger, forbidden by name.** The tripwire's list gained
`/intelligence\/research\/(ledger|runResearch|researchAthlete|planner)$/` (pinned caught; the provider's
`geminiGrounded` pinned NOT caught). routes.test stands the ledger in and asserts `reserveLlmCall` is never
called AND `research_budget_days` has the same row count after the call; moment.test asserts the row count
on PGlite without any stand-in.

**Gates.** both tsc configs green; eslint 0 errors; prettier clean on the owned files (config.ts
hand-formatted); jest direction **117/117** (11 suites: moment 11 new, routes 32, tripwire 4, envelope 9,
client reader 9, …); the whole suite at 416a478 (before Lane D): 459 suites / 8793 tests / 1 red — the
affiliationSync house flake by name.

**Mutations (7, running as this is written — the table below is filled in when they land):**

| # | Mutation | Expected red |
|---|---|---|
| D-M1 | "moment writes to research ledger" — `reserveLlmCall` imported and awaited before the search | the tripwire's walk; routes.test "never touches the research ledger" (the stand-in's spy); moment.test (a real row lands in research_budget_days on PGlite) |
| D-M2 | "trend returns fabricated data" — `available: true` with a list | routes.test "the trend door says, honestly, that it is not available — and carries nothing else" |
| D-M3 | the model's `date` read into the Timing line when hers is absent | "a date is hers or nobody's" (the 2026-10-04 assertions), route + unit |
| D-M4 | the model's claimed `sources` cited instead of the provider's chunks | the fake.example assertions, route + unit |
| D-M5 | the limiter not consulted | "over the shared per-athlete window the door is a 429 and no search runs"; "over the window: refused, no call" |
| D-M6 | the flag ignored | "does not exist without its own flag"; "the flag off is a refusal before the row, the limiter or the search" |
| D-M7 | her ask sent unfenced | "fences her ask…" (the exact query); the route's marker regex |

**Live cells (23 Sep, through the route, after Adi's restart with the flag; 3 calls, $0.1067 — every
call $0.0356, i.e. the search's $0.035 plus ≈ $0.0006 of tokens).** First run came back 404 ×3 at $0: the
flag was missing from the restart (the trend door answered 200, so the code was current); one more restart.

| cell | run | valid | literal | unflagged | dateBasis | stray date | sources | queries | story |
|---|---|---|---|---|---|---|---|---|---|
| D1 | 1 | ✓ | 0 | 0 | none | **false** | **0** | 3 | FIFA Women's World Cup Final in Brazil |
| D1 | 2 | ✓ | 0 | 0 | none | **false** | **0** | 3 | NWSL Championship at Audi Field |
| D2 (`--date "Saturday 4 Oct"`) | 1 | ✓ | 1 (`extras.constraints.0`) | 0 | hers | **false** | 2 (nwslsoccer.com, justwomenssports.com) | 3 | 2026 NWSL Championship |

**Held:** valid 3/3; every line inferred except her own Timing line; unflagged 0; `dateBasis` none / hers as
predicted; **stray date false on all three** — the live proof the model never dates it; cost ≥ $0.035 on
each. **Missed:** "sources ≥ 1 on at least one of D1's two runs" — D1 cited **0 sources on both** (the
search ran: 3 web queries each; the provider returned no grounding chunks with the JSON answer), while D2
cited 2. So a cited answer came back on 1 of 3 runs. The tool reports it honestly ("Found by Google Search
via Gemini: 0 sources cited"; the because reads "no source named") and the moments themselves were real and
current — but a 0-source moment is a model claim, and the brief's rule is belief earned by verification.
Decision for Adi (not mine): (a) keep accepting, with Lane E rendering "0 sources — unverified" as an explicit
warning line on the confirm step; or (b) refuse `uncited` (422) when the provider names no chunk, at the
price of 2 of these 3 answers. Recommended: (a) — a refusal spends the search and gives nothing back, and
the epistemic status (every line inferred, 0 cited) is already on the wire.

One more honest note: D2's story is "2026 NWSL Championship" — a YEAR inside the event's name. The stray-date
scan looks for calendar dates (ISO / slashed); a year in a title is the event's name, not a schedule, and
`dateBasis` stayed "hers". Named here so the rule's edge is written down; tightening it (strip years from
titles) is a one-line change if Adi wants it.

`research_budget_days` after the three calls (Adi's query, 23 Sep): ONE row, `2026-09-13 | 225 | 0 | 0` —
the research team's own night; **no row for 2026-09-23**. The binding rule held on dev too; the unit test's
spy and the route's stand-in are the code-level witnesses.

---

## Lane E — the confirm screen on the real doors (built 23 Sep; device pass is Adi's)

**Decisions taken in (Adi, 23 Sep).** Sources (a) hardened: an unverified moment shows **"0 sources —
unverified"** as its own line AND reaches `toPriorContext` only through her explicit confirm tap, never by
default. Year-in-title: the invariant "no model-supplied timing signal passes, calendar date or year" is
now a strip on the server (Lane D follow-up, f558c0a) — the scan covers years and month-and-days, and what
was removed rides in `extras.moment.timingRemoved` for the confirm step to show. `brandNamesMatch` ported to
the client as a pure copy pinned to `shared/brandMatch.fixtures.ts` on BOTH sides. Header
`X-Studio-Reference-Asset-Id` consumed as-is.

**The two Adi reads first.**

*Control cell — flags off, byte-identical.* Every new block on the brief step sits behind
`pillarsFor({plansOntoBoard, moments})`, which returns **no doors and `readsBrief: false`** when
`STUDIO_AGENT && STUDIO_BRAND_PROFILES` is off — held by a test whose mutation ("draw a door with the flag
off") reds by name. The diff's removed lines are the dev-only echo door (`__DEV__ && PLANS_ONTO_BOARD`,
never drawn with the flag off), comments, and the three `onPick` calls that now also carry
`referenceAssetId: null` on a context the flags-off path hands to `SetupScreen`, which does not read it. The
upload door's flags-off stub is the same four lines. The trend fetch runs only when the trend door is drawn.

*Skip-unchanged.* `needsConfirm(p)` = any inferred line **or an unverified moment** (never skipped, whatever
its lines say). Every door lands through one `land(p)`: the confirm step when `needsConfirm`, else straight
on to the plan step. Held by "an unverified moment is never skipped; … a proposal with nothing inferred goes
straight on"; mutation "unverified moment skipped" reds by name.

**What it is.**

- **Four pillars on the brief step** (`BrandPostScreen.tsx` `BriefStep`, flags on): *Upload a brief* now
  READS it (`uploadBrief` → `summarizeBriefByPath` → confirm); *Find a moment* — an ask and an optional
  "when" of her own → `researchMoment` (drawn only with the client half `EXPO_PUBLIC_STUDIO_DIRECTION_MOMENTS`,
  the server's 404 the real gate); *A reference* — pasted words or a link to an image (`referenceSourceFor`)
  → `decomposeReference`, the stored row's id kept from the header; *Ask for ideas* → `proposeCampaign`,
  built on a confirmed moment when there is one (`toPriorContext(moment, {confirmed: true})` — the only
  call site that passes `confirmed`), then a `ProposalsStep` to pick one; *Trends* — a muted row carrying the
  server's own reason from `trendSignal()`, never a list. A photo from her library as a reference is a card
  (the picker mount). Objective for ideas is the brand flow's `showcase-product`.
- **A confirmed moment waits** as "Built on: …" with "Use this moment as the brief" beside the ideas door
  (which then reads "Ideas built on this moment").
- **ConfirmBriefStep**: a "What the search found" card — title, summary, the provider's sources by domain
  or the unverified line + "Confirm only if you know it is real", the timing the search supplied and the
  tool removed; "Your reference is saved with this brief" when a link was stored.
- **The plan step plans from her confirmed brief** (`brandCampaignBrief`: the proposal's brief IS the
  campaign; the step overlays only the product she picked there and the Board's 9:16 video output; a story
  or brand the proposal left empty falls back to the deal's). Its `extras.concept` is the picked idea
  (`id: "A"`), so the concept call is skipped unless she asks for new ideas (decision 3). Subtitle says
  "brief confirmed" / "reference saved".
- **Product mismatch** where both sides are known — the plan step's product photo: `useMediaDetail` reads
  its `vision.brands_visible`; `brandMismatch(brandsVisible, brandName)` (the rule's normalisation, deduped)
  → "This photo shows Nike — this post is for Adidas." The reference decomposition carries no brand field
  and the confirm step has no photo, so this is the one honest site for it.
- **`referenceAssetId`** rides `BriefContext` → the plan step; the plan body has no field for it (server:
  `AGENT_BODY_KEYS`), and a reference row is deliberately not castable, so it is kept and shown, not sent —
  card: "a stored reference on the plan row".

**Gates.** both tsc configs green; eslint 0 errors (0 warnings on the four UI/logic files); prettier on the
owned files and the previously-clean `BrandPlanStep.tsx`, `brandPlan.test.ts`, `flags.ts`
(`BrandPostScreen.tsx`, `brandLogic.ts`, `mediaSearch.test.ts` were unformatted on main — hand-formatted);
jest: direction 125/125 (client reader + logic 15), ConfirmBriefStep 7, brandPlan 15, mediaSearch 10.

**Mutations, red by name (8/8, restored, clean re-run green) — one honest note:**

| # | Mutation | Red |
|---|---|---|
| E-M1 | "unverified moment stacks without confirm" — the guard dropped from `toPriorContext` | "an unverified moment stacks only through her confirm tap, never by default…" |
| E-M2 | "unverified moment skipped" — `needsConfirm` without the unverified clause | **NOT red on the first run**: the moment fixture carried an inferred line, so both halves of the rule said "confirm" and the test could not tell them apart. Fixture added — an unverified moment with nothing inferred — and E-M2b reds: "an unverified moment is never skipped…" |
| E-M3 | a door drawn with the flags off | "flags off: no doors, and the upload door is today's stub…" (the control cell) |
| E-M4 | `brandMismatch` returns [] | "a product photo that shows another brand is said, not swallowed…" |
| E-M5 | a confirmed proposal dropped (`return assembled` always) | "her confirmed brief is the campaign — the step only overlays the product she picked here and the Board's output" |
| E-M6a | the client's brand rule drifts (threshold 3 → 2) | "agrees with shared/brandMatch.fixtures.ts — the table the server's copy is pinned to as well" |
| E-M6b | the server's brand rule drifts the same way | mediaSearch.test "agrees with the shared fixture table the client's copy is pinned to as well" |
| E-M7 | the unverified line hidden (the sources branch taken for an empty list) | ConfirmBriefStep.test "an unverified moment says so, in its own words, and still waits for every inferred line" |

**The upload door, by capability (Adi's walk, 23 Sep 12:28).** The first press on a laptop died at the
signed-url mint: `SigningError: Cannot sign data without client_email` — ADC on a laptop cannot sign; Cloud
Run's service account can. Adi's constraint: branch on capability, never replace the signed path. Built:
the mint (`routes/studio.ts`) answers **`501 {error: "signing_unavailable", fallback: "raw"}`** on a
`SigningError` (any other failure stays the 500 it was) and logs `brief upload path: signed-url` when it
serves; the raw route (`direction/routes.ts`) logs `brief upload path: raw-fallback` when it serves — one
greppable line per path. The client (`summarizeBriefPicked`): mint first → PUT → `summarize_brief` by
path; on 501 only, the raw route (the File on web, the uri streamed on device). Both hand `summarize_brief`
a path under `studio-briefs/<her id>/`, so the proposal and the confirm screen are identical either way;
`via` is returned for a caller's log and never shown. `uploadBrief()` (PR 6) keeps its behaviour, now built
from `pickBriefPdf` + `mintBriefUpload` + `putPickedBrief`. Held in `studio.agent.test`: signer present →
200 + the signed-url line; signer absent → 501 + the fallback line; another failure → 500. Mutation E-M8
"signer absent reported as 500" red by name. Deployed dev (Mia) exercises the signed path; a laptop
exercises the fallback; both are tested rather than assumed.

**Adi's walk, pass 2 (23 Sep 12:40, the simulated Jane Street campus brief, phone-width Chrome).** The read
itself was strong: brand, attributes, product, story, feel, deliverable, aspect ratio and platform all
**literal with real quotes** (each checked against the PDF); identity, style, kind of work and goal
**inferred with sound whys**; fidelity marked as the default it was. Three findings, all fixed in this PR:

1. **Constraints came through as four rows labelled 0–3, value "—", inferred "the quote is not in the
   document's text"** — although the four texts rendered verbatim in the card below. Two defects, one per
   side. *Server:* the model answers `constraints` as ONE list line under ONE quote, and `assembleProposal`
   gave the list one verdict — no single quote holds four sentences, so all four were downgraded together
   (the "constraints under one quote" nit from Lane A, biting). Now each constraint is verified on its own
   evidence: under the line's quote when it holds it, else as its own quote, literal only if the document
   contains it. *Client:* `confirmRows` read every path off the brief, so `extras.constraints.N` was a dash
   under a label that humanised "N"; now `valueFor` reads constraint and concept rows from the extras and
   `labelForRow` says which kind a constraint is — **"Do not"** or **"Requirement"** — by its own words. The
   duplicate card is gone; the rows carry the constraints, badged literal, needing no tap. **The verifier
   downgrading the system's own malformed rows to inferred was the defence working exactly as designed:**
   nothing unverifiable reached the screen as a fact, it reached it as a question.
2. **The tool's notes were never rendered**, nor the read-as-image lead — a thin read could not say why.
   Now a "What I noticed" card carries the notes (it showed the simulated-brief footer at once), and an
   `extraction: "unavailable"` switches the lead to the read-as-image wording.
3. **An unrelated PDF read as two defaults that looked like a thin brief.** The server now adds
   `NOT_A_BRIEF_NOTE` when the document contributed nothing: "Nothing in this document read as a brief —
   the lines below are the defaults, not a reading."

Mutations W-M1 (one verdict for the list), W-M2 (rows read off the brief), W-M3 (notes card dropped), W-M4
(the not-a-brief note dropped): red by name. Display-only, carded: deliverable / aspect ratio / platform quote
the same sentence thrice (group them); the 30–45 s length has no field in the brief. The gate on the
capability-branch commit: 461 suites / 8833 tests / 1 red — affiliationSync, the house flake, by name.

**Adi's walk, pass 3 (12:49) — the same brief, read as an image.** Same PDF, same door (the log: `brief upload
path: raw-fallback`), and this time `lib/pdfExtract` logged **"PDF text extraction failed — Command token too
long: 128"**; `corpusChars: 0`; the fail-closed path did its job (17 lines, 0 literal, 11 downgraded, the
read-as-image lead) — the VALUES matched pass 2, the badges did not. Not the model, not the door: the parser,
in a process that had already parsed two other PDFs. Offline probe ($0, `extractPdfTextDetailed`, fresh
process per row, five orders × 3):

| order | run 1 | run 2 | run 3 |
|---|---|---|---|
| parser-breaking → brief ×3 | PB ok · **brief EMPTY** · ok · ok | PB empty · ok ok ok | PB empty · ok ok ok |
| brief → parser-breaking → brief ×2 | ok · PB empty · ok ok | same | same |
| brief ×4 (does a clean document poison itself?) | ok ok ok ok | ok ok ok ok | ok ok ok ok |
| full fixture → brief ×2 | ok ok ok | ok ok ok | ok ok ok |
| brief → full → brief | ok ok ok | ok ok ok | ok ok ok |

**Read:** contamination REPRODUCES, but narrowly and transiently — the one failure was the brief parsed right
after the parser-breaking document had parsed *successfully* (1 of 9 next-parses after it), and the same
process read the brief fine on the very next call. A clean document never poisons itself (12/12) and a clean
fixture never poisons the brief (12/12). `pdf-parse 1.1.1` is also nondeterministic on the odd document by
itself (PB ok 1 of 3). Blast radius: a long-lived server does not go blind for good; a parse can fail right
after an odd document and recover on the next call — which is exactly the live sequence (the unrelated ICC
PDF, then the brief twice: text, then none).

**Decision (Adi): (b) + one retry.** Per-call isolation was refused as the complexity clause (a worker file
that must resolve under tsx in dev and the container in prod, plus timeout and error plumbing); the honest
degraded path ships, and the maintained-extractor swap (PR 10) isolates properly. In between, ONE retry at
the call site in `summarize.ts` — an empty or thrown first draw gets one second draw, then the fail-closed
path exactly as before — because the probe showed the failure is **transient, recovers on the next call,
and good documents never self-poison**. The retry logs one greppable line, `pdf extraction retried:
recovered | failed`, with both errors token-free, so PR 10's card accumulates live numbers instead of
anecdotes. Held by two cases (a throw and an empty first draw each recover to the text path with a
verified literal and a "recovered" line; two failures are the image path with a "failed" line; a clean
first draw never retries) and mutation R-M1 "extraction not retried", red by name. Adi re-uploads the Jane
Street brief as the retry's live re-verify.

**Adi's walk, pass 4 (13:02) — the plan step's ideas cut mid-word.** After the confirmed Jane Street brief
fed the concept step, "New ideas" came back with every angle sliced: "rapid-fire iterative repetition
(fits her 'fast paced' ask a". Two defects: the model wrote each angle as a title PLUS a justification, and
`studio/agent/concepts.ts` capped `angle` with a bare `slice(0, 60)`. **Model-filled fields need semantic
caps, not byte caps — bare `slice` on model text is a display bug waiting for realistic input.** Built:
`studio/text.ts` — `capWords` (cut at the last word before the cap; a head that ends exactly on a word
keeps it; trailing punctuation dropped; a quote cut this way is still a verbatim substring) and `capTitle`
(an over-long title first loses a trailing parenthetical, the justification, then `capWords`); the concept
prompt's angle line now says "a title of at most 60 characters, never a justification". One grep for bare
`slice` on model text in `studio/agent/**` and `studio/direction/**`, every display cap moved to the
helpers in the same commit: concepts (angle → title, feeling, line), cast (the edit note), entryPrompt (the
fits line), plan (beat, direction, search query), decompose (energy, notes, both becauses), moment (title,
summary, angle, feeling, line, source titles, timing removed, story, both becauses, notes, queries),
propose (both becauses), summarize (the quote, the because, each constraint). Left as bytes on purpose:
prompt fencing (`fenced`, `fencedDocument` — a corpus cut to a budget, and the quote check needs the
prefix), log truncation, ids and URLs, and the two refusing caps (`shortLine`, propose's `line`) that drop
an over-long value rather than cut it. Fixtures: the three live angles. Mutations T-M1 "angle cut mid-word"
and T-M2 "cap cuts mid-word" red by name; suites: text 6, concepts 10, cast 77, entryPrompt 11, plan 105,
direction 131.

### The brief → plan routing (Adi's ruling, 23 Sep 2026 — a deliberate product change)

**What the walk found.** "Plan this one" from the confirmed brief AUTO-RAN the planner and landed on the
Board as a shot list — PR 6's 6d "terminate in Board", working as built, with no steering point between her
concept pick and the spend. The hype board Adi screenshotted ("dramatic / gravity-defying / high-speed
action" against a brief that says *avoid hype*) came from the Board's own "or let the agent build this for
you" door: the PR 6 agent-door fallback sentence ("A video for Jane Street, with trading firm"), an EMPTY
feel, no brief — the known limitation, on a real brief.

**Fix 3 first — did the fenced CAMPAIGN block reach the planner on the brief-path ride?** Read from the
stored plan rows (his athlete only, SELECT, $0): plan `bcca2398` (13:16) **had the brief on its row** —
brand Jane Street, the story sentence verbatim, tone [understated, precise, quietly confident], style ugc,
goal announce — and the row's `brief` is the same variable the planner rendered `campaignBlock()` from. Its
reasons read in register ("the understated, UGC feel of the campaign", "iterative, methodical repetition").
No row exists for the agent-door ride (PR 6 stores best-effort). So **routing and inputs explain the hype
board; the planner is not the culprit** — Fixes 1–2 cover it; plan.ts's prompt is untouched except 4a.

**The ruling, recorded.** The brand flow becomes **brief → confirm → concepts → AGENT COMPOSE (pre-filled,
editable) → her Plan-it tap → planner → Board.** The Board is reached through the plan, never landed on
pre-assembled from this flow. **This supersedes 6d's terminate-in-Board for the brief path** (the manual
path — a deliverable or "skip" — still plans on the plan step and lands on the Board as 6d built it), and it
**moves the planner's spend behind her explicit tap** — ground rule 06. The agent door FROM the Board keeps
its behaviour: `inheritFromStoredPlan` / `inheritedBody` are untouched, `forBrand` stays true through
`BRAND_BOARD_OBJECTIVE`, `{fromPlanId}` still passes; the new `fromBrief` param is a sibling, and `carried`
is the union of both bodies.

**Fix 1 — routing + pre-fill.** `planStepAction(input)` = "compose" with a confirmed proposal, "board"
without; `briefHandoff(input, concept)` builds the hand-off; `BrandPlanStep`'s "Plan this one" navigates
to `StudioAgent { fromBrief }`. `AgentScreen` initialises prompt / purpose chip / feel / product rows from
it, shows a "FROM YOUR BRIEF · JANE STREET" card with the concept she picked, and its main CTA plans on her
tap when a concept is carried ("Or ask for other ideas first" beside it). **Two channels, never one:** the
visible fields are hers to edit; `briefBody(handoff, productCount)` rides the confirmed brief as `campaign`
(the photo handle dropped only when she removed every product photo — the inherited plan's own rule), the
brief file and the deal on every request, whatever she typed. Regression held: `briefHandoff` for the Jane
Street brief has a non-empty feel and no fallback sentence.

**Fix 2 — the composed ask.** `composeAskFromBrief(proposal, brand)`: *"A 9:16 video for Instagram, for
Jane Street — to announce campus internship program. Draw the parallel between athletic preparation and the
way Jane Street approaches problems — deliberately, iteratively, without theatrics. In her own footage
style, with her clearly in it."* Every phrase a confirmed line plus glue (a test walks every word of the ask
against the brief and a short glue list); constraints never enter the visible ask; the tone triple is the
feel verbatim; the goal is the purpose chip (one vocabulary). The claim lexicon holds over it: `claimHits`
finds nothing in the composed ask that the brief did not say, and still bites on a sentence it did not
("Built to keep you focused all season"). Not in the ask, on purpose: the 30–45 s length — the brief schema
has no field for it, so there is no confirmed line to trace it to (card).

**Fix 4a — brand-world B-roll.** Landed as the S half: doctrine rule 4 now says a "broll" scene may carry
the brand's world in the CAMPAIGN block's own words (its story, product line, brand attributes) when her
library holds nothing of it, and never invents a brand attribute the block does not state. The code half —
`claimHits` over every broll direction at parse time — is **carded, not landed**: `parsePlan` does not
receive the ask text, so the check needs a new `given.inputs` threaded from the plan route, plus moving
the lexicon out of `direction/propose.ts` to avoid a plan ↔ propose import cycle — three files, one of them
the shared route. Today's board is the evidence.

**Fix 4b — where "mention the program by name once" could live.** Recon: the video pipeline renders no text
by doctrine (rule 2: "never invent text, slogans, logos or overlays… she adds her own captions later"); the
one caption surface is the Board's caption line (video-captions, `stitchLogic` / `MadeItScreen`), typed by
her. **Card, precisely:** constraints display on the confirm screen but do not shape captions; the home is
a pre-filled caption suggestion on the Board from `extras.constraints` lines that say "mention" / "tag" /
"include" — PR 9 holds the Board's shared UI, so after both merge.

**Mutations, red by name:** P-M1b "brief dropped at compose hop", P-M2 "planner runs without her tap on the
brief path", P-M3b "compose falls back to the one-liner", P-M4b "the structured brief dropped whatever she
edits". Suites: directionLogic 19, brandPlan 18, agentLogic 35, plan 105, propose 14. One pre-existing lint
error in `MainTabNavigator.tsx` (`Couldn't open this deal`, `react/no-unescaped-entities`) sits next to the
one-line param edit — on main before this PR, not touched.

**Adi's re-walk on the new chain (23 Sep, evening) — the verdict.** Plan this one → compose arrived pre-filled
(the tone triple in the feel, the composed ask, no fallback sentence) → Plan it untouched → Board. **Register
FIXED:** shot 4 reads "clean, minimalist workspace… soft, precise desk lamp" — the tone triple's own words —
and there is zero hype vocabulary; the audio recommendation surfaced correctly. **The one gap:** B-roll took
the brief's *mood* but not the campaign block's named nouns — no puzzles, no math competitions, no campus
events — although rule 4 now says a broll scene may carry the brand's world in the block's own words. A
sharper sentence was on offer and **declined tonight, on purpose**: it is the same lever that just failed to
bite, and one re-plan at temperature cannot say whether a sharper line bit or the dice did (the register
call took three runs to trust) — a prompt sentence that cannot be asserted is the "unassertable request"
the codebase's own headers name. This board is the evidence for the code half (the card below), which can
be held against the Jane Street fixture: the block's nouns preferred for a broll's subject when the library
holds no brand material, and the lexicon over every broll direction.

**Adi's walk — the reference door (live, an Unsplash URL).** PASS on substance: fetched, stored as her
reference row, a 9-dimension decomposition rendered with per-line attribution, "9 observed, 0 inferred"
disclosed, the all-inferred-by-definition framing right. One display defect, in-PR: the **REFERENCES row
rendered "[object Object]"** — the structured reference (`[{ref, role, intent}]`) reached the row renderer,
whose object branch was the platform's `String(v)`: the morning's constraints index rows, one layer down.
Fixed centrally, not per row: `renderValue` now has a **structured-value guard** — a reference renders as
"style reference · read on 9 of 12 dimensions" (`describeReference`), any other object as its short scalar
fields, never `[object Object]`; a test sweeps every row of every fixture this suite holds (the echo, the
Jane Street brief, a moment, a reference) for the string. And the row is now **context, not a tap**: the
decomposition's lines above it (style, tone, energy) are the inference she confirms one by one; the
references row is their provenance, so it carries a CONTEXT badge, no Confirm pill, and `inferredPaths`
(the "nothing proceeds unconfirmed" rule) leaves it out — the door opens once the other inferred lines are
tapped. Mutations V-M1 "structured value rendered raw" and V-M2 "reference row demands a tap", red by name.

**"Are you 100 % sure the brief is sent AND used?" (Adi, 23 Sep, evening) — no, and the check found two
holes.** *Sent* was proven twice (the plan row's `brief` column is the variable the planner renders from;
`briefBody` is held to carry it on every request). *Used* was only half-proven, so `campaignBlock()` was
read line by line: it rendered objective, story, brand + attributes, her identity and sport, the product,
the feel, the references' ROLES, and the deliverable. Two things never reached the planner:

1. **The constraints.** The brief schema had no `constraints` field and nothing sent `extras.constraints`
   to the plan route — "no financial advice", "no competitor firms", "mention the program by name once"
   stopped at the confirm screen. Decision 3's second half ("constraints go INTO the brief with a
   campaignBlock line — a constraint the planner never sees isn't one") had not landed, and Fix 2's note
   that "the fenced block travels in full" was wrong about them. **Landed now:** `campaignBriefSchema`
   gains an optional `constraints` (≤ 6 × 120; every older brief still validates); the hand-off's campaign
   carries the confirmed lines (`brandCampaignBrief`'s overlay); `campaignBlock` renders a `constraints:`
   line, and its header says what they bind — a "do not" binds every item, a "mention / tag / include" is
   hers to add in her caption, named in `gaps` when no item can carry it.
2. **The reference's reading.** A confirmed decomposition reached the planner as its role word alone —
   `references: style_reference` — never the twelve dimensions she confirmed (the brief's style / tone /
   energy lines it filled did travel). **Landed now:** each reference with an intent renders one line —
   `ref_1 (style_reference) reads as — composition: …; lighting: …` — every dimension it was read on, in
   the reading's own sentence, fenced and capped.

Held: plan.test "constraints reach the planner…" and "a reference's reading reaches the planner…";
brief.test "constraints are lines of the brief…"; brandPlan.test's hand-off case gains the four lines.
Mutations K-M1 "constraints never reach the planner", K-M2 "reference reading not rendered", K-M3
"constraints dropped at the hop" — red by name. The confirm screen keeps reading constraints from
`extras.constraints`; the planner reads them from the brief; the same four lines, two readers.

**The last plan of the night (after the reach fix, the full block in front of the planner — constraints,
the reference's reading, the brand's attributes, the story).** Still **no B-roll about trading or Jane
Street.** So the prompt lever is now fully exhausted as evidence: rule 4's sentence, the block's own
nouns, the attributes, the constraints — all in front of the model — and its B-roll stayed with her
routine. The PR 10 card (the code half: the block's concrete nouns preferred for a broll's subject when
her library holds no brand material, the lexicon over every broll direction, both held against the Jane
Street fixture) has its third board as evidence. Ledgered, not fixed tonight — Adi's call.

**The first deploy after the push failed in step 1 (23 Sep, 21:50 UTC).** `scripts/db-migrate.sh` re-runs
`migrations/legacy/08_studio_generation.sql` on EVERY deploy, before the numbered files, and that file
DROPs and re-ADDs `media_assets_origin_check` — with the old four-value list. Dev already held a
`'reference'` row (the URL cell's), so the narrow re-add died with "check constraint … is violated by
some row", and 0062 never ran. The 0062 header's claim that "no file does a narrower re-add" was **wrong**:
the legacy step does, on every deploy, and the DDL-path recon (numbered list + schema.ts) missed the legacy
folder. Fixed: the legacy line lists `'reference'` with a comment naming the rule, and
`referenceOrigin.migration.test.ts` pins the legacy list to the schema's vocabulary AND replays step 1's
DROP + ADD on a PGlite that already holds a `'reference'` row. Lesson for the DDL memory: **widening a
CHECK means the legacy re-add too — three places in one commit, not two.** Ten other legacy CHECK re-adds
(deals, snapshots, agent_actions, athletes, roles, notifications, approval) are the same trap for anyone
widening them.

**Not done here, on purpose:** the iOS Simulator and phone-width Chrome pass is Adi's (this session has no
device); the live flow through every door needs the three flags on the client build
(`EXPO_PUBLIC_STUDIO_AGENT`, `EXPO_PUBLIC_STUDIO_BRAND_PROFILES`, `EXPO_PUBLIC_STUDIO_DIRECTION_MOMENTS`)
and on the server. Cards: a library photo as a reference (the picker mount on the brief step); a stored
reference on the plan row (a server field); an objective picker for "Ask for ideas" (fixed to the brand
flow's `showcase-product` today).

## Lane G — ig-token-refresh (diagnose-first; G1 in progress)

**The path.** Scheduler job `ig-token-refresh`, `0 3 1 */2 *` (`scripts/provision-schedulers.sh:69`) — the 1st of
every other month — posts to `POST /api/internal/ig-token-refresh` (`server/index.ts:444`) →
`refreshInstagramToken()` (`server/lib/igTokenRefresh.ts:77`): a Facebook `fb_exchange_token` on
`IG_PAGE_ACCESS_TOKEN`, then a new Secret Manager version of that secret. **Every failure is the same
`500 {"error":"Internal server error"}` (`index.ts:452-453`), which Scheduler shows as code 13.** The cause is
in one log line, `"IG token refresh failed" {error}`.

**From `gcloud scheduler jobs describe` (Adi, 23 Sep):** no `retryCount`, so Sep 1 was ONE attempt; last
attempt 2026-09-01T03:00Z, status 13; `userUpdateTime` Sep 4 (re-provisioned after the failure); next firing
Nov 1. The 30-day log read (`--limit=20`) was exhausted by the daily 04:30 TikTok/YouTube lazy refreshes before
reaching Sep 1; the one Instagram line — Sep 11 18:01 "Instagram token refreshed" — is `instagram.ts:191`'s
per-connection refresh, not the job. Two narrower reads requested.

**Candidate causes, each a distinct log message:** FB error 190 (token expired); `Secret Manager write HTTP 403`
(runtime SA can read secrets but not add versions); app mismatch — since `6190fd3` (19 Sep) dev's
`INSTAGRAM_APP_ID/SECRET` are the Meta TEST app's (`cloud-run-dev.yaml:108-117`) while `IG_PAGE_ACCESS_TOKEN`
is still the shared, un-suffixed secret (`:86-90`). That is after Sep 1, so not the Sep 1 cause, but it
guarantees Nov 1 fails too.

**Finding 1 — two tokens, do not conflate them.** The job refreshes the GLOBAL discovery page token
(`platformDiscovery.ts:11`, `collectDiscoveryAnalytics.ts:118`, `researchAthlete`). Her own posts use her
per-connection token in `connected_accounts`, refreshed lazily by `instagram.ts:191-210` only when a fetch
runs with ≤ 7 days left (`:620`, `:731`; daily via `collectSocialAnalytics.ts:82`). **Her reels unblock =
her reconnect (if lapsed) + the lazy refresh — not this job.** The approved read of her row's
`token_expires_at` is Adi's to run (psql is permission-denied for Claude in this session).

**Finding 2 — a cross-environment hazard (card, Mia-adjacent: deploy config).** Dev and prod both mount the
same secret — `gcp/cloud-run-dev.yaml:86-90` and `gcp/cloud-run-prod.yaml:137-141` both read
`IG_PAGE_ACCESS_TOKEN` `key: latest` — and both run the refresher (`provision-schedulers.sh:69`; the in-process
cron at `server/index.ts:1952`). A successful dev refresh writes the token prod reads. Exact change for Mia:
give dev its own `IG_PAGE_ACCESS_TOKEN_DEV` (as the `*_DEV` app secrets already are) or drop the job from dev.

**G2 (built 23 Sep, S).** `server/lib/igTokenRefresh.ts`: every failure is an `IgTokenRefreshError` with a
`kind` — `token_expired` (FB 190) → **424**, `secret_write_failed` (Secret Manager 4xx, or no GCP access
token) → **502**, `transient` (FB or Secret Manager 5xx / 429, a timeout, a network error) → **503**,
`misconfigured` (env missing; FB's OAuth family other than 190 — code 100/101, the app credentials; or the
token belonging to ANOTHER app than the one signing the exchange) → **500** — `statusForRefreshError` is the
one mapping the route (`index.ts`) and the in-process cron's log line use, with the kind and token-free
`detail` (`fbCode`, `httpStatus`, `step`, `tokenAppId` / `ourAppId`) on both. BEFORE the exchange, one FB
`debug_token` call logs the token's **state** per run — `isValid`, `expiresAt`, `dataAccessExpiresAt`,
`tokenAppId`, `type`, scope count, and `appMatches` against `INSTAGRAM_APP_ID` — never the token; a failed
debug is a warning and the exchange still runs. That `appMatches: false` line is Finding 3 made visible on
the next firing: dev's TEST app signing an exchange for the shared token comes back `misconfigured` naming
both app ids, not code 13. `igTokenRefresh.test.ts` (8): the happy path byte-identical (the base64 payload),
every kind and status, the mismatch line, missing env before any call, a failed debug never refusing, and
"the token itself never reaches a log line" on every level. Mutations: "expired token reported as
transient" (190 classified transient) and "the token logged" — see the table below once run. The Sep 1
cause itself is still unread (the two narrower log reads are Adi's); Nov 1 will name it.

---

## Closing (23 Sep 2026) — what shipped, what it cost, what is left

**The gate.** `npm test` bare, latest over the reach-fix commit (c884249): **462 suites / 8862 tests / 1 red —
affiliationSync, the house flake, by name**; over the renderer-guard commit (9a2f43e): the same one red; over the
routing-ruling commit (45757b9): 462 / 8856 / 0; over the semantic-caps commit (8d0d95e): 462 / 8849 / 1 red — affiliationSync, the house flake, by name; over the retry tree 461 / 8841 / 1 (the same); over the
walk fixes 461 / 8839 / 1 (the same); over the capability branch 461 / 8833 / 1 (the same); on the branch
before the walk (f6131a5, G2's suite collected): **461 suites / 8832 tests / 0 failed**. The run before it, at the Lane E tip: 460 / 8824 / 0. affiliationSync — the house flake,
red ~46 % of runs on main — happened to be green both times; the one earlier run that showed it red (at
416a478) named it alone. Two of the scoped runs during Lane E overlapped the first background pass; neither
pass showed a hook-timeout red, so nothing needed the one rerun the house rule allows.

**Spend against the $2.00 envelope: ≈ $0.88, by the routes' own estimates** (`X-Studio-Cost-Usd` from the
cost model — price-list estimates, never invoices; the Pro cell is the one that could be materially off).

| cell | calls | $ |
|---|---|---|
| Lane A, Flash (`summarize_brief/1`, three fixtures × 3) | 12 | 0.0245 |
| Lane A, Pro comparison (slower, worse, one 502) | 12 | 0.31 |
| Lane A, Flash after the bend (`/2`, 13/13 × 3) | 3 | 0.025 |
| Lane B, propose (Pro @ 0.6, n = 3) | 3 | 0.164 |
| Lane S, the stacking proof (n = 3) | 3 | 0.179 |
| Lane B re-run after the sport fix (n = 1) | 1 | 0.0645 |
| Lane C, text + image + URL | 5 | 0.0097 |
| Lane D, moment × 3 (each $0.035 search + tokens) | 3 | 0.1067 |
| spike, F, G, E | 0 | 0 |
| **total** | **42** | **≈ 0.88** |

**Lanes.**

| lane | what | live |
|---|---|---|
| spike | `BriefProposal` envelope, echo door, confirm step, tripwire | — |
| F | safeFetch DNS-rebinding pin + the three unguarded fetch sites | — |
| A | `summarize_brief` — PDF → proposal, code-verified literals, fail-closed extraction | 13/13 literal ×3 held |
| B | `propose_campaign` — objective + her library → 2–3 proposals, claims gated at the route | every bar held; re-run after the sport fix: soccer |
| S | stacking: a moment as prior context lands in 1–2 proposals per run | held |
| C | `decompose_reference` — text, her photo, a link (origin `'reference'`, 0062, excluded by every reader) | held on all three |
| D | `research_moment` — one grounded search, the date hers or nobody's, timing stripped; the trend stub | no-date rule 3/3; sources 1/3 (accepted, shown as unverified) |
| E | the brief step's four pillars, skip-unchanged, the confirm screen, the plan from her confirmed brief | Adi's device pass, before merge |
| G | G1 diagnose (three findings); G2: every refresh failure named, the token's state logged | Nov 1 |
| sport | `briefSport`: a plurality is not a majority; a split defers to the row and warns | Lane B re-run |

**The G findings, folded in.** (1) Two tokens: the scheduler job refreshes the GLOBAL discovery page token;
her own posts ride her per-connection token, refreshed lazily by `instagram.ts` with ≤ 7 days left — her
reels unblock by reconnect + that refresh, not by this job. (2) Dev and prod mount the same
`IG_PAGE_ACCESS_TOKEN` and both run the refresher: a dev refresh writes the token prod reads — Mia's card:
`IG_PAGE_ACCESS_TOKEN_DEV`, or drop the job from dev. (3) Since 19 Sep dev signs the exchange with the Meta
TEST app while the token is the shared one — Nov 1 will fail, and after G2 it fails as `misconfigured`
naming both app ids, not code 13. The Sep 1 cause is still unread (the two narrower log reads are Adi's).

**Decisions that hold the shape** (all Adi's, 22–23 Sep): shape C; every filled line flagged, literal only
when code can verify the quote; constraints ride into the brief; a picked proposal's concept IS the plan
call's concept; live-no-date for moments; the trend pillar says no rather than simulates; option (i) for the
reference marker; 0-source moments accepted and shown as unverified, stacking only through her tap; the
header stays; D → S → E → G2.

## Cards (not built)

- **Mila as a caller** — `campaign_brief_proposal` widget carrying `{proposalId, sourceTool, brandName, counts}`
  (no free text), a `studio_brief_proposals` table, a `MILA_DIRECTION` flag; PDF attachments in chat; multi-turn
  refinement ("make it moodier"); deeper orchestration beyond the B2/S proof.
- **Page scraping for a reference link** — the URL door takes a direct image only (a page is a 415 naming
  why); reading a lookbook page for its images is its own card.
- **A stored reference on the plan row** — the row's id rides `X-Studio-Reference-Asset-Id` and
  `BriefContext`; the plan body has no field for it and a reference row is deliberately not castable.
- **B-roll from the brand's world, in code (PR 10)** — `claimHits` over every "broll" direction at parse
  time, and the campaign block's concrete nouns preferred for a broll's SUBJECT when her library holds no
  brand material — both testable against the Jane Street fixture (puzzles, math competitions, campus
  events). Needs `given.inputs` threaded from the plan route and the lexicon moved out of
  `direction/propose.ts` (a plan ↔ propose import cycle otherwise). Evidence: the 23 Sep boards — the hype
  one before the routing fix, and the in-register one after it whose B-roll still carried mood, not nouns.
  The prompt lever alone was tried (rule 4's line) and did not bite; a third board, planned with the
  FULL block in front of the model (constraints, the reference's reading, the attributes), still carried no
  trading or Jane Street B-roll — the prompt lever is exhausted as evidence; this is a code change.
- **Board caption suggestions (PR 10, Adi)** — seeded from the brief's constraint lines ("mention the
  campus internship program by name once", "tag @janestreet…") and the picked concept's line,
  grounding-checked like all copy. The same mechanism gives a constraint its home: today constraints
  display on the confirm screen but do not shape captions, and the pipeline renders no text by doctrine.
  After PR 9 (it holds the Board's shared UI).
- **The deliverable's length** — the brief schema has no field for "30–45 s", so the composed ask cannot
  carry it; a `output.length_seconds` range is a schema decision.
- **A library photo as a reference** — the picker mount on the brief step (text and links ship in E).
- **An objective picker for "Ask for ideas"** — fixed to the brand flow's `showcase-product` today.
- **Verified moment dates** — needs safeFetch of source pages; the date stays hers until then.
- **Real trend signal** — trend v0 = her own top-performing posts' formats/audio from the IG integration, the
  day G lands + Mia's lane call on reading performance data.
- **Moment-search into the Studio daily-cap framework** (Lane D logs its cost; it does not count yet).
- **Widen the sport count** — `briefSport` counts the searched slice; counting every tagged row of hers (one
  SELECT) would make two sentences agree. A derive-at-enrichment question (Adi), not a tie-rule rider.
- **Original-ask-words column** (future migration).
- **Replace pdf-parse** (PR 10, upgraded 23 Sep) — observed LIVE on the first realistic brief (pass 3 of Adi's
  walk: "Command token too long", corpus 0, every line inferred). Long-lived-process contamination confirmed
  offline: 1 of 9 next-parses after a parser-breaking document failed, recovered on the following call; a
  clean document never poisons itself (12/12). 1.1.1 is also nondeterministic on odd documents alone. The
  fail-closed path holds the line until the swap; the maintained extractor should isolate per call.
- **`getBrandContext`** — unscoped and numeric-id-only; a `brand.profile` handle resolves to nothing today.
- **IG token conflation** (Finding 1), **the shared `IG_PAGE_ACCESS_TOKEN`** (Finding 2) and **dev's TEST app
  signing for the shared token** (Finding 3) — Mia's, deploy config.
- **Nits** — constraints under one quote; energy as a whole clause; first-person concept lines.
- **PR 9 rebase** — it owns the Board row button + photo mode and `server/studio/edit/**`; this PR owns the
  brand-flow screens and `server/studio/direction/**`; whichever merges second rebases (one trivial hunk
  in `db-migrate.sh`'s echo text).
- **Deep-link params for `StudioBrandPost`** — only if a Mila shape ever lands.

## Spend

Commit 0: $0. Commit 1: $0. Envelope $2.00 (Adi, 23 Sep). Spent so far ≈ $0.78 (A $0.025×3 + Pro A cell, B $0.164, S $0.179, B re-run $0.0645, C text + image $0.008). URL cell $0.0017. Lane D cells $0.1067 (3 × $0.0356). Total ≈ $0.89 of $2.00.
