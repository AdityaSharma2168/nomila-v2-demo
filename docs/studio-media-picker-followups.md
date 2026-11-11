# Cards found while building the shared Studio media picker

Written 21 Sep 2026 on `studio/media-picker`. Each card is recorded so it is raised on its own terms,
not fixed beside the picker. None is built here.

---

## 1 · Synced EXIF orientation on the generation path — #312's reason may be obsolete

**Status:** OPEN — one measured probe decides it.

The Board and the Agent offer uploads and Made here, not synced posts (`mediaPickerLogic.ts`
`MOUNT_ORIGINS`). The reason is #312's: `ReferencePicker.tsx`'s header keeps ingested media out
because it "keeps its EXIF orientation flag", while an upload is straightened on the way in
(`routes/media.ts` → `studio/orient.ts`).

That reason may be obsolete. Since #312:
- the first frame is rotated before it is sent (`studio/video/firstFrame.ts:117`, `sharp().rotate()`);
- `personReference` rotates her photographs;
- `thingReference` rotates products, objects and brand imagery;
- `resolveStoredReference` normalises an edit's source frame when the brief says it declares an
  orientation.

Nobody has measured a synced row through those paths.

**The probe:** take one connected (Instagram) photo that carries an orientation flag other than 1.
Run it through the Board's i2v path once, and through an edit once. Read what the provider received
(the frame is logged as bytes or a url, see `videoRunner.ts` `framedReferences`). If both arrive
upright, add `"synced"` to the Board and Agent in `MOUNT_ORIGINS` — one line, and
`mediaPickerLogic.test.ts`'s "synced posts are never offered on the Board or the Agent" changes with
it, on purpose. If either arrives sideways, the reason stands, and this card says which path.

## 2 · Does Veo accept a HEIC first frame?

**Status:** OPEN, unmeasured. Nothing is marked in the picker because nobody knows.

On the Board and the Agent a HEIC photo is offered, as it always was. Its path to Veo:
- `cropToAspect`'s sharp cannot decode HEIC (this build reads only AVIF out of the HEIF family);
- `framedReferences` falls back to the frame as stored (`videoRunner.ts:166-175`);
- Veo is sent `image/heic` (`adapters/vertex.ts:135, 270`).

Whether it accepts that, refuses it (billed or not), or garbles it has never been run.

Why it matters more now: expo-image-picker 17.0.11 hands a HEIC back as HEIC even at `quality: 0.9`
(`ios/ImageUtils.swift:145-146`; default representation `.current`, `ImagePickerOptions.swift:44`).
So an iPhone upload is likely a HEIC — read from source, not checked on a device.

The durable fix is not ours: `preferredAssetRepresentationMode: Compatible` in `pickFromCameraRoll`
(`use-media-library.ts`, shared), or HEIC→JPEG at ingest (`routes/media.ts`, shared). That is Mia's.
The Video tab is already safe: stills are filtered to `STILL_CONTENT_TYPES` on the server, and an
upload-in-place HEIC there is refused in the still door's own words, not picked.

## 3 · Synced TikTok and YouTube rows are labelled "Instagram"

**Status:** OPEN, carded, not fixed here.

`ORIGIN_LABEL.connected = "Instagram"` (`client/hooks/use-studio-stitch.ts`). But
`rehostAthleteMedia.ts` syncs instagram, tiktok and youtube, all as `origin = connected`. So a
TikTok clip's tile in the Video tab says "Instagram". The picker's chip avoids the word ("From your
accounts"); the tile caption still uses the label. The fix is to label by `platform`, which the
lists would have to send. Small, but it touches the /stitch/* wire shape.

## 4 · The Board's "Replace / Keep mine" seed banner cannot fire

**Status:** OPEN, found while building "Back to the plan".

`seedDecision` answers `ask` when a seed arrives over a board that holds work, and the Board draws a
Replace / Keep banner. But "Put it on the board" navigates to StudioHome with params, and React
Navigation 7.5.5's `navigate()` pushes a screen it is not already on (`StackRouter.tsx:377-388,
447-456`). So every seed lands on a FRESH StudioHome with an empty board: the answer is always
`apply`, and the banner is unreachable on this path. Her original board sits beneath the Agent
screen, untouched.

Deciding whether seeds should go back to the existing board (`popTo`, which unmounts the Agent
screen and its plan) is a product call. It is the same fork "Back to the plan" had to live with.

## 5 · ReferencePicker still offers only 24 uploads

**Status:** OPEN.

`client/components/studio/ReferencePicker.tsx` (CampaignWorkspace's reference packs) is a fourth
Studio picker. It still reads `useMyMedia("photos", {source: "upload"})`: page 1 of 24, never
advanced, `posted_at`-sorted, deleted rows included. It could mount `StudioMediaPicker` in one
commit, like the three here. It was not in this card's scope.
