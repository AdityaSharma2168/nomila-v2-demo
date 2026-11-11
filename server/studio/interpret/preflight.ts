/**
 * studio/interpret/preflight — before R1 records anything, send the product's exact request once, and if
 * Vertex refuses it, NAME the field (the interpreter, I.3).
 *
 * interpret/1's first live call came back 400 INVALID_ARGUMENT, and R1 printed only its first 200
 * characters — so "which field" had to be worked out by diffing, not read (2026-09-14). This makes the next
 * mismatch name itself:
 *
 *   1. the wire, field by field, beside the request detection and QA send daily on this project;
 *   2. the product's exact request (interpret/transport.ts, `interpreterRequest`), once;
 *   3. refused → Vertex's WHOLE answer, then one variant per differing field, walking back toward
 *      detection's request, stopping at the FIRST that is accepted: that field is the one.
 *
 * A refused request is turned away before the model runs; the first accepted one is one ordinary call.
 * Nothing here reads a row.
 * `send` is injected, so the walk itself is tested without a model (preflight.test.ts).
 */
import type { interpreterRequest } from "./transport";

export type WireRequest = ReturnType<typeof interpreterRequest>;

/** The generation config detection and QA send every day on this project — the known-good baseline. */
export const DETECTION_CONFIG: Readonly<Record<string, unknown>> = {
  responseMimeType: "application/json",
  temperature: 0,
};

/** What one send came back with. `error` is the provider's whole answer — never cut. */
export type SendResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type Send<T> = (params: WireRequest) => Promise<SendResult<T>>;

/** The wire, as lines: model, then every config field, each beside detection's and marked where it differs. */
export function wireLines(
  product: WireRequest,
  detectionModel: string,
): string[] {
  const config = product.config as Record<string, unknown>;
  const lines = [
    `model              interpreter ${product.model}   detection ${detectionModel}${product.model === detectionModel ? "" : "   ← differs"}`,
  ];
  for (const k of new Set([
    ...Object.keys(config),
    ...Object.keys(DETECTION_CONFIG),
  ])) {
    const mine = k in config ? JSON.stringify(config[k]) : "(not sent)";
    const theirs =
      k in DETECTION_CONFIG
        ? JSON.stringify(DETECTION_CONFIG[k])
        : "(not sent)";
    lines.push(
      `config.${k.padEnd(18)} interpreter ${mine.padEnd(28)} detection ${theirs}${mine === theirs ? "" : "   ← differs"}`,
    );
  }
  return lines;
}

/** One step of the walk back toward detection's request: the field it takes out, and the request without it. */
export interface Variant {
  field: string;
  params: WireRequest;
}

/**
 * The walk: each config field detection does not send, taken out one at a time; then detection's model id,
 * if it differs; then detection's whole request shape. The FIRST accepted names the field.
 */
export function variantsOf(
  product: WireRequest,
  detectionModel: string,
): Variant[] {
  const config = product.config as Record<string, unknown>;
  const differs = Object.keys(config).filter(
    (k) =>
      !(k in DETECTION_CONFIG) ||
      JSON.stringify(config[k]) !== JSON.stringify(DETECTION_CONFIG[k]),
  );
  const without = (k: string): WireRequest => {
    const rest = { ...config };
    if (k in DETECTION_CONFIG) rest[k] = DETECTION_CONFIG[k];
    else delete rest[k];
    return { ...product, config: rest } as WireRequest;
  };
  return [
    ...differs.map((k) => ({ field: `config.${k}`, params: without(k) })),
    ...(product.model !== detectionModel
      ? [{ field: "model", params: { ...product, model: detectionModel } }]
      : []),
    {
      field: "every differing field at once (detection's request shape)",
      params: {
        ...product,
        model: detectionModel,
        config: { ...DETECTION_CONFIG },
      } as WireRequest,
    },
  ];
}

export type PreflightResult<T> =
  | { kind: "accepted"; value: T; calls: number }
  | {
      kind: "named";
      field: string;
      error: string;
      tried: { field: string; error: string }[];
      calls: number;
    }
  | {
      kind: "unnamed";
      error: string;
      tried: { field: string; error: string }[];
      calls: number;
    };

/**
 * Send the product's request; accepted → its answer. Refused → walk the variants and name the field the
 * first accepted one took out — or say that none was, so the difference is not in the config at all.
 */
export async function preflight<T>(
  product: WireRequest,
  detectionModel: string,
  send: Send<T>,
): Promise<PreflightResult<T>> {
  const first = await send(product);
  if (first.ok) return { kind: "accepted", value: first.value, calls: 1 };
  const tried: { field: string; error: string }[] = [];
  let calls = 1;
  for (const v of variantsOf(product, detectionModel)) {
    const r = await send(v.params);
    calls++;
    if (r.ok)
      return {
        kind: "named",
        field: v.field,
        error: first.error,
        tried,
        calls,
      };
    tried.push({ field: v.field, error: r.error });
  }
  return { kind: "unnamed", error: first.error, tried, calls };
}
