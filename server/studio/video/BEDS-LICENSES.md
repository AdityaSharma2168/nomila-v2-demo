# Music beds — what we ship, and the grant we rely on for each

The allowlist is `STITCH_BEDS` in [`beds.ts`](./beds.ts). This file is its paper trail: for every
track an athlete can lay under a video, **what the source page said on the day we took it.**

## The rule

- **CC0-1.0 or explicit public domain only.** Not CC-BY — an attribution she would have to carry into
  a brand deliverable. Not a site's own "royalty-free" or "free to use" licence (Pixabay's "CC0"
  filter is the Pixabay Content License, not CC0) — that is a contract with the site, not a grant
  from the author.
- **No scraping.** A track is downloaded by a person, from its own page, through the site's own
  download button.
- **Someone listened to it, start to finish, before it was listed.** For sample-based genres (phonk,
  lo-fi hip-hop) that means listening _for sampled vocals or recognisable recordings_: an uploader's
  CC0 dedication covers what is theirs to give and cannot clear a third party's sample.
- **One entry per track, recorded below before `listed: true`.** `beds.test.ts` fails a listed bed
  with no provenance, a licence outside the set, a non-https source, or a malformed date or hash.

## Why the date and the hash

A CC0 dedication is irrevocable. A hosting page is not: an uploader can relabel a track tomorrow.
If that happens, the evidence of the grant we relied on is this file — the URL, the licence text the
page showed, the day it was read, and the SHA-256 of the exact bytes downloaded that day, so the
file in the bucket can be matched to the page it came from.

## Record — one block per listed track

Copy this block. Every field is required.

```
### <name in STITCH_BEDS> — "<track title>"

- Artist:        <as credited on the page>
- Track page:    <https URL of the TRACK, not the album or the site>
- Licence shown: <exact text, e.g. "CC0 1.0 Universal">
- Artist's words, if any: "<verbatim>"
- Retrieved on:  <YYYY-MM-DD>, by <who>
- SHA-256 (as downloaded, before any transcode): <64 hex>
- Listened to in full by: <who>, <YYYY-MM-DD>. Sampled vocals / recognisable recordings: none heard
- Bucket object: studio/beds/<name>.m4a  (transcode: <the ffmpeg line used, or "none">)
```

## Listed tracks

The licence text below was read through a page-summarising fetch on 2026-09-20; Aditya had each
page open when downloading.

### walking-away — "Walking Away ( Lofi , Peaceful , Motivating )"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/walking-away-lofi-peaceful-motivating/
- Licence shown: "CC0 1.0 Universal License", linking to
  https://creativecommons.org/publicdomain/zero/1.0/ — read off the TRACK's own page, which also
  marks it Instrumental. Album: "Public Domain Lofi", whose page carries the artist's line "This
  music is completely Public Domain, so use it how you want!"
- Retrieved on: 2026-09-20, by Aditya Sharma, through the page's own download button
- SHA-256 (as downloaded, before any transcode): `fd8a618a4076b76f02f69414d6beb4ad7ddf3b8c26164085bd6dc1a9fd2f7610`
- File as downloaded: `HoliznaCC0 - Walking Away ( Lofi , Peaceful , Motivating ).mp3`
- Heard: played in the app by Aditya Sharma, 2026-09-20 (dev). **A full start-to-finish listen for
  sampled vocals / recognisable recordings is NOT yet confirmed** — it gates the PROD upload, see
  the flip checklist. Low risk by kind (an instrumental lo-fi track the page marks Instrumental),
  and recorded as unconfirmed rather than assumed
- Bucket object: `studio/beds/walking-away.m4a` (transcode:
  `ffmpeg -i <download>.mp3 -vn -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart walking-away.m4a`)

### doodles — "Doodles ( LoFi , Happy ).mp3"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/doodles-lofi-happy-mp3/
- Licence shown: "CC0 1.0 Universal License", linking to
  https://creativecommons.org/publicdomain/zero/1.0/ — read off the TRACK's own page, which also
  marks it Instrumental. Album: "Public Domain Lofi", whose page carries the artist's line "This
  music is completely Public Domain, so use it how you want!"
- Retrieved on: 2026-09-20, by Aditya Sharma, through the page's own download button
- SHA-256 (as downloaded, before any transcode): `84db72387b14fa51294ba76a0bb3f72f39172527e5eb7964da8567596561ae72`
- File as downloaded: `HoliznaCC0 - Doodles ( LoFi , Happy ).mp3.mp3`
- Heard: played in the app by Aditya Sharma, 2026-09-20 (dev). **A full start-to-finish listen for
  sampled vocals / recognisable recordings is NOT yet confirmed** — it gates the PROD upload, see
  the flip checklist. Low risk by kind (an instrumental lo-fi track the page marks Instrumental),
  and recorded as unconfirmed rather than assumed
- Bucket object: `studio/beds/doodles.m4a` (transcode:
  `ffmpeg -i <download>.mp3 -vn -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart doodles.m4a`)

### tokyo-sunset — "Tokyo Sunset ( Lofi , Peaceful , Soft )"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/tokyo-sunset-lofi-peaceful-soft/
- Licence shown: "CC0 1.0 Universal License", linking to
  https://creativecommons.org/publicdomain/zero/1.0/ — read off the TRACK's own page, which also
  marks it Instrumental. Album: "Public Domain Lofi", whose page carries the artist's line "This
  music is completely Public Domain, so use it how you want!"
- Retrieved on: 2026-09-20, by Aditya Sharma, through the page's own download button
- SHA-256 (as downloaded, before any transcode): `83b9208ab781af9b2da86e6885c4ec0fc1270457848609a1f96267539518fb9b`
- File as downloaded: `HoliznaCC0 - Tokyo Sunset ( Lofi , Peaceful , Soft ).mp3`
- Heard: played in the app by Aditya Sharma, 2026-09-20 (dev). **A full start-to-finish listen for
  sampled vocals / recognisable recordings is NOT yet confirmed** — it gates the PROD upload, see
  the flip checklist. Low risk by kind (an instrumental lo-fi track the page marks Instrumental),
  and recorded as unconfirmed rather than assumed
- Bucket object: `studio/beds/tokyo-sunset.m4a` (transcode:
  `ffmpeg -i <download>.mp3 -vn -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart tokyo-sunset.m4a`)

### hope-on-repeat — "Hope On Repeat"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/spring-woke-me-up/hope-on-repeat/
- Licence shown: "CC0 1.0 Universal License", linking to
  https://creativecommons.org/publicdomain/zero/1.0/ — read off the TRACK's own page. The page marks it Instrumental. Album:
  "Spring Woke Me Up", whose page carries the artist's line "This music is completely Public Domain, so use
  it how you want!"
- Retrieved on: 2026-09-20, by Aditya Sharma, through the page's own download button
- SHA-256 (as downloaded, before any transcode): `e781cf3926ea5b769f3b5667011234f4524cbcb06e539ba563c7f15fd805477a`
- File as downloaded: `HoliznaCC0 - Hope On Repeat.mp3`
- Heard: played in the app by Aditya Sharma, 2026-09-20 (dev). **A full start-to-finish listen for
  sampled vocals / recognisable recordings is NOT yet confirmed** — it gates the PROD upload, see
  the flip checklist
- Bucket object: `studio/beds/hope-on-repeat.m4a` (transcode:
  `ffmpeg -i <download>.mp3 -vn -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart hope-on-repeat.m4a`)

### we-drove-all-night — "We Drove All Night"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/we-drove-all-night-game-soundtrack/we-drove-all-night/
- Licence shown: "CC0 1.0 Universal License", linking to
  https://creativecommons.org/publicdomain/zero/1.0/ — read off the TRACK's own page. The page marks it Instrumental. Album:
  "We Drove All Night - Game Soundtrack", whose page carries the artist's line "This music is completely Public Domain, so use
  it how you want!"
- Retrieved on: 2026-09-20, by Aditya Sharma, through the page's own download button
- SHA-256 (as downloaded, before any transcode): `7f2f8953c5cb21c4704ec700a2c16f75043f6ceb7d8cfab69e69bc175b6ffaed`
- File as downloaded: `HoliznaCC0 - We Drove All Night.mp3`
- Heard: played in the app by Aditya Sharma, 2026-09-20 (dev). **A full start-to-finish listen for
  sampled vocals / recognisable recordings is NOT yet confirmed** — it gates the PROD upload, see
  the flip checklist
- Bucket object: `studio/beds/we-drove-all-night.m4a` (transcode:
  `ffmpeg -i <download>.mp3 -vn -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart we-drove-all-night.m4a`)

### only-human — "ONLY HUMAN"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/phonk-aura-farming/only-human/
- Licence shown: "CC0 1.0 Universal License", linking to
  https://creativecommons.org/publicdomain/zero/1.0/ — read off the TRACK's own page. ⚠️ **The page marks this one "Instrumental: No", genre "Rap"** — the only track here so marked, and phonk is a genre built on sampled vocals, which an uploader's CC0 dedication cannot clear. Album:
  "PHONK - AURA FARMING", whose page carries the artist's line "This music is completely Public Domain, so use
  it how you want!"
- Retrieved on: 2026-09-20, by Aditya Sharma, through the page's own download button
- SHA-256 (as downloaded, before any transcode): `d91ab977eecf295d1ae3c332fdebac2361c549a0059e44e27036a42e6a21095f`
- File as downloaded: `HoliznaCC0 - ONLY HUMAN.mp3`
- Heard: **listened to by Aditya Sharma, 2026-09-20, specifically because of that marking: "i heard it, no
  vocals, clearly."** The page's field and his ears disagree; his listen is what the rule asks
  for, and both are written down so the disagreement is visible. If a vocal is ever found in it,
  this is the first track to pull — unlist it (do not delete the name; stored rows hold it)
- Bucket object: `studio/beds/only-human.m4a` (transcode:
  `ffmpeg -i <download>.mp3 -vn -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart only-human.m4a`)

## Unlisted

### placeholder — a generated tone

- Licence: `generated`. A 220/330/440 Hz stack from ffmpeg's own `lavfi` source with a tremolo and
  fades — nobody's recording and nobody's composition. Recipe:
  [`docs/probes/video-v7-bed-placeholder.md`](../../../docs/probes/video-v7-bed-placeholder.md).
- **Unlisted** since the captions + music card: it proved the audio path and is not music. It stays
  a valid name so a stored row that holds it still re-parses and runs.

## Candidates under review (NOT approved, NOT shipped)

Proposed 2026-09-20. Details below came through a page summariser and are **unverified** — each
track's own page is re-read, and its block above filled in from that reading, before it is listed.

All by **HoliznaCC0** on Free Music Archive; each album page showed "CC0 1.0 Universal" and the
artist's line "This music is completely Public Domain, so use it how you want!"

| Feel       | Track        | Page                                                                                                    |
| ---------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| Hype       | Pantheon     | https://freemusicarchive.org/music/holiznacc0/phonk-aura-farming/pantheon/                              |
| Hype (alt) | ONLY HUMAN   | https://freemusicarchive.org/music/holiznacc0/phonk-aura-farming/only-human/                            |
| Motivating | Walking Away | https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/walking-away-lofi-peaceful-motivating/ |
| Bright     | Doodles      | https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/doodles-lofi-happy-mp3/                |
| Chill      | Tokyo Sunset | https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/tokyo-sunset-lofi-peaceful-soft/       |

The two phonk tracks carry the sample risk described under "The rule". "Phonk Remix" from the same
album was left out on its title alone.
