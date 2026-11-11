/**
 * seams/cohort.ts — the COHORT runner: resolve identity → governed v3 research → M.I.A. recompute, for a list of
 * athletes, one at a time, through the admin seams (a SeamClient). Then it writes a per-athlete outcome report.
 *
 * Where it executes: the client is the admin HTTP API of the service (server/scripts/intelligence/intelligenceCohort.ts),
 * so every provider call happens on the service, where the flags and credentials live. Tests pass an in-process client.
 * The runner itself never calls a provider, never writes the database, and never changes a flag or a cap.
 *
 *   Sequential     one athlete at a time; each stage waits for its workflow run to finish (polling inspect).
 *   Budget-aware   before each athlete, today's LLM headroom (inspect.budget) must cover a resolve plus a full run
 *                  (2 × maxCallsPerRun, conservative). Otherwise the cohort STOPS and the rest are reported `capped`
 *                  (resume tomorrow). A run whose steps were refused by the ledger is reported capped and also stops
 *                  the cohort. Caps are never raised.
 *   Resumable      the state (per athlete: the stages done and their run ids) is saved after every stage; a re-run
 *                  with the same state skips finished athletes and finished stages.
 *   Gate-faithful  research runs only for a resolved identity (pending is resolved first); ambiguous / failed are
 *                  reported, never re-resolved unless `reresolve` is set; M.I.A. is requested only through the
 *                  preflighted seam, so a held athlete is reported held.
 */

export interface SeamResponse { status: number; body: any }
export interface SeamClient {
  resolveIdentity(athleteId: string, body: { promoteWithoutAccount?: boolean; label?: string }): Promise<SeamResponse>;
  runResearch(athleteId: string, body: { domains?: string[]; label?: string }): Promise<SeamResponse>;
  recomputeMia(athleteId: string, body: { reason?: string }): Promise<SeamResponse>;
  inspect(athleteId: string): Promise<SeamResponse>;
}

export type Stage = "resolve" | "research" | "mia";
export interface AthleteCohortState {
  stages: Partial<Record<Stage, { at: string; status: number; workflowRunId?: string | null; outcome: string }>>;
  report?: CohortReportRow;
}
export interface CohortState { version: 1; startedAt: string; athletes: Record<string, AthleteCohortState> }

export interface CohortReportRow {
  athleteId: string;
  name: string | null;
  account: boolean | null;
  outcome: "completed" | "held_for_identity" | "capped" | "timeout" | "error" | "not_found" | "not_started";
  identity: { value: string | null; reason: string | null; basis: string | null };
  resolve: string | null;
  research: { outcome: string | null; workflowRunId: string | null; runStatus: string | null; capped: boolean; settled: Record<string, string>; held: string[] };
  facts: { current: number; byOrigin: Record<string, number>; evidence: number };
  mia: { outcome: string | null; pageState: string | null; score: number | null; readState: string | null };
  budget: { day: string | null; llmAttempts: number | null; headroom: number | null };
  notes: string[];
}

export interface CohortOptions {
  promoteWithoutAccount?: boolean;
  domains?: string[] | null;
  mia?: boolean;
  reresolve?: boolean;
  redo?: boolean;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  save?: (state: CohortState) => Promise<void> | void;
  log?: (msg: string) => void;
}

const TERMINAL = new Set(["done", "failed", "canceled"]);
const newState = (now: Date): CohortState => ({ version: 1, startedAt: now.toISOString(), athletes: {} });

function emptyRow(athleteId: string): CohortReportRow {
  return {
    athleteId, name: null, account: null, outcome: "not_started",
    identity: { value: null, reason: null, basis: null }, resolve: null,
    research: { outcome: null, workflowRunId: null, runStatus: null, capped: false, settled: {}, held: [] },
    facts: { current: 0, byOrigin: {}, evidence: 0 },
    mia: { outcome: null, pageState: null, score: null, readState: null },
    budget: { day: null, llmAttempts: null, headroom: null },
    notes: [],
  };
}

/** Fill a report row from an inspection (the intelligence-inspect/0.1 body). */
export function rowFromInspection(row: CohortReportRow, ins: any): CohortReportRow {
  const detail = (ins?.identity?.detail ?? {}) as Record<string, any>;
  const domains = (ins?.researchStatus?.domains ?? {}) as Record<string, any>;
  const settled: Record<string, string> = {};
  const held: string[] = [];
  for (const [d, v] of Object.entries(domains)) {
    if (v?.lifecycle === "settled" && v?.outcome) settled[d] = v.outcome;
    if (v?.heldBy === "identity_gate") held.push(d);
  }
  return {
    ...row,
    name: ins?.athlete?.fullName ?? row.name,
    account: typeof ins?.account?.hasSelfMembership === "boolean" ? ins.account.hasSelfMembership : row.account,
    identity: { value: ins?.identity?.value ?? null, reason: detail.reason ?? null, basis: detail.basis ?? (detail.trigger ? `entered:${detail.trigger}` : null) },
    research: { ...row.research, settled, held },
    facts: { current: ins?.knowledge?.currentFacts ?? 0, byOrigin: ins?.knowledge?.factsByOrigin ?? {}, evidence: ins?.knowledge?.evidence ?? 0 },
    mia: { ...row.mia, pageState: ins?.mia?.pageState ?? null, score: ins?.mia?.score ?? null, readState: ins?.mia?.readState ?? null },
    budget: { day: ins?.budget?.day ?? null, llmAttempts: ins?.budget?.llmAttempts ?? null, headroom: ins?.budget?.headroom ?? null },
  };
}

/**
 * Run the cohort. Returns the report (one row per athlete, in input order) and the final state. `state` is the state a
 * previous invocation saved (resume), or omitted for a fresh cohort.
 */
export async function runCohort(athleteIds: readonly string[], client: SeamClient, opts: CohortOptions = {}, state?: CohortState): Promise<{ report: CohortReportRow[]; state: CohortState; stoppedBy: "capped" | null }> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 15_000;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const log = opts.log ?? (() => {});
  const st = state ?? newState(now());
  const save = async () => { await opts.save?.(st); };
  const ids = [...new Set(athleteIds)];
  const report: CohortReportRow[] = [];
  let stoppedBy: "capped" | null = null;

  /** Poll inspect until `pick` finds the run terminal (or inspect says nothing is in flight). */
  const waitFor = async (athleteId: string, done: (ins: any) => boolean): Promise<{ ins: any; timedOut: boolean }> => {
    const t0 = Date.now();
    for (;;) {
      const r = await client.inspect(athleteId);
      if (r.status !== 200) throw new Error(`inspect ${athleteId} → ${r.status}`);
      if (done(r.body)) return { ins: r.body, timedOut: false };
      if (Date.now() - t0 >= timeoutMs) return { ins: r.body, timedOut: true };
      await sleep(pollMs);
    }
  };
  const runTerminal = (wf: string | null | undefined) => (ins: any) => !wf || TERMINAL.has(((ins?.researchRuns ?? []) as any[]).find((x) => x.workflowRunId === wf)?.status ?? "done");
  const runOf = (ins: any, wf: string | null | undefined) => ((ins?.researchRuns ?? []) as any[]).find((x) => x.workflowRunId === wf) ?? null;

  for (const athleteId of ids) {
    const a = (st.athletes[athleteId] ??= { stages: {} });
    if (stoppedBy) { const row = emptyRow(athleteId); row.outcome = "capped"; row.notes.push("not started: the cohort stopped at the daily LLM cap; resume with the same state file"); report.push(row); continue; }
    if (a.report && a.report.outcome === "completed" && !opts.redo) { report.push(a.report); log(`${athleteId}: already completed (resume)`); continue; }
    let row = emptyRow(athleteId);
    try {
      const first = await client.inspect(athleteId);
      if (first.status === 404) { row.outcome = "not_found"; a.report = row; report.push(row); await save(); continue; }
      if (first.status !== 200) throw new Error(`inspect → ${first.status}`);
      let ins = first.body;
      row = rowFromInspection(row, ins);

      // ── budget: a resolve plus a full run must fit today's headroom ──
      const need = 2 * Number(ins.budget?.maxCallsPerRun ?? 8);
      if (Number(ins.budget?.headroom ?? 0) < need) {
        row.outcome = "capped"; row.notes.push(`daily LLM headroom ${ins.budget?.headroom} < ${need} needed; stopped (caps are not raised)`);
        stoppedBy = "capped"; a.report = row; report.push(row); await save(); continue;
      }

      // ── 1. resolve ──
      const value = ins.identity?.value ?? null;
      const wantResolve = value === null || value === "pending" || ((value === "ambiguous" || value === "failed") && opts.reresolve);
      let resolveOutcome: string | null = null;
      if (wantResolve && !a.stages.resolve) {
        const r = await client.resolveIdentity(athleteId, { promoteWithoutAccount: opts.promoteWithoutAccount === true });
        const wf = r.body?.started ? r.body?.workflowRunId ?? null : null;
        resolveOutcome = r.body?.started ? `started${r.body?.transition ? `:${r.body.transition}` : ""}` : String(r.body?.reason ?? r.body?.error ?? r.status);
        // Only a started act is a finished stage; a refusal (no account, disabled, …) is retried on the next invocation.
        if (r.body?.started) { a.stages.resolve = { at: now().toISOString(), status: r.status, workflowRunId: wf, outcome: resolveOutcome }; await save(); }
        if (r.body?.reason === "no_self_membership") row.notes.push("no Nomila account: enter her deliberately with --promote-without-account");
        if (wf && a.stages.resolve) {
          const w = await waitFor(athleteId, runTerminal(wf));
          ins = w.ins;
          if (w.timedOut) { row = rowFromInspection(row, ins); row.resolve = a.stages.resolve.outcome; row.outcome = "timeout"; row.notes.push("identity run still in flight; resume later"); a.report = row; report.push(row); delete a.stages.resolve; await save(); continue; }
          if (runOf(ins, wf)?.capped) { row = rowFromInspection(row, ins); row.resolve = a.stages.resolve.outcome; row.outcome = "capped"; row.research.capped = true; row.notes.push("Q1 refused by the LLM budget ledger"); stoppedBy = "capped"; delete a.stages.resolve; a.report = row; report.push(row); await save(); continue; }
        } else {
          ins = (await client.inspect(athleteId)).body;
        }
      }
      row.resolve = resolveOutcome ?? a.stages.resolve?.outcome ?? (value === "resolved" ? "already_resolved" : value ? `not_resolved:${value}` : null);
      row = rowFromInspection(row, ins);

      // ── 2. research (only for a resolved identity) ──
      if (ins.identity?.value === "resolved") {
        if (!a.stages.research) {
          const r = await client.runResearch(athleteId, opts.domains?.length ? { domains: [...opts.domains] } : {});
          const stage = { at: now().toISOString(), status: r.status, workflowRunId: r.body?.started ? r.body?.workflowRunId ?? null : null, outcome: r.body?.started ? "started" : String(r.body?.reason ?? r.body?.error ?? r.status) };
          row.research.outcome = stage.outcome;
          if (r.body?.started) { a.stages.research = stage; await save(); }
        }
        const wf = a.stages.research?.workflowRunId ?? null;
        if (a.stages.research) row.research.outcome = a.stages.research.outcome;
        row.research.workflowRunId = wf;
        if (wf) {
          const w = await waitFor(athleteId, runTerminal(wf));
          ins = w.ins; row = rowFromInspection(row, ins);
          const run = runOf(ins, wf);
          row.research.runStatus = run?.status ?? null; row.research.capped = !!run?.capped;
          if (w.timedOut) { row.outcome = "timeout"; row.notes.push("research run still in flight; resume later"); a.report = row; report.push(row); await save(); continue; }
          // A capped run is not a finished stage: the resume (a later UTC day, so a new admin key) starts a fresh run.
          if (run?.capped) { row.outcome = "capped"; row.notes.push("research steps refused by the LLM budget ledger; stopped (caps are not raised)"); stoppedBy = "capped"; delete a.stages.research; a.report = row; report.push(row); await save(); continue; }
        }
      } else {
        row.research.outcome = "held_for_identity";
      }

      // ── 3. M.I.A. (preflighted: held when identity is not resolved) ──
      if (opts.mia !== false) {
        if (!a.stages.mia) {
          const r = await client.recomputeMia(athleteId, { reason: "dev seam cohort" });
          const stage = { at: now().toISOString(), status: r.status, workflowRunId: r.body?.runId ?? null, outcome: r.status === 202 ? "requested" : r.body?.held ? `held:${r.body.held}` : String(r.body?.error ?? r.status) };
          row.mia.outcome = stage.outcome;
          if (r.status === 202) { a.stages.mia = stage; await save(); }   // a held request is retried on the next invocation
        }
        if (a.stages.mia) row.mia.outcome = a.stages.mia.outcome;
        if (a.stages.mia?.outcome === "requested") {
          // Wait for THIS forced run, not "nothing in flight": since H2 a resolution also queues a debounced
          // IDENTITY_RESOLVED run (it fires ~10 min later and skips when the evidence digest is unchanged).
          const runId = a.stages.mia.workflowRunId;
          const w = await waitFor(athleteId, (x) => { const r = ((x?.mia?.runs ?? []) as any[]).find((m) => m.runId === runId); return r ? TERMINAL.has(r.status) : x?.mia?.inProgress !== true; });
          ins = w.ins; row = rowFromInspection(row, ins);
          if (w.timedOut) row.notes.push("M.I.A. evaluation still in flight at the timeout");
        }
      }

      row = rowFromInspection(row, ins);
      row.outcome = ins.identity?.value === "resolved" ? "completed" : "held_for_identity";
      if (row.outcome === "held_for_identity") row.notes.push(`identity ${ins.identity?.value ?? "NULL"}${row.identity.reason ? ` (${row.identity.reason})` : ""}: Q2–Q6 and M.I.A. wait for resolution (her confirmation, or an admin re-resolve)`);
    } catch (err: any) {
      row.outcome = "error"; row.notes.push(String(err?.message ?? err).slice(0, 300));
    }
    a.report = row; report.push(row); await save();
    log(`${athleteId}: ${row.outcome} · identity ${row.identity.value ?? "NULL"} · facts ${row.facts.current} · M.I.A. ${row.mia.pageState ?? "-"}`);
  }
  return { report, state: st, stoppedBy };
}

/** The HTTP SeamClient over the admin API (base = the service origin). The token is sent, never logged. */
export function httpSeamClient(base: string, token: string, fetchImpl: typeof fetch = fetch): SeamClient {
  const root = `${base.replace(/\/+$/, "")}/api/v1/admin/intelligence/athletes`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<SeamResponse> => {
    const r = await fetchImpl(`${root}/${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return {
    resolveIdentity: (id, body) => call("POST", `${id}/resolve-identity`, body),
    runResearch: (id, body) => call("POST", `${id}/research`, body),
    recomputeMia: (id, body) => call("POST", `${id}/mia/recompute`, body),
    inspect: (id) => call("GET", id),
  };
}
