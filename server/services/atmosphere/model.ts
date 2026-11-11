/**
 * atmosphere/model.ts — the two cheap-tier model calls: write the search queries (skill atmosphere/queries) and check
 * one candidate image (skill atmosphere/check, vision).
 *
 * Both go through the agent's structured call (agent/research/llm.ts callStructured): the skill file is the prompt
 * (server/agent/jobs/atmosphere/*.md, listed in the Prompt Register), models.ts picks the cheap tier's model (Gemini
 * Flash on Vertex, by the provider rule: routine tagging, no web search), and
 * the cost comes back with the answer so the caller can count it against the caps. Tests swap the transport
 * (setGeminiClient) and never reach a provider.
 *
 * The check's verdict is decided HERE, from the six answers, not from anything the model calls a verdict: an image is
 * accepted only when no person, face, logo, text or watermark was seen and it fits the purpose.
 */
import type { RunCost } from "../../../shared/agent";
import { loadJob } from "../../agent/jobs";
import { modelFor } from "../../agent/models";
import { callStructured } from "../../agent/research/llm";
import type { SlotType } from "./config";

/**
 * The athlete's world as the query writer sees it: the sport from the athlete row, and up to a dozen facts about the
 * athlete from memory (team, level, competition, season), with the athlete's name taken out (store.readAthleteScene).
 */
export interface AthleteSceneData {
  sport: string | null;
  facts: Array<{ topic: string; claim: string }>;
}

export interface SlotRequest {
  type: SlotType;
  /** What the image is for, e.g. a goal's domain. */
  purpose: string;
  /** An optional short line of context (a goal's title, a section's name). */
  context?: string | null;
}

export interface WrittenQueries {
  queries: string[];
  imagePrompt: string;
  model: string;
  cost: RunCost;
}

const QUERIES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries", "image_prompt"],
  properties: {
    queries: { type: "array", items: { type: "string" } },
    image_prompt: { type: "string" },
  },
};

/** Clean the model's queries: trimmed, one line, ≤ 100 chars (Pixabay's limit), de-duplicated, at most 4. */
export function cleanQueries(raw: unknown): string[] {
  const out: string[] = [];
  for (const q of Array.isArray(raw) ? raw : []) {
    if (typeof q !== "string") continue;
    const s = q.replace(/\s+/g, " ").trim().slice(0, 100);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length === 4) break;
  }
  return out;
}

export async function writeQueries(athlete: AthleteSceneData, slot: SlotRequest, today: string): Promise<WrittenQueries> {
  const skill = loadJob("atmosphere/queries");
  const model = modelFor(skill);
  const input = JSON.stringify({
    athlete: { sport: athlete.sport, facts: athlete.facts },
    slot: { type: slot.type, purpose: slot.purpose, context: slot.context ?? null },
    today,
  });
  const res = await callStructured({ skill, model, input, schemaName: "atmosphere_queries", schema: QUERIES_SCHEMA, maxOutputTokens: 600 });
  const json = res.json as { queries?: unknown; image_prompt?: unknown };
  return {
    queries: cleanQueries(json.queries),
    imagePrompt: typeof json.image_prompt === "string" ? json.image_prompt.trim().slice(0, 1200) : "",
    model: model.model,
    cost: res.cost,
  };
}

export const CHECK_FLAGS = ["person", "face", "logo", "text", "watermark"] as const;
export type CheckFlag = (typeof CHECK_FLAGS)[number];

export interface CheckResult {
  accepted: boolean;
  /** Why it was rejected: the flags that tripped, then "off_purpose"; "unreadable" when the answer was malformed. Null when accepted. */
  rejectReason: string | null;
  answer: Record<CheckFlag, boolean> & { fits_purpose: boolean; reason: string };
  model: string;
  skillVersion: string;
  cost: RunCost;
}

const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...CHECK_FLAGS, "fits_purpose", "reason"],
  properties: {
    ...Object.fromEntries(CHECK_FLAGS.map((f) => [f, { type: "boolean" }])),
    fits_purpose: { type: "boolean" },
    reason: { type: "string" },
  },
};

/**
 * The verdict from the six answers. Anything that is not exactly `false` for a flag (missing, a string, null) counts
 * as the flag being present: a malformed answer can only reject, never accept.
 */
export function verdictOf(json: Record<string, unknown>): Pick<CheckResult, "accepted" | "rejectReason" | "answer"> {
  const answer = {
    ...Object.fromEntries(CHECK_FLAGS.map((f) => [f, json[f] !== false])),
    fits_purpose: json.fits_purpose === true,
    reason: typeof json.reason === "string" ? json.reason.slice(0, 300) : "",
  } as CheckResult["answer"];
  const tripped: string[] = CHECK_FLAGS.filter((f) => answer[f]);
  if (!answer.fits_purpose) tripped.push("off_purpose");
  return { accepted: tripped.length === 0, rejectReason: tripped.length ? tripped.join(",") : null, answer };
}

export async function checkImage(image: { bytes: Buffer; contentType: string }, slot: SlotRequest, query: string): Promise<CheckResult> {
  const skill = loadJob("atmosphere/check");
  const model = modelFor(skill);
  const input = [{
    role: "user",
    content: [
      { type: "input_text", text: JSON.stringify({ slot: { type: slot.type, purpose: slot.purpose, context: slot.context ?? null }, query }) },
      // detail "high": small text, a distant figure or a corner watermark is exactly what this check exists to catch,
      // and at the cheap tier's input price a full-detail image still costs a fraction of a cent.
      { type: "input_image", image_url: `data:${image.contentType};base64,${image.bytes.toString("base64")}`, detail: "high" },
    ],
  }];
  const res = await callStructured({ skill, model, input, schemaName: "atmosphere_check", schema: CHECK_SCHEMA, maxOutputTokens: 400 });
  return { ...verdictOf(res.json as Record<string, unknown>), model: model.model, skillVersion: skill.version, cost: res.cost };
}
