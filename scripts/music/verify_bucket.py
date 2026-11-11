"""Checklist step 6e: every free-library track is in <bucket>/studio/tracks/free/ with its manifest MD5.
Prints OK n/n and exits 0, or names each missing or mismatched object and exits 1. Read-only."""
import json, re, subprocess, sys
from pathlib import Path

bucket = sys.argv[1]
manifest = json.loads((Path(__file__).resolve().parents[2] / 'server/studio/music/library.manifest.json').read_text(encoding='utf-8'))
out = subprocess.run(f'gsutil ls -L gs://{bucket}/studio/tracks/free/', shell=True, capture_output=True, text=True).stdout
md5, cur = {}, None
for line in out.splitlines():
    m = re.match(r'^gs://[^ ]+/studio/tracks/free/([a-z0-9-]+)\.m4a:', line)
    if m: cur = m.group(1); continue
    m = re.search(r'Hash \(md5\):\s+(\S+)', line)
    if m and cur: md5[cur] = m.group(1)
bad = [f"{t['id']}: {'missing' if t['id'] not in md5 else 'md5 ' + md5[t['id']] + ' != ' + t['md5Base64']}"
       for t in manifest if md5.get(t['id']) != t['md5Base64']]
for b in bad: print(b)
print(('OK' if not bad else 'FAIL'), f"{len(manifest) - len(bad)}/{len(manifest)}")
sys.exit(1 if bad else 0)
