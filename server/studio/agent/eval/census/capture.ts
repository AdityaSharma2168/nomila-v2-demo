/**
 * studio/agent/eval/census/capture — what a census run saw, point by point (PR 16, R-2).
 *
 * A point is one artifact of the pipeline, in pipeline order. Each holds TEXT (what is grepped) and,
 * where the point is a typed source of its own (CastItems, Board rows, clip requests, …), the OBJECTS
 * (what its fields' values are read from). `write` puts every point on disk as text under
 * probe-out/flow-eval/<run>/, so two runs diff line by line. Test-only: nothing in production imports
 * this file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The capture points, in pipeline order. A row's reach is measured only DOWNSTREAM of its origin. */
export const POINTS = [
  // Direction tools and the confirm step.
  "direction_prompt",
  "proposal",
  "plan_request",
  // The planner.
  "concepts_prompt",
  "library",
  "planner_prompt",
  "plan_answer",
  "cast_items",
  "plan_row",
  // The Board and its requests (client, replicated from pure functions).
  "board_rows",
  "clip_requests",
  // The server's brief and the compiled prompt.
  "brief_inputs",
  "brief_jobs",
  "compiled_prompts",
  // Image edit.
  "recommend_prompt",
  "op_quote",
  // The stitch.
  "stitch_body",
  "stitch_spec",
  // The composer's record on the spec (PR 15.1, spec.composer): stored for a later reader, reaches no
  // ffmpeg argv (docs/probes/composer-boundary.md:44) — so NOT a consuming point.
  "stitch_record",
  // The billable door and its bookkeeping.
  "adapter_inputs",
  "cost_lines",
  "join_row",
] as const;
export type Point = (typeof POINTS)[number];

/** The points whose content reaches a model or decides an output — reaching one is CONSUMED. */
export const CONSUMING: ReadonlySet<Point> = new Set<Point>([
  "direction_prompt",
  "concepts_prompt",
  "planner_prompt",
  "compiled_prompts",
  "recommend_prompt",
  "op_quote",
  "stitch_spec",
  "adapter_inputs",
]);

export interface Captured {
  text: string[];
  objects: unknown[];
}

export class CaptureStore {
  readonly points = new Map<Point, Captured>();

  constructor(readonly run: string) {}

  /** Record one artifact at a point: its text, and the object itself when it is a typed source. */
  add(
    point: Point,
    value: unknown,
    asObject = typeof value === "object",
  ): void {
    const cur = this.points.get(point) ?? { text: [], objects: [] };
    cur.text.push(
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    if (asObject && value !== null && typeof value === "object")
      cur.objects.push(value);
    this.points.set(point, cur);
  }

  text(point: Point): string {
    return (this.points.get(point)?.text ?? []).join("\n");
  }

  objects(point: Point): unknown[] {
    return this.points.get(point)?.objects ?? [];
  }

  /** Every point to probe-out/flow-eval/<run>/<nn>-<point>.txt — readable, diffable. */
  write(root: string): string {
    const dir = join(root, this.run);
    mkdirSync(dir, { recursive: true });
    POINTS.forEach((p, i) => {
      const got = this.points.get(p);
      if (got)
        writeFileSync(
          join(dir, `${String(i).padStart(2, "0")}-${p}.txt`),
          got.text.join("\n\n──────────\n\n") + "\n",
        );
    });
    return dir;
  }
}
