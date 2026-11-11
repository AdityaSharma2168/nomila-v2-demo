/**
 * templates/freeze — the prompt template a brief compiles from, frozen onto it at the quote (quality-scrappy piece 4,
 * ADI-QS-GO R2). Behind STUDIO_PROMPT_REGISTRY (under the master).
 *
 *   the brief ──plannedInputs──▶ its template key ──registry──▶ a published row, if one fits ──▶ brief.job.template
 *
 * ─── WHY AT THE QUOTE, AND WHY THE BODY ─────────────────────────────────────────────────────────────────
 *
 * The run re-derives the prompt from the frozen brief (videoRunner `inputsFor`, generate.ts `runStudioGeneration`).
 * Freezing the published row's BODY — not just its key — is what makes a publish between the quote and the run
 * unable to move a queued clip: the run renders the text she was quoted against. It is the same rule that put the
 * duration, the sound and the last frame on the brief (ledger D1, D3).
 *
 * ─── EVERY JOB CARRIES ITS KEY ──────────────────────────────────────────────────────────────────────────
 *
 * With no published row — the default, and every key not in REGISTRY_TEMPLATES — the frozen record says
 * `source: "code"`: the TS literal, and the prompt is byte-identical. It is frozen anyway, so every job's brief names
 * the template it ran under and a pass rate can be counted per key (piece 5's gate log line reads it).
 *
 * A published row is used only if its envelope parses (templates/render.ts) AND its `meta.model_target`/`provider`
 * name the target this brief is actually routed to. Otherwise the literal, and a warning line with the reason.
 */
import { createLogger } from "../../logger";
import type { CreativeBrief } from "../brief";
import { promptRegistryEnabled, routeFor, vertexModelFor } from "../config";
import { plannedInputs } from "../preview";
import { publishedTemplate } from "./registry";
import { resolveTemplate } from "./resolve";
import { readNativeIntent } from "../nativeEdit";
import {
  isRegistryTemplateKey,
  parseEnvelope,
  type FrozenTemplate,
} from "./render";

const logger = createLogger("studio-templates");

/** The brief with its template frozen onto `job.template`, or the brief untouched (flag off, or an edit). */
export async function withPromptTemplate(
  brief: CreativeBrief,
): Promise<CreativeBrief> {
  if (!promptRegistryEnabled()) return brief;
  const planned = plannedInputs(brief, {});
  const key = planned.templateKey;
  if (!key) return brief;

  // Piece 9: the resolver's candidates, most specific first and this key last — the first one published that parses and
  // fits the route wins. Today no variant is published, so this is the base key, and the base is today's prompt.
  const native = readNativeIntent(brief);
  const { candidates, inputs } = resolveTemplate(
    brief,
    native.kind === "native" ? native.intent : null,
    key,
  );
  let frozen: FrozenTemplate = {
    key,
    source: "code",
    version: null,
    hash: null,
    inputs,
  };
  if (isRegistryTemplateKey(key)) {
    const route =
      planned.videoRoute ?? (planned.task ? routeFor(planned.task) : null);
    for (const candidate of candidates) {
      const row = await publishedTemplate(candidate);
      if (!row) continue;
      // A variant is parsed against its BASE's placeholders: it may say more, and may drop nothing the base keeps.
      const parsed = parseEnvelope(key, row.body);
      const fits =
        parsed.ok &&
        !!route &&
        parsed.meta.provider === route.provider &&
        (parsed.meta.model_target === route.model ||
          vertexModelFor(parsed.meta.model_target) === route.model);
      if (fits) {
        frozen = {
          key: candidate,
          source: "registry",
          version: row.version,
          hash: row.hash,
          body: row.body,
          inputs,
        };
        break;
      }
      logger.warn(
        {
          key: candidate,
          version: row.version,
          hash: row.hash,
          reason: parsed.ok ? "target_mismatch" : parsed.reason,
          routed: route ? `${route.model}@${route.provider}` : null,
        },
        "published template not frozen — the literal applies",
      );
    }
  }
  logger.info(
    {
      key: frozen.key,
      source: frozen.source,
      version: frozen.version,
      hash: frozen.hash,
      inputs,
    },
    "prompt template frozen onto the brief",
  );
  return { ...brief, job: { ...brief.job, template: frozen } };
}
