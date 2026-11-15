"""Smaller GLB without visible change: the body-build targets of the plates
carry no normal deltas.

'lean' and 'strong' move a rigid plate by a smooth, gentle field (a few per
cent across a breastplate), so its normals turn by a fraction of a degree;
Blender still writes a full normal delta per vertex, as much data as the
positions. Those accessors become zero accessors (glTF: an accessor without a
bufferView is all zeros), which loaders read as "normal unchanged", and the
binary is repacked without the bytes nobody references. The veteran target
keeps its normals: dents are seen by their shading.
"""
import struct

SLIM_TARGETS = ('lean', 'strong')


def _zero_accessor(src):
    a = {k: src[k] for k in ('componentType', 'count', 'type')}
    if 'normalized' in src: a['normalized'] = src['normalized']
    return a


def slim(doc, binary, prefix='ARMOR_'):
    """Zero the normal deltas of SLIM_TARGETS on meshes named with prefix; returns (doc, binary, saved bytes)."""
    acc = doc['accessors']
    for mesh in doc['meshes']:
        if not mesh['name'].startswith(prefix): continue
        names = mesh.get('extras', {}).get('targetNames', [])
        for prim in mesh['primitives']:
            for name, target in zip(names, prim.get('targets', [])):
                if name in SLIM_TARGETS and 'NORMAL' in target:
                    acc.append(_zero_accessor(acc[target['NORMAL']])); target['NORMAL'] = len(acc) - 1
    # drop accessors nobody references, then buffer views nobody references, and repack
    used = set()
    def mark(i):
        if i is not None: used.add(i)
    for mesh in doc['meshes']:
        for prim in mesh['primitives']:
            for i in prim['attributes'].values(): mark(i)
            mark(prim.get('indices'))
            for t in prim.get('targets', []):
                for i in t.values(): mark(i)
    for skin in doc.get('skins', []): mark(skin.get('inverseBindMatrices'))
    for anim in doc.get('animations', []):
        for s in anim['samplers']: mark(s['input']); mark(s['output'])
    remap_a = {}
    kept = []
    for i, a in enumerate(acc):
        if i in used: remap_a[i] = len(kept); kept.append(a)
    doc['accessors'] = kept
    for mesh in doc['meshes']:
        for prim in mesh['primitives']:
            prim['attributes'] = {k: remap_a[i] for k, i in prim['attributes'].items()}
            if 'indices' in prim: prim['indices'] = remap_a[prim['indices']]
            if 'targets' in prim: prim['targets'] = [{k: remap_a[i] for k, i in t.items()} for t in prim['targets']]
    for skin in doc.get('skins', []):
        if 'inverseBindMatrices' in skin: skin['inverseBindMatrices'] = remap_a[skin['inverseBindMatrices']]
    for anim in doc.get('animations', []):
        for s in anim['samplers']: s['input'] = remap_a[s['input']]; s['output'] = remap_a[s['output']]
    views = set()
    for a in kept:
        if 'bufferView' in a: views.add(a['bufferView'])
        for k in ('indices', 'values'):
            if k in a.get('sparse', {}): views.add(a['sparse'][k]['bufferView'])
    for im in doc.get('images', []):
        if 'bufferView' in im: views.add(im['bufferView'])
    out, remap_v, new_views = bytearray(), {}, []
    for i, v in enumerate(doc['bufferViews']):
        if i not in views: continue
        out += b'\0' * ((-len(out)) % 4)
        start = v.get('byteOffset', 0)
        nv = dict(v); nv['byteOffset'] = len(out)
        out += binary[start:start + v['byteLength']]
        remap_v[i] = len(new_views); new_views.append(nv)
    out += b'\0' * ((-len(out)) % 4)
    doc['bufferViews'] = new_views
    for a in kept:
        if 'bufferView' in a: a['bufferView'] = remap_v[a['bufferView']]
        for k in ('indices', 'values'):
            if k in a.get('sparse', {}): a['sparse'][k]['bufferView'] = remap_v[a['sparse'][k]['bufferView']]
    for im in doc.get('images', []):
        if 'bufferView' in im: im['bufferView'] = remap_v[im['bufferView']]
    doc['buffers'][0]['byteLength'] = len(out)
    return doc, bytes(out), len(binary) - len(out)
