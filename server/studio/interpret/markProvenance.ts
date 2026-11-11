/**
 * studio/interpret/markProvenance — which brand marks an interpreted edit asked to bring in or take away,
 * and who asked, for QA's marks check (the interpreter, I.5; plan v2 N7, C-6).
 *
 * Cell 1a is an adidas ad over a Nike kit: the swap brings adidas in and takes Nike away, and neither is
 * in her words — the swap is the brand's (M2). Judged by her words alone, QA would call the Nike marks
 * "vanished". So the frozen interpretation says what the edit asked for, and QA reads that:
 *
 *   arrivals    a swap's brand; a brand in a design, in a worn add, in what she pointed at
 *   departures  the brands the model saw on an item the edit swaps, and a brand's marks she removes or an
 *               exclusion keeps out
 *
 * Each with the source of the edit or constraint that asked — "yours", "suggested" or "brand". Read off the
 * record the preview froze, never from a model; the first source to name a brand stands, and hers come
 * first. A job the interpreter did not propose has none, and QA judges it exactly as before.
 */
import type { MarkProvenance, MarkSource } from "../qa/types";
import { brandsIn } from "./ad";
import type { InterpretationRecord } from "./interpret";

export function markProvenanceFor(
  record: InterpretationRecord | undefined,
): MarkProvenance | null {
  if (!record || record.outcome !== "proposed") return null;
  const arrivals = new Map<string, MarkSource>();
  const departures = new Map<string, MarkSource>();
  const note = (to: Map<string, MarkSource>, brand: string, s: MarkSource) => {
    if (!to.has(brand)) to.set(brand, s);
  };
  const seenOn = (item: string) =>
    record.visibleMarks.filter((m) => m.item === item).map((m) => m.brand);

  for (const e of record.edits) {
    switch (e.kind) {
      case "brand_swap":
        note(arrivals, e.brand, e.source);
        for (const b of [...(e.reason?.away ?? []), ...seenOn(e.item)]) {
          if (b !== e.brand) note(departures, b, e.source);
        }
        break;
      case "pointed_swap": {
        const to = brandsIn(e.what);
        for (const b of to) note(arrivals, b, e.source);
        for (const b of seenOn(e.target)) {
          if (!to.includes(b)) note(departures, b, e.source);
        }
        break;
      }
      case "design":
        for (const b of brandsIn(e.design)) note(arrivals, b, e.source);
        break;
      case "add":
        for (const b of brandsIn(e.thing)) note(arrivals, b, e.source);
        break;
      case "remove":
        for (const b of brandsIn(e.target)) note(departures, b, e.source);
        break;
      default:
        break;
    }
  }
  for (const c of record.constraints) {
    if (c.kind === "exclude_marks") note(departures, c.brand, c.source);
  }
  const list = (m: Map<string, MarkSource>) =>
    [...m].map(([brand, source]) => ({ brand, source }));
  return { arrivals: list(arrivals), departures: list(departures) };
}
