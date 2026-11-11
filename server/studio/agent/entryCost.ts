/**
 * studio/agent/entryCost — an entry's cost in words, read from the price registry at render time (never a copied
 * figure). Shared by the Board's block and the capability block (capabilityBlock.ts); re-exported by entryPrompt.ts.
 */
import { MODELS } from "../config";
import { estimateCost } from "../pricing";
import type { CapabilityEntry } from "./capabilityEntries";

/** The length every generated entry is priced at — preview.ts DEFAULT_CLIP_SECONDS. */
const PRICED_SECONDS = 4;

const money = (n: number) => `$${n.toFixed(2)}`;

/** An entry's cost in words, from the registry now — never a copied figure. */
export function costWords(e: CapabilityEntry): string {
  if (e.cost.kind === "free") return `$0 (${e.cost.why})`;
  const model = MODELS[e.cost.model];
  const size = e.cost.model === "veo" ? {} : { width: 720, height: 1280 };
  const inputs = { prompt: "", durationSeconds: PRICED_SECONDS, ...size };
  const silent = estimateCost(
    inputs,
    model,
    e.cost.audioArm
      ? { providerParams: { parameters: { generateAudio: false } } }
      : undefined,
  );
  if (silent.unpriced) return "priced when she makes it";
  const sound = e.cost.audioArm
    ? estimateCost(inputs, model, {
        providerParams: { parameters: { generateAudio: true } },
      })
    : null;
  return `${money(silent.amountUsd)} per ${PRICED_SECONDS} s shot${sound && !sound.unpriced ? `, ${money(sound.amountUsd)} with sound` : ""}`;
}
