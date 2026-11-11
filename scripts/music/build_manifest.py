"""Step 3: the downloads' records (recs_ids.json) + measurements (analysis.json) + the tagging rules below
-> library.manifest.json. md5 comes from upload.json (gsutil ls -L after upload)."""
import json, os, statistics as st, re, collections

recs = {r['id']: r for r in json.load(open('recs_ids.json'))}
ana = {a['id']: a for a in json.load(open('analysis.json'))}
md5 = json.load(open('upload.json')) if os.path.exists('upload.json') else {}
grid = {g['id']: g for g in json.load(open('grid.json'))}
pieces = {p['title']: p for p in json.load(open('pieces.json', encoding='utf-8'))}
INC_GENRE = {'7': 'electronic', '19': 'rock', '22': 'cinematic', '6': 'disco', '16': 'pop', '8': 'funk', '18': 'reggae',
             '24': 'electronic', '26': 'hip-hop'}
# Incompetech's "Contemporary" is not a genre Artlist or Epidemic use: placed by its instruments.
CONTEMPORARY = {'Super Power Cool Dude': 'electronic', 'Dreamer': 'acoustic', 'Late Night Radio': 'electronic',
                'Dream Culture': 'acoustic', 'Neon Laser Horizon': 'synthwave', 'Angel Share': 'rock', 'Carefree': 'acoustic',
                'Montauk Point': 'rock'}
HOL_GENRE = {'rock-montage': 'rock', 'power-pop': 'pop', 'gamer-beats': 'chiptune', 'phonk-aura-farming': 'phonk',
             'lazy-summer-lofi-1': 'lofi', 'summer-air-lo-fi': 'lofi', 'city-slacker': 'hip-hop', 'waves-of-nostalgia-2': 'synthwave',
             'interstellar-pop-songs': 'pop', 'be-happy-with-who-you-are': 'lofi', 'bassic': 'funk', 'public-domain-lofi': 'lofi',
             'spring-at-last-lofi-tape': 'lofi'}


def themes_of(moods, energy, genre):
    t = []
    if energy >= 4 and set(moods) & {'hype', 'driving'}: t += ['sport-fitness', 'workout']
    if energy >= 3 and set(moods) & {'hype', 'uplifting'} and genre in ('cinematic', 'rock', 'electronic', 'synthwave'): t.append('championships')
    if energy <= 2 and set(moods) & {'reflective', 'warm', 'uplifting'}: t.append('slow-motion')
    if set(moods) & {'bright', 'playful', 'warm'} and 2 <= energy <= 4: t.append('vlog')
    return t


def vocals_of(r):
    if r['source'] != 'incompetech': return None
    ins = (pieces[r['title']]['instruments'] or '')
    if ins.strip() in ('', 'None'): return None
    if any(w in ins for w in ('Singers', 'Choir', 'Vocal', 'Voice')): return 'backing'
    return 'instrumental'

PRIO = ['hype', 'dark', 'uplifting', 'driving', 'bright', 'playful', 'reflective', 'warm']
FM = {'Intense': 'hype', 'Epic': 'hype', 'Action': 'hype', 'Aggressive': 'hype', 'Driving': 'driving', 'Dark': 'dark',
      'Bright': 'bright', 'Uplifting': 'uplifting', 'Bouncy': 'playful', 'Humorous': 'playful', 'Relaxed': 'warm',
      'Grooving': 'warm', 'Calming': 'reflective', 'Somber': 'reflective'}
# HoliznaCC0: the artist gives the genre (album) and, on the lofi album, mood words in the title. Elsewhere the mood
# is ours, from the album's genre and the title, checked against the measured energy and tempo. Strongest first.
HOL = {
    'Grunge': ['driving', 'dark'], 'Jams': ['driving', 'bright'], 'Punk': ['hype', 'driving'], 'Americana': ['uplifting', 'warm'],
    'Classic': ['driving', 'bright'], 'Funky Pop': ['playful', 'bright'], 'Happy Dance': ['bright', 'playful'],
    'Retro Synths': ['driving', 'bright'], '50 Over The Speed Limit': ['hype', 'driving'], 'Bouncing': ['playful', 'bright'],
    'Back In The 80s': ['driving', 'uplifting'], 'Mutant Club': ['dark', 'driving'], 'Love Love Love': ['warm', 'bright'],
    'Final Level': ['hype', 'driving'], 'Hard Mode': ['hype', 'dark'], 'Legends': ['uplifting', 'hype'],
    'Pantheon': ['dark', 'hype'], 'Phonk ish': ['dark', 'driving'],
    'Windows Down': ['warm', 'reflective'], 'Blue Skies': ['warm', 'bright'], 'Roof Tops': ['reflective', 'warm'],
    'August Never Lasts': ['reflective', 'warm'], 'Busking In the SunLight': ['warm', 'bright'],
    'Hooptie With The Windows Down': ['warm', 'playful'], 'Moving Forward': ['uplifting', 'warm'],
    'Endless Grind': ['driving', 'dark'], 'Fresh Fit': ['playful', 'warm'],
    'Night Life': ['driving', 'dark'], 'All The Fight Left': ['hype', 'uplifting'], 'New Gods': ['hype', 'dark'],
    'Street Lights Passing By': ['reflective', 'driving'], 'Mars': ['hype', 'driving'], 'Venus': ['warm', 'bright'],
    'Jupiter': ['uplifting', 'bright'], 'The Good Times': ['bright', 'uplifting'], 'City Lights': ['warm', 'reflective'],
    'Finding Yourself': ['reflective', 'uplifting'], 'Make Funk': ['playful', 'warm'], 'Make Money': ['driving', 'playful'],
    'Bubbles ( Lofi , Bright , Relaxed )': ['bright', 'warm'], 'Projector Screen ( LoFi , Happy )': ['bright', 'playful'],
    'Canon Event ( Lofi , Sad , Reflection )': ['reflective'], 'Spring At Last': ['warm', 'bright'],
    'Sense Of Purpose': ['uplifting', 'reflective'],
}
ALBUM = {'rock-montage': 'Rock Montage', 'power-pop': 'Power Pop', 'gamer-beats': 'Gamer Beats',
         'phonk-aura-farming': 'Phonk Aura Farming', 'lazy-summer-lofi-1': 'Lazy Summer Lofi', 'summer-air-lo-fi': 'Summer Air Lo-Fi',
         'city-slacker': 'City Slacker', 'waves-of-nostalgia-2': 'Waves Of Nostalgia 2', 'interstellar-pop-songs': 'Interstellar Pop Songs',
         'be-happy-with-who-you-are': 'Be Happy With Who You Are', 'bassic': 'Bassic', 'public-domain-lofi': 'Public Domain Lofi',
         'spring-at-last-lofi-tape': 'Spring At Last (Lofi Tape)'}
# Sample-based genres: a CC0 dedication covers what is the uploader's to give and cannot clear a third party's sample.
# Until someone has listened for samples, these are not offered under brand work.
SAMPLE_RISK = {'phonk-aura-farming', 'lazy-summer-lofi-1', 'summer-air-lo-fi', 'city-slacker', 'be-happy-with-who-you-are',
               'bassic', 'public-domain-lofi', 'spring-at-last-lofi-tape'}
CALM = {'Calming', 'Relaxed', 'Somber'}
HOT = {'Intense', 'Aggressive', 'Action', 'Epic'}

ids = [i for i in recs if i in ana]


def z(vals):
    m = st.mean(vals); s = st.pstdev(vals) or 1
    return [(v - m) / s for v in vals]


def bpm_of(r, a):
    if r['source'] == 'incompetech':
        s = r['sourceBpm']; m = a['measuredBpm']
        agree = any(abs(m * f - s) / s < 0.04 for f in (1, 2, 0.5, 1.5, 2 / 3))
        return s, 'stated', agree
    b = a['measuredBpm']
    while b < 70: b *= 2
    while b > 180: b /= 2
    return round(b, 1), 'measured', None


bp = {i: bpm_of(recs[i], ana[i]) for i in ids}
on = z([ana[i]['onsetMean'] for i in ids]); rate = z([ana[i]['onsetRate'] for i in ids])
bz = z([bp[i][0] for i in ids]); cz = z([ana[i]['centroid'] for i in ids])
score = {i: 0.4 * on[k] + 0.25 * rate[k] + 0.2 * bz[k] + 0.15 * cz[k] for k, i in enumerate(ids)}
srt = sorted(score.values()); q = [srt[len(srt) * k // 5] for k in (1, 2, 3, 4)]
rows = []; mism = []
for i in ids:
    r = recs[i]; a = ana[i]
    e = 1 + sum(score[i] >= x for x in q)
    if r['source'] == 'incompetech':
        feel = [f.strip() for f in r['sourceFeel'].split(',')]
        ms = sorted({FM[f] for f in feel if f in FM}, key=PRIO.index)[:2]
        if set(feel) & CALM and not set(feel) & HOT and e >= 4: e = 3
        if set(feel) & HOT and e <= 2: e = 3
        moods_from = f'Incompetech "feel": {r["sourceFeel"]}'
        if not bp[i][2]: mism.append((i, r['sourceBpm'], a['measuredBpm']))
    else:
        ms = HOL[r['title']]
        own = ' (the artist\'s own mood words in the title)' if '(' in r['title'] else ''
        moods_from = f'HoliznaCC0 album "{ALBUM[r["album"]]}" and the title{own}; not yet checked by ear'
    # The measured band, kept consistent with the mood: a hype or driving track is never 'low'; a warm or reflective
    # one never 'high'.
    if ms[0] in ('hype', 'driving') and e <= 2: e = 3
    if ms[0] in ('warm', 'reflective') and e >= 4: e = 3
    if r['source'] == 'incompetech':
        genre = CONTEMPORARY.get(r['title'], INC_GENRE.get(r['sourceGenre'], 'electronic')) if r['sourceGenre'] == '5' else INC_GENRE[r['sourceGenre']]
    else:
        genre = HOL_GENRE[r['album']]
    g = grid[i]
    bpm = bp[i][0]; bpm_src = bp[i][1]
    if r['source'] != 'incompetech' and g['gridAgrees'] and g['bpm']:
        gb = g['bpm']
        for f in (1, 2, 0.5):
            if abs(gb * f - bpm) / bpm < 0.04: bpm = round(gb * f, 2); break
    first = None
    if g['gridAgrees'] and g['bpm']:
        if abs(g['bpm'] - bpm) / bpm < 0.01: first = g['firstBeatSec']
        elif abs(g['bpm'] * 2 - bpm) / bpm < 0.01: first = round(g['firstBeatSec'] % (60 / bpm), 3)
    drop = g['dropSec'] if g['dropSec'] is not None and g['dropSec'] >= 5 else None
    credit = (f'"{r["title"]}" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0 (creativecommons.org/licenses/by/4.0)'
              if r['licence'] == 'CC-BY-4.0' else None)
    cc0 = r['licence'] == 'CC0-1.0'
    safe = cc0 and r['album'] not in SAMPLE_RISK
    why = ('CC0: no conditions; commercial and advertising use allowed; a rock, synth or pop production, not a sample-based genre.' if safe
           else 'CC0, but a sample-based genre: a CC0 dedication cannot clear a third party\'s sample, so it is not offered under brand work until someone has listened for samples.' if cc0
           else 'CC BY 4.0 allows commercial use only with the credit carried on the post; a brand controls its own deliverable, so it is not offered under brand work.')
    title = r['title'] if r['source'] == 'incompetech' else re.sub(r'\s*\(.*\)\s*$', '', r['title']).strip()
    row = dict(id=i, title=title, artist=r['artist'], source=r['source'], sourceUrl=r['pageUrl'], fileUrl=r['fileUrl'],
               retrievedOn=r['retrievedOn'], licence=r['licence'], licenceShown=r['licenceShown'], attributionRequired=r['licence'] != 'CC0-1.0',
               creditLine=credit, sourceCreditText=r['attribution'],
               contentIdRegistered=True if r['source'] == 'incompetech' else None,
               brandSafe=safe, brandSafeWhy=why, moods=ms, moodsFrom=moods_from, energy=e, genre=genre,
               themes=themes_of(ms, e, genre), vocals=vocals_of(r), bpm=bpm, bpmSource=bpm_src, firstBeatSec=first,
               sections=dict(dropSec=drop, peakSec=g['peakSec']),
               durationSec=a['durationSec'], loops=bool(a['headDb'] > -6 and a['tailDb'] > -6),
               gcsPath=f'studio/tracks/free/{i}.m4a', bytes=a['bytes'], sha256=a['sha256'],
               md5Base64=md5.get(i, 'AAAAAAAAAAAAAAAAAAAAAA=='), sourceFile=r['sourceFile'], sourceSha256=a['sourceSha256'],
               loudness=dict(integratedLufs=a['outI'], truePeakDbtp=a['outTP'], method=a['method']), listenedBy=None)
    if r.get('isrc'): row['isrc'] = r['isrc']
    rows.append(row)
rows.sort(key=lambda x: x['id'])
with open('library.manifest.json', 'w', encoding='utf-8') as f:
    json.dump(rows, f, indent=2, ensure_ascii=False); f.write('\n')
print('tracks', len(rows), 'brandSafe', sum(r['brandSafe'] for r in rows))
print('primary mood', collections.Counter(r['moods'][0] for r in rows))
print('any mood', collections.Counter(m for r in rows for m in r['moods']))
print('energy', collections.Counter(r['energy'] for r in rows), 'loops', sum(r['loops'] for r in rows))
print('genre', collections.Counter(r['genre'] for r in rows)); print('themes', collections.Counter(t for r in rows for t in r['themes']))
print('grid', sum(r['firstBeatSec'] is not None for r in rows), 'vocals', collections.Counter(r['vocals'] for r in rows))
print('brand-safe by mood', collections.Counter(m for r in rows if r['brandSafe'] for m in r['moods']))
print('bpm mismatches (stated kept)', mism)
