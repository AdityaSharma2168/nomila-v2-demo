/**
 * agent/research/v2/sportTerms.ts — the words a page uses for a sport, so the identity filter (rank.ts) can tell
 * "this page is about the athlete's sport" from "this page is about another sport". Generic sport vocabulary only —
 * never an athlete, team, school or brand (no-hardcoding rule). A sport not listed here is matched by its own name.
 *
 * Words shared by two sports (a soccer and a lacrosse "midfielder", "football" for soccer outside the US) are in both
 * families: a shared word anchors either sport and is never counted as evidence of the other one.
 */

interface SportFamily {
  /** What an athlete may type as their sport. */
  names: string[];
  /** Words a page about this sport uses (names included). */
  terms: string[];
}

const FAMILIES: SportFamily[] = [
  { names: ["soccer", "association football"], terms: ["soccer", "football", "futbol", "fútbol", "nwsl", "mls", "fifa", "uswnt", "usmnt", "goalkeeper", "midfielder", "striker"] },
  { names: ["football", "american football"], terms: ["football", "nfl", "quarterback", "linebacker", "wide receiver", "running back", "cornerback", "touchdown", "gridiron"] },
  { names: ["basketball"], terms: ["basketball", "wnba", "nba", "hoops", "point guard", "rebounds", "three-pointer"] },
  { names: ["baseball"], terms: ["baseball", "mlb", "pitcher", "innings", "home run", "batting"] },
  { names: ["softball"], terms: ["softball", "pitcher", "innings", "home run", "batting"] },
  { names: ["volleyball", "beach volleyball"], terms: ["volleyball", "outside hitter", "setter", "libero", "avp"] },
  { names: ["tennis"], terms: ["tennis", "wta", "atp", "itf", "grand slam"] },
  { names: ["golf"], terms: ["golf", "golfer", "lpga", "pga", "birdie"] },
  { names: ["track", "track and field", "athletics", "cross country", "running"], terms: ["track and field", "track & field", "cross country", "sprinter", "hurdles", "marathon", "relay", "100m", "200m", "400m", "800m", "1500m", "long jump", "high jump", "pole vault", "shot put"] },
  { names: ["swimming", "swim"], terms: ["swimming", "swimmer", "freestyle", "backstroke", "breaststroke", "butterfly", "medley", "relay"] },
  { names: ["diving"], terms: ["diving", "diver", "springboard"] },
  { names: ["gymnastics"], terms: ["gymnastics", "gymnast", "balance beam", "uneven bars", "floor exercise", "vault"] },
  { names: ["wrestling"], terms: ["wrestling", "wrestler", "takedown"] },
  { names: ["hockey", "ice hockey"], terms: ["hockey", "nhl", "pwhl", "goaltender"] },
  { names: ["field hockey"], terms: ["field hockey", "hockey"] },
  { names: ["lacrosse"], terms: ["lacrosse", "midfielder", "attackman", "faceoff"] },
  { names: ["rugby", "rugby sevens"], terms: ["rugby", "sevens"] },
  { names: ["cricket"], terms: ["cricket", "wicket", "batsman", "bowler"] },
  { names: ["rowing"], terms: ["rowing", "rower", "regatta", "coxswain"] },
  { names: ["cycling"], terms: ["cycling", "cyclist", "peloton"] },
  { names: ["skiing", "alpine skiing"], terms: ["skiing", "skier", "slalom"] },
  { names: ["snowboarding"], terms: ["snowboarding", "snowboarder"] },
  { names: ["boxing"], terms: ["boxing", "boxer"] },
  { names: ["mma", "mixed martial arts"], terms: ["mma", "ufc", "mixed martial arts"] },
  { names: ["fencing"], terms: ["fencing", "fencer", "sabre", "épée", "epee"] },
  { names: ["figure skating"], terms: ["figure skating", "figure skater"] },
  { names: ["surfing"], terms: ["surfing", "surfer", "wsl"] },
  { names: ["skateboarding"], terms: ["skateboarding", "skateboarder"] },
  { names: ["climbing"], terms: ["climbing", "climber", "bouldering"] },
  { names: ["triathlon"], terms: ["triathlon", "triathlete", "ironman"] },
  { names: ["water polo"], terms: ["water polo"] },
  { names: ["handball"], terms: ["handball"] },
  { names: ["cheer", "cheerleading"], terms: ["cheerleading", "cheerleader"] },
  { names: ["esports"], terms: ["esports"] },
];

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/\s+/g, " ").trim();

/** Every term for the athlete's sport (their own word always included). */
export function sportTermsOf(sport: string): string[] {
  const s = norm(sport);
  if (!s) return [];
  const own = FAMILIES.filter((f) => f.names.includes(s) || f.terms.includes(s));
  return [...new Set([s, ...own.flatMap((f) => f.terms)])];
}

/** Terms that would mean ANOTHER sport: every other family's terms, minus any word the athlete's sport also uses. */
export function otherSportTermsOf(sport: string): string[] {
  const ours = new Set(sportTermsOf(sport));
  const s = norm(sport);
  const others = FAMILIES.filter((f) => !f.names.includes(s) && !f.terms.includes(s)).flatMap((f) => f.terms);
  return [...new Set(others.filter((t) => !ours.has(t)))];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A word-boundary matcher for a list of terms ("nba" never matches inside "wnba"'s neighbour words, "track" never
 *  inside "soundtrack"). Null when the list is empty. */
export function termMatcher(terms: string[]): RegExp | null {
  const list = terms.map(norm).filter((t) => t.length > 1);
  if (!list.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.sort((a, b) => b.length - a.length).map(esc).join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

/** Words that name many teams and so tie a page to none ("University", "FC", "High School" …). */
const GENERIC_TEAM_WORDS = new Set([
  "the", "of", "at", "and", "university", "college", "school", "high", "hs", "academy", "club", "team", "fc", "sc", "cf",
  "afc", "athletic", "athletics", "sports", "state", "national", "women", "womens", "women's", "men", "mens", "men's",
  "girls", "boys", "varsity", "jv", "junior", "senior", "u16", "u17", "u18", "u19", "u20", "u21", "u23",
]);

/** The words of a team or school name that actually distinguish it ("Stanford" from "Stanford University"). */
export function distinctiveTeamWords(team: string | null | undefined): string[] {
  return [...new Set(norm(team ?? "").replace(/[^\p{L}\p{N}' ]/gu, " ").split(" ").filter((w) => w.length >= 3 && !GENERIC_TEAM_WORDS.has(w)))];
}
