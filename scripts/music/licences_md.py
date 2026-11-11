"""Step 4: library.manifest.json + recs_ids.json -> LIBRARY-LICENSES.md (one licence record per track)."""
import json

rows = json.load(open('library.manifest.json', encoding='utf-8'))
recs = {r['id']: r for r in json.load(open('recs_ids.json'))}
out = []
out.append('''# Free music library — what we ship, and the grant we rely on for each

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
''')
for r in rows:
    src = recs[r['id']]
    lines = [f"### {r['id']} — \"{r['title']}\"", '',
             f"- Artist: {r['artist']}",
             f"- Track page: {r['sourceUrl']}" + (f" (ISRC {r['isrc']})" if r.get('isrc') else ''),
             f"- File as linked: {r['fileUrl']}",
             f"- Licence shown: \"{r['licenceShown']}\" ({r['licence']})",
             f"- Evidence: {src['licenceEvidence']}",
             f"- Credit to carry (TASL, locked in the caption): {r['creditLine'] if r['creditLine'] else 'none owed'}",
             f"- The source's own credit text: {r['sourceCreditText'] if r['sourceCreditText'] else 'none asked for'}",
             f"- Content ID: {'registered (the source describes claims on its recordings and how a credit releases them)' if r['contentIdRegistered'] else 'not known' if r['contentIdRegistered'] is None else 'not registered'}",
             f"- Brand-safe: {'yes' if r['brandSafe'] else 'no'} — {r['brandSafeWhy']}",
             f"- Retrieved on: {r['retrievedOn']}, by script (scripts/music/fetch_library.py)",
             f"- SHA-256 as downloaded (`{r['sourceFile']}`): {r['sourceSha256']}",
             f"- Bucket object: {r['gcsPath']} — SHA-256 {r['sha256']}, MD5 {r['md5Base64']}",
             f"- Loudness: {r['loudness']['integratedLufs']} LUFS, {r['loudness']['truePeakDbtp']} dBTP ({r['loudness']['method']})",
             f"- Tags: {', '.join(r['moods'])} · energy {r['energy']}/5 · {r['genre']} · themes: {', '.join(r['themes']) or 'none'} · vocals: {r['vocals'] or 'not yet heard'}",
             f"- Tempo: {r['bpm']} BPM ({r['bpmSource']}) · first beat: {r['firstBeatSec'] if r['firstBeatSec'] is not None else 'grid not trusted'} · drop: {r['sections']['dropSec']} · loudest 8 s from {r['sections']['peakSec']} s · {r['durationSec']} s" + (' · loops' if r['loops'] else ''),
             f"- Moods from: {r['moodsFrom']}",
             "- Listened to in full by: nobody yet", '']
    out.append('\n'.join(lines))
open('LIBRARY-LICENSES.md', 'w', encoding='utf-8').write('\n'.join(out))
print('records', len(rows))
