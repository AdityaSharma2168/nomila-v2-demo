"""Step 3b: after `gsutil cp out/*.m4a gs://<bucket>/studio/tracks/free/`, read back each object's MD5 -> upload.json."""
import json, re, subprocess, sys
bucket = sys.argv[1]
out = subprocess.run(['gsutil', 'ls', '-L', f'gs://{bucket}/studio/tracks/free/'], capture_output=True, text=True, shell=True).stdout
md5, cur = {}, None
for line in out.splitlines():
    m = re.match(r'^gs://[^ ]+/studio/tracks/free/([a-z0-9-]+)\.m4a:', line)
    if m: cur = m.group(1); continue
    m = re.search(r'Hash \(md5\):\s+(\S+)', line)
    if m and cur: md5[cur] = m.group(1)
json.dump(md5, open('upload.json', 'w'), indent=1)
print(len(md5), 'objects')
