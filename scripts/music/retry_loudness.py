import json,sys
"""Step 2a: a dynamic-loudnorm retry for files the linear pass and the limiter could not bring to -14 LUFS / -1 dBTP.
What still misses is dropped from analysis.json (left out of the library; LIBRARY-LICENSES.md lists them)."""
from analyse_library import *
recs={r['id']:r for r in json.load(open('recs_ids.json'))}
A=json.load(open('analysis.json'))
for x in A:
  if abs(x['outI']+14)<=0.5 and x['outTP']<=-1: continue
  rid=x['id']; src=recs[rid]['file']; outp=f'out/{rid}.m4a'
  enc=['-vn','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart','-map_metadata','-1']
  # dynamic loudnorm: it limits true peak itself, at the cost of some dynamics
  for tp in (-2.0,-3.0,-4.0):
    run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',src,'-af',f'loudnorm=I=-14:TP={tp}:LRA=11',*enc,outp])
    m=measure(outp); I=float(m['input_i']); T=float(m['input_tp'])
    print(rid,tp,I,T,flush=True)
    if abs(I+14)<=0.5 and T<=-1: break
  x['outI']=I; x['outTP']=T; x['method']=f'loudnorm-dynamic (TP target {tp} dBTP)'; x['sha256']=sha(outp); x['bytes']=os.path.getsize(outp)
  x['durationSec']=round(float(run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',outp]).stdout.strip()),2)
ok=[x for x in A if abs(x['outI']+14)<=0.5 and x['outTP']<=-1]
print('left out:',[x['id'] for x in A if x not in ok])
json.dump(ok,open('analysis.json','w'),indent=1)
