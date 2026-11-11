/**
 * shared/sports.ts — THE sport list: the onboarding sport grid's tiles, in order. The one source every reader uses:
 *
 *   the app        the sport grid (client/screens/onboarding/SportGridScreen.tsx) shows `label`
 *   the web        the landing page's grid reads landing/sports.js, which is GENERATED from this file
 *                  (`npx tsx scripts/build-landing-sports.ts`; scripts/sports.test.ts fails while the two differ)
 *   the icons      each sport's `icon` (the app's grid and Mila's chat chips); the landing page draws the same icons from
 *                  landing/sport-icons.js, GENERATED from this file (`python scripts/build-landing-sport-icons.py`;
 *                  scripts/sports.test.ts fails while a sport has no icon there)
 *   the library    the atmosphere library files a sport photo under its `id` (server/services/atmosphere/library.ts)
 *
 * `id` is stable (stored by the landing page and the photo library; never renamed); `label` is what a person reads and
 * what the app stores as the athlete's sport. "Other" is not a tile here: each surface adds its own free-text field,
 * and the library files a photo for a sport outside the list under OTHER_SPORT.
 */
/** The sports no MaterialCommunityIcons glyph shows well: drawn in the app (client/components/onboarding/SportIcon.tsx). */
export type CustomSportIcon = "lacrosse" | "artistic_swimming" | "pickleball";

/**
 * A sport's icon: a MaterialCommunityIcons name (the set @expo/vector-icons ships; scripts/sports.test.ts checks each
 * name is in it), or the key of one of the app's own drawn glyphs. Plain data, so the server can import this file.
 */
export type SportIcon = { mdi: string } | { custom: CustomSportIcon };

export interface Sport {
  id: string;
  label: string;
  icon: SportIcon;
}

export const SPORTS: readonly Sport[] = [
  { id: "football", label: "Football", icon: { mdi: "football" } },
  { id: "basketball", label: "Basketball", icon: { mdi: "basketball" } },
  { id: "soccer", label: "Soccer", icon: { mdi: "soccer" } },
  { id: "baseball", label: "Baseball", icon: { mdi: "baseball-bat" } },
  { id: "softball", label: "Softball", icon: { mdi: "baseball" } },
  { id: "volleyball", label: "Volleyball", icon: { mdi: "volleyball" } },
  { id: "beach_volleyball", label: "Beach volleyball", icon: { mdi: "beach" } },
  { id: "lacrosse", label: "Lacrosse", icon: { custom: "lacrosse" } },
  { id: "field_hockey", label: "Field hockey", icon: { mdi: "hockey-sticks" } },
  { id: "hockey", label: "Hockey", icon: { mdi: "hockey-puck" } },
  { id: "swimming_diving", label: "Swimming", icon: { mdi: "swim" } },
  { id: "rowing", label: "Rowing", icon: { mdi: "rowing" } },
  { id: "water_polo", label: "Water polo", icon: { mdi: "water-polo" } },
  { id: "sailing", label: "Sailing", icon: { mdi: "sail-boat" } },
  { id: "track_field", label: "Track and field", icon: { mdi: "run-fast" } },
  { id: "cross_country", label: "Cross country", icon: { mdi: "run" } },
  { id: "tennis", label: "Tennis", icon: { mdi: "tennis" } },
  { id: "squash", label: "Squash", icon: { mdi: "racquetball" } },
  { id: "gymnastics", label: "Gymnastics", icon: { mdi: "gymnastics" } },
  { id: "wrestling", label: "Wrestling", icon: { mdi: "kabaddi" } },
  { id: "fencing", label: "Fencing", icon: { mdi: "fencing" } },
  { id: "golf", label: "Golf", icon: { mdi: "golf" } },
  { id: "artistic_swimming", label: "Artistic swimming", icon: { custom: "artistic_swimming" } },
  { id: "pickleball", label: "Pickleball", icon: { custom: "pickleball" } },
  { id: "skiing", label: "Skiing", icon: { mdi: "ski" } },
  // Action sports (X Games), added 23 Oct 2026.
  { id: "snowboarding", label: "Snowboarding", icon: { mdi: "snowboard" } },
  { id: "skateboarding", label: "Skateboarding", icon: { mdi: "skateboarding" } },
  { id: "bmx", label: "BMX", icon: { mdi: "bicycle" } },
  { id: "motocross", label: "Motocross", icon: { mdi: "motorbike" } },
  { id: "surfing", label: "Surfing", icon: { mdi: "surfing" } },
];

/** The id a sport outside the list is filed under (the photo library), and the "Other" field's key. */
export const OTHER_SPORT = "other";

/** The list's id for a label or id (case and spacing ignored); null for a sport outside the list. */
export function sportIdOf(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  return SPORTS.find((s) => s.id === v || s.label.toLowerCase() === v)?.id ?? null;
}

/** Every id the photo library accepts: the list's, plus OTHER_SPORT. */
export function sportIds(): Set<string> {
  return new Set([...SPORTS.map((s) => s.id), OTHER_SPORT]);
}

/** The ES module the landing page imports (landing/sports.js), written from SPORTS. Deterministic, so the test can compare. */
export function landingSportsModule(): string {
  const rows = SPORTS.map((s) => `  [${JSON.stringify(s.id)}, ${JSON.stringify(s.label)}],`).join("\n");
  return [
    "// GENERATED from shared/sports.ts by scripts/build-landing-sports.ts. Do not edit: change shared/sports.ts and",
    "// run `npx tsx scripts/build-landing-sports.ts` (scripts/sports.test.ts fails while this file is stale).",
    "export const SPORTS = [",
    rows,
    "];",
    "",
  ].join("\n");
}
