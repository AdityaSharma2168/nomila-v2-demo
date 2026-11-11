/**
 * registry.ts — where workflow definitions live at runtime.
 *
 * Definitions are registered at module load (each process has its own file under
 * server/workflow/definitions/, added in later PRs). The registry keeps EVERY version it has
 * seen, because a run pins the version it started on and must keep resolving it after a
 * newer version ships. Rule for authors: add steps or bump the version; never rename or
 * reorder steps inside a live version.
 */

import type { CompiledStep, CompiledWorkflow, StepDef, WorkflowDef } from "./types";

const byProcess = new Map<string, Map<number, CompiledWorkflow>>();

function compile(def: WorkflowDef): CompiledWorkflow {
  if (!def.process || !/^[a-z][a-z0-9_]*$/.test(def.process)) {
    throw new Error(`Workflow process name must be snake_case: "${def.process}"`);
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`Workflow "${def.process}" version must be a positive integer`);
  }
  if (!def.steps.length) throw new Error(`Workflow "${def.process}" has no steps`);

  const names = new Set<string>();
  const steps: CompiledStep[] = [];
  let ordinal = -1;
  def.steps.forEach((s: StepDef, i) => {
    if (!s.name || names.has(s.name)) throw new Error(`Workflow "${def.process}": duplicate or empty step name "${s.name}"`);
    names.add(s.name);
    if (s.parallel && i === 0) throw new Error(`Workflow "${def.process}": first step cannot be parallel`);
    if ((s.kind === "code" || s.kind === "model") && !s.run) throw new Error(`Step "${s.name}" (${s.kind}) needs run()`);
    if (s.kind === "await_human" && (!s.payload || !s.complete)) throw new Error(`Step "${s.name}" (await_human) needs payload() and complete()`);
    if (s.kind === "schedule" && !s.readyAt) throw new Error(`Step "${s.name}" (schedule) needs readyAt()`);
    if (s.kind === "await_human" && s.parallel) throw new Error(`Step "${s.name}": await_human cannot be parallel`);
    if (!s.parallel) ordinal += 1;
    steps.push({ ...s, ordinal });
  });

  const groups: CompiledStep[][] = [];
  for (const s of steps) (groups[s.ordinal] ??= []).push(s);
  return { process: def.process, version: def.version, steps, groups, activeScope: def.activeScope, onDone: def.onDone };
}

/**
 * Versions registered as "opt-in": resolvable by a pinned `version` (a run keeps the version it started on; tests pin it)
 * but never the default a caller gets by omitting the version. Phase A Step 3b: onboarding v3 is registered this way so
 * every existing caller keeps starting v2 until a flag names 3 explicitly.
 */
const optIn = new Map<string, Set<number>>();

export function defineWorkflow(def: WorkflowDef, opts: { optIn?: boolean } = {}): CompiledWorkflow {
  const compiled = compile(def);
  const versions = byProcess.get(def.process) ?? new Map<number, CompiledWorkflow>();
  if (versions.has(def.version)) {
    throw new Error(`Workflow "${def.process}" v${def.version} is already defined — bump the version`);
  }
  versions.set(def.version, compiled);
  byProcess.set(def.process, versions);
  if (opts.optIn) optIn.set(def.process, new Set([...(optIn.get(def.process) ?? []), def.version]));
  return compiled;
}

/** The named version, or the latest NON-opt-in version when omitted. Throws when unknown. */
export function getDefinition(process: string, version?: number): CompiledWorkflow {
  const versions = byProcess.get(process);
  if (!versions) throw new Error(`Unknown workflow process "${process}"`);
  if (version === undefined) {
    const skip = optIn.get(process) ?? new Set<number>();
    const candidates = [...versions.keys()].filter((v) => !skip.has(v));
    if (!candidates.length) throw new Error(`Workflow "${process}" has no default version`);
    return versions.get(Math.max(...candidates))!;
  }
  const def = versions.get(version);
  if (!def) throw new Error(`Workflow "${process}" has no version ${version}`);
  return def;
}

export function listProcesses(): Array<{ process: string; versions: number[] }> {
  return [...byProcess.entries()].map(([process, v]) => ({ process, versions: [...v.keys()].sort() }));
}

/** Tests only: forget every definition. */
export function __resetRegistry(): void {
  byProcess.clear();
}
