# Voice model retirement — what Mila's live voice runs on, when it stops, and what replaces it

Status: **read-only investigation, nothing changed, no provider calls made.** Sources accessed 2026-09-27.
Scope: the LiveKit voice worker (`nomila-co/mila-voice`, clone at `C:\ClaudeProjects\mila-voice`, `main` @ `eedd988`) and the backend routes it calls (`server/voice/`).

## What the athlete experiences, and what happens underneath

When an athlete taps the voice button inside Ask Mila, the app opens a LiveKit room and a worker on LiveKit Cloud joins as Mila. Everything Mila hears and says goes through **one Google speech-to-speech model** (Gemini Live) — it listens, decides when the athlete has stopped talking, calls Nomila's tools (deals, score, drafts…), and speaks back. If Google turns that model off, the voice button connects and then Mila never speaks.

**Headline correction to the audit:** the model the worker uses, `gemini-live-2.5-flash-native-audio` on **Vertex AI**, retires on **13 December 2026**, not 16 October 2026. The October date belongs to the *text* Gemini 2.5 models (and is now 20 October 2026 on Vertex). We have ~11 weeks, not ~3. Google's named path is **`gemini-3.8-live`** (GA on Vertex since 24 Sep 2026). But the LiveKit plugin we pin **cannot** run 3.8 on Vertex today, and even the newest plugin (1.9.1) refuses it — so the swap is not a one-line config change.

---

## 1. Voice requirements as actually implemented

| Requirement | As implemented | Where |
|---|---|---|
| Model | `gemini-live-2.5-flash-native-audio`, **hard-coded** (no env override) | `mila-voice/src/agent.ts:1306-1316` |
| Endpoint | **Vertex AI** (`vertexai: true`; project/location from `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`, plugin default `us-central1`). Comment: without it the plugin sends `id` on FunctionResponse, "which Vertex rejects" | `agent.ts:1308-1312` |
| Alternate model | xAI `grok-voice-fast-1.0` behind `MILA_VOICE_XAI=1` (+ `XAI_API_KEY`, fatal boot check). Same persona and tools; own VAD tuning | `agent.ts:1000-1303`, `.env.example`, `main.ts:38-44` |
| Architecture | Pure realtime (speech-to-speech). **No STT/TTS/turn-detector in the session**; commented-out cascaded fallback (`deepgram/nova-3` → LLM → `cartesia/sonic-3` + LiveKit TurnDetector) is documented in place | `main.ts:103-112` |
| LiveKit packages | `@livekit/agents` **1.6.2**, `@livekit/agents-plugin-google` **1.6.2**, `-openai` 1.6.2, `-xai` 1.6.2 (exact pins), `@google/genai` 2.15.0 (lockfile), `@livekit/plugins-ai-coustics` 0.2.15. **Three local pnpm patches** on agents / google / openai 1.6.2 (echo + self-interrupt fixes) | `package.json`, `pnpm-lock.yaml`, `patches/` |
| Voice | `Puck` (Gemini); Grok voice separately configured | `agent.ts:1313` |
| Sampling | `temperature: 0.8` | `agent.ts:1314` |
| Turn detection | Gemini server-side automatic activity detection: `startOfSpeechSensitivity: START_SENSITIVITY_LOW`, `prefixPaddingMs: 300` | `REALTIME_INPUT_CONFIG`, `agent.ts:129-140` |
| Barge-in / interruption | `activityHandling: NO_INTERRUPTION` — barge-in is **deferred, not disabled** (athlete audio is still captured/transcribed). Chosen to stop Mila interrupting herself via speaker echo. Framework interruption (`interruption.enabled:false`) deliberately rejected | `agent.ts:79-127` |
| Noise | ai-coustics `quailVfS` enhancement on input | `main.ts:147-151` |
| Transcription | Plugin defaults: input + output transcription **on** (`{}`); each completed turn is written to the Ask Mila thread (`source='voice'`), de-duplicated by item id | plugin `realtime_api.ts:337-340`; `main.ts:130-135`, `memory.ts` |
| Language | **Not set** — model auto-detects. Prompt is English | — |
| Session length | No `contextWindowCompression` configured. Plugin enables `sessionResumption` and restarts on `goAway` (non-seamless per plugin TODO). Vertex doc: audio sessions end at ~15 min without compression; connections live ~10 min. `scripts/long-call.ts` exists to find the ceiling (observed +~190 prompt tokens/exchange from 1,068) | plugin `realtime_api.ts:1524, 1914-1918`; `scripts/long-call.ts` |
| Token/join limits | LiveKit token TTL **15 min**; client agent-join timeout **30 s** (covers LiveKit Cloud scale-to-zero cold start) | `server/voice/webTokenRoute.ts:139`; `client/components/mila/voiceSession.ts:149`, `.web.ts:134` |
| Greeting | `session.generateReply(...)` at join (onboarding step line or a one-line hi) — needs a model that accepts mid-session replies | `main.ts:162-170` |
| Seeded memory | One assistant-role line in the initial `chatCtx` (prefill) | `agent.ts` `createAgent`, `memory.ts` |
| Tool budget | Every tool wrapped: max **12 calls per turn** (after a 108-call storm) | `turnBudget.ts:48`, `agent.ts:1164` |
| Tool behaviour | All tools **blocking** (async brand-brief was removed because the plugin's `autoToolReplyGeneration` double-delivered answers) | `agent.ts:1354-1358` |
| Cost tracking | **None in production.** Only `scripts/long-call.ts` reads `MetricsCollected` token counts | grep of `src/`, `scripts/` |
| Deployed config | `livekit.toml`: project `nomila-qi7makh2`, agent `CA_XhcYeRfk9T3C`; built from `Dockerfile` via `lk agent create/deploy`. No CI workflows in repo. Secrets live in LiveKit Cloud | `livekit.toml`, `Dockerfile` |

**Which model is live?** From code: Gemini `gemini-live-2.5-flash-native-audio` on Vertex, unless the LiveKit Cloud secrets set `MILA_VOICE_XAI=1` (then Grok). **UNVERIFIED** which is set: `lk agent secrets` could not run (no LiveKit project configured on this machine). Check with `lk agent secrets` / the boot line `[mila.main] MILA_VOICE_XAI is on`.

### Tools the voice agent exposes (`agent.ts:1372-1750`)

Always registered: `get_score` (also pushes the score card), `open_draft` (draft/revise a reply; pushes a card), `get_athlete_profile`, `list_deals` (first ~10), `get_deal_brief` (brand/campaign → deal + brand + fit; `notCached` on miss), `get_thread` (brand emails, wrapped as external content), `get_score_history`, `get_share_signals`.
Conditional: `web_search` (only if `MILA_VOICE_WEB_SEARCH=true`; the env comment notes Gemini announced before calling only 2/8 times, so it is "a Grok-path capability"), `complete_onboarding_step` (onboarding sessions only).
Exported but not registered: `get_deal`, `get_brand_brief`.
Backend: `server/voice/*Route.ts` (score, deals, deal brief, threads, profile, onboarding, seed, transcript, web search, share signals, token).

---

## 2. Provider facts (verified from docs, accessed 2026-09-27)

### 2a. Retirement of the model we use

| Fact | Value | Source |
|---|---|---|
| `gemini-live-2.5-flash-native-audio` (Vertex) | Launch stage **GA**, released **December 12, 2025**, **"Retirement date: December 13, 2026"** | https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api |
| Same, lifecycle table | "gemini-live-2.5-flash-native-audio — December 12, 2025 — December 13, 2026" (replacement column **empty**). Page adds: "retirement timelines may be extended, they won't be moved to an earlier date" | https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions |
| Where the "Oct 16" came from | Not found on current pages. Vertex now lists **`gemini-2.5-flash` / `-pro` / `-flash-lite` retiring October 20, 2026** — text models, not Live. Treat Oct 16 as stale | same lifecycle page |
| Gemini API (not our endpoint) | `gemini-2.5-flash-native-audio-preview-12-2025`: "No shutdown date announced", replacement `gemini-3.8-live` | https://ai.google.dev/gemini-api/docs/deprecations |

### 2b. The replacement Google names: `gemini-3.8-live`

Google publishes a Vertex migration guide *from* `gemini-live-2.5-flash-native-audio` *to* `gemini-3.8-live`, and lists it first as "Recommended" on the Live API overview.

| Property | Vertex AI (our endpoint) | Gemini API |
|---|---|---|
| Status | **GA**, released **September 24, 2026**; regions: multi-region `us`, `eu`, `us-central1` | **Stable**, released Sep 15, 2026, no shutdown date |
| Native audio in/out | Yes (16 kHz PCM in, 24 kHz out) | Yes |
| Function calling | Supported. **Async NON_BLOCKING is the default**; `behavior=BLOCKING` supported and **auto-cancelled if the user speaks**; `scheduling=INTERRUPT` downgraded to WHEN_IDLE while the user speaks | Same (NON_BLOCKING default) |
| FunctionResponse `id` | **"Every FunctionResponse turn must supply the exact id"** — the opposite of what our plugin does on Vertex | — |
| Affective dialog | "Always enabled by default"; do not pass `enable_affective_dialog` | "**removed from the API**" (docs disagree across endpoints) |
| Proactive audio | Always on; do not pass `proactivity` | Permanently on; `proactive_audio:false` errors |
| Thinking | Not supported | "Supported (interleaved reasoning)"; `thinking_level` not supported |
| History seeding | Requires `HistoryConfig(initial_history_in_client_content=True)` | `send_client_content` supported all session |
| New | `custom_vocabulary` for transcription biasing; live avatar video | — |
| Context | 128K in / 64K out | 131,072 / 65,536 |
| Session limits (Live API, Vertex) | Audio-only session 15 min without context-window compression; connection ~10 min; `goAway` 60 s before; resumption within ~10 min window (24 h stated elsewhere on the page); 1,000 concurrent sessions/project PayGo | — |
| Known 3.8 behaviour | "Sometimes makes redundant back-to-back function calls … sweeping two to five times" when a tool returns empty/uninformative results; requires `status`/`retryable`/`message` in tool results and a prompt cap of two consecutive calls | — |
| Pricing (/1M tokens) | text in $0.75, audio in $3.00, image/video in $1.00, text out $4.50, **audio out $12.00** | same, "or $0.005/min (audio in)", "$0.018/min (audio out)" |

Sources:
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-live
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-live
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/migrate-from-gemini-2-5-to-gemini-3-8-live
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session
- https://cloud.google.com/vertex-ai/generative-ai/pricing
- https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live
- https://ai.google.dev/gemini-api/docs/pricing

Comparison — current 2.5 Live on Vertex: text in $0.50, audio in $3.00, text out $2.00, audio out $12.00 (same audio prices). Vertex billing note: "Tokens from past turns are re-processed and billed in every new turn"; audio = 25 tokens/second. So audio-only list price ≈ **$0.0045/min listening + $0.018/min speaking**, plus re-billed context that grows each turn.

Google's own migration guide on LiveKit: "LiveKit's Google plugin RealtimeModel supports Gemini 3.8 Live, but … thinking_level, enable_affective_dialog, proactivity [are] not supported … use extra caution … it requires careful adaptation."

### 2c. Fallbacks only

1. **xAI Grok Voice — already built.** `MILA_VOICE_XAI=1` swaps in `grok-voice-fast-1.0` with the same tools; no code change. xAI's current page lists "grok-voice-think-fast-2.0 … $0.08 / min ($4.80 / hr)" plus "$0.004 / text input" (https://docs.x.ai/docs/models). Price and lifecycle of `grok-voice-fast-1.0` specifically: **UNVERIFIED**.
2. **OpenAI Realtime** (plugin already installed): `gpt-realtime-*` audio in $32 / cached $0.40 / out $64 per 1M; `gpt-realtime-2.1-mini` $10 / $0.30 / $20 (https://developers.openai.com/api/docs/pricing). At 25 tok/s-equivalent that is several times Gemini's price. Not wired as a Mila path.
3. **Cascaded STT → LLM → TTS via LiveKit Inference** (commented template in `main.ts`): provider-independent, keeps LiveKit turn detector and framework barge-in, higher latency. Pricing per component **UNVERIFIED** (not researched).

---

## 3. Can our pinned plugin run the replacement? What would the swap take?

**Pinned 1.6.2 — no.** Its `LiveAPIModels` list has no `gemini-3.8-live`. Its only 3.x handling is `model.includes('3.1')`, so `gemini-3.8-live` would be treated as a 2.5-style model: plain `clientContent` prefill (the 3.x servers close the socket on that — see the plugin's own `live_setup.ts`), a `"."` placeholder user turn on `generateReply` (3.x answers it with an empty turn), and no `id` on FunctionResponse under Vertex.

**Latest 1.9.1 (published 2026-09-26) — only via the Gemini API, not Vertex.**
- Adds `gemini-3.8-live` / `-extended-thinking` (agents-js PR #2503, merged 2026-09-15), skips the placeholder for 3.1/3.8, uses role `model` for instructions.
- But `KNOWN_GEMINI_API_MODELS` contains `gemini-3.8-live` and `validateModelAPIMatch()` **throws** `"Model 'gemini-3.8-live' is a Gemini API model, but vertexai=true"`. The Python fix (livekit/agents PR #7510, "allow gemini-3.8-live with vertexai=True") is **open**; no JS equivalent found.
- 1.9.1 still omits FunctionResponse `id` when `vertexai` is true — conflicts with 3.8's "must supply the exact id".
- Open agents-js PRs directly on 3.8: #2528 (default NON_BLOCKING tools), #2594 (NON_BLOCKING result never delivered because 3.8 keeps talking — "we hit this on a voice agent in production"), #2507 (goAway ~1 s into a 3.8 session cut the opening reply; resumption on 3.8 lost prefilled context 2 of 3 runs).
- Our google patch (`isNewGeneration` ignoring empty transcriptions) is **not** upstream in 1.9.1; all three patches must be rebased on a 1.6.2 → 1.9.x bump of agents + google + openai + xai (they are version-locked together).

**So the change is code, not config:**
1. Bump the four `@livekit/*` packages to ≥1.9.1 and rebase the three patches (the Dockerfile's pnpm-11 patch install must still pass).
2. Choose the endpoint:
   - **Gemini API** (works on 1.9.1 today): `vertexai: false`, `GOOGLE_API_KEY` as a LiveKit Cloud secret, paid tier. Moves spend and data terms from GCP to AI Studio billing.
   - **Vertex** (keeps current GCP auth/billing): needs a local patch to the plugin validator + FunctionResponse `id` (or wait for an upstream JS port of #7510) — then test.
3. Change `model` in `milaRealtimeModel()` (ideally make it env-overridable so a rollback is a secret flip, like `MILA_VOICE_XAI`), update `voiceModel.test.ts:150-153` and `brandBrief.test.ts:410-411`.
4. Re-tune: `REALTIME_INPUT_CONFIG` (echo/VAD dials were measured on 2.5), keep all tools BLOCKING explicitly (3.8 defaults to NON_BLOCKING), and give `get_deal_brief` `notCached` / empty results the `status`+`retryable:false`+`message` shape Google now requires; add Google's "no more than two consecutive calls without speaking" line to the prompt (our cap is 12).
5. Verify `generateReply` greeting and the seeded assistant-line prefill still work; drop nothing about `enableAffectiveDialog`/`proactivity` (we never set them). Note proactive audio is now always on — it may *help* the echo problem or may make Mila stay silent on off-axis speech; test it.

---

## 4. Empirical test plan (NOT executed — requires founder approval before any spend)

**Arms.** A = current `gemini-live-2.5-flash-native-audio` on Vertex (baseline). B = `gemini-3.8-live` on the Gemini API (plugin 1.9.1 + rebased patches). Optional C = Grok via `MILA_VOICE_XAI=1` (fallback readiness). Optional B′ = 3.8 on Vertex once patched.

**Where.** A local worker with `MILA_VOICE_AGENT_NAME=mila-voice-test` (so the cloud worker is untouched), against dev backend, on a **test athlete** account with seeded deals — not Mia's live data. Scripted sessions driven by `scripts/long-call.ts`-style harness (text/recorded-audio input) plus a small number of real-device calls on speaker.

| Requirement | How measured | Pass bar |
|---|---|---|
| Time to first audio (TTFA) | Metrics timestamps: end-of-user-speech → first audio frame; also join → greeting | 3.8 median ≤ 2.5 median; p90 < 1.5 s |
| Barge-in / self-interrupt | Real device on speaker: 10 scripted interruptions + 10 no-interrupt long answers; count spurious restarts and missed barge-ins | 0 self-restarts; ≥ 9/10 barge-ins honoured (deferred OK) |
| Tool-call correctness | 20-prompt script covering all 8 always-on tools + onboarding tool: right tool, right args, no name-variant sweeping on `notCached`, ≤ 2 consecutive calls, result actually spoken | ≥ 95% correct; 0 sweeps; 0 lost results |
| Greeting + memory seed | 5 sessions each with and without a seed / onboarding step | greeting spoken 100%; seed referenced when relevant |
| Session length | 2 × 30-min `long-call.ts` runs per arm; record where the session ends, goAway handling, context retained after resumption | survives ≥ 30 min or ends with a clean, logged restart that keeps context |
| Audio quality / persona | Blind A/B of 10 paired clips rated by founder (naturalness, warmth, pacing, pronunciation of brand names) | 3.8 ≥ 2.5 |
| Transcript fidelity | Compare written thread turns vs script; test `custom_vocabulary` with brand names | WER not worse than baseline |
| Cost per minute | Sum `usage_metadata` tokens by modality per session × list price | report $/min at p50/p90 |

**Volume.** Per arm: 30 scripted sessions × ~6 min = 180 min, + 2 long calls × 30 min = 60 min → **240 min per arm**. A + B = 480 min; + C = 720 min.

**Estimated cost (list prices above).** Audio alone ≈ $0.0045/min in + $0.018/min out → ~$0.013/min at 40 % Mila talk-time. Re-billed context (≈1–4K tokens per turn, ~3 turns/min, billed at up to $3/M) and tool-result text add ~$0.01–0.04/min. Budget a conservative **$0.10/min** ceiling:
- Arms A + B: 480 min × $0.10 ≈ **$48**, realistic ≈ $15–25.
- + Grok arm C: 240 min × $0.08 (xAI's listed think-fast-2.0 rate; fast-1.0 UNVERIFIED) ≈ **$19**.
- Backend Gemini calls triggered by tools (brand narration/fit fills): small, UNVERIFIED — cap included below.
- **Proposed hard cap: $100 total**, enforced by a GCP budget alert on the project and an AI Studio key with a spend limit; stop at the cap.

**Approval gate.** No session is started, no key created, no dependency bumped until the founder approves this plan and the cap. Sequencing: approve → bump + patch rebase in a worktree (no spend) → arm A/B runs → decision memo → deploy with an env-switchable model id and Grok flag as the rollback.

## Timeline

- Hard deadline: **2026-12-13** (Vertex retirement of `gemini-live-2.5-flash-native-audio`).
- Suggested: test plan approved by mid-October; 3.8 path chosen and deployed by **mid-November**, leaving ~4 weeks of live running before the cut-off. Re-check the Vertex lifecycle page and livekit/agents-js releases (Vertex validator fix) before starting.
