/**
 * scripts/dev/chat-v2-smoke.ts — one real chat v2 turn against the DEV server, read with the APP's own code
 * (client/components/mila/thread/api.ts: the same transport, SSE parser and message assembly the phone runs).
 *
 *   1. "What can you help me with?" → text arrives, every status part is one of the fixed lines, no tool arguments or
 *      results in any part, data-mila-done arrives
 *   2. GET /chat/v2/runs/:runId → completed
 *   3. a second message, stopped through POST /chat/v2/runs/:runId/stop → the run says stopped
 *
 * DEV ONLY, AND ONLY AS A TEST ATHLETE. It talks to the real dev model: a few cents a run. Run it once, never in a loop.
 *
 * Auth: there is no machine path to sign in as a test athlete today (the test athlete dd1a8a80-… has no login — no
 * auth_id), so this script takes a Firebase ID token for a TEST account from the environment and never mints one:
 *   MILA_SMOKE_ID_TOKEN   a Firebase ID token for a test athlete's login (never printed)
 *   MILA_SMOKE_ATHLETE_ID the athlete that login holds (sent as x-athlete-id); Mia's id is refused
 *   MILA_SMOKE_API_URL    optional; defaults to the dev Cloud Run service
 * Run: npx tsx scripts/dev/chat-v2-smoke.ts
 */
import { randomUUID } from "node:crypto";
import { THINKING_STATUS, TOOL_STATUS_FALLBACK, TOOL_STATUS_LABELS } from "../../server/agent/engine/toolStatus";
import { createMilaApi, sendAndCollect } from "../../client/components/mila/thread/api";
import { doneOf, textOf } from "../../client/components/mila/thread/wire";

const DEV_API = "https://nomila-v2-iau7alh5qq-uc.a.run.app";
const TEST_ATHLETE = "dd1a8a80-d31b-423a-a572-9d146716cb0f";
/** The founder's real account: never a smoke target. */
const REFUSED_PREFIXES = ["dc8f37f1"];
const FIXED = new Set([...Object.values(TOOL_STATUS_LABELS), TOOL_STATUS_FALLBACK, THINKING_STATUS]);
const LEAKS = ["toolCallId", "\"input\"", "\"output\"", "tool-input", "tool-output", "\"args\""];

function fail(msg: string): never {
  console.error(`FAIL ${msg}`);
  process.exit(1);
}

async function main(): Promise<number> {
  const token = process.env.MILA_SMOKE_ID_TOKEN?.trim();
  const athleteId = process.env.MILA_SMOKE_ATHLETE_ID?.trim() || TEST_ATHLETE;
  const apiUrl = process.env.MILA_SMOKE_API_URL?.trim() || DEV_API;
  if (REFUSED_PREFIXES.some((p) => athleteId.startsWith(p))) fail("refusing a real athlete's account; use a test athlete");
  if (apiUrl.includes("api.nomila.co")) fail("refusing production; this smoke run is dev only");
  if (!token) {
    console.error([
      "No MILA_SMOKE_ID_TOKEN. This script never mints a login. It needs a Firebase ID token for a TEST account that holds",
      `athlete ${athleteId} (today the test athlete has no login: no auth_id), passed in the environment.`,
    ].join("\n"));
    return 2;
  }

  const conversationId = randomUUID();
  const api = createMilaApi({
    apiUrl: () => apiUrl,
    headers: async () => ({ Authorization: `Bearer ${token}`, "x-athlete-id": athleteId }),
    conversationId: () => conversationId,
    fetch: (url, init) => fetch(url, init),
  });

  // 1. One harmless turn.
  const t0 = Date.now();
  const r = await sendAndCollect(api, "What can you help me with?");
  if (r.error) fail(`the stream errored: ${String((r.error as Error)?.message ?? r.error).slice(0, 200)}`);
  const m = r.message;
  if (!m) fail("no message assembled");
  const text = textOf(m);
  const statuses = r.chunks.filter((c) => c.type === "data-mila-status").map((c) => (c as { data: { label: string } }).data.label);
  const done = doneOf(m);
  const raw = JSON.stringify(r.chunks);
  console.log(`turn 1: ${r.chunks.length} parts in ${Date.now() - t0} ms; types: ${[...new Set(r.chunks.map((c) => c.type))].join(", ")}`);
  console.log(`  text: ${text.length} chars ("${text.slice(0, 80).replace(/\s+/g, " ")}…")`);
  console.log(`  status lines: ${JSON.stringify([...new Set(statuses)])}`);
  console.log(`  done: ${JSON.stringify(done)}`);
  if (!text) fail("no text arrived");
  for (const s of statuses) if (!FIXED.has(s)) fail(`a status line is not one of the fixed lines: ${s}`);
  for (const l of LEAKS) if (raw.includes(l)) fail(`a raw tool field reached the app: ${l}`);
  if (r.chunks.some((c) => c.type.startsWith("tool-"))) fail("a tool-* part reached the app");
  if (!done) fail("no data-mila-done");
  const runId = String(m.metadata?.runId ?? done.runId ?? "");

  // 2. The run status.
  const run = await api.getRun(runId);
  console.log(`run status: ${JSON.stringify(run && { status: run.status, messageIds: run.messageIds.length })}`);
  if (run?.status !== "completed") fail("the run is not completed");

  // 3. A second message, stopped.
  const ctl = new AbortController();
  let second = "";
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no start part within 30 s")), 30_000);
    void sendAndCollect(api, "Write me a long, detailed plan for my next month.", {
      signal: ctl.signal,
      onChunk: (c) => {
        if (c.type !== "start" || second) return;
        second = String((c as { messageMetadata?: { runId?: string } }).messageMetadata?.runId ?? "");
        clearTimeout(timer);
        resolve();
      },
    });
  });
  await started;
  const stop = await api.stopRun(second);
  ctl.abort();
  console.log(`stop: ${stop}`);
  let st = await api.getRun(second);
  for (let i = 0; st?.status === "running" && i < 20; i++) { await new Promise((res) => setTimeout(res, 1000)); st = await api.getRun(second); }
  console.log(`second run: ${st?.status} (${st?.stopReason ?? "-"})`);
  if (stop !== "stopping" && stop !== "ended") fail(`stop answered ${stop}`);
  if (st?.status !== "stopped" && st?.status !== "completed") fail(`the second run is ${st?.status}`);
  console.log("PASS");
  return 0;
}

main().then((code) => process.exit(code), (e) => fail(String(e?.message ?? e).slice(0, 200)));
