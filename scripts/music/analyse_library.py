import json,re,subprocess,hashlib,os,sys,base64
import numpy as np, librosa
from concurrent.futures import ProcessPoolExecutor
TARGET_I=-14.0; TARGET_TP=-1.0
def run(a): return subprocess.run(a,capture_output=True,text=True)
def sha(p): return hashlib.sha256(open(p,'rb').read()).hexdigest()
def measure(path):
  r=run(['ffmpeg','-hide_banner','-nostats','-i',path,'-af','loudnorm=I=-14:TP=-1:LRA=11:print_format=json','-f','null','-'])
  j=json.loads(r.stderr[r.stderr.rindex('{'):r.stderr.rindex('}')+1])
  return j
def slug(s): return re.sub(r'[^a-z0-9]+','-',s.lower()).strip('-')
def process(rec):
  src=rec['file']; rid=rec['id']
  outp=f'out/{rid}.m4a'
  m1=measure(src)
  af=(f"loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA=11:measured_I={m1['input_i']}:measured_TP={m1['input_tp']}:"
      f"measured_LRA={m1['input_lra']}:measured_thresh={m1['input_thresh']}:offset={m1['target_offset']}:linear=true")
  enc=['-vn','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart','-map_metadata','-1']
  run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',src,'-af',af,*enc,outp])
  m2=measure(outp); method='loudnorm-2pass-linear'
  if abs(float(m2['input_i'])-TARGET_I)>0.5 or float(m2['input_tp'])>TARGET_TP:
    # plain loudnorm missed (a peak blocks the linear gain): gain to target, then a true-peak limiter run at 4x
    # oversampling, re-measured after the AAC encode and tightened until both the level and the ceiling hold.
    g=TARGET_I-float(m1['input_i']); lim=0.79
    for i in range(6):
      af2=f'aresample=192000,volume={g:.2f}dB,alimiter=limit={lim:.3f}:level=false:attack=1:release=50,aresample=48000'
      run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',src,'-af',af2,*enc,outp])
      m2=measure(outp); method=f'gain+limiter(4x oversampled, limit {20*np.log10(lim):.1f} dBFS)'
      I=float(m2['input_i']); tp=float(m2['input_tp'])
      if abs(I-TARGET_I)<=0.5 and tp<=TARGET_TP: break
      if tp>TARGET_TP: lim*=0.9
      if I<TARGET_I-0.3 or I>TARGET_I+0.3: g+=TARGET_I-I
  # features, on the normalised file
  w=f'wav/{rid}.wav'
  run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',outp,'-ac','1','-ar','22050',w])
  y,sr=librosa.load(w,sr=22050,mono=True)
  dur=len(y)/sr
  tempo,_=librosa.beat.beat_track(y=y,sr=sr)
  tempo=float(np.atleast_1d(tempo)[0])
  oenv=librosa.onset.onset_strength(y=y,sr=sr)
  onsets=librosa.onset.onset_detect(onset_envelope=oenv,sr=sr)
  rms=librosa.feature.rms(y=y)[0]
  db=20*np.log10(rms+1e-9); med=float(np.median(db))
  hop=512/sr; n1=int(1.0/hop)
  head=float(np.mean(db[:n1])); tail=float(np.mean(db[-n1:]))
  H,P=librosa.effects.hpss(y)
  perc=float(np.sum(P**2)/(np.sum(y**2)+1e-12))
  cent=float(np.mean(librosa.feature.spectral_centroid(y=y,sr=sr)))
  os.remove(w)
  probe=run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',outp]).stdout.strip()
  return dict(id=rid,method=method,inputI=float(m1['input_i']),inputTP=float(m1['input_tp']),outI=float(m2['input_i']),outTP=float(m2['input_tp']),
    durationSec=round(float(probe),2),measuredBpm=round(tempo,2),onsetRate=round(len(onsets)/dur,3),onsetMean=round(float(np.mean(oenv)),3),
    percRatio=round(perc,3),centroid=round(cent,1),headDb=round(head-med,1),tailDb=round(tail-med,1),dynStd=round(float(np.std(db[db>med-30])),2),
    sha256=sha(outp),bytes=os.path.getsize(outp),sourceSha256=sha(rec['file']))
if __name__=='__main__':
  recs=json.load(open('recs.json'))
  recs=[r for r in recs if r['licence']]
  used=set('walking-around status with-your-hands save placeholder walking-away doodles tokyo-sunset hope-on-repeat we-drove-all-night only-human'.split())
  for r in recs:
    s=slug(r['title'])
    if s in used: s=s+('-macleod' if r['source']=='incompetech' else '-holizna')
    assert s not in used; used.add(s); r['id']=s
  done={}
  if os.path.exists('analysis.json'): done={a['id']:a for a in json.load(open('analysis.json'))}
  todo=[r for r in recs if r['id'] not in done]
  with ProcessPoolExecutor(4) as ex:
    for a in ex.map(process,todo):
      done[a['id']]=a; print(a['id'],a['method'],a['outI'],a['outTP'],a['measuredBpm'],flush=True)
      json.dump(list(done.values()),open('analysis.json','w'),indent=1)
  json.dump(recs,open('recs_ids.json','w'),indent=1)
