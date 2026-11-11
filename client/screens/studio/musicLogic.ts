/**
 * musicLogic — which track is under the Board's stitch, when the server has a suggestion.
 *
 * Pure, like every Board module. The rule (PR 8, Adi 22 Sep 2026): the suggested track is
 * PRESELECTED until she touches the Music row. The first tap — on any chip, "None" included — is
 * hers, and from then on the suggestion never re-asserts, however her words change.
 */

export interface MusicPick {
  /** Her chip, or null for none. Meaningless until `touched`. */
  bed: string | null;
  onBeat: boolean;
  /** She has tapped a Music chip. Once true it stays true for this board. */
  touched: boolean;
}

/**
 * The bed the stitch uses: hers once she has touched Music; before that, the suggestion — but only
 * one the picker actually offers while music can be used, never a name the chips cannot show.
 */
export function effectiveBed(
  pick: MusicPick,
  suggested: string | null,
  offered: readonly string[],
  musicReady: boolean,
): string | null {
  if (pick.touched) return pick.bed;
  if (musicReady && suggested !== null && offered.includes(suggested))
    return suggested;
  return pick.bed;
}

/** Her row sentences, as the feel the suggestion is read from. Empty rows say nothing. */
export const feelFromRows = (rows: readonly { prompt: string }[]): string[] =>
  rows.map((r) => r.prompt).filter((p) => p.trim() !== "");
