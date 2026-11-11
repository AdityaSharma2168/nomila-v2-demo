# Free music library — what we ship, and the grant we rely on for each

The catalogue is [`library.manifest.json`](./library.manifest.json), read by [`library.ts`](./library.ts). This file is
its paper trail: for every track, **what its source said on the day we took it**, and the hashes that tie the file in
the bucket to that page.

## The rules

- **Allowed:** CC0 1.0, or CC BY 4.0 / CC BY-SA 4.0 with a TASL credit line stored. **Excluded:** anything NC or ND,
  any "free for personal use" track, a site's own licence (Pixabay, Mixkit music, YouTube Audio Library), and anything
  whose terms were unclear. A track whose licence could not be verified on its own page is left out.
- **Brand-safe** only when the licence clearly allows commercial and advertising use with nothing else to clear: CC0,
  and not a sample-based genre (phonk, lo-fi hip-hop, beat tapes), because a CC0 dedication cannot clear a third
  party's sample. CC BY is never brand-safe here: the credit has to travel with the post, and a brand controls its
  own deliverable (the same reason [`BEDS-LICENSES.md`](../video/BEDS-LICENSES.md) keeps CC BY out of the beds).
- **Credit:** a CC BY track carries a TASL credit line (Title, Author, Source, Licence — the Creative Commons
  recommended practice). While it is the selected track the line is in the post's caption, and it is locked: a caption
  saved without it gets it back (`agent/postKit/music.ts`, `edit.ts`). Sourcing order: CC0 first; CC BY only with
  that locked credit.
- **Content ID:** Incompetech pre-registers Kevin MacLeod's recordings with YouTube Content ID on purpose
  (incompetech.com/music/royalty-free/youtube-contentid.html): a YouTube upload using one can be claimed, and the
  claim is released on dispute once the credit is in the video's description. Expect a claim, not a false one.
  Whether they are also registered with Meta's Rights Manager is not stated. HoliznaCC0 says nothing (null).
  `contentIdRegistered` records what the source says; the hashes and page text here are the evidence for a dispute.
- **Platform sounds:** TikTok's Commercial Music Library and Meta's Sound Collection are added in the app when she
  posts. They cannot be baked into an exported file and are never catalogue tracks.
- **Loudness:** every file is normalised to −14 LUFS integrated, −1 dBTP true peak (`studio/video/finishing.ts`):
  two-pass `loudnorm` (linear), or where a peak blocks the linear gain, gain plus a 4×-oversampled limiter, re-measured
  after the AAC encode. Encode: AAC 192 kb/s, 48 kHz stereo, faststart, metadata stripped.
- **Not yet heard.** Unlike the beds, these were checked on paper, not by ear: nobody has listened start to finish
  (`listenedBy: null`). They are offered only behind the dev flag `AGENT_POST_KIT_MUSIC_CHOICES` so a person can
  listen in the app first. Moods for HoliznaCC0 tracks outside the lofi album are our reading of the album's genre and
  the title (`moodsFrom` says which).
- **How they were taken:** by `scripts/music/` — each track's own page fetched and its licence text read and
  recorded, then the file the page itself links downloaded (one request a second). This is a departure from the beds'
  "a person presses the download button" rule, recorded here on purpose; the page text and hashes below are the
  evidence either way.

## Sources

- **Incompetech (Kevin MacLeod)** — every track entry on the site's catalogue renders the block "Licensed under
  Creative Commons: By Attribution 4.0 License"; the licences page says free use requires attribution (CC BY 4.0); the
  FAQ says exceptions are noted in a track's description. Every description below was checked for one; none has an
  exception. The site's catalogue data (`pieces.json`, linked from incompetech.com/llms.txt) gives the title, ISRC,
  BPM and "feel". Its Content ID page says the recordings are pre-registered and a claim is released on dispute
  once the credit is in the description: the credit in the caption is what she pastes there.
- **HoliznaCC0 on the Free Music Archive** — each track page says "<title> by HoliznaCC0 is licensed under a CC0 1.0
  Universal License", linking creativecommons.org/publicdomain/zero/1.0/. The file is the one the page itself embeds.

## Left out

- **Loudness could not be met** (true peak stayed above −1 dBTP after the AAC encode, or the level missed −14 by more
  than 0.5 LU): Incompetech "Miami Viceroy", HoliznaCC0 "Final Level", HoliznaCC0 "Canon Event". Downloaded and
  licence-checked, not shipped.
- **Not taken at all:** ccMixter (remixes carry other uploaders' samples under mixed licences), OpenGameArt (mostly
  game-styled loops; not needed to reach the count), Free Music Archive tracks under NC/ND licences, Pixabay and
  Mixkit music (their own licences, not CC), YouTube Audio Library (YouTube-only), anything "personal use".
- **Excluded by description:** any Incompetech track whose description mentions a licence exception, commission,
  rights, samples, vocals or lyrics was filtered out before picking.

## Tags and measurements

- **Moods** — Incompetech: from the site's "feel" tags (Intense/Epic/Action/Aggressive → hype, Driving → driving,
  Dark → dark, Bright → bright, Uplifting → uplifting, Bouncy/Humorous → playful, Relaxed/Grooving → warm,
  Calming/Somber → reflective), at most two. HoliznaCC0: our reading of the album's genre and the title.
- **Energy 1–5** — onset strength and rate, tempo and brightness, in quintiles of this library; a hype or driving
  track is at least 3, a warm or reflective one at most 3.
- **BPM** — Incompetech: the author's figure. HoliznaCC0: measured; the beat grid's when its halves agree.
  **First beat** — librosa's beat tracker on the normalised file, kept only when the two halves agree (≤ 0.5 BPM,
  ≤ 30 ms of phase); otherwise null. Not ear-checked.
- **Genre** — Artlist / Epidemic names. **Themes** — our rule: energy ≥ 4 and hype/driving → sport-fitness, workout;
  energy ≥ 3, hype/uplifting, cinematic/rock/electronic/synthwave → championships; energy ≤ 2 and
  reflective/warm/uplifting → slow-motion; bright/playful/warm at energy 2–4 → vlog.
- **Vocals** — Incompetech: from the instruments list (Singers or Choir → backing, else instrumental). HoliznaCC0: not
  yet heard (null).
- **Sections** — the drop is the biggest rise in level over 2 s (≥ 6 dB, after the first 5 s); the peak is the
  loudest 8 s.
- **Loops** — starts and ends at full level (no fade-in, no fade-out, no silent tail).

## Records

### 50-over-the-speed-limit — "50 Over The Speed Limit"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/power-pop/50-over-the-speed-limit/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/nBHRjy9qqBbnbEEJHQAWphNq016wwx2z22RBGkO7.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "50 Over The Speed Limit by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`nBHRjy9qqBbnbEEJHQAWphNq016wwx2z22RBGkO7.mp3`): c00de3e6294bc7dbd484c26815dfcfe0787cb352e7129a0e84ba14941fcab37f
- Bucket object: studio/tracks/free/50-over-the-speed-limit.m4a — SHA-256 1def68c1ac28bfb9d4ad221b1121ddda23e8e6e17bbb038cb9be14a5b5f394b0, MD5 zFIC9OL818Uv+KPjYwlTFQ==
- Loudness: -14.07 LUFS, -4.11 dBTP (loudnorm-2pass-linear)
- Tags: hype, driving · energy 3/5 · pop · themes: none · vocals: not yet heard
- Tempo: 139.99 BPM (measured) · first beat: 0.037 · drop: None · loudest 8 s from 40.77 s · 130.66 s
- Moods from: HoliznaCC0 album "Power Pop" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### all-the-fight-left — "All The Fight Left"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/waves-of-nostalgia-2/all-the-fight-left/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/rwOtm1n49lHZw3eubNzgiFDkkpRTTPygZDuDF6fk.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "All The Fight Left by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`rwOtm1n49lHZw3eubNzgiFDkkpRTTPygZDuDF6fk.mp3`): b6ce971879313d6a5011589da68b561db04278bae65eb44af937f7ec039ecbcd
- Bucket object: studio/tracks/free/all-the-fight-left.m4a — SHA-256 b0b6d3fa3b5a465d7608423db0d0f574f1d0de23b097b910090455192ca63517, MD5 jvAjynhl6rkyYVASlWkmYg==
- Loudness: -14.33 LUFS, -1.29 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: hype, uplifting · energy 3/5 · synthwave · themes: championships · vocals: not yet heard
- Tempo: 119.99 BPM (measured) · first beat: 0.039 · drop: 8.17 · loudest 8 s from 76.0 s · 171.96 s
- Moods from: HoliznaCC0 album "Waves Of Nostalgia 2" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### americana — "Americana"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1200092)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Americana.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Americana" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Americana" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Americana.mp3`): 664880bb7368b8b85e362a5dae28338de4e4741205991a0817ceeaabe7366153
- Bucket object: studio/tracks/free/americana.m4a — SHA-256 24a66c554edb6e560e2ae3a193deb531e1e11ac7753d301ca9a3d9efcb153e45, MD5 CkFSReaK/nzg2oQ7RohSng==
- Loudness: -14.33 LUFS, -1.69 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: hype, uplifting · energy 3/5 · cinematic · themes: championships · vocals: instrumental
- Tempo: 104.0 BPM (stated) · first beat: grid not trusted · drop: 11.15 · loudest 8 s from 164.68 s · 202.21 s
- Moods from: Incompetech "feel": Epic, Uplifting
- Listened to in full by: nobody yet

### americana-holizna — "Americana"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/rock-montage/americana-1/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/lcamgyu0FARn9mGV1iQogNHwpWqCupY2M9O1D4q1.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Americana by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`lcamgyu0FARn9mGV1iQogNHwpWqCupY2M9O1D4q1.mp3`): 50ccf0afd5e1d0a5bc28505e57c20ccda5fd76ac535997b3ed497ad1983d730b
- Bucket object: studio/tracks/free/americana-holizna.m4a — SHA-256 505ee2ab36bf05dfb3a41f52badb7c01be9492d4b17a86e88ab2125f519a90a1, MD5 /5PC5CXi0jTN9Am9GYQfzw==
- Loudness: -14.06 LUFS, -3.75 dBTP (loudnorm-2pass-linear)
- Tags: uplifting, warm · energy 1/5 · rock · themes: slow-motion · vocals: not yet heard
- Tempo: 130.01 BPM (measured) · first beat: 0.04 · drop: 5.57 · loudest 8 s from 67.83 s · 95.02 s
- Moods from: HoliznaCC0 album "Rock Montage" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### angel-share — "Angel Share"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1700021)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Angel%20Share.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Angel Share" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Angel Share" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Angel Share.mp3`): 280cb6b9c2a802291dae277e506e98ec10aef206a2bca588a14a0d2886f803bc
- Bucket object: studio/tracks/free/angel-share.m4a — SHA-256 a57acb406c3f0e3162d525e9bdee49aa80bade1a87f15169dedff63bb3bf1704, MD5 g68Qt4AMB61hAwFIO8QY7w==
- Loudness: -14.24 LUFS, -2.42 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: uplifting, bright · energy 1/5 · rock · themes: slow-motion · vocals: backing
- Tempo: 85.0 BPM (stated) · first beat: grid not trusted · drop: 23.29 · loudest 8 s from 146.17 s · 200.54 s
- Moods from: Incompetech "feel": Bright, Relaxed, Uplifting
- Listened to in full by: nobody yet

### august-never-lasts — "August Never Lasts"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/summer-air-lo-fi/august-never-lasts/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/xY61Jdd0qLKdI8245OtZQc7XOxTgJo2zn2tY8vW6.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "August Never Lasts by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`xY61Jdd0qLKdI8245OtZQc7XOxTgJo2zn2tY8vW6.mp3`): 4d21118ad4d45347d61cb19d54641f0134a8a286d666dc2483a3bd9ddbce8160
- Bucket object: studio/tracks/free/august-never-lasts.m4a — SHA-256 29615ba798788add23ee55383fa0e891370a55b78890ff5b1d7959cdb462e8aa, MD5 dEtHUiykUDOmZqJqXeGW+Q==
- Loudness: -14.03 LUFS, -1.31 dBTP (loudnorm-2pass-linear)
- Tags: reflective, warm · energy 1/5 · lofi · themes: slow-motion · vocals: not yet heard
- Tempo: 85.0 BPM (measured) · first beat: 0.037 · drop: None · loudest 8 s from 111.22 s · 158.06 s
- Moods from: HoliznaCC0 album "Summer Air Lo-Fi" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### back-in-the-80s — "Back In The 80s"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/power-pop/back-in-the-80s/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/mwxiOyntd7joJQg0mRq9cJPqRq6NvnrK2Xc3QDUe.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Back In The 80s by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`mwxiOyntd7joJQg0mRq9cJPqRq6NvnrK2Xc3QDUe.mp3`): d9ace2cffbd5fab3a5e151e578062eb3925a0e670227a534e299fe7f660fdca5
- Bucket object: studio/tracks/free/back-in-the-80s.m4a — SHA-256 f2cacab56b9ef97ed5b63f99a4962ceb9295bf3dff83cb41cefcf5082e5f31ac, MD5 HDX4myBpEVuGR87DPv0RPQ==
- Loudness: -14.05 LUFS, -1.08 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: driving, uplifting · energy 5/5 · pop · themes: sport-fitness, workout · vocals: not yet heard
- Tempo: 120.0 BPM (measured) · first beat: 0.041 · drop: 8.96 · loudest 8 s from 159.38 s · 239.95 s
- Moods from: HoliznaCC0 album "Power Pop" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### blue-skies — "Blue Skies"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/lazy-summer-lofi-1/blue-skiesmp3/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/XpOthDGLRLQULX4ayE2hezIK43FqPYAo69N5xxhn.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Blue Skies by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`XpOthDGLRLQULX4ayE2hezIK43FqPYAo69N5xxhn.mp3`): 1b5916797fe6341663a7172d8f653e95691d9462be51537c56ebfaabd81b8696
- Bucket object: studio/tracks/free/blue-skies.m4a — SHA-256 1d964c9e7935cc14376141a7823bb5579e8012cc9c201b5c322d46a8402b8074, MD5 q9SQZ+/X5UKwo/v3SzU3ow==
- Loudness: -14.18 LUFS, -1.43 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: warm, bright · energy 2/5 · lofi · themes: slow-motion, vlog · vocals: not yet heard
- Tempo: 82.0 BPM (measured) · first beat: 0.029 · drop: 169.3 · loudest 8 s from 61.44 s · 175.56 s
- Moods from: HoliznaCC0 album "Lazy Summer Lofi" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### bouncing — "Bouncing"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/power-pop/bouncing/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/jlbq3zqaGWo0V4gnuXk0cF9e5GVUbKGAqNb2C9T5.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Bouncing by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`jlbq3zqaGWo0V4gnuXk0cF9e5GVUbKGAqNb2C9T5.mp3`): c0b111e12939abab2afa0ee6b479609829d753f73db47e4c57b97c0bf0f6ca5f
- Bucket object: studio/tracks/free/bouncing.m4a — SHA-256 398e6e9a3acd456a7705295e01bb66fa94842ba24565735999c01c3a5d3d71fe, MD5 /th/e5Moyy+Zm7k8AhE2VQ==
- Loudness: -14.07 LUFS, -2.32 dBTP (loudnorm-2pass-linear)
- Tags: playful, bright · energy 4/5 · pop · themes: vlog · vocals: not yet heard
- Tempo: 117.5 BPM (measured) · first beat: grid not trusted · drop: None · loudest 8 s from 8.03 s · 87.94 s
- Moods from: HoliznaCC0 album "Power Pop" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### bubbles-lofi-bright-relaxed — "Bubbles"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/bubbles-lofi-bright-relaxed/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/zh5usndkyEfVvKOz8dvsrCd1Ga0jfz4xIcLUendD.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Bubbles ( Lofi , Bright , Relaxed ) by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`zh5usndkyEfVvKOz8dvsrCd1Ga0jfz4xIcLUendD.mp3`): 73efb557d8cfcca0f5cf3b435d3a0157bf9a702115b55266b8a2529f3997b542
- Bucket object: studio/tracks/free/bubbles-lofi-bright-relaxed.m4a — SHA-256 645c7b28932565ca46ad57339f184a52c4a0c729e6cf69d6bedad34e12df522b, MD5 ZPT2TRVUEPYaSUanIw0dnA==
- Loudness: -14.35 LUFS, -1.54 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: bright, warm · energy 2/5 · lofi · themes: slow-motion, vlog · vocals: not yet heard
- Tempo: 130.0 BPM (measured) · first beat: 0.07 · drop: None · loudest 8 s from 21.94 s · 147.62 s
- Moods from: HoliznaCC0 album "Public Domain Lofi" and the title (the artist's own mood words in the title); not yet checked by ear
- Listened to in full by: nobody yet

### bummin-on-tremelo — "Bummin on Tremelo"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1700032)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Bummin%20on%20Tremelo.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Bummin on Tremelo" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Bummin on Tremelo" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Bummin on Tremelo.mp3`): bddefba384d462e0e2d9b1d4111ea7fc8cee5a5a34e920f3366d8237a061e9c5
- Bucket object: studio/tracks/free/bummin-on-tremelo.m4a — SHA-256 51e476c1386992b72c9b2c9c7c528b0c4a28dfd53b073f5837b04e96df77d9b4, MD5 iKLX+gl0tfJN4aWaHX/hXA==
- Loudness: -14.28 LUFS, -1.69 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: bright, warm · energy 2/5 · pop · themes: slow-motion, vlog · vocals: backing
- Tempo: 120.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 49.13 s · 192.05 s
- Moods from: Incompetech "feel": Grooving, Relaxed, Bright
- Listened to in full by: nobody yet

### busking-in-the-sunlight — "Busking In the SunLight"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/city-slacker/busking-in-the-sunlight/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/kdmUgfaajJ783BvFpHmMWgdLMzVmuxhF1PFDFMCl.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Busking In the SunLight by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`kdmUgfaajJ783BvFpHmMWgdLMzVmuxhF1PFDFMCl.mp3`): a11baac282a8858cbaf74a1291b57fc83360af310763b4ed49857d5182808287
- Bucket object: studio/tracks/free/busking-in-the-sunlight.m4a — SHA-256 84ee5d041aebb40cc514b09dc17d10710eecca4785a8ce149a7e00785da5e942, MD5 od8CZmFl5lPg4y73HIQYLA==
- Loudness: -14.01 LUFS, -3.81 dBTP (loudnorm-2pass-linear)
- Tags: warm, bright · energy 3/5 · hip-hop · themes: vlog · vocals: not yet heard
- Tempo: 129.2 BPM (measured) · first beat: grid not trusted · drop: 258.65 · loudest 8 s from 243.58 s · 262.68 s
- Moods from: HoliznaCC0 album "City Slacker" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### carefree — "Carefree"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1400037)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Carefree.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Carefree" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Carefree" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Carefree.mp3`): 8433b770a630d9b1594fd484442c677907ece899a4d149954cd2e74fd733e311
- Bucket object: studio/tracks/free/carefree.m4a — SHA-256 ac8a7f78747e0035765a6c16c1b15e075be1ab99f87e55d0e64b2183bcdbc164, MD5 g09ZATucCCetozSVaBNQZA==
- Loudness: -14.13 LUFS, -1.22 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: uplifting, bright · energy 3/5 · acoustic · themes: vlog · vocals: instrumental
- Tempo: 96.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 72.52 s · 205.14 s
- Moods from: Incompetech "feel": Bouncy, Bright, Calming, Uplifting
- Listened to in full by: nobody yet

### chill-wave — "Chill Wave"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600048)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Chill%20Wave.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Chill Wave" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Chill Wave" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Chill Wave.mp3`): 7f07fbf89860959ff527f7b74606146dd0b0de263739989a70ce712c7c361614
- Bucket object: studio/tracks/free/chill-wave.m4a — SHA-256 623362d2a2333e0307c310d3df821716cc4b5fbf6ba7cdb4faa8a00f2516c2b1, MD5 g7PCZk9G2VcBIdu1gWg/qQ==
- Loudness: -14.02 LUFS, -1.79 dBTP (loudnorm-2pass-linear)
- Tags: warm · energy 3/5 · funk · themes: vlog · vocals: instrumental
- Tempo: 100.0 BPM (stated) · first beat: grid not trusted · drop: 154.6 · loudest 8 s from 198.04 s · 240.07 s
- Moods from: Incompetech "feel": Grooving, Relaxed
- Listened to in full by: nobody yet

### city-lights — "City Lights"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/be-happy-with-who-you-are/city-lights-1/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/3rTPHXICTqxoPmS0YLVUSm9qwOWoJxiXTaOy2vmx.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "City Lights by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`3rTPHXICTqxoPmS0YLVUSm9qwOWoJxiXTaOy2vmx.mp3`): 5cef4e2511dca0a8363b79fbc513709103a68b0a153877cf4922bcc0214135d2
- Bucket object: studio/tracks/free/city-lights.m4a — SHA-256 b2e975a741d9b2f617404ab1194a4e699d4dcb4db87ac0c3b9c003839d8ab03f, MD5 W+pSN6+t0DfOCG7sBsRs1A==
- Loudness: -14.02 LUFS, -3.94 dBTP (loudnorm-2pass-linear)
- Tags: warm, reflective · energy 2/5 · lofi · themes: slow-motion, vlog · vocals: not yet heard
- Tempo: 90.0 BPM (measured) · first beat: 0.029 · drop: None · loudest 8 s from 136.7 s · 277.27 s
- Moods from: HoliznaCC0 album "Be Happy With Who You Are" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### classic — "Classic"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/rock-montage/classic/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/7KkRfJDj7UGWOt25IdkSNisMJSHXC7P9LwIUxIVL.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Classic by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`7KkRfJDj7UGWOt25IdkSNisMJSHXC7P9LwIUxIVL.mp3`): eb9f2e7f92278f1ee39990b4a4ecf948c9b5cee0892c57d0fac29e614717d739
- Bucket object: studio/tracks/free/classic.m4a — SHA-256 e209c4ce42fc3a02cd70fcca8ac9fb9b2674a063341647a798e89fda3cd9547e, MD5 H6q740uazvEXy0uDzARZfQ==
- Loudness: -14.03 LUFS, -5.13 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: driving, bright · energy 3/5 · rock · themes: vlog · vocals: not yet heard
- Tempo: 120.0 BPM (measured) · first beat: 0.04 · drop: None · loudest 8 s from 5.02 s · 149.69 s
- Moods from: HoliznaCC0 album "Rock Montage" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### digital-lemonade — "Digital Lemonade"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1700010)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Digital%20Lemonade.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Digital Lemonade" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Digital Lemonade" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Digital Lemonade.mp3`): be9f665efd035dea23a1e9539c534ba905f44144f7dda05a0a663ccecda1ab21
- Bucket object: studio/tracks/free/digital-lemonade.m4a — SHA-256 51d6b4b424316090231000587b71a1dc3f0edfc6cd734fb5976b894ec3a91fea, MD5 GFvqXGj3Rj421RPFTEnm+A==
- Loudness: -14.35 LUFS, -1.46 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: bright, playful · energy 3/5 · electronic · themes: vlog · vocals: instrumental
- Tempo: 120.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 139.27 s · 180.06 s
- Moods from: Incompetech "feel": Bouncy, Bright, Relaxed
- Listened to in full by: nobody yet

### disco-medusae — "Disco Medusae"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1500041)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Disco%20Medusae.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Disco Medusae" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Disco Medusae" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Disco Medusae.mp3`): 1b54c9d99110f5ad3e8ced322681f0f81d18c919434e55375b40dc75c8bb09f3
- Bucket object: studio/tracks/free/disco-medusae.m4a — SHA-256 0c8471c642a9648bd6ea528a82550117ca41303537c124c204845c6ccf517b04, MD5 /0HqYifd5UKN9juYsHXpEQ==
- Loudness: -14.06 LUFS, -1.15 dBTP (loudnorm-2pass-linear)
- Tags: bright, warm · energy 5/5 · disco · themes: none · vocals: instrumental
- Tempo: 115.0 BPM (stated) · first beat: 0.06 · drop: None · loudest 8 s from 92.16 s · 221.28 s
- Moods from: Incompetech "feel": Bright, Grooving
- Listened to in full by: nobody yet

### dream-culture — "Dream Culture"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1300046)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Dream%20Culture.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Dream Culture" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Dream Culture" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Dream Culture.mp3`): f12cbb52bd4b92bd6cf8a343645567c119627e9cbf98108a3eb6ac2cc275ee46
- Bucket object: studio/tracks/free/dream-culture.m4a — SHA-256 8397b211d47aa267c1e83eadb2d938e3b010e7a38cbb4749c2b8412350dd3d13, MD5 2b5SUb4D4gyJeMKLX1sbCw==
- Loudness: -14.22 LUFS, -1.6 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: uplifting, reflective · energy 1/5 · acoustic · themes: slow-motion · vocals: instrumental
- Tempo: 70.0 BPM (stated) · first beat: 0.062 · drop: 155.27 · loudest 8 s from 155.85 s · 214.36 s
- Moods from: Incompetech "feel": Calming, Relaxed, Uplifting
- Listened to in full by: nobody yet

### dreamer — "Dreamer"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600043)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Dreamer.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Dreamer" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Dreamer" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Dreamer.mp3`): 615e65c9ca131c11f8e12970644ed74ef822ec4f643b1d9d0085a223600bcdfb
- Bucket object: studio/tracks/free/dreamer.m4a — SHA-256 bbb49c6355f611f16e365833822f5e84601965119a33b160ecad4583c568afde, MD5 E2lZK90vJVFqeqzSeEWTYA==
- Loudness: -14.48 LUFS, -1.6 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: reflective, warm · energy 2/5 · acoustic · themes: slow-motion, vlog · vocals: instrumental
- Tempo: 100.0 BPM (stated) · first beat: 0.068 · drop: 39.4 · loudest 8 s from 0.0 s · 204.07 s
- Moods from: Incompetech "feel": Calming, Relaxed
- Listened to in full by: nobody yet

### eighties-action — "Eighties Action"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1100243)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Eighties%20Action.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Eighties Action" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Eighties Action" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Eighties Action.mp3`): ae418a7f7e1b4ed77b0b3edb9ae416b34936777fd262e4c30cfe7483a8da45dd
- Bucket object: studio/tracks/free/eighties-action.m4a — SHA-256 f17bfedfc7d725fe5aeca285256ba20f6f40b78e250b41a8167b40933af85876, MD5 U0Mi2mVpwsmZP1t5/k3WRQ==
- Loudness: -14.45 LUFS, -1.7 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: hype, driving · energy 3/5 · rock · themes: championships · vocals: instrumental
- Tempo: 132.0 BPM (stated) · first beat: 0.075 · drop: 123.07 · loudest 8 s from 107.16 s · 170.97 s
- Moods from: Incompetech "feel": Driving, Action
- Listened to in full by: nobody yet

### endless-grind — "Endless Grind"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/city-slacker/endless-grind/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/QIaQ6S2PBm1VOfVXhLpJk7UJgg9yh3OLXiXekARt.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Endless Grind by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`QIaQ6S2PBm1VOfVXhLpJk7UJgg9yh3OLXiXekARt.mp3`): 61d6be06746e0d9608340872105061ba32aea9e6eaaf9277475eb80b79152664
- Bucket object: studio/tracks/free/endless-grind.m4a — SHA-256 1b59ac177bd0b471ea1038ccd0a9e37d86dc292059b5bf21209b43b1f16d2691, MD5 r5X2eI1zyV19AiMPyzcRfw==
- Loudness: -14.04 LUFS, -2.22 dBTP (loudnorm-2pass-linear)
- Tags: driving, dark · energy 4/5 · hip-hop · themes: sport-fitness, workout · vocals: not yet heard
- Tempo: 172.3 BPM (measured) · first beat: grid not trusted · drop: 216.85 · loudest 8 s from 176.24 s · 236.02 s
- Moods from: HoliznaCC0 album "City Slacker" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### eternity — "Eternity"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600031)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Eternity.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Eternity" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Eternity" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Eternity.mp3`): e9cf0d8fbea2f7f1fc60ecb1c1182cff7506e12f8927001e7b8ebe2e352eacc1
- Bucket object: studio/tracks/free/eternity.m4a — SHA-256 2e1a44503631452f39778e7ba0fb7abfa6ed51ebb3858a7b29ecdd7b7e6d0c8f, MD5 bi5duCXAxW4gNsGbii9MMQ==
- Loudness: -14.01 LUFS, -5.5 dBTP (loudnorm-2pass-linear)
- Tags: warm · energy 2/5 · electronic · themes: slow-motion, vlog · vocals: instrumental
- Tempo: 100.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 4.3 s · 198.06 s
- Moods from: Incompetech "feel": Relaxed, Grooving
- Listened to in full by: nobody yet

### exhilarate — "Exhilarate"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1300028)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Exhilarate.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Exhilarate" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Exhilarate" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Exhilarate.mp3`): 3e50c832e0739479c6f0306661c9601e081738eef939630bb121e66195691b64
- Bucket object: studio/tracks/free/exhilarate.m4a — SHA-256 3c772a5297b210c8fe4e114725290796e95d8ef754f71fae2f36ffd4398c2ed1, MD5 /8YgjIro+XPh7fB4emYLXg==
- Loudness: -14.1 LUFS, -3.89 dBTP (loudnorm-2pass-linear)
- Tags: hype, driving · energy 3/5 · rock · themes: championships · vocals: instrumental
- Tempo: 170.0 BPM (stated) · first beat: 0.067 · drop: None · loudest 8 s from 28.28 s · 145.48 s
- Moods from: Incompetech "feel": Aggressive, Driving, Intense
- Listened to in full by: nobody yet

### exit-the-premises — "Exit the Premises"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1500029)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Exit%20the%20Premises.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Exit the Premises" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Exit the Premises" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Exit the Premises.mp3`): 441d1b594a15b0acdac531495e9c56906e3df5d4002fc651b5a0b763f679c70b
- Bucket object: studio/tracks/free/exit-the-premises.m4a — SHA-256 9dd11c37c9bbf9444e9abf0e7706ea12d513876634b3713955456d27181787ac, MD5 aB2cTDBg1sk2Ds56jgBuTA==
- Loudness: -14.09 LUFS, -2.15 dBTP (loudnorm-2pass-linear)
- Tags: hype, driving · energy 3/5 · electronic · themes: championships · vocals: instrumental
- Tempo: 128.0 BPM (stated) · first beat: grid not trusted · drop: 145.43 · loudest 8 s from 185.02 s · 210.08 s
- Moods from: Incompetech "feel": Driving, Intense
- Listened to in full by: nobody yet

### fearless-first — "Fearless First"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600058)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Fearless%20First.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Fearless First" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Fearless First" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Fearless First.mp3`): ea862755d92cfe6ce6f54fcbe3cb2738881746af3456160868e60b39ed62e103
- Bucket object: studio/tracks/free/fearless-first.m4a — SHA-256 c68cfe3627e7a229ab47321e90868dcecf5ea3ab749600c27e56af5cc90cb6dc, MD5 +6YdSv072HUIHOLOtLm7jw==
- Loudness: -14.02 LUFS, -4.1 dBTP (loudnorm-2pass-linear)
- Tags: driving, warm · energy 3/5 · cinematic · themes: vlog · vocals: instrumental
- Tempo: 92.0 BPM (stated) · first beat: 0.053 · drop: None · loudest 8 s from 182.04 s · 195.71 s
- Moods from: Incompetech "feel": Driving, Grooving
- Listened to in full by: nobody yet

### finding-yourself — "Finding Yourself"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/be-happy-with-who-you-are/finding-yourself/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/oiidxxRMyz6B7XOLx2IOfeHKb1Pq3414iDMKQtvk.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Finding Yourself by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`oiidxxRMyz6B7XOLx2IOfeHKb1Pq3414iDMKQtvk.mp3`): 1b1951f72fce8d566051dbec3721c2320c3d6473e8485b5e80139ac49df40aac
- Bucket object: studio/tracks/free/finding-yourself.m4a — SHA-256 799b657cee1b6f51487c2dadcaeaee986ac460e8c315dfaa1291827010424a37, MD5 gn+SSTBupWCZ+EO3goI/ag==
- Loudness: -14.03 LUFS, -4.38 dBTP (loudnorm-2pass-linear)
- Tags: reflective, uplifting · energy 3/5 · lofi · themes: none · vocals: not yet heard
- Tempo: 95.0 BPM (measured) · first beat: 0.035 · drop: None · loudest 8 s from 100.82 s · 154.06 s
- Moods from: HoliznaCC0 album "Be Happy With Who You Are" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### fresh-fit — "Fresh Fit"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/city-slacker/fresh-fit/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/S2PVQAXdmcYCDUFXEtqPwfIX9XBAkhwiQGcKK6uj.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Fresh Fit by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`S2PVQAXdmcYCDUFXEtqPwfIX9XBAkhwiQGcKK6uj.mp3`): 1b403269d6e2ee561bcc2a4a8b431993bbdfb62be95f8320eff8c72f80c90a7c
- Bucket object: studio/tracks/free/fresh-fit.m4a — SHA-256 af8eae26555a358cf65a444ccaa185932508a44bfda408b13be4ee83af65d331, MD5 LEwSL4BVKH70dF5Feb5ZEg==
- Loudness: -14.01 LUFS, -3.56 dBTP (loudnorm-2pass-linear)
- Tags: playful, warm · energy 2/5 · hip-hop · themes: slow-motion, vlog · vocals: not yet heard
- Tempo: 80.0 BPM (measured) · first beat: 0.038 · drop: 12.98 · loudest 8 s from 40.17 s · 163.46 s
- Moods from: HoliznaCC0 album "City Slacker" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### funin-and-sunin — "Funin and Sunin"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1700011)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Funin%20and%20Sunin.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Funin and Sunin" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Funin and Sunin" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Funin and Sunin.mp3`): 72d8cdf58029908acddc8d437fe0b5bc81566f2f05e723cc254a87da615febd9
- Bucket object: studio/tracks/free/funin-and-sunin.m4a — SHA-256 07a23355b7b8fdefd52c40cb6342033c39fbfd3298e6b4fd7afd8cdf7cb956e8, MD5 u0OFgOPKlcofGLV4s6hISA==
- Loudness: -14.04 LUFS, -1.21 dBTP (loudnorm-2pass-linear)
- Tags: bright, playful · energy 3/5 · rock · themes: vlog · vocals: instrumental
- Tempo: 120.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 147.14 s · 218.96 s
- Moods from: Incompetech "feel": Bouncy, Bright, Relaxed
- Listened to in full by: nobody yet

### funky-chunk — "Funky Chunk"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1500054)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Funky%20Chunk.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Funky Chunk" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Funky Chunk" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Funky Chunk.mp3`): e6203c8c8fddbae0d9790da391a6ea73ef765fc3eec08bd87441e63037dc3c9c
- Bucket object: studio/tracks/free/funky-chunk.m4a — SHA-256 be6f29902a8ebe41a74a8464d61dfa8ccf733637884b13945ba3daae998660ad, MD5 swBx+B4weJHPy7lYBXps1w==
- Loudness: -14.35 LUFS, -1.48 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: uplifting, bright · energy 3/5 · funk · themes: vlog · vocals: instrumental
- Tempo: 115.0 BPM (stated) · first beat: 0.065 · drop: None · loudest 8 s from 167.49 s · 239.02 s
- Moods from: Incompetech "feel": Bright, Grooving, Uplifting
- Listened to in full by: nobody yet

### funky-pop — "Funky Pop"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/power-pop/funky-pop/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/c3qtEJjVKXI87BexJ5Ra4Sxy2iY9DAphxzqyrhg6.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Funky Pop by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`c3qtEJjVKXI87BexJ5Ra4Sxy2iY9DAphxzqyrhg6.mp3`): f4ece98b361ba68fdfa5c94c8856e639c64459f10b10c5294e523e3c00d9bbcf
- Bucket object: studio/tracks/free/funky-pop.m4a — SHA-256 1d3282613212a04984422cea5010ee9708cded826cd32d7e5e1f19f69d47f865, MD5 +B/6GeJgAk/lHhJBQbgduQ==
- Loudness: -14.05 LUFS, -2.79 dBTP (loudnorm-2pass-linear)
- Tags: playful, bright · energy 3/5 · pop · themes: vlog · vocals: not yet heard
- Tempo: 120.99 BPM (measured) · first beat: 0.035 · drop: 73.61 · loudest 8 s from 1.25 s · 142.75 s
- Moods from: HoliznaCC0 album "Power Pop" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### getting-it-done — "Getting it Done"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1800004)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Getting%20it%20Done.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Getting it Done" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Getting it Done" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Getting it Done.mp3`): bc74076ec1c263f6ac4634403d0acc1ccc5d2e79f2d083243e00d236b547c15b
- Bucket object: studio/tracks/free/getting-it-done.m4a — SHA-256 5530619ba95af2d83555c97a7610e83eddda2738e5b31e64f4ffa02413d20229, MD5 AsQWO172WWhDb6rlK2cGJA==
- Loudness: -14.07 LUFS, -1.65 dBTP (loudnorm-2pass-linear)
- Tags: bright, warm · energy 3/5 · electronic · themes: vlog · vocals: instrumental
- Tempo: 135.0 BPM (stated) · first beat: 0.058 · drop: None · loudest 8 s from 177.1 s · 209.84 s
- Moods from: Incompetech "feel": Bright, Grooving, Relaxed
- Listened to in full by: nobody yet

### glitter-blast — "Glitter Blast"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1900001)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Glitter%20Blast.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Glitter Blast" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Glitter Blast" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Glitter Blast.mp3`): 6d24390bfe0dba5107b04d643c2e36e13dae8048a382d465f0b575397f01b89b
- Bucket object: studio/tracks/free/glitter-blast.m4a — SHA-256 8ee4bdac23ba5d11b8d80d7011aee188d2576353081d546f145cf53337bd6656, MD5 +O9edkMf67WX0pXtb8CIew==
- Loudness: -14.16 LUFS, -1.13 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: bright, playful · energy 5/5 · pop · themes: none · vocals: instrumental
- Tempo: 100.0 BPM (stated) · first beat: 0.494 · drop: 115.75 · loudest 8 s from 59.49 s · 177.82 s
- Moods from: Incompetech "feel": Bouncy, Bright, Grooving
- Listened to in full by: nobody yet

### grunge — "Grunge"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/rock-montage/grunge/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/PudO8yqUuwHYDnHJSVIMzh5Bshy5K5wDnhwH58Y4.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Grunge by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`PudO8yqUuwHYDnHJSVIMzh5Bshy5K5wDnhwH58Y4.mp3`): 337a07a275cfd054abb1f6cacc0b672485793751ab4629422aa6f43685168141
- Bucket object: studio/tracks/free/grunge.m4a — SHA-256 486ff0c05bce14bb623c8311f7c81b427037bd253519f5ba5824164c38844f2c, MD5 R0vWun5mRLOz3A925zW4Gw==
- Loudness: -14.07 LUFS, -4.37 dBTP (loudnorm-2pass-linear)
- Tags: driving, dark · energy 3/5 · rock · themes: none · vocals: not yet heard
- Tempo: 103.4 BPM (measured) · first beat: grid not trusted · drop: 6.18 · loudest 8 s from 71.24 s · 108.98 s
- Moods from: HoliznaCC0 album "Rock Montage" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### happy-dance — "Happy Dance"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/power-pop/happy-dance-2/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/RW0ClzjYQLeklBk8rH87iOMymxlbShz12SXfzAQq.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Happy Dance by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`RW0ClzjYQLeklBk8rH87iOMymxlbShz12SXfzAQq.mp3`): 75d7247e6025a9a0372a2069a0634301d94e92793a03f90a2f082acffcf3851a
- Bucket object: studio/tracks/free/happy-dance.m4a — SHA-256 91652057fc7de5e9c9ce718b01ab92ef07509e251f92f4e854c2390945ad618c, MD5 kWarBpBKA3pA9qGTILt3kg==
- Loudness: -14.11 LUFS, -1.29 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: bright, playful · energy 4/5 · pop · themes: vlog · vocals: not yet heard
- Tempo: 120.0 BPM (measured) · first beat: 0.04 · drop: None · loudest 8 s from 130.73 s · 155.95 s
- Moods from: HoliznaCC0 album "Power Pop" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### hard-mode — "Hard Mode"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/gamer-beats/hard-mode/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/it8JEzrHmTA7UdLbFgepdmkjtfFeW4QX2D5tkSRP.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Hard Mode by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`it8JEzrHmTA7UdLbFgepdmkjtfFeW4QX2D5tkSRP.mp3`): 280c17c6dbb5b37224d5e96e992876f785a78f42835ed51012253818881db544
- Bucket object: studio/tracks/free/hard-mode.m4a — SHA-256 02c7c4044f52ffea59bd27047a8a5d2654dcf85f078fb39d21753f5eaa8da8bc, MD5 h5/EZPw/Pszvo91O9LeOKw==
- Loudness: -14.03 LUFS, -1.49 dBTP (loudnorm-2pass-linear)
- Tags: hype, dark · energy 5/5 · chiptune · themes: sport-fitness, workout · vocals: not yet heard
- Tempo: 150.0 BPM (measured) · first beat: 0.034 · drop: 6.99 · loudest 8 s from 63.58 s · 179.54 s
- Moods from: HoliznaCC0 album "Gamer Beats" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### highlight-reel — "Highlight Reel"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1100205)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Highlight%20Reel.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Highlight Reel" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Highlight Reel" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Highlight Reel.mp3`): 8a3d437f4191e7ecc08184d447da6cb4a2861a22b7f3ba595cdc636586f9b1c3
- Bucket object: studio/tracks/free/highlight-reel.m4a — SHA-256 9fba307fd260d1275f1bc63d0d95ce9dcc600872ab6c6b054b8b5222ead58c74, MD5 PsB2nnV7gXP4FIdizQJEtA==
- Loudness: -14.41 LUFS, -1.77 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: driving · energy 3/5 · rock · themes: none · vocals: instrumental
- Tempo: 90.0 BPM (stated) · first beat: 0.066 · drop: None · loudest 8 s from 56.31 s · 175.93 s
- Moods from: Incompetech "feel": Driving
- Listened to in full by: nobody yet

### hooptie-with-the-windows-down — "Hooptie With The Windows Down"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/city-slacker/hooptie-with-the-windows-down/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/St1iQIVKqpwhbOQztN0hdX0g3oF6uMZ6fUhBBnNd.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Hooptie With The Windows Down by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`St1iQIVKqpwhbOQztN0hdX0g3oF6uMZ6fUhBBnNd.mp3`): a66f728a0739677bd4c21b2e26b4f0c8d88c5d1192a7bc6b240c3dd02c9e4f6b
- Bucket object: studio/tracks/free/hooptie-with-the-windows-down.m4a — SHA-256 e9cdb2d07a9244ce9f2884340d4e35318e1a73735c2626e7256853e6122b535d, MD5 vVkVYjdito4VDdGfVgIO9A==
- Loudness: -14.42 LUFS, -1.52 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: warm, playful · energy 1/5 · hip-hop · themes: slow-motion · vocals: not yet heard
- Tempo: 80.0 BPM (measured) · first beat: 0.023 · drop: 117.98 · loudest 8 s from 187.85 s · 233.95 s
- Moods from: HoliznaCC0 album "City Slacker" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### jams — "Jams"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/rock-montage/jams/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/PEvs96WOmGA37goSqtF85IdgOZtIdgZ0nurqn4D1.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Jams by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`PEvs96WOmGA37goSqtF85IdgOZtIdgZ0nurqn4D1.mp3`): 442b221cbb23904515e73e014b274ebf9e8adffc800e7e645c88b5ed09131ea5
- Bucket object: studio/tracks/free/jams.m4a — SHA-256 f0160d06c6bbd593a6fa1516d18ad93211441d29eb380d7e2114a51eb6504371, MD5 iUMVfgmsKC/Z2z/y5/slhw==
- Loudness: -14.28 LUFS, -1.55 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: driving, bright · energy 3/5 · rock · themes: vlog · vocals: not yet heard
- Tempo: 95.0 BPM (measured) · first beat: 0.036 · drop: None · loudest 8 s from 124.9 s · 188.16 s
- Moods from: HoliznaCC0 album "Rock Montage" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### jupiter — "Jupiter"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/interstellar-pop-songs/jupiter/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/CA1NhupBiSSWalVG1SaAmQxVZPxFehntClbzsAhk.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Jupiter by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`CA1NhupBiSSWalVG1SaAmQxVZPxFehntClbzsAhk.mp3`): 457dab6d63a996fffd8ec3fda1b993be41d68c0af4eb69421b52ddf931308a56
- Bucket object: studio/tracks/free/jupiter.m4a — SHA-256 aa9e04a7c300240376f985d2c9394c4be23db5f0b21c3d79281d17df69877103, MD5 sREUSSqjpfO6zQVCSTt83w==
- Loudness: -14.36 LUFS, -2.07 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: uplifting, bright · energy 5/5 · pop · themes: none · vocals: not yet heard
- Tempo: 89.99 BPM (measured) · first beat: 0.031 · drop: None · loudest 8 s from 36.15 s · 135.94 s
- Moods from: HoliznaCC0 album "Interstellar Pop Songs" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### late-night-radio — "Late Night Radio"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN2100003)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Late%20Night%20Radio.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Late Night Radio" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Late Night Radio" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Late Night Radio.mp3`): d720ee8c55abceef59ff5778bd47bca80713e903bc49719960888a68f6d40ecd
- Bucket object: studio/tracks/free/late-night-radio.m4a — SHA-256 758102851ac8195b82fd6b7af0f4789f32bd9aaff9bbe98e2d4a1835f51ffc1f, MD5 qXM4spe7rst2G2NLdSoDHQ==
- Loudness: -14.01 LUFS, -2.44 dBTP (loudnorm-2pass-linear)
- Tags: reflective, warm · energy 1/5 · electronic · themes: slow-motion · vocals: instrumental
- Tempo: 72.0 BPM (stated) · first beat: grid not trusted · drop: 187.9 · loudest 8 s from 104.03 s · 263.6 s
- Moods from: Incompetech "feel": Calming, Relaxed
- Listened to in full by: nobody yet

### legends — "Legends"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/gamer-beats/legends/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/DdGp8GQnQdt86CUuKRioGCiEeB9wrYK1UtKbRTCc.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Legends by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`DdGp8GQnQdt86CUuKRioGCiEeB9wrYK1UtKbRTCc.mp3`): 8b1767800c4d5047edd2e59dea96c071c3e313be7536f6954c7bab2a9d5b041c
- Bucket object: studio/tracks/free/legends.m4a — SHA-256 2c6e09d0d3ef0fca7c6efa4874bd9d869ad68c57528cfcb0d2d8c37690bddca8, MD5 7LprXRXzY+zCYvqUAl/ksQ==
- Loudness: -14.12 LUFS, -1.06 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: uplifting, hype · energy 4/5 · chiptune · themes: sport-fitness, workout · vocals: not yet heard
- Tempo: 129.2 BPM (measured) · first beat: grid not trusted · drop: 148.56 · loudest 8 s from 172.15 s · 210.41 s
- Moods from: HoliznaCC0 album "Gamer Beats" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### level-up — "Level Up"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1500023)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Level%20Up.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Level Up" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Level Up" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Level Up.mp3`): 6fce8b8671618283afb2f4dbb16faacc20b6c141613ad80c0b2fbbd2c6e9ba47
- Bucket object: studio/tracks/free/level-up.m4a — SHA-256 4449bd5ab3352a57960aef19ff41dca78a196eb1b1dda5301ca14712527db669, MD5 445S8OoH42BqxkYPtAnjFg==
- Loudness: -14.34 LUFS, -2.34 dBTP (gain+limiter(4x oversampled, limit -4.8 dBFS))
- Tags: hype, dark · energy 5/5 · electronic · themes: sport-fitness, workout, championships · vocals: instrumental
- Tempo: 114.0 BPM (stated) · first beat: 0.055 · drop: None · loudest 8 s from 140.06 s · 219.01 s · loops
- Moods from: Incompetech "feel": Dark, Intense
- Listened to in full by: nobody yet

### life-of-riley — "Life of Riley"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1400054)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Life%20of%20Riley.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Life of Riley" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Life of Riley" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Life of Riley.mp3`): 1916f05cd1860949f9241e17966d334c39852b531329e4a05802720bb154c564
- Bucket object: studio/tracks/free/life-of-riley.m4a — SHA-256 844b7cd423ccdc8064bb7b418ebc432239170cf0047f265de285ecae76e88848, MD5 u2QtjWJyjpsFLmVNOs4Vww==
- Loudness: -14.09 LUFS, -1.61 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: uplifting, bright · energy 3/5 · pop · themes: vlog · vocals: instrumental
- Tempo: 102.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 124.62 s · 235.36 s
- Moods from: Incompetech "feel": Bright, Relaxed, Uplifting
- Listened to in full by: nobody yet

### love-love-love — "Love Love Love"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/power-pop/love-love-love/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/QyOdjJhuXLVTQJykleAL7negVj97mpFr63vt4sPO.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Love Love Love by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`QyOdjJhuXLVTQJykleAL7negVj97mpFr63vt4sPO.mp3`): 8f579ae23d50513c073ad914eb6bcd93d6abe33b53130c1dcf493c5c2c114322
- Bucket object: studio/tracks/free/love-love-love.m4a — SHA-256 dd93f7b6f80783e5aaac0bf5ac572ee21047df64d2d715e74f7b8d16475f3e37, MD5 9jS9UiVSNkn1YVdM0UHdLg==
- Loudness: -14.05 LUFS, -3.76 dBTP (loudnorm-2pass-linear)
- Tags: warm, bright · energy 3/5 · pop · themes: vlog · vocals: not yet heard
- Tempo: 114.99 BPM (measured) · first beat: 0.023 · drop: 59.33 · loudest 8 s from 58.98 s · 175.25 s
- Moods from: HoliznaCC0 album "Power Pop" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### make-funk — "Make Funk"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/bassic/make-funk/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/gvipQswrNI4uF5PNymw5d1cWq9gqqdTIsgHDMKCJ.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Make Funk by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`gvipQswrNI4uF5PNymw5d1cWq9gqqdTIsgHDMKCJ.mp3`): 4631f55b7fc2a021f24b22f60ec87735cf9163638b3a79ac1719ea3515949f9c
- Bucket object: studio/tracks/free/make-funk.m4a — SHA-256 91482c41ee049770a56e28132d4ebd740ef260fbff57f63d85e610a47586da0f, MD5 kdBDSMJIwCEmrJUNtnVJtQ==
- Loudness: -14.02 LUFS, -4.56 dBTP (loudnorm-2pass-linear)
- Tags: playful, warm · energy 5/5 · funk · themes: none · vocals: not yet heard
- Tempo: 99.0 BPM (measured) · first beat: 0.029 · drop: None · loudest 8 s from 34.39 s · 163.01 s
- Moods from: HoliznaCC0 album "Bassic" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### make-money — "Make Money"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/bassic/make-money/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/4rHAGwpxfZXDye4JNMh9EQs6MsDoQgPyCrxC4pzR.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Make Money by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`4rHAGwpxfZXDye4JNMh9EQs6MsDoQgPyCrxC4pzR.mp3`): 3f10f346e5ab4c4c63977bd0157926075e0bba768bc48e89515669b1a9c8fe90
- Bucket object: studio/tracks/free/make-money.m4a — SHA-256 980bbd13333f0cf2e20f067c3f277420ef0470f3141556ab84805a6e3ab17a08, MD5 tE2WsJnyq8Pxhr+edmB4XQ==
- Loudness: -14.05 LUFS, -3.0 dBTP (loudnorm-2pass-linear)
- Tags: driving, playful · energy 4/5 · funk · themes: sport-fitness, workout, vlog · vocals: not yet heard
- Tempo: 129.2 BPM (measured) · first beat: grid not trusted · drop: None · loudest 8 s from 38.41 s · 223.94 s
- Moods from: HoliznaCC0 album "Bassic" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### mandeville — "Mandeville"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1100809)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Mandeville.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Mandeville" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Mandeville" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Mandeville.mp3`): 12ab9c5d515da7b7d6c8f437281b369cdee4da9a53d7fbda9847a5936c4dc515
- Bucket object: studio/tracks/free/mandeville.m4a — SHA-256 677700567963119e0490ca7bd1bb1c8d1b6959cf3d36a2dbdcac107b3bbf05fe, MD5 naXRYneTTmdWtfwqETW+Qg==
- Loudness: -14.28 LUFS, -1.27 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: dark, warm · energy 2/5 · reggae · themes: slow-motion, vlog · vocals: instrumental
- Tempo: 72.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 58.68 s · 217.03 s
- Moods from: Incompetech "feel": Dark, Grooving
- Listened to in full by: nobody yet

### mars — "Mars"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/interstellar-pop-songs/mars-4/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/YkTY0ZFYFpQZLXb1UQ6imgY5CJY9jAVi33lLeaa9.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Mars by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`YkTY0ZFYFpQZLXb1UQ6imgY5CJY9jAVi33lLeaa9.mp3`): 99a8017ee955ce724529655987e5c693fc4c3cd94bbabf151c9e0bb2d5f02d0d
- Bucket object: studio/tracks/free/mars.m4a — SHA-256 c950f7901d694c010cd4625f6d6750a7f98e068562fd1db14b1296be4eca931e, MD5 HqjJZJywNynfnL9VRKcB4A==
- Loudness: -14.06 LUFS, -1.05 dBTP (loudnorm-2pass-linear)
- Tags: hype, driving · energy 5/5 · pop · themes: sport-fitness, workout · vocals: not yet heard
- Tempo: 135.0 BPM (measured) · first beat: 0.05 · drop: None · loudest 8 s from 84.64 s · 137.28 s
- Moods from: HoliznaCC0 album "Interstellar Pop Songs" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### montauk-point — "Montauk Point"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1400013)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Montauk%20Point.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Montauk Point" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Montauk Point" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Montauk Point.mp3`): bba425149807011f6a9cfd1db38bb06cab3d0e82e8a1d9ecaf280f71e5fc2b1b
- Bucket object: studio/tracks/free/montauk-point.m4a — SHA-256 ab030bfe533b9fe30094ed0dccff54a2c181202bf112385676578daeaaaca5e9, MD5 KgoOyOC+vPBIeXzfyj0icA==
- Loudness: -14.39 LUFS, -1.79 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: uplifting, bright · energy 2/5 · rock · themes: slow-motion, vlog · vocals: instrumental
- Tempo: 118.0 BPM (stated) · first beat: 0.07 · drop: 114.13 · loudest 8 s from 180.54 s · 219.72 s
- Moods from: Incompetech "feel": Bright, Bouncy, Uplifting
- Listened to in full by: nobody yet

### motivator — "Motivator"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1100803)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Motivator.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Motivator" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Motivator" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Motivator.mp3`): f34e279c759a7bb0fdeb6cea0b5a4e6264d7677408fbb48ecf13f5c538d13478
- Bucket object: studio/tracks/free/motivator.m4a — SHA-256 182f70bd02e2734260f0cc02d35898efee48e77decc195a4201ae9614e41af4f, MD5 XfYhaLJnBMvcN+imzS3QEw==
- Loudness: -14.04 LUFS, -3.88 dBTP (loudnorm-2pass-linear)
- Tags: uplifting, driving · energy 3/5 · rock · themes: championships · vocals: instrumental
- Tempo: 126.0 BPM (stated) · first beat: 0.063 · drop: None · loudest 8 s from 214.27 s · 237.82 s
- Moods from: Incompetech "feel": Bouncy, Bright, Driving, Uplifting
- Listened to in full by: nobody yet

### moving-forward — "Moving Forward"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/city-slacker/moving-forward/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/IdkCbTfdqqPvA5UK4myb5qLVuLFjX3JKUUuNxcZT.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Moving Forward by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`IdkCbTfdqqPvA5UK4myb5qLVuLFjX3JKUUuNxcZT.mp3`): f50e307ca88ff29b4294cf5f39f77b0d0c76043eebe7411fb1b6501013cd1184
- Bucket object: studio/tracks/free/moving-forward.m4a — SHA-256 9e94ceacf4422a68b730d737e15daec9d3d5447315974f5340a8b7d53c91af18, MD5 eNI6fI1JYeiFBTYjdrhLhA==
- Loudness: -14.02 LUFS, -2.32 dBTP (loudnorm-2pass-linear)
- Tags: uplifting, warm · energy 1/5 · hip-hop · themes: slow-motion · vocals: not yet heard
- Tempo: 80.8 BPM (measured) · first beat: grid not trusted · drop: 11.89 · loudest 8 s from 43.37 s · 128.93 s
- Moods from: HoliznaCC0 album "City Slacker" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### mutant-club — "Mutant Club"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/power-pop/mutant-club/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/01HWIPso52L6soAVjWsXl3zchU3ea9PuoVfWhXJ8.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Mutant Club by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`01HWIPso52L6soAVjWsXl3zchU3ea9PuoVfWhXJ8.mp3`): 385d8b71a88b933f5360ef63ed1e777ceb869e32ad6b1c6a4b784cba56a0255c
- Bucket object: studio/tracks/free/mutant-club.m4a — SHA-256 97332b5d416a9d35e02efcf9afafed08f33685c911a66985811d53e1119f5799, MD5 wCTnXwwjjnqg0rFnJxaN8Q==
- Loudness: -14.03 LUFS, -2.9 dBTP (loudnorm-2pass-linear)
- Tags: dark, driving · energy 4/5 · pop · themes: sport-fitness, workout · vocals: not yet heard
- Tempo: 140.0 BPM (measured) · first beat: 0.034 · drop: None · loudest 8 s from 2.81 s · 130.66 s
- Moods from: HoliznaCC0 album "Power Pop" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### neon-laser-horizon — "Neon Laser Horizon"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN2000023)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Neon%20Laser%20Horizon.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Neon Laser Horizon" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Neon Laser Horizon" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Neon Laser Horizon.mp3`): 1921dce762a8589e1f50fe68f827701a129946884eccd33a36c9ac7e1c2c8005
- Bucket object: studio/tracks/free/neon-laser-horizon.m4a — SHA-256 a652f8bb2648afff67eec8619e53764c0f0efdf40f7268f01d38a6e46dad90a4, MD5 ybjOss5VtvzTdoJPhFEErg==
- Loudness: -14.5 LUFS, -1.3 dBTP (gain+limiter(4x oversampled, limit -3.9 dBFS))
- Tags: uplifting, bright · energy 4/5 · synthwave · themes: championships, vlog · vocals: instrumental
- Tempo: 160.0 BPM (stated) · first beat: 0.065 · drop: None · loudest 8 s from 14.14 s · 178.57 s
- Moods from: Incompetech "feel": Grooving, Bright, Uplifting
- Listened to in full by: nobody yet

### new-gods — "New Gods"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/waves-of-nostalgia-2/new-gods/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/4s9gpMh7oy2wb9SytLpROJRogHKexUJXGqSVWgdT.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "New Gods by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`4s9gpMh7oy2wb9SytLpROJRogHKexUJXGqSVWgdT.mp3`): 645d3a2b54aee7a2f2de6a886015f7fdb220490cecba2913fab31e1cde67b2f5
- Bucket object: studio/tracks/free/new-gods.m4a — SHA-256 5c027d4be61121ea7116fddb6a3ac40c7278e489aa638808bc505b312ea5c0e9, MD5 nCJzQtXMzCHn7krU2vephQ==
- Loudness: -14.15 LUFS, -1.63 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: hype, dark · energy 3/5 · synthwave · themes: championships · vocals: not yet heard
- Tempo: 119.61 BPM (measured) · first beat: 0.351 · drop: None · loudest 8 s from 255.98 s · 315.82 s
- Moods from: HoliznaCC0 album "Waves Of Nostalgia 2" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### newer-wave — "Newer Wave"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN2000024)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Newer%20Wave.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Newer Wave" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Newer Wave" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Newer Wave.mp3`): ef26589e066cc2f60f9523f8a3c17e543f57fc9e1145efc3bc46f7e5db92d0bc
- Bucket object: studio/tracks/free/newer-wave.m4a — SHA-256 602d258669d78deda606fb1e99bd7eceff22825ea970da3dcc8cb65e50a08dc3, MD5 wddyPB3w6EjwABy5hp1q0g==
- Loudness: -14.27 LUFS, -1.79 dBTP (gain+limiter(4x oversampled, limit -4.8 dBFS))
- Tags: uplifting, bright · energy 5/5 · electronic · themes: championships · vocals: instrumental
- Tempo: 110.0 BPM (stated) · first beat: 0.058 · drop: None · loudest 8 s from 135.02 s · 174.6 s
- Moods from: Incompetech "feel": Grooving, Bright, Uplifting
- Listened to in full by: nobody yet

### night-life — "Night Life"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/waves-of-nostalgia-2/night-life/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/yYvl1UOJqmrvHNetZJWEu6TOkQPLZwqszdca7fGf.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Night Life by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`yYvl1UOJqmrvHNetZJWEu6TOkQPLZwqszdca7fGf.mp3`): 119b628fece763ccaf3da607d848258e6a281d6a45d0e27ac6c6841ee3022b21
- Bucket object: studio/tracks/free/night-life.m4a — SHA-256 d53a745b81fdf5ca00a37bc5f06d244e68647da926addabb52b8f0f810a9c9a9, MD5 qr6+TgBJIhBFQsMGrvIXgA==
- Loudness: -14.5 LUFS, -1.21 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: driving, dark · energy 3/5 · synthwave · themes: none · vocals: not yet heard
- Tempo: 93.25 BPM (measured) · first beat: 0.044 · drop: None · loudest 8 s from 60.74 s · 223.97 s
- Moods from: HoliznaCC0 album "Waves Of Nostalgia 2" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### nonstop — "Nonstop"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600042)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Nonstop.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Nonstop" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Nonstop" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Nonstop.mp3`): 2f2cef2f811dc267f958e483fa17211a3f7efcd93535adfd865ce3224f9b9b7c
- Bucket object: studio/tracks/free/nonstop.m4a — SHA-256 209e0fdcfca30517d17fa39dda79a19cf863f284071a0e8e63d9eb09d342dd21, MD5 Mx88N+1Ib9zoRf4gGTGYwA==
- Loudness: -14.15 LUFS, -1.13 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: uplifting, driving · energy 3/5 · electronic · themes: championships · vocals: instrumental
- Tempo: 128.0 BPM (stated) · first beat: 0.074 · drop: None · loudest 8 s from 59.77 s · 191.32 s
- Moods from: Incompetech "feel": Driving, Grooving, Uplifting
- Listened to in full by: nobody yet

### nowhere-land — "Nowhere Land"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600051)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Nowhere%20Land.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Nowhere Land" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Nowhere Land" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Nowhere Land.mp3`): b4439b5c329f23cd9a650e59c59b0023986e84eba812002dd4509e277e55d2c9
- Bucket object: studio/tracks/free/nowhere-land.m4a — SHA-256 4dd166f25b766bddfde84e821e720f94be38341307b6c15099f8ebe567dd3a33, MD5 FQswZsLpsSfYIeM3Gad+Fw==
- Loudness: -14.03 LUFS, -2.41 dBTP (loudnorm-2pass-linear)
- Tags: uplifting, bright · energy 4/5 · electronic · themes: championships, vlog · vocals: instrumental
- Tempo: 120.0 BPM (stated) · first beat: 0.059 · drop: None · loudest 8 s from 24.15 s · 132.08 s
- Moods from: Incompetech "feel": Bright, Uplifting
- Listened to in full by: nobody yet

### pantheon — "Pantheon"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/phonk-aura-farming/pantheon/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/15yiCDxLujj0mWw7LZHHsSxb33E1qfdAHyzoTqPB.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Pantheon by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`15yiCDxLujj0mWw7LZHHsSxb33E1qfdAHyzoTqPB.mp3`): 91f12bcbab2a774933f0beef26fccf92911d5da1c09588558374d31962fd9ee1
- Bucket object: studio/tracks/free/pantheon.m4a — SHA-256 f31adec23437292bc2f9b0842db3ee9e0e124a493fdab411173792bfdadafa96, MD5 pA60bwvOvkBL6dXZ4IhD8A==
- Loudness: -14.08 LUFS, -1.97 dBTP (loudnorm-2pass-linear)
- Tags: dark, hype · energy 3/5 · phonk · themes: none · vocals: not yet heard
- Tempo: 107.7 BPM (measured) · first beat: grid not trusted · drop: 106.81 · loudest 8 s from 42.45 s · 192.41 s
- Moods from: HoliznaCC0 album "Phonk Aura Farming" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### phonk-ish — "Phonk ish"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/phonk-aura-farming/phonk-ish/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/RLX0u2cmWIjC0KerQHMzbWSILeGhWLIkxWorpbeQ.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Phonk ish by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`RLX0u2cmWIjC0KerQHMzbWSILeGhWLIkxWorpbeQ.mp3`): 1b9f5f16caf1e3db60a731eb78bc854b049bce5fc89093ee202da6da15966817
- Bucket object: studio/tracks/free/phonk-ish.m4a — SHA-256 514a687841315850061c03bc0fa592ed36bb80f757f4814d4ff59ef9a478f2c8, MD5 IHIP8Kj3qiF3yxsHB2n+jw==
- Loudness: -14.17 LUFS, -1.43 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: dark, driving · energy 1/5 · phonk · themes: none · vocals: not yet heard
- Tempo: 75.01 BPM (measured) · first beat: 0.054 · drop: None · loudest 8 s from 93.65 s · 145.54 s
- Moods from: HoliznaCC0 album "Phonk Aura Farming" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### projector-screen-lofi-happy — "Projector Screen"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/public-domain-lofi/projector-screen-lofi-happy-mp3/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/SrYI6LJrSooBuV1Vz7XocwyKdkoXRFyNpgzn0lI4.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Projector Screen ( LoFi , Happy ) by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`SrYI6LJrSooBuV1Vz7XocwyKdkoXRFyNpgzn0lI4.mp3`): b757435f375fc9290483e6ffabf763598664b1bb37fcd4644712529ba3dd5e04
- Bucket object: studio/tracks/free/projector-screen-lofi-happy.m4a — SHA-256 c9dbefb3d0076a1e19b991db46041f9dd19efa71b5105d3b84c6d5f2461714eb, MD5 7GhjI8cofJ3Sj57RMAmrDw==
- Loudness: -14.01 LUFS, -2.36 dBTP (loudnorm-2pass-linear)
- Tags: bright, playful · energy 3/5 · lofi · themes: vlog · vocals: not yet heard
- Tempo: 140.0 BPM (measured) · first beat: 0.049 · drop: 6.99 · loudest 8 s from 46.3 s · 142.25 s
- Moods from: HoliznaCC0 album "Public Domain Lofi" and the title (the artist's own mood words in the title); not yet checked by ear
- Listened to in full by: nobody yet

### pulse — "Pulse"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1100102)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Pulse%20Rock.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Pulse" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Pulse" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Pulse Rock.mp3`): 7e390ec77b25c68f8c82475508584c5dd724f265e84bec237b11bd5370b3ede7
- Bucket object: studio/tracks/free/pulse.m4a — SHA-256 31d134e76141390ef02fd4676b3af32e65af0a80e6f6cb13f222e463fa8508c4, MD5 6PPY3QhtBrxNhYV1OFjMIQ==
- Loudness: -14.3 LUFS, -1.66 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: dark, driving · energy 4/5 · rock · themes: sport-fitness, workout · vocals: instrumental
- Tempo: 110.0 BPM (stated) · first beat: 0.349 · drop: None · loudest 8 s from 31.74 s · 176.25 s
- Moods from: Incompetech "feel": Dark, Driving
- Listened to in full by: nobody yet

### punk — "Punk"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/rock-montage/punk/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/Abb9uO4mRmose8NbER3XSh0DDvXwSh7xdyh3gkSP.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Punk by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Abb9uO4mRmose8NbER3XSh0DDvXwSh7xdyh3gkSP.mp3`): c71408dafca5c34ff66c7376ea873ee662bf78052f6e0991384947f3cbb8cf4d
- Bucket object: studio/tracks/free/punk.m4a — SHA-256 f950243197df95e8fc37edfc7ea14b6f5eb17f700821c465e9969ae62eaa1174, MD5 FO4xnaoFfq2W2WOIDPsJKw==
- Loudness: -14.07 LUFS, -5.21 dBTP (loudnorm-2pass-linear)
- Tags: hype, driving · energy 3/5 · rock · themes: championships · vocals: not yet heard
- Tempo: 117.5 BPM (measured) · first beat: grid not trusted · drop: None · loudest 8 s from 81.83 s · 131.95 s
- Moods from: HoliznaCC0 album "Rock Montage" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### ready-aim-fire — "Ready Aim Fire"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1500002)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Ready%20Aim%20Fire.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Ready Aim Fire" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Ready Aim Fire" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Ready Aim Fire.mp3`): 9c733e8227961f989b743d7566a8e6c777ebd8555265d803df740775ab31b9d3
- Bucket object: studio/tracks/free/ready-aim-fire.m4a — SHA-256 f19a8eeab87fdcf0554f8122d67bf5fac3083473cd0c13a2230796e2f0621419, MD5 ui0pdXnZ9cNdh5bY8vFLcQ==
- Loudness: -14.07 LUFS, -1.83 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: hype, driving · energy 4/5 · rock · themes: sport-fitness, workout, championships · vocals: instrumental
- Tempo: 172.0 BPM (stated) · first beat: 0.33 · drop: None · loudest 8 s from 107.83 s · 216.95 s
- Moods from: Incompetech "feel": Aggressive, Driving, Intense
- Listened to in full by: nobody yet

### retro-synths — "Retro Synths"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/power-pop/retro-synths/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/iWRFaLOfYZ7uoW1ugOUUUlfHkpsZnLzTQJ0CUWqr.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Retro Synths by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`iWRFaLOfYZ7uoW1ugOUUUlfHkpsZnLzTQJ0CUWqr.mp3`): 0aba9efcd8b2d6b127ac69676e15c7364ba5e2ed0adc811a19aa2da2eb2ed1d7
- Bucket object: studio/tracks/free/retro-synths.m4a — SHA-256 acca64bf34f19d1b9201f13fe702a15faa8e178ca124d64f1df6d64a3de36cd7, MD5 9rJUEBBUeok6VMk6G33mkQ==
- Loudness: -14.38 LUFS, -2.6 dBTP (gain+limiter(4x oversampled, limit -5.7 dBFS))
- Tags: driving, bright · energy 5/5 · pop · themes: sport-fitness, workout · vocals: not yet heard
- Tempo: 117.5 BPM (measured) · first beat: grid not trusted · drop: 16.56 · loudest 8 s from 44.72 s · 222.94 s
- Moods from: HoliznaCC0 album "Power Pop" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### rhinoceros — "Rhinoceros"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1500040)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Rhinoceros.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Rhinoceros" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Rhinoceros" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Rhinoceros.mp3`): a73fa6059d078700c7d07d0c89343753acdaa368dc78f5c843bc23ec29036fec
- Bucket object: studio/tracks/free/rhinoceros.m4a — SHA-256 7e9ebcea7ed75664d7569c487f2fdbe5d6ce0e240baecc280e823db6fc1325ba, MD5 j3mpaxTwmNCjtr0EGWEOfA==
- Loudness: -14.07 LUFS, -1.52 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: hype · energy 5/5 · electronic · themes: sport-fitness, workout, championships · vocals: instrumental
- Tempo: 126.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 62.44 s · 203.89 s
- Moods from: Incompetech "feel": Intense, Action
- Listened to in full by: nobody yet

### roof-tops — "Roof Tops"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/summer-air-lo-fi/roof-tops/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/2hFTiuqYI7onbLzpi9ldoBP8AYeuStsCUxTqm6vd.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Roof Tops by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`2hFTiuqYI7onbLzpi9ldoBP8AYeuStsCUxTqm6vd.mp3`): f6e619fbfdc0898c409494d5c810d34d9cd29be2b75bb2d8c197e1edb37155b5
- Bucket object: studio/tracks/free/roof-tops.m4a — SHA-256 74aa01f8cf0f59077e4f4691fed111a465c13e9c77b98585a8143c32a4b8cda9, MD5 rqAJfUYQCmli30FAp1U6JA==
- Loudness: -14.2 LUFS, -1.72 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: reflective, warm · energy 1/5 · lofi · themes: slow-motion · vocals: not yet heard
- Tempo: 80.0 BPM (measured) · first beat: 0.043 · drop: 9.98 · loudest 8 s from 173.27 s · 214.44 s
- Moods from: HoliznaCC0 album "Summer Air Lo-Fi" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### sense-of-purpose — "Sense Of Purpose"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/spring-at-last-lofi-tape/sense-of-purpose/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/4CDzyuvIsN3ewnoz7fj8aVy3UkqK5lcIDuuZlflA.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Sense Of Purpose by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`4CDzyuvIsN3ewnoz7fj8aVy3UkqK5lcIDuuZlflA.mp3`): f04d24e0dfa2e0be2c558ce6e9688be5f3d53000553179e38127cc87cbc066d8
- Bucket object: studio/tracks/free/sense-of-purpose.m4a — SHA-256 a4b1d9e6f71b7b0c50ca4514d345e9117ec457de037ac251d53c3ceca42e6e89, MD5 KeZqJ1mLAv4DV3FBx6Lc/A==
- Loudness: -14.32 LUFS, -1.57 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: uplifting, reflective · energy 2/5 · lofi · themes: slow-motion · vocals: not yet heard
- Tempo: 80.0 BPM (measured) · first beat: 0.025 · drop: 6.22 · loudest 8 s from 83.85 s · 122.18 s
- Moods from: HoliznaCC0 album "Spring At Last (Lofi Tape)" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### shiny-tech — "Shiny Tech"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1100078)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Shiny%20Tech.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Shiny Tech" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Shiny Tech" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Shiny Tech.mp3`): 1889779e953b392ae07c57219066e2a14407e796eaa5a167da5cea6fc622d357
- Bucket object: studio/tracks/free/shiny-tech.m4a — SHA-256 55b5131d4372aba91a6cb933123208a4a93bd265793c0af6cb34cf52bfb0e67e, MD5 qARaWpiFJgfUm0OKL+U+sw==
- Loudness: -14.35 LUFS, -2.08 dBTP (gain+limiter(4x oversampled, limit -3.9 dBFS))
- Tags: hype, uplifting · energy 5/5 · electronic · themes: sport-fitness, workout, championships · vocals: not yet heard
- Tempo: 138.0 BPM (stated) · first beat: grid not trusted · drop: 7.5 · loudest 8 s from 130.91 s · 222.67 s
- Moods from: Incompetech "feel": Driving, Action, Intense, Uplifting, Bright
- Listened to in full by: nobody yet

### spring-at-last — "Spring At Last"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/spring-at-last-lofi-tape/spring-at-last/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/b0wvuRWG2uKSphPOe6tm0WdUzgyEwB9LMTjeVGie.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Spring At Last by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`b0wvuRWG2uKSphPOe6tm0WdUzgyEwB9LMTjeVGie.mp3`): 623d4d1a4748a72eb6147c7a940ef6dcd2e96fd3d63b4e4b8f7d64a4387530d8
- Bucket object: studio/tracks/free/spring-at-last.m4a — SHA-256 7030a046d6e98ee197e8e0630b63fb09d5d54e8a9efe4909fe31497af2e8658a, MD5 MWoI+QizBEDfxsHQ7fXSCg==
- Loudness: -14.5 LUFS, -2.07 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: warm, bright · energy 2/5 · lofi · themes: slow-motion, vlog · vocals: not yet heard
- Tempo: 140.0 BPM (measured) · first beat: 0.034 · drop: None · loudest 8 s from 102.82 s · 137.09 s
- Moods from: HoliznaCC0 album "Spring At Last (Lofi Tape)" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### street-lights-passing-by — "Street Lights Passing By"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/waves-of-nostalgia-2/street-lights-passing-by/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/Dic7e8LgNkbdqdsX1jjETsRfbgLdxBLn9rllznl1.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Street Lights Passing By by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Dic7e8LgNkbdqdsX1jjETsRfbgLdxBLn9rllznl1.mp3`): a8cc8cef62321f85ea34272578523c04322b9d49231280cb191f685f8a009bcf
- Bucket object: studio/tracks/free/street-lights-passing-by.m4a — SHA-256 1a4d6c65848dcd003439fe60f829ea7c2583c27ad11edc13ec1e6c2e59787447, MD5 0+poY0/rxXivbrK+hgQi6w==
- Loudness: -14.04 LUFS, -1.21 dBTP (loudnorm-2pass-linear)
- Tags: reflective, driving · energy 2/5 · synthwave · themes: slow-motion · vocals: not yet heard
- Tempo: 90.0 BPM (measured) · first beat: 0.038 · drop: 11.63 · loudest 8 s from 142.97 s · 215.95 s
- Moods from: HoliznaCC0 album "Waves Of Nostalgia 2" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### super-power-cool-dude — "Super Power Cool Dude"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600036)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Super%20Power%20Cool%20Dude.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Super Power Cool Dude" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Super Power Cool Dude" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Super Power Cool Dude.mp3`): 20f5111a77fe1e482ae1c5bbeaa64f65c467d3d5b5453e8386afd8afd23a9989
- Bucket object: studio/tracks/free/super-power-cool-dude.m4a — SHA-256 1567fa4119d9b159be0491d15a7ea2a5dca5b8bddbefe61e8163b5dc208b94aa, MD5 JXsRV4N3wj5p4LsIvGAJpA==
- Loudness: -14.18 LUFS, -1.32 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: hype, uplifting · energy 3/5 · electronic · themes: championships · vocals: instrumental
- Tempo: 110.0 BPM (stated) · first beat: 0.06 · drop: None · loudest 8 s from 216.57 s · 235.7 s
- Moods from: Incompetech "feel": Action, Driving, Uplifting
- Listened to in full by: nobody yet

### the-good-times — "The Good Times"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/be-happy-with-who-you-are/the-good-times/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/4e5GjL0fiBnn8ZtCegJ7U337KfG91HXRzDjE3mkg.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "The Good Times by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`4e5GjL0fiBnn8ZtCegJ7U337KfG91HXRzDjE3mkg.mp3`): 1278ca58edeb7003150629baf593461314b41d41fe987ac3e133eea4ac316303
- Bucket object: studio/tracks/free/the-good-times.m4a — SHA-256 e6aee98931503bf07c33e6e55ad95727b4e963d92ec07b2a31e08615b94e8b73, MD5 AHCbRDklS3MxWNLKp2I1nA==
- Loudness: -14.04 LUFS, -3.17 dBTP (loudnorm-2pass-linear)
- Tags: bright, uplifting · energy 2/5 · lofi · themes: slow-motion, vlog · vocals: not yet heard
- Tempo: 90.0 BPM (measured) · first beat: 0.033 · drop: 46.65 · loudest 8 s from 13.72 s · 141.29 s
- Moods from: HoliznaCC0 album "Be Happy With Who You Are" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### too-cool — "Too Cool"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600068)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Too%20Cool.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Too Cool" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Too Cool" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Too Cool.mp3`): f1ebb92d48941c8cca461f512cb5322617a1ce632a62ec761dcd01e457702162
- Bucket object: studio/tracks/free/too-cool.m4a — SHA-256 1510cb7564f3aa9b0367b53e0aaaf20002398d3787a5612d74189b971a774d78, MD5 cNtI1YAwr3K6RfOvjA2POg==
- Loudness: -14.02 LUFS, -3.02 dBTP (loudnorm-2pass-linear)
- Tags: warm · energy 3/5 · hip-hop · themes: vlog · vocals: instrumental
- Tempo: 80.0 BPM (stated) · first beat: grid not trusted · drop: 121.0 · loudest 8 s from 14.16 s · 181.58 s
- Moods from: Incompetech "feel": Grooving, Relaxed
- Listened to in full by: nobody yet

### twisted — "Twisted"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1400046)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Twisted.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Twisted" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Twisted" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Twisted.mp3`): 56a2305a7b0356a9e0054fc4d8636a6d86f366578618f7271880136defe7ccda
- Bucket object: studio/tracks/free/twisted.m4a — SHA-256 ce2d251e73bd584c803a94201f8b46026dd52dca82b8460c213c49888d7df850, MD5 pt0AzXotZ+q2LqEyFCPrjg==
- Loudness: -14.02 LUFS, -4.41 dBTP (loudnorm-2pass-linear)
- Tags: driving, warm · energy 3/5 · rock · themes: vlog · vocals: instrumental
- Tempo: 118.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 31.37 s · 187.19 s
- Moods from: Incompetech "feel": Driving, Grooving
- Listened to in full by: nobody yet

### unity — "Unity"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1400014)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Unity.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Unity" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Unity" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Unity.mp3`): d244d14d86d7fdaee36f2ed45c22406f19d1042bc6535ee42939ab8eb5020225
- Bucket object: studio/tracks/free/unity.m4a — SHA-256 08b1723e891571565b8cdc5ef345fc6fead1876dda71115a9d1339d7a39f258a, MD5 6Q0uiZ0DTCHjZjxBHkZZaQ==
- Loudness: -14.47 LUFS, -1.13 dBTP (gain+limiter(4x oversampled, limit -3.0 dBFS))
- Tags: hype, driving · energy 4/5 · cinematic · themes: sport-fitness, workout, championships · vocals: instrumental
- Tempo: 140.0 BPM (stated) · first beat: 0.064 · drop: 165.26 · loudest 8 s from 230.2 s · 264.07 s
- Moods from: Incompetech "feel": Action, Driving, Intense
- Listened to in full by: nobody yet

### urban-gauntlet — "Urban Gauntlet"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1500009)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Urban%20Gauntlet.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Urban Gauntlet" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Urban Gauntlet" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Urban Gauntlet.mp3`): 663078120ab0651f1992b8ea33e5f8752cbaeb7c2684b55408519b8cfe61d216
- Bucket object: studio/tracks/free/urban-gauntlet.m4a — SHA-256 35ccdbb4b63e3ce0e4cc0fdb8e0d56d1b35f92cb28831f8f0c702d679b983156, MD5 SJvs9UMiMU/lJkRdjjbXVQ==
- Loudness: -14.46 LUFS, -2.67 dBTP (gain+limiter(4x oversampled, limit -4.8 dBFS))
- Tags: hype · energy 4/5 · cinematic · themes: sport-fitness, workout, championships · vocals: instrumental
- Tempo: 116.0 BPM (stated) · first beat: 0.065 · drop: 194.49 · loudest 8 s from 154.71 s · 209.03 s
- Moods from: Incompetech "feel": Epic, Intense
- Listened to in full by: nobody yet

### venus — "Venus"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/interstellar-pop-songs/venus-2/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/qh9Kcq7mzHhQjNQEb8tmfWPCAibY7DDeDG1zHYfw.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Venus by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: yes — CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`qh9Kcq7mzHhQjNQEb8tmfWPCAibY7DDeDG1zHYfw.mp3`): 46711fbf6ca93728360be4c962462000a2a3e02fff0601b3da86813a07b55501
- Bucket object: studio/tracks/free/venus.m4a — SHA-256 39278d2c3dee868fc7ea66c67a4947aaa8c1bed39d802dc536e19201c3410d84, MD5 G47lj04XJbnGuUIErwpdKQ==
- Loudness: -14.02 LUFS, -3.49 dBTP (loudnorm-2pass-linear)
- Tags: warm, bright · energy 2/5 · pop · themes: slow-motion, vlog · vocals: not yet heard
- Tempo: 85.0 BPM (measured) · first beat: 0.036 · drop: None · loudest 8 s from 11.31 s · 300.65 s
- Moods from: HoliznaCC0 album "Interstellar Pop Songs" and the title; not yet checked by ear
- Listened to in full by: nobody yet

### voltaic — "Voltaic"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1600056)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Voltaic.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Voltaic" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Voltaic" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Voltaic.mp3`): 98d6a79a8577c17648ffa533ab213f709005c3a3a51c32e2ad8bd38eb361b5df
- Bucket object: studio/tracks/free/voltaic.m4a — SHA-256 e5cafb933a04edf808ef4b6517a7e099db07118065e827c7db334301640cb53f, MD5 tp6RxmQw4kKU+1l0huC5WQ==
- Loudness: -14.35 LUFS, -1.28 dBTP (gain+limiter(4x oversampled, limit -5.7 dBFS))
- Tags: hype, driving · energy 5/5 · electronic · themes: sport-fitness, workout, championships · vocals: instrumental
- Tempo: 120.0 BPM (stated) · first beat: grid not trusted · drop: None · loudest 8 s from 177.75 s · 196.08 s
- Moods from: Incompetech "feel": Action, Driving, Grooving
- Listened to in full by: nobody yet

### werq — "Werq"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1800005)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Werq.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Werq" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Werq" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Werq.mp3`): e03bc2d89a1913ba68d120c806141952bea09d93cf11fcc0cac7c2d378014d13
- Bucket object: studio/tracks/free/werq.m4a — SHA-256 8d9bb52e57687f73ea9d942ee44834781b9354b081a98190e02d9fe8e3c7b1ac, MD5 /ZnvRQAC6ZQ1uuyimP2KEQ==
- Loudness: -14.21 LUFS, -1.55 dBTP (gain+limiter(4x oversampled, limit -3.9 dBFS))
- Tags: bright, warm · energy 3/5 · pop · themes: vlog · vocals: instrumental
- Tempo: 125.0 BPM (stated) · first beat: 0.061 · drop: 94.13 · loudest 8 s from 0.0 s · 162.3 s
- Moods from: Incompetech "feel": Bright, Grooving, Relaxed
- Listened to in full by: nobody yet

### who-likes-to-party — "Who Likes to Party"

- Artist: Kevin MacLeod
- Track page: https://incompetech.com/music/royalty-free/music.html (ISRC USUAN1200075)
- File as linked: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Who%20Likes%20to%20Party.mp3
- Licence shown: "Licensed under Creative Commons: By Attribution 4.0 License" (CC-BY-4.0)
- Evidence: Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track's description - this description has none.
- Credit to carry (TASL, locked in the caption): "Who Likes to Party" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)
- The source's own credit text: "Who Likes to Party" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/
- Content ID: registered (the source describes claims on its recordings and how a credit releases them)
- Brand-safe: no — CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`Who Likes to Party.mp3`): 4a5d168d1714f750c85a928db9f61dba7e4c4a188965fdaac659f58daff4f7d6
- Bucket object: studio/tracks/free/who-likes-to-party.m4a — SHA-256 e2085b66f3e63fea5695a24793b8b49b686f56760a2c45c8713a892007301750, MD5 K7xIW76pbUXKnwvYYDcuow==
- Loudness: -14.12 LUFS, -2.3 dBTP (loudnorm-2pass-linear)
- Tags: hype, uplifting · energy 5/5 · disco · themes: sport-fitness, workout · vocals: instrumental
- Tempo: 117.0 BPM (stated) · first beat: 0.457 · drop: 189.27 · loudest 8 s from 0.33 s · 257.49 s
- Moods from: Incompetech "feel": Action, Bright, Grooving, Intense, Uplifting
- Listened to in full by: nobody yet

### windows-down — "Windows Down"

- Artist: HoliznaCC0
- Track page: https://freemusicarchive.org/music/holiznacc0/lazy-summer-lofi-1/windows-downmp3/
- File as linked: https://files.freemusicarchive.org/storage-freemusicarchive-org/tracks/jZCjMLhNU3T6APLZgxzqkLTGAuHY8RJzH29w0iFe.mp3
- Licence shown: "CC0 1.0 Universal License" (CC0-1.0)
- Evidence: Track page says: "Windows Down by HoliznaCC0 is licensed under a CC0 1.0 Universal License", linking creativecommons.org/publicdomain/zero/1.0/.
- Credit to carry (TASL, locked in the caption): none owed
- The source's own credit text: none asked for
- Content ID: not known
- Brand-safe: no — CC0, but a sample-based genre: a CC0 dedication cannot clear a third party's sample, so it is not offered under brand work until someone has listened for samples.
- Retrieved on: 2026-10-12, by script (scripts/music/fetch_library.py)
- SHA-256 as downloaded (`jZCjMLhNU3T6APLZgxzqkLTGAuHY8RJzH29w0iFe.mp3`): 54dc5dfb84c8ea71fa16866c4ad14d10ae4063e68d03f0f284156826ad882fac
- Bucket object: studio/tracks/free/windows-down.m4a — SHA-256 cbe8df6a9f5a8e6ba3f726a167d90f4d1c7adcce1ac4ef1fd2be0857285972c4, MD5 0eZ50mwaUf6vgU09qVe5/w==
- Loudness: -14.16 LUFS, -1.58 dBTP (gain+limiter(4x oversampled, limit -2.0 dBFS))
- Tags: warm, reflective · energy 3/5 · lofi · themes: vlog · vocals: not yet heard
- Tempo: 107.7 BPM (measured) · first beat: grid not trusted · drop: 5.32 · loudest 8 s from 110.71 s · 165.77 s
- Moods from: HoliznaCC0 album "Lazy Summer Lofi" and the title; not yet checked by ear
- Listened to in full by: nobody yet
