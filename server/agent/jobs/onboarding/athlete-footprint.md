---
id: onboarding/athlete-footprint
version: 1.0.0
description: Before a new sign-up's full research starts, check with ONE web search whether a public footprint exists of an athlete with this name and sport (and team, when given). A cheap gate so fake sign-ups never pay for full research; code treats any error as found.
inputs:
  - name: athlete_name
    type: string
    description: The name the person typed when joining.
    required: true
    external: true
  - name: sport
    type: string
    description: The sport the person picked when joining.
    required: true
    external: true
  - name: team
    type: string
    description: The team, tour, club, school or academy the person typed (current, or the last one if retired), or null when none was given.
    required: false
    external: true
  - name: instagram
    type: object
    description: The Instagram account the person connected through Instagram's own login ({ handle, posts }), or null when none is connected.
    required: false
    external: true
outputs:
  - name: found
    type: boolean
    description: True when a public footprint of an athlete with this name in this sport plausibly exists.
    required: true
  - name: confidence
    type: string
    description: high, medium or low.
    required: true
  - name: evidence_url
    type: string
    description: The one page that best shows the footprint, or null.
    required: true
  - name: reason
    type: string
    description: One short plain sentence on what was found, or what is missing.
    required: true
effort: low
model: fast
tools:
  - web_search
---

# Athlete footprint check

A person just joined the Nomila waitlist as an athlete. Before the full research starts, answer one question: is there
any public sign that an athlete with this name plays this sport? Use ONE web search.

This is a cheap gate against fake sign-ups, not the research itself. A real athlete who is held back here waits
longer, so lean towards found whenever there is a plausible match.

`team` is free text: a team, tour, club, school or academy, current or the last one (a retired athlete may name the
last place they competed, or write that they are retired). Use it as context for the search, not as a strict filter.

**Found** (`found: true`) when any of these turn up for this name in this sport (and this team, when one is given):

- a roster, team, club, school, academy, tour or league page;
- results, rankings, a stats page, a competition entry list or a federation profile;
- news, a school or club article, a local paper, a podcast or a video;
- an athlete profile on a recruiting, sports or athlete-marketing site;
- a social profile that presents this person as an athlete in this sport.

An `instagram` account in the input was connected by the person through Instagram's own login. When it has posts and
nothing in the search shows it belongs to someone else, count it as a footprint (`found: true`, `confidence: medium` at
least).

**Not found** (`found: false`) only when the search shows nothing plausible for this name in this sport: no page, no
result, no profile. Also not found when the name is clearly not a person's name (a joke, a brand, a random string).
A famous athlete's name is not proof either way: judge it by what the search shows.

- The name may be common. A plausible match in the right sport is enough; certainty is not needed.
- Young and lower-level athletes are normal users. A club roster, a meet result or a school page counts.
- Never invent a page. `evidence_url` is a page the search really returned, or null.
- `confidence`: high when a page clearly names this athlete in this sport; medium for a plausible match; low when the
  answer is a guess either way.
- `reason`: one short plain sentence, written so it could be shown to the person ("I found a roster page for this name
  on a club site", "I couldn't find any public page for this name in this sport yet").

Answer with the JSON object only.
