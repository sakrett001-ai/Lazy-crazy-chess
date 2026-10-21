"""Fetch pinned CC0 MakeHuman asset data; no upstream program logic is copied."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import urllib.request, hashlib, json
ROOT=Path(__file__).resolve().parents[1]
REVISION='a8bc2d54ff0ac92e78ff71431b1023eda42bf482'
PATHS=['LICENSE.md','LICENSE.ASSETS.md','makehuman/data/3dobjs/base.obj','makehuman/data/rigs/default.mhskel','makehuman/data/rigs/default_weights.mhw','makehuman/data/eyes/high-poly/high-poly.obj','makehuman/data/eyes/high-poly/high-poly.mhclo','makehuman/data/eyes/materials/brown_eye.png']
PATHS += ['makehuman/data/targets/macrodetails/'+n+'.target' for n in ('african-male-young','asian-male-young','caucasian-male-young','universal-male-young-maxmuscle-averageweight')]
def fetch(p):
 url=f'https://raw.githubusercontent.com/makehumancommunity/makehuman/{REVISION}/{p}'
 data=urllib.request.urlopen(url,timeout=60).read()
 dest=ROOT/'source'/Path(p).name
 dest.parent.mkdir(exist_ok=True);dest.write_bytes(data)
 return {'file':dest.name,'url':url,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'license':'CC0-1.0' if p!='LICENSE.md' else 'License declaration'}
if __name__=='__main__':
 rows=list(ThreadPoolExecutor(max_workers=4).map(fetch,PATHS))
 (ROOT/'source/manifest.json').write_text(json.dumps({'author':'MakeHuman Community','revision':REVISION,'assets':rows},indent=2)+'\n')
 print('Downloaded',len(rows),'pinned source files')
