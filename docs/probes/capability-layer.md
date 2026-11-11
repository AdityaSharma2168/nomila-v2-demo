# Studio capability layer — ledger

Design: "The Studio capability layer" v3 (12 Oct 2026). PR 1a, "the block the agent reads". Every entry this layer
adds to server/studio/agent/capabilityEntries.ts cites one line here, and Aditya's rule holds: no claim without a
measured line. Until a capability's own PR lands its probe, its line says NOT measured, and the entry says so.

When a probe lands, its numbers replace the line (and the entry's cite moves with them). A line here that an entry
cites must not move without the entry's cite moving too: capabilityEntries.test.ts reads every cite.

## Lines the entries cite

- music.mood — NOT measured as a post-kit choice: the preview picks the best catalogue track for the mood; no listening check yet.
- look.preset — NOT measured: one fixed colour filter per name on every clip and photo of a post; no cast check on clips yet.
- caption (post kits) — NOT measured: the hook is drawn inside the Reels safe zones; a line the font cannot draw is left off with a note.
- clip.stabilise — NOT measured yet: the steadying probe (shake threshold, both passes timed on 2 vCPU) lands with PR 4.
- clip.slow_mo — NOT measured yet: the retime probe (60 and 120 fps sources, sound dropped for the beat) lands with PR 5.
- caption.auto — NOT measured yet: the speech probe (word accuracy, timing against sentence edges) lands with PR 8.
- image.cutout — NOT measured yet: the cut-out quality gate fixtures (clean, empty, edge-touching, other people) land with PR 9.
- image.background_place — NOT measured yet: the placed-or-pasted check on each background source lands with PR 9.
- card.ad.cutout_hero — NOT measured yet: the ad card's logo and headline checks land with PR 9.
- card.title — NOT measured yet: the title card's render time and text fit land with PR 10.
- card.countdown — NOT measured yet: the countdown's day count and re-render when stale land with PR 10.

## Evals

None yet. The capability evals (design §3 rule 6, PR 6b) report here: about 30 realistic jobs across sports and
formats, graded on whether the right entries were chosen.
