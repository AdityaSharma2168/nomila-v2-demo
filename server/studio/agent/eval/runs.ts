/**
 * studio/agent/eval/runs — the shape of a recorded run, and the prompt fingerprint that names it.
 *
 * A run file is self-contained: what was sent (the libraries as recorded, the prompts), what came
 * back (raw and parsed), and what it was sampled at — so "did the planner change or did the model"
 * is answerable from the file. It lives under the gitignored probe-out/ (the library lines are the
 * tagger's words about real photographs of a real person); the ledger commits aggregates only.
 */
import { createHash } from "node:crypto";
import { agentPrompt } from "../plan";
import type { PlanUsage } from "../plan";
import type { AgentPlan, LibraryEntry, PlanAsk, ProductEntry } from "../types";

export interface RunMeta {
  /** `<label>-<date>-<fingerprint>` — what the key names, what the ledger cites. */
  id: string;
  label: string;
  startedAt: string;
  gitSha: string;
  /** Of the prompt TEMPLATE (a fixed synthetic ask) — changes when the prompt changes, not the library. */
  promptFingerprint: string;
  model: string;
  temperature: number;
  thinking: unknown;
  n: number;
  maxCalls: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  briefs: string[];
  /** Which recording of the libraries the run used (probe-out/plan-eval/library/<set>). */
  librarySet: string;
}

export interface RecordedLibrary {
  briefId: string;
  recordedAt: string;
  entries: LibraryEntry[];
  products: ProductEntry[];
  /** False when the brief asks for a product and none was given on the command line. */
  productGiven: boolean;
}

export interface RunCell {
  briefId: string;
  repeat: number;
  prompt: string;
  raw: string | null;
  plan: AgentPlan | null;
  ms: number;
  usage: PlanUsage | null;
  model: string;
  /** Why the plan is null — the transport's failure, or "parsePlan refused the reply". Null on a plan. */
  error: string | null;
}

export interface RunFile {
  meta: RunMeta;
  libraries: Record<string, RecordedLibrary>;
  cells: RunCell[];
}

/** A synthetic ask that renders every branch of the prompt: a photo of her, a scene, a clip, a product. */
export const FINGERPRINT_ASK: PlanAsk = {
  prompt: "fingerprint",
  objective: "recap",
  aesthetic: "plain",
  library: [
    {
      ref: "a1",
      description: "her",
      shotType: "portrait",
      athletePresent: true,
      setting: "s",
      vibe: "v",
      picked: true,
      brands: [],
      provenance: "camera",
      mediaType: "photo",
      durationSeconds: null,
      beats: [],
      sport: null,
      verified: null,
    },
    {
      ref: "a2",
      description: "a place",
      shotType: "other",
      athletePresent: false,
      setting: "s",
      vibe: "v",
      picked: false,
      brands: [],
      provenance: "made-here",
      mediaType: "photo",
      durationSeconds: null,
      beats: [],
      sport: null,
      verified: null,
    },
    {
      ref: "a3",
      description: "she runs",
      shotType: "action",
      athletePresent: true,
      setting: "s",
      vibe: "v",
      picked: false,
      brands: [],
      provenance: "camera",
      mediaType: "clip",
      durationSeconds: 6,
      beats: [
        {
          index: 0,
          startSec: 0,
          endSec: 3,
          description: "run",
          camera: "wide",
          movement: "static",
          motion: null,
        },
      ],
      sport: null,
      verified: null,
    },
  ],
  products: [{ ref: "p1", description: "a boot" }],
  // One fixed campaign (PR 14, R-7), so the fingerprint covers the campaign block: a reading with tags
  // and a basis, and one constraint. Synthetic, and never changed — the fingerprint names the template.
  campaign: {
    schema: "campaign-brief/1",
    objective: { type: "ad", goal: "showcase-product" },
    story: null,
    brand: { name: "Fixture", brand_attributes: ["plain"], profile: null },
    subject: { identity_priority: "high", sport: null },
    product: null,
    creative_direction: { tone: ["calm"], style: null, energy: "steady" },
    references: [
      {
        ref: "ref_1",
        role: "style_reference",
        intent: {
          composition: {
            summary: "Centered.",
            tags: ["centered"],
            basis: "observed",
          },
          camera: {
            summary: "A static medium shot.",
            tags: ["medium", "static"],
            basis: "observed",
          },
          lens_perspective: null,
          lighting: {
            summary: "Soft studio light.",
            tags: ["studio", "soft_light"],
            basis: "inferred",
          },
          color: { summary: "Muted.", tags: [], basis: "observed" },
          environment: null,
          subject_placement: null,
          wardrobe: null,
          motion: null,
          editing_rhythm: null,
          typography: null,
          emotional_tone: { summary: "Calm.", tags: [], basis: "observed" },
        },
      },
    ],
    output: { type: "video", aspect_ratio: "9:16", platform: null },
    constraints: ["do not show a competitor's logo"],
  },
};

/** Twelve hex characters of the prompt template's sha256. */
export const promptFingerprint = (): string =>
  createHash("sha256")
    .update(agentPrompt(FINGERPRINT_ASK))
    .digest("hex")
    .slice(0, 12);
