// Opportunities' two top tabs (deals design §7b; owner, 12 Oct 2026): Deals | Bookings, both always there.
export type OppsTab = "deals" | "bookings";
export const OPPS_TABS: ReadonlyArray<{ key: OppsTab; label: string }> = [
  { key: "deals",    label: "Deals" },
  { key: "bookings", label: "Bookings" },
];

/** A section pill on the v3 surfaces (PillToggle): its label and what needs her there. */
export interface PillTab<K extends string> { key: K; label: string; count?: number | null }

/** "Deals, 4 need you" — the pill's spoken label. Pure. */
export function pillLabel(t: Pick<PillTab<string>, "label" | "count">): string {
  return t.count ? `${t.label}, ${t.count} need${t.count === 1 ? "s" : ""} you` : t.label;
}
