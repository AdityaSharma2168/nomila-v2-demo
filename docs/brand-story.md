# Nomila — Brand Story & Naming Reference

> The canonical source for what Nomila *means* — the name, the mark, and the voice.
> Use it for homepage/about copy, and as the well we draw from when **naming** features,
> surfaces, and creatives (e.g. the athlete brand card, and whatever comes next). When you
> name something, link back here to the meaning it draws from.
>
> Status: refined with Fable 5 from the founder's brainstorm (below). Living document.

---

## The name

**Nomila** holds two words:
- **Nom** — *identity; a name you claim.*
- **Mila** — *a beloved essence; something cherished.*

Together: *who you are is worth claiming, and worth holding dear.*

---

## The narrative (canonical copy)

### The story
Nomila begins the way every story does: with a name. Ours holds two — *Nom*, the identity you
claim, and *Mila*, a beloved essence, something cherished. Together they say what we believe: who
you are is worth claiming, and worth holding dear.

The rings of our mark are the layers of a life — not one dimension, but many. Athlete. Creator.
Entrepreneur. Family. Dreamer. Every arc rises from the same point, because every facet of you
begins in the same place: you. And the rings don't stay still — they widen as you do, layer by
layer, reach by reach.

Nomila is where every layer of your identity is seen, celebrated, and given room to grow. Because a
name is never just a name. It's the journey behind it.

### Homepage hero (~62 words)
Nomila holds two words: *Nom* — the identity you claim — and *Mila* — a beloved essence, something
cherished. The rings of our mark are the layers of who you are — athlete, creator, entrepreneur,
family, dreamer — each rising from the same point, each expanding as you do. Here, every layer of
you is seen, celebrated, and given room to grow.

### One line
**Not just a name — the journey behind it.**

Alternates:
- Every layer of you, from one beginning.
- One self. Many rings. Room to grow.
- Claim the name. Cherish the journey.

---

## The mark

**Five arcs, one anchor.** Every ring in the Nomila mark fans out from a single shared point —
because athlete, creator, entrepreneur, family, and dreamer all begin in the same self — and each
ring reaches a little further as you grow.

**Load-bearing (don't lose this):** the shared origin point is not decoration — it *is* the thesis
made visual. Every facet starts from the same self and expands outward. Two rules follow:
1. The arcs **share one anchor** (in the mark, the bottom-left origin). Never draw them from
   separate centers — that breaks the meaning.
2. The rings **expand** — growth is outward, layer by layer. The five facets, in order:
   **athlete · creator · entrepreneur · family · dreamer.**

### Where the mark already lives in product
The same concentric-rings motif is realized as the marketability visual:
`client/components/score/ConcentricRingScore.tsx` (`ConcentricRingScore` / `ScoreRing`, used on
`BrandScreen`). The logo's idea — facets fanning from one self — is literally how we render an
athlete's score. Keep these visually and conceptually in sync; they are the same story.

---

## Naming philosophy (how we name things *from* this)

When we name a feature, surface, or creative, it should trace back to one of these wells — and the
name's doc/PR should **link here** to say which:

| Well | Meaning to draw on |
|---|---|
| **Claim** (Nom) | owning your identity, staking your name |
| **Cherish** (Mila) | warmth, worth, something valued — not cold/corporate |
| **Facets / layers** | multi-dimensional self (athlete, creator, entrepreneur, family, dreamer) |
| **Rings / expansion** | growth outward from one self; the concentric motif |
| **One anchor** | every facet begins in the same self — coherence, provenance, truth |
| **The journey** | the story behind the surface, not the surface alone |

Voice guardrails: warm, human, celebratory, quietly confident. **No** buzzwords —
`empower / unleash / elevate / synergy` and their kin are banned by default.

### DECIDED: the athlete brand card is the **"Nomi Card"**
Renamed from "media kit" (dated PDF-era term). **Nomi Card** draws from the **Claim** well —
*Nom* = the name you claim — fused with the card-stack format. Wholly ownable, born from Nomila's
own root, and legible in use ("Mia's Nomi Card", "send your Nomi Card"). Scales past athletes (a
creator/entrepreneur has a Nomi Card too).

Usage: **user-facing label = "Nomi Card."** Internal code names stay stable (`MediaKitData`,
`mediaKitService`, `kitRenderer`) — they don't need to match the brand label. Shortlist we chose
from (for the record): Proof · Arc · Nomi · Mark.

---

## Source — founder's original brainstorm (preserved)

> "At Nomila, we believe a name is just the beginning. Our name blends 'Nom' — identity, a name you
> claim — and 'Mila' — a beloved essence, something cherished. The rings of our logo represent the
> layers of who we are — not just one dimension, but many. Each ring is a facet — athlete, creator,
> entrepreneur, family, dreamer — expanding as you do. Nomila is a place where every layer of your
> identity is seen, celebrated, and given space to grow. It's not just a name — it's the journey
> behind it."

*(Brainstormed in an earlier Claude session; refined with Fable 5 into the canonical copy above.
The only idea promoted from the mark description into the story itself is the shared-anchor point —
because it is the visual thesis, it belongs in the narrative, not just the logo note.)*
