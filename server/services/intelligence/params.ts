/**
 * intelligence/params.ts — the versioned parameter store (model_params, migration 0043).
 *
 * Read and write helpers only. (The retired v7 engine read scoring_weights through weightsService;
 * both are gone.) An engine that reads model_params decides its own cache policy; there is
 * deliberately no in-process cache here.
 *
 * Rules the helpers enforce (spec §15):
 *   · rows are never edited in place — a change is a new (family, version) row;
 *   · `draft` rows are review-only and are never returned by getActiveParams;
 *   · exactly one `active` row per family, swapped in ONE transaction by activateParams
 *     (one active row per family, swapped in one transaction);
 *   · every row carries the config hash, so a trace and a row line up by eye.
 */

import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { modelParams, type ModelParamsRow } from "../../../shared/schema";
import { PARAM_FAMILIES, type ParamFamily } from "./types";

export class ParamsError extends Error {}

export function isParamFamily(v: unknown): v is ParamFamily {
  return typeof v === "string" && (PARAM_FAMILIES as readonly string[]).includes(v);
}

/** Key-order-insensitive JSON, so the same config always hashes the same. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val as object).sort().reduce((o: Record<string, unknown>, k) => { o[k] = (val as Record<string, unknown>)[k]; return o; }, {})
      : val,
  );
}

/** First 12 hex chars of sha1(canonical JSON) — the convention prompts.hash already uses. */
export function hashConfig(config: unknown): string {
  return createHash("sha1").update(canonicalJson(config)).digest("hex").slice(0, 12);
}

/** The one live row for a family, or null. Drafts, inactive and archived rows are never returned. */
export async function getActiveParams(family: ParamFamily): Promise<ModelParamsRow | null> {
  const [row] = await db.select().from(modelParams)
    .where(and(eq(modelParams.family, family), eq(modelParams.status, "active")))
    .limit(1);
  return row ?? null;
}

/** Every version of a family, newest first, whatever its status. */
export async function listParams(family: ParamFamily): Promise<ModelParamsRow[]> {
  return db.select().from(modelParams)
    .where(eq(modelParams.family, family))
    .orderBy(desc(modelParams.created_at));
}

export interface InsertDraftInput {
  family:        ParamFamily;
  version:       string;
  schemaVersion: string;
  config:        Record<string, unknown>;
  note?:         string | null;
  createdBy?:    string | null;
}

/**
 * Insert a DRAFT row. Idempotent on (family, version): an existing row is returned unchanged,
 * even if the config differs — a version is immutable once written, so a differing config
 * is a new version, never an overwrite.
 */
export async function insertDraftParams(input: InsertDraftInput): Promise<{ row: ModelParamsRow; created: boolean }> {
  if (!isParamFamily(input.family)) throw new ParamsError(`unknown parameter family "${input.family}"`);
  if (!input.version.trim()) throw new ParamsError("version is required");
  if (!input.schemaVersion.trim()) throw new ParamsError("schemaVersion is required");
  if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) throw new ParamsError("config must be an object");

  const [existing] = await db.select().from(modelParams)
    .where(and(eq(modelParams.family, input.family), eq(modelParams.version, input.version)))
    .limit(1);
  if (existing) {
    // A parameter version is immutable. The same (family, version) may be re-seeded only with the
    // identical config and schema version; anything else is a new version, never a silent no-op.
    const hash = hashConfig(input.config);
    if (existing.hash !== hash || existing.schema_version !== input.schemaVersion) {
      throw new ParamsError(`${input.family} ${input.version} already exists with a different ${existing.hash !== hash ? `config (hash ${existing.hash} ≠ ${hash})` : `schema version (${existing.schema_version} ≠ ${input.schemaVersion})`}; a version is immutable — use a new version`);
    }
    return { row: existing, created: false };
  }

  const [row] = await db.insert(modelParams).values({
    family:         input.family,
    version:        input.version,
    schema_version: input.schemaVersion,
    status:         "draft",
    config:         input.config,
    hash:           hashConfig(input.config),
    note:           input.note ?? null,
    created_by:     input.createdBy ?? null,
  }).returning();
  return { row, created: true };
}

/**
 * Make one version the family's live row, in one transaction: the current active row (if any)
 * becomes inactive, the target becomes active. Refuses an archived target and an unknown one.
 * Never called implicitly — activation is a deliberate, reviewed act.
 */
export async function activateParams(family: ParamFamily, version: string): Promise<ModelParamsRow> {
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(modelParams)
      .where(and(eq(modelParams.family, family), eq(modelParams.version, version)))
      .limit(1);
    if (!target) throw new ParamsError(`no ${family} parameters at version "${version}"`);
    if (target.status === "archived") throw new ParamsError(`${family} "${version}" is archived and cannot be activated`);
    if (target.status === "active") return target;

    await tx.update(modelParams)
      .set({ status: "inactive" })
      .where(and(eq(modelParams.family, family), eq(modelParams.status, "active")));
    const [row] = await tx.update(modelParams)
      .set({ status: "active", activated_at: new Date() })
      .where(eq(modelParams.id, target.id))
      .returning();
    return row;
  });
}
