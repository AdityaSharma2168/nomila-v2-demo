// Two Kimi endpoints:
// - Vertex AI (K2 Thinking): kimiInstant, kimiThinking, kimiStream — covered by GCP credits
// - Moonshot direct (K2.6): kimiSearch only — needed for $web_search, not available on Vertex
// When K2.6 + $web_search lands on Vertex, flip kimiSearch to use getVertexClient() too.
import OpenAI from "openai";
import { GoogleAuth } from "google-auth-library";
import { withTimeout } from "./withTimeout";
import { KIMI } from "./models";
import { kimiGate, moonshotGate } from "./llm";
import { observeOpenAI } from "@langfuse/openai";
import { tracingEnabled } from "./tracing";

/**
 * Both clients go through here, which is the whole reason the gate and the tracer live at
 * this layer: every Kimi caller in the codebase is covered without touching one of them.
 *
 * Wrapping the CLIENT rather than each call means `kimiStream` is traced too — including
 * time-to-first-token, which is the number that matters for the one user-facing path here
 * and the one thing a per-call wrapper around the non-streaming helpers would have missed.
 *
 * Returns the client untouched when tracing is off, so the disabled path costs nothing and
 * behaves identically. The Vertex client is rebuilt on every token refresh, so this runs
 * often — it is a cheap wrapper, not a connection.
 *
 * ⚠️  THESE SPANS NEED A ROOT. Verified against the live project: `observeOpenAI` emits a
 * span that expects a parent, and Langfuse v4 drops it when there is none — the export
 * succeeds and nothing is ingested. Inside a `startActiveObservation` it lands correctly.
 * The Gemini path in lib/models.ts does not have this problem because `startObservation`
 * marks itself as the app root when no parent exists.
 *
 * The roots now exist — `traceUnit()` in lib/tracing.ts, applied at detectDeal (one trace per
 * inbound message, with classify, summarize and score beneath it) and narrateKit. But the
 * CONSTRAINT has not gone away, so it stays written down: any new path that calls Kimi from
 * outside an active observation produces spans that are exported and then silently dropped.
 * If a Kimi call is missing from Langfuse, look for the missing root before suspecting this
 * wrapper. See docs/plans/phase-1-observability.md §4.
 */
function traced(client: OpenAI, route: "vertex" | "moonshot"): OpenAI {
  if (!tracingEnabled()) return client;
  // NAME THE SPAN. Without generationName the wrapper labels every span "OpenAI.chat", after
  // the SDK method — which is actively misleading here, because no OpenAI model is ever called
  // and no data goes to OpenAI. The openai package is a client LIBRARY, and both Vertex MaaS
  // and Moonshot expose OpenAI-COMPATIBLE endpoints, so it is the correct client to point at
  // them. A trace that has to be explained is a trace nobody reads, and these are meant to be
  // read by the founder — so the span names the Kimi route that actually served the call.
  return observeOpenAI(client, {
    generationName: route === "vertex" ? "kimi.vertex-maas" : "kimi.moonshot",
  }) as unknown as OpenAI;
}

// Deal-path calls (classify/summarize/score) are "instant" JSON — >~30s is pathological
// and a hung call holds a DB connection + batch slot, so fail fast to avoid pool exhaustion.
// Creative generation (kimiThinking) legitimately runs longer, so it gets a higher ceiling.
const KIMI_INSTANT_TIMEOUT_MS  = Number(process.env.KIMI_INSTANT_TIMEOUT_MS  ?? 30_000);
const KIMI_THINKING_TIMEOUT_MS = Number(process.env.KIMI_THINKING_TIMEOUT_MS ?? 60_000);
// Document extraction reads tens of thousands of characters and reasons over them. 60s was
// too tight for a 23-page contract, and a timeout here is worse than slow: the caller cannot
// tell "the model died" from "the document says nothing".
const KIMI_EXTRACT_TIMEOUT_MS  = Number(process.env.KIMI_EXTRACT_TIMEOUT_MS  ?? 180_000);

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? "gamechanger-pocket-agent";

// ─── Vertex AI client (K2 Thinking — covered by GCP credits) ────────────────
// Uses Application Default Credentials: service account on Cloud Run, or
// `gcloud auth application-default login` for local dev.
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
let vertexToken = "";
let vertexTokenExpiry = 0;

async function getVertexClient(): Promise<OpenAI> {
  if (Date.now() > vertexTokenExpiry - 300_000) {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    vertexToken = token!;
    // Trust the credential's REAL expiry, don't assume ~55 min. google-auth's
    // getAccessToken() can return a still-cached token with only a few minutes of
    // life left; hardcoding `now + 3_300_000` meant that for stretches of each cycle
    // we kept sending an already-expired token → intermittent Vertex 401s that broke
    // classification (kimiInstant) AND draft generation (kimiStream) app-wide.
    // The refresh check above re-runs 5 min before this real expiry.
    const expiryDate = (client as any).credentials?.expiry_date as number | undefined;
    vertexTokenExpiry = expiryDate ?? (Date.now() + 3_300_000);
  }
  return traced(new OpenAI({
    apiKey: vertexToken,
    baseURL: `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/global/endpoints/openapi`,
  }), "vertex");
}

// Model id now lives in lib/models.ts (fleet-wide registry). The Vertex-vs-Moonshot
// client strategy — whether this workhorse should stay on Vertex MaaS or move to the
// Moonshot API for a newer K2.x — is still open and lives in this file's clients below.
const VERTEX_MODEL = KIMI.vertexModel;

// ─── Moonshot direct client (K2.6 — $web_search only) ───────────────────────
// Lazy to avoid crashing on import when MOONSHOT_API_KEY is absent
let _moonshot: OpenAI | null = null;
function getMoonshotClient(): OpenAI {
  if (!_moonshot) {
    _moonshot = traced(new OpenAI({
      baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1",
      apiKey: process.env.MOONSHOT_API_KEY,
    }), "moonshot");
  }
  return _moonshot;
}
const MOONSHOT_MODEL = KIMI.moonshotModel;

// ─── Public functions ────────────────────────────────────────────────────────

// Extraction, classification, scoring — Vertex (GCP credits)
export async function kimiInstant(
  systemPrompt: string,
  userPrompt: string,
  jsonMode = false,
  timeoutMs = KIMI_INSTANT_TIMEOUT_MS,   // deal path uses the 30s default; research passes 60s for big extractions
) {
  const kimi = await getVertexClient();
  // Typed as the NON-streaming params (+ Vertex's non-standard extra_body) and passed
  // as a variable — so the overload resolves to ChatCompletion with NO cast, and the
  // extra_body field doesn't trip the object-literal excess-property check. This is
  // one-shot by contract; streaming lives in kimiStream. `stream: false` here means a
  // future stream:true edit fails to compile instead of being silently asserted away.
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & { extra_body?: unknown } = {
    model: VERTEX_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    stream: false,
    extra_body: { thinking: { type: "disabled" } },
    ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
  };
  // Gate INSIDE the timeout, deliberately: the timeout must measure the model call, not the
  // wait for a slot. Timing the queue too would turn a healthy burst into a wave of spurious
  // "kimiInstant timed out" — and in the deal path a failed classify defaults to NOISE, so a
  // mis-scoped timeout would silently discard real deals under load.
  return kimiGate.run(() =>
    withTimeout(kimi.chat.completions.create(params), timeoutMs, "kimiInstant"),
  );
}

// Creative content (brand stories) — Vertex (GCP credits)
export async function kimiThinking(systemPrompt: string, userPrompt: string, timeoutMs = KIMI_THINKING_TIMEOUT_MS) {
  const kimi = await getVertexClient();
  return kimiGate.run(() =>
    withTimeout(
      kimi.chat.completions.create({
        model: VERTEX_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.9,
        stream: false,   // one-shot by contract; streaming lives in kimiStream
      }),
      timeoutMs,
      "kimiThinking",
    ),
  );
}

/**
 * Document extraction — Vertex, DETERMINISTIC, thinking enabled.
 *
 * Exists because contract extraction was reaching for kimiThinking, which runs at
 * temperature 0.9 because its other caller writes brand stories. A creative sampler is
 * disqualifying for a document whose entire point is that it says one fixed thing: the same
 * contract re-uploaded came back with different numbers.
 *
 * kimiInstant was not the answer either — it hard-disables thinking, and a conditional
 * multi-year term ("the earlier of December 31 of the second Professional Contract Year, or
 * December 31 2028") is exactly where reasoning earns its keep.
 *
 * So: temperature 0 for repeatability, JSON response format so the caller is not
 * fence-stripping prose, thinking left ON, and a timeout sized for a real document.
 */
export async function kimiExtract(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = KIMI_EXTRACT_TIMEOUT_MS,
) {
  const kimi = await getVertexClient();
  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: VERTEX_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    stream: false,
    response_format: { type: "json_object" as const },
  };
  return kimiGate.run(() =>
    withTimeout(kimi.chat.completions.create(params), timeoutMs, "kimiExtract"),
  );
}

// Research pipeline ONLY — Moonshot direct ($web_search not available on Vertex)
// $web_search is incompatible with thinking mode; thinking is always disabled here.
export async function kimiSearch(prompt: string, jsonMode = false) {
  // moonshotGate, not kimiGate — a different provider with a different quota. Sharing one
  // would let research back-pressure the deal pipeline for no reason.
  return moonshotGate.run(() => getMoonshotClient().chat.completions.create({
    model: MOONSHOT_MODEL,
    messages: [{ role: "user", content: prompt }],
    // builtin_function + extra_body are Moonshot extensions not in OpenAI types
    tools: [{ type: "builtin_function", function: { name: "$web_search" } }] as any,
    temperature: 1, // kimi-k2.6 only accepts temperature=1
    ...(jsonMode && { response_format: { type: "json_object" } }),
    extra_body: { thinking: { type: "disabled" } },
  } as any));
}

// Agent chat loop — streaming on Vertex (0.79s TTFT, GCP credits)
// opts.temperature: omit for the model default (chat agent); reply drafts pass
// a low value so regenerating the same tone yields near-identical output.
//
// ⚠️  DELIBERATELY NOT GATED. Every other function here passes through kimiGate; this one
// does not, and that is a decision rather than an oversight.
//
// A gate slot is held for the duration of the work. For a one-shot call that is a second or
// two. For a stream it is however long the athlete's answer takes to write — and the caller,
// not this function, decides when the stream ends. Gating it would mean N slow readers can
// occupy every slot and BLOCK CLASSIFICATION BEHIND CHAT, or, worse, block chat behind chat:
// the athlete's next message waits on someone else's answer finishing. The background work
// this gate protects is exactly the work that must not be starved by a foreground stream.
//
// Doing it properly means acquiring on initiation and releasing on stream end OR abort OR
// client disconnect, with its own slot budget separate from the batch work — which is a
// different change with a different failure mode, and worth doing on its own.
//
// Streams are also self-limiting in a way batch calls are not: each one is tied to a live
// HTTP connection, so the count is bounded by concurrent human users rather than by inbox
// volume. The 429 cascade this file exists to stop comes from a Gmail push fanning out over
// N messages, and none of those go through here.
export async function kimiStream(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.ChatCompletionTool[],
  opts: { temperature?: number; signal?: AbortSignal } = {},
) {
  const kimi = await getVertexClient();
  // @ts-expect-error extra_body is Vertex extension not in OpenAI streaming types
  return kimi.chat.completions.create(
    {
      model: VERTEX_MODEL,
      messages,
      tools,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      stream: true,
      stream_options: { include_usage: true },
      extra_body: { thinking: { type: "disabled" } },
    },
    // Per-request AbortSignal — aborting rejects the pending iterator.next() so a
    // guardStream() timeout (or a client disconnect) actually cancels the Vertex
    // call instead of leaving it running in the background.
    { signal: opts.signal },
  );
}
