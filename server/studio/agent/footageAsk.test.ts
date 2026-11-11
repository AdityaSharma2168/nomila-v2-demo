/**
 * footageAsk.test — the wording family that asks for her own footage, one fixture per phrasing.
 *
 * ⚠️ MUTATION: make `asksForOwnFootage` return true always — every "must not fire" case reds by
 * name, "make me an ad" first. Make it return false always — every "fires" case reds.
 */
import { asksForOwnFootage } from "./footageAsk";

describe("asksForOwnFootage — the phrasings that mean her own footage", () => {
  const FIRES = [
    "use my real footage",
    "using my real footage",
    "a recap of this week's training, using what I actually filmed",
    "use my real footage — nothing made up, just my own clips cut together",
    "my own clips",
    "my own footage, please",
    "just my videos",
    "only from the videos I uploaded",
    "the clips I added last week, cut together",
    "recap my training, use live footage",
    "actual match footage, not a generated one",
    "the raw clips from Saturday",
    "stuff I shot at practice",
    "the moments we recorded on the trip",
    "nothing generated — a plain recap",
    "no AI, just a cut of the game",
    "don't generate anything, use what's there",
    "do not make anything up",
    "Use My REAL Footage",
  ];
  const MUST_NOT = [
    "make me an ad",
    "an adidas ad — me in the three stripes, on the pitch, that feels like a real spot",
    "season-opener hype — cinematic, loud, get people excited for the first game",
    "a day in my life — morning, training, downtime, in my own photos",
    "me beating three defenders, cutting inside and scoring top corner",
    "go live on Friday with something big",
    "a real one for the fans",
    "announce the partnership — a short, proud reveal that I've signed",
    "the drop — my new boots are out, show them off and then me wearing them",
    "an idea for a night-match reel — floodlights, rain, the walk out of the tunnel",
    "",
  ];

  it.each(FIRES)("fires on: %s", (s) => {
    expect(asksForOwnFootage(s)).toBe(true);
  });

  it.each(MUST_NOT)("does not fire on: %s", (s) => {
    expect(asksForOwnFootage(s)).toBe(false);
  });
});
