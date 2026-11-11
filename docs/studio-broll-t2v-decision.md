# Decision — b-roll is made from a sentence, not from a photo (t2v over i2v)

**Status:** DECIDED (Adi, 21 Sep 2026). The blind probe drafted for this was **cancelled, never
run, $0 spent**, because Adi ran the comparison himself. The build that follows from it is
`docs/studio-broll-t2v-card.md`: its own small PR, after C1 (stills) and before C1b.

## The question

Does b-roll made image-to-video — with one of her object or scene photos as the reference — look
worse than the same shot made text-to-video?

## The verdict

1. **i2v b-roll starts on the reference, by construction.** Image-to-video conditions on the image as
   frame 1. That is the model's semantics on both providers, not a defect of ours. On our b-roll route
   the first reference becomes OpenRouter's `frame_images[0]` ("first or last frame images for
   IMAGE-TO-VIDEO", `server/studio/adapters/openrouter.ts:143-160`, `:197`). On Vertex it becomes
   Veo's `image` (`vertex.ts:270`).
2. **Quality: judged equal.**
3. **Preference: t2v.** A b-roll beat does not have to open on one of her photographs, and a sentence
   is not limited to the scenes her library happens to hold. The device check found 7 scene photos in
   a library of 365 (open-cards card 5).

## What was already true, and made this cheap to act on

- **A photo-less video path already exists on the product.** A Board row with no photo sends
  `references: []` (`client/screens/studio/storyboardRun.ts:47-49`). `shotTypeFor([])` returns
  `broll` (`server/studio/video/shotType.ts:87`), which routes to openrouter `seedance-2.0-fast`
  (`server/studio/config.ts:185-198`). The adapter then sends neither `frame_images` nor
  `input_references` (`openrouter.ts:197-198`). A route test pins "no references → seedance, same
  price as photo b-roll" (`server/routes/studio.test.ts:535-562`).
- **Veo can also run t2v** (it attaches `image` only when a reference exists), but the product never
  sends Veo a photo-less clip: `shotTypeFor([])` is never `identity`.

## What this does NOT decide

- **Product shots stay image-to-video.** A sentence cannot render *her* product, so a `product` item
  keeps its photo. The change is keyed on the Agent's `kind === "broll"`, never on the Board's
  `row.kind === "broll"`, which products also use (see the card, §3).
- **i2v shots of her are unchanged.** They are identity shots on Veo, made from her photo on purpose.
- **Reference-to-video** (the photo as a soft content reference rather than frame 1) was named in the
  cancelled probe as a third option for product b-roll. It stays unexplored; nothing here depends on it.
