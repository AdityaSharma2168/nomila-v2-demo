/**
 * evals/agent/moments/mock.ts — the moments stage's --mock model: the case's scripted answer, with its "$F:/$M:/$D:"
 * placeholders resolved to the keys the scan's input actually gave (read off the input lines, as a model would) and its
 * "+N" dates resolved on the run's day. No provider is reached; the "searches" saw exactly the case's mock sources.
 */
import { fakeResponses, skillOf, type FakeTransport } from "../../../server/testUtils/agentModel";
import { caseDate } from "./runMomentsCase";
import type { MomentsCase } from "./types";

/** The input key whose line carries `text` (F lines carry the claim, M lines the claim, D lines the brand). */
function keyFor(input: string, prefix: "F" | "M" | "D", text: string): string {
  const line = input.split("\n").find((l) => new RegExp(`^${prefix}\\d+ \\| `).test(l) && l.includes(text));
  return line ? line.split(" | ")[0] : `${prefix}0`;
}

/** Resolve one scripted answer against the input. Exported for the CI test. */
export function resolveMock(c: MomentsCase, input: string, today: string): Record<string, unknown> {
  const textOf = (kind: string, key: string) =>
    kind === "F" ? c.fixture.facts.find((f) => f.key === key)?.claim
      : kind === "M" ? c.fixture.moments.find((m) => m.key === key)?.claim
        : c.fixture.deals.find((d) => d.key === key)?.brand;
  const json = JSON.stringify({ moments: c.mock.moments, retire: c.mock.retire, path_note: "mock: the case's scripted answer" })
    .replace(/\$([FMD]):(\w+)/g, (_m, kind: "F" | "M" | "D", key: string) => keyFor(input, kind, textOf(kind, key) ?? `missing ${key}`));
  const parsed = JSON.parse(json) as { moments: Array<Record<string, unknown>>; retire: unknown[]; path_note: string };
  for (const m of parsed.moments) if (typeof m.date === "string") m.date = caseDate(m.date, today);
  return parsed;
}

/** The fake transport for one case (pass it to setResponsesTransport). */
export function momentsMockTransport(c: MomentsCase, today: string): FakeTransport {
  return fakeResponses((body) => {
    if (skillOf(body) !== "moments") throw new Error(`moments mock: no answer for skill ${skillOf(body)}`);
    return {
      json: resolveMock(c, String(body.input ?? ""), today),
      sources: c.mock.sources.map((url) => ({ url, title: "A made-up page" })),
      queries: c.mock.sources.length ? ["upcoming moments"] : [],
      usage: { input: 30_000, cached: 0, output: 2_500, reasoning: 800 },
    };
  });
}
