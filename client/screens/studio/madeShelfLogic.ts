/**
 * madeShelfLogic — what the Made shelf shows, as a pure function.
 *
 * Extracted from the component for the same reason weekLogic and filteredLogic are: the rules about
 * which lens hides what are easy to get subtly wrong and impossible to see in a screenshot. The
 * component renders; this decides.
 *
 * The rule that carries the most weight: ARCHIVED IS OUT unless archived is what you asked for. An
 * archive that shows up uninvited is not an archive, and it would also double-count every state
 * total on the strip.
 */
import type { MadeItem, MadeState, StudioSurface } from "../../hooks/use-studio-pending";

export type Lens = "all" | "scheduled" | "attention" | "archived";

/** Which states each lens admits. `all` and `archived` are handled by the archive rule, not here. */
const STATE_OF_LENS: Record<"scheduled" | "attention", MadeState[]> = {
  scheduled: ["scheduled"],
  attention: ["awaiting", "making"],
};

/** The four sections, in the order they earn attention. */
export const SECTION_ORDER: { key: StudioSurface; heading: string }[] = [
  { key: "brand",    heading: "Brand posts" },
  { key: "personal", heading: "Personal posts" },
  { key: "pitch",    heading: "Pitches" },
  { key: "anything", heading: "Anything" },
];

export interface ShelfCounts {
  scheduled: number;
  attention: number;
  /** Everything not archived — the shelf's own size, not the row count of the table. */
  all: number;
  archived: number;
}

export interface ShelfSection {
  key: StudioSurface;
  heading: string;
  items: MadeItem[];
}

export function shelfCounts(data: MadeItem[]): ShelfCounts {
  const live = data.filter((i) => i.state !== "archived");
  return {
    scheduled: live.filter((i) => i.state === "scheduled").length,
    attention: live.filter((i) => i.state === "awaiting" || i.state === "making").length,
    all: live.length,
    archived: data.filter((i) => i.state === "archived").length,
  };
}

/** Free-text match across the fields a person would actually type. */
function matches(i: MadeItem, q: string): boolean {
  if (!q) return true;
  return `${i.title} ${i.subtitle ?? ""} ${i.mediaType}`.toLowerCase().includes(q);
}

export function visibleItems(data: MadeItem[], lens: Lens, query: string): MadeItem[] {
  const q = query.trim().toLowerCase();
  return data
    .filter((i) => (lens === "archived" ? i.state === "archived" : i.state !== "archived"))
    .filter((i) =>
      lens === "all" || lens === "archived" ? true : STATE_OF_LENS[lens].includes(i.state),
    )
    .filter((i) => matches(i, q));
}

/** Sections with nothing in them do not render — an empty heading is noise, not structure. */
export function shelfSections(data: MadeItem[], lens: Lens, query: string): ShelfSection[] {
  const visible = visibleItems(data, lens, query);
  return SECTION_ORDER
    .map((s) => ({ ...s, items: visible.filter((i) => i.surface === s.key) }))
    .filter((s) => s.items.length > 0);
}
