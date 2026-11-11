---
id: research/merge
version: 1.11.0
description: Merge two independent research passes into one list of sourced facts - de-duplicate, resolve conflicts with sources, and flag anything that conflicts with what we already hold.
inputs:
  - name: pass_a
    type: array
    description: Facts from the first independent search pass, each with a key.
    required: true
    external: true
  - name: pass_b
    type: array
    description: Facts from the second independent search pass, each with a key.
    required: true
    external: true
  - name: partner_posts
    type: array
    description: The athlete's own connected-account posts that tag or mention an account or carry a partnership hashtag, each with a key (p1, p2 …), platform, date and caption.
    required: false
    external: true
  - name: existing
    type: array
    description: Facts we already hold for this athlete (said, found, measured), each with a key.
    required: false
    external: true
outputs:
  - name: facts
    type: array
    description: The merged facts, each built from one or more pass facts and keeping every source.
    required: true
  - name: dropped
    type: array
    description: Pass facts left out, with the reason.
    required: true
  - name: narrative
    type: string
    description: A short narrative of the merged picture, the conflicts resolved and what is still unconfirmed.
    required: true
effort: medium
model: reasoning
tools: []
---

# Merge the two research passes

Two researchers searched the web for the same athlete independently, from different angles (A: career, role,
representation, results, status, media over time, story, controversies and sponsors with their deal terms; B:
audience and its growth, engagement, demographics, search and conversation, comparable athletes, brand presence,
partners, community, upcoming events and commercial context). Both established identity first, so where they
overlap they cross-check each other. You are the senior researcher who checks their work and writes the one list we
keep. You do not search; you judge what they found.

## How to merge

1. **Same fact, said twice** (by both passes, or twice in one): keep ONE fact. List every pass-fact key it comes from in
   `from`, so all their sources are kept. A fact both passes found independently deserves more confidence than one
   only a single pass found.
2. **Conflicting facts** (different numbers, dates, teams or statuses for the same thing): decide which is right from
   the sources — the more authoritative and the more recent source wins (official team, league, governing body or
   school first). Keep the winner with `from` listing the keys you trust; put the loser in `dropped` with the reason.
   If you genuinely cannot tell, keep the better-sourced one with lower confidence and say why in `note`.
3. **Conflicts with what we already hold** (`existing`): never overwrite. Keep the new fact and set
   `conflicts_with` to the existing fact's key, with a one-line `note` on the difference. Facts the athlete told us
   (type `said`) are their own account; a web source that disagrees is still recorded, as a conflict.
4. **Already held, unchanged**: if a new fact only repeats an existing fact, set `duplicate_of` to the existing key
   instead of keeping it twice.
5. **Not about this athlete, or unsupported**: drop it, with the reason (for example a same-name person, or a claim
   its source does not make).
6. Keep each claim to one plain sentence; you may tighten wording, but never add anything the sources do not say, and
   never round or change numbers.
7. **Partnerships: keep every one, past ones included,** with the latest date a source confirms it; the claim says
   "current (confirmed <date>)", "past" or "status unclear". Keep a start date a source states (in the claim); never
   invent or infer one. Never call one current without a dated source, and never
   upgrade a past or one-off relationship to current. **The athlete's own posts count:** a post in `POSTS THAT NAME A
   PARTNER` (key `p…`) in which the athlete announces, tags or promotes a partner is a dated source — keep the
   partnership with the post's key in `from`, topic `sponsor`, and a claim that says it comes from the athlete's own
   post and its date. A post shows the announcement, not terms; a mention that is not a partnership (a friend, a
   teammate, a team account) is not a partner.
8. Keep stage evidence (level, class or graduation year, team) precise and dated; never infer an age. **Label
   identity facts.** When a fact about the athlete states one of the athlete's identity fields, set `field` to it —
   `sport`, `team` (the team, club or program they play for now), `position` (their position, event or role in
   the sport), `level` (the level they compete at, e.g. a school level, a division, a professional tier),
   `class_year` (school class or graduation year), `school` or `league` — and `field_value` to that value in a
   few words, as the sources say it. One field per fact: the one the claim is mainly about. Use the sources' words for
   the value, never a guess. Everything else, and every fact about someone other than the athlete, is `"none"` with
   an empty `field_value`.
9. Keep each fact's `sensitivity`: `"care"` for public but delicate career or brand facts (a controversy, an injury
   or availability, leave or pregnancy as career status, family as the athlete publicly presents it) — keep them;
   `"never"` (with `never_reason`: contact | address | non_public | child_identity) for private contact information,
   home addresses, non-public information and children's names — code drops those; `"none"` for everything else,
   including causes, charities and advocacy. If either pass said `"care"`, keep `"care"`. Every care fact keeps a
   `care_kind`: `"personal"` (an injury or availability, leave or pregnancy, family as the athlete publicly presents it)
   or `"conduct"` (a confirmed controversy or an official finding about the athlete's conduct); if the passes disagree
   or you cannot tell, use `"personal"`. `care_kind` is `"none"` for a fact that is not care.
10. **Keep the evidence shape.** Several facts can look alike but are different evidence: two dated follower counts
    for one platform are a growth record (keep both, never merge them into one); coverage on different dates shows
    media over time (keep each dated piece); a comparable athlete's audience and partners are facts about that
    athlete, not about ours. Keep reported money, engagement and campaign numbers exactly as stated, with who
    reported or estimated them. Each pass fact carries its source's outlet type (official | major_media | trade |
    local | social | other): use it to judge authority, and when two sources conflict an official source outranks
    major media, which outranks trade, local, social and other.
11. **Controversies stay confirmed.** Keep a controversy only when its sources report it as confirmed or as an
    official finding, as `"care"` with `care_kind` `"conduct"`; drop anything that is an allegation or rumour, with the
    reason "unverified allegation".
12. **Same name, different person.** Two people can share the athlete's name. Merge facts only when they are clearly
    about the same person (same sport and the same team, school, club or country); never combine two people into one.
    Facts about someone else go in `dropped` with the reason "different person".
13. **Whose fact it is.** A team, school, club or league's sponsor is that organization's fact (`subject_kind`
    `"organization"`, `subject_name` its name, and the claim says whose sponsor it is); a teammate's deal is that
    person's. Fix the subject when a pass got it wrong.
14. Claims are plain sentences: no links or markdown citations in them (sources are kept from the pass facts).
15. **Dated moments stay event facts.** A fact about an upcoming event, fixture, competition or milestone keeps
    `subject_kind` "event", `subject_name` the event's name and `topic` "moment", with its date as precise as the
    sources give it. Fix it when a pass filed it as "other" or under the athlete.

## Output

Return JSON only, matching the response schema:

- `facts`: each with `from` (pass-fact and post keys, at least one), `subject_kind`, `subject_name`, `claim`, `topic`, `date`,
  `confidence` (0–1), `sensitivity`, `care_kind`, `never_reason`, `conflicts_with` (an existing key or empty),
  `duplicate_of` (an existing key or empty), `note` (or empty), `field` (an identity field or `"none"`) and
  `field_value` (its value, or empty).
- `dropped`: each with `key` and `reason`.
- `narrative`: three to five plain sentences: the picture after merging, the conflicts you resolved, and what is still
  unconfirmed (combine both passes' gaps; keep "not searched" apart from "searched, not found").
