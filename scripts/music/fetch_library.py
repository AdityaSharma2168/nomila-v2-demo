"""
scripts/music — rebuild the free music library (server/studio/music/library.manifest.json + LIBRARY-LICENSES.md).

Run from an empty work directory, in order (Python 3.12, librosa 0.11, numpy; ffmpeg/ffprobe on PATH):
  1. python fetch_library.py      the catalogue pages and each track's own page; licence text read and recorded;
                                  the file the page links downloaded (raw/), one request a second -> recs.json
  2. python analyse_library.py    normalise to -14 LUFS / -1 dBTP (out/<id>.m4a), measure BPM, energy features,
                                  fades -> analysis.json, recs_ids.json
     python retry_loudness.py       a dynamic-loudnorm retry for any that missed (still missing: left out)
     python analyse_grid.py         beat grid (half-split check) and sections -> grid.json
  3. gsutil cp out/*.m4a gs://<dev media bucket>/studio/tracks/free/  then  python upload_md5.py <bucket>
  4. python build_manifest.py     tags + licence + hashes -> library.manifest.json
  5. python licences_md.py        -> LIBRARY-LICENSES.md
Copy the two outputs to server/studio/music/. Picks (which tracks) are in picks.py.
"""
import json,re,subprocess,time,hashlib,html,urllib.parse,datetime,os
from picks import INC,FMA
today=datetime.date.today().isoformat()
def curl(url,out):
  r=subprocess.run(['curl','-sSL','-m','120','-A','Mozilla/5.0 (nomila music licence check)','-o',out,'-w','%{http_code}',url],capture_output=True,text=True)
  return r.stdout.strip()
def sha(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()
recs=[]
# Incompetech: the catalogue entry IS the track's page data; the site renders the licence block from it.
os.makedirs('raw',exist_ok=True); os.makedirs('pages',exist_ok=True)
curl('https://incompetech.com/llms.txt','llms.txt')
curl('https://incompetech.com/music/royalty-free/pieces.json','pieces.json')
curl('https://incompetech.com/music/royalty-free/music.html','inc-music.html')
dupes={}
for p in json.load(open('pieces.json',encoding='utf-8')): dupes[p['title']]=dupes.get(p['title'],0)+1
pieces={p['title']:p for p in json.load(open('pieces.json',encoding='utf-8'))}
music_html=open('inc-music.html',encoding='utf-8').read()
assert 'Licensed under Creative Commons: By Attribution 4.0 License' in music_html
for t in INC:
  p=pieces[t]; assert dupes[t]==1,t
  desc=p['description'] or ''
  if re.search(r'licen|creative commons|not available|exception|commission|rights',desc,re.I): raise SystemExit('exception text '+t)
  url='https://incompetech.com/music/royalty-free/mp3-royaltyfree/'+urllib.parse.quote(p['filename'])
  out='raw/inc-'+re.sub(r'[^a-z0-9]+','-',t.lower()).strip('-')+'.mp3'
  if not os.path.exists(out): c=curl(url,out); time.sleep(1)
  else: c='200'
  recs.append(dict(source='incompetech',title=t,artist='Kevin MacLeod',album=None,
    pageUrl='https://incompetech.com/music/royalty-free/music.html',fileUrl=url,isrc=p['isrc'],
    licence='CC-BY-4.0',licenceShown='Licensed under Creative Commons: By Attribution 4.0 License',
    licenceEvidence='Track entry in the site catalogue (pieces.json, uuid/isrc above) rendered by music.html with the attribution block "Licensed under Creative Commons: By Attribution 4.0 License"; licences page: free use requires attribution (CC BY 4.0); FAQ: exceptions are noted in a track\'s description - this description has none.',
    attribution=f'"{t}" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 License http://creativecommons.org/licenses/by/4.0/',
    sourceBpm=float(p['bpm']),sourceFeel=p['feel'],sourceGenre=p['genre'],description=desc,
    retrievedOn=today,file=out,http=c,sourceFile=p['filename']))
  print('inc',t,c)
# HoliznaCC0 on the Free Music Archive: each album page lists its tracks (data-track-info), with each track's own page.
tracks=[]
for a in FMA:
  f=f'pages/alb-{a}.html'
  if not os.path.exists(f): curl(f'https://freemusicarchive.org/music/holiznacc0/{a}/',f); time.sleep(1)
  seen=set()
  for m in re.finditer(r"data-track-info='([^']*)'",open(f,encoding='utf-8',errors='replace').read()):
    j=json.loads(html.unescape(m.group(1)))
    if j['id'] in seen: continue
    seen.add(j['id']); j['album']=a; tracks.append(j)
for a,titles in FMA.items():
  for t in titles:
    j=[x for x in tracks if x['album']==a and x['title']==t][0]
    pg='pages/fma-'+j['handle']+'.html'
    if not os.path.exists(pg): curl(j['url'],pg); time.sleep(1)
    txt=re.sub(r'\s+',' ',re.sub(r'<[^>]*>',' ',open(pg,encoding='utf-8',errors='replace').read()))
    m=re.search(r'is licensed under an? (.{3,80}?) License',txt)
    shown=m.group(1).strip() if m else None
    ok = shown=='CC0 1.0 Universal'
    # the file the page itself embeds for this track (its own player/download data)
    t2=open(pg,encoding='utf-8',errors='replace').read()
    fm=re.search(r'"fileUrl":"([^"]+)"',html.unescape(t2))
    furl=fm.group(1).replace('\\/','/') if fm else j['fileUrl']
    out='raw/fma-'+j['handle']+'.mp3'
    c='skip'
    if ok and not os.path.exists(out): c=curl(furl,out); time.sleep(1)
    recs.append(dict(source='fma-holiznacc0',title=t.replace('.mp3',''),artist='HoliznaCC0',album=a,pageUrl=j['url'],fileUrl=furl,isrc=None,
      licence='CC0-1.0' if ok else None,licenceShown=(shown+' License') if shown else None,
      licenceEvidence=f'Track page says: "{t.replace(".mp3","")} by HoliznaCC0 is licensed under a {shown} License", linking creativecommons.org/publicdomain/zero/1.0/.' if ok else 'NOT VERIFIED',
      attribution=None,sourceBpm=None,sourceFeel=None,sourceGenre=a,description=None,retrievedOn=today,file=out if ok else None,http=c,sourceFile=j['fileName'],fmaId=j['id']))
    print('fma',a,t,shown,c)
json.dump(recs,open('recs.json','w'),indent=1)
