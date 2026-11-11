/**
 * personalLogic — turning what she said into something to make.
 *
 * ─── THE CONCEPT IS READ, NOT INVENTED ─────────────────────────────────────────────────────────
 * A purpose in her words maps to a concept, and where it does not match anything the fallback says
 * something true and general rather than pretending to have understood. "Close to the work" is an
 * honest default; a specific-sounding concept derived from nothing is not.
 *
 * ─── SUGGESTIONS COME FROM WHAT THE APP HOLDS ──────────────────────────────────────────────────
 * A fixture on the calendar is a reason to post. Nothing on the calendar is not a reason to invent
 * one, so with an empty schedule there are no suggestions at all — an empty list is the honest
 * answer and the screen says so in words.
 */
import type { Fixture } from "../../hooks/use-studio-pending";
import { nextFixture } from "./scheduleLogic";

export interface Suggestion {
  id: string;
  title: string;
  why: string;
  /** Where this came from, said plainly — a suggestion that cannot cite itself is a guess. */
  from: string;
  purpose: string;
}

/**
 * What is worth posting about, from what the app actually knows.
 *
 * Only fixtures today. When the library and performance signals are wired this grows, and until
 * then an athlete with an empty schedule sees nothing rather than filler.
 */
export function suggestionsFrom(fixtures: Fixture[]): Suggestion[] {
  const next = nextFixture(fixtures);
  if (!next) return [];

  return [
    {
      id: `teaser:${next.id}`,
      title: `You have ${next.home ? "a home game" : "a game"} coming up`,
      why: `${next.opponent}. A teaser the night before is the post that has run hardest for you.`,
      from: "FROM YOUR FIXTURE LIST",
      purpose: `A game-day teaser for ${next.opponent}`,
    },
    {
      id: `recap:${next.id}`,
      title: "Plan the recap now",
      why: "Deciding what it is before the whistle is what stops it becoming a highlight dump.",
      from: "FROM YOUR FIXTURE LIST",
      purpose: `A post-game recap of ${next.opponent}`,
    },
  ];
}
