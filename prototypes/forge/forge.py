"""Запечь бесшовные PBR-карты снаряжения на CPU.

python prototypes/forge/forge.py --out prototypes/forge/maps [--size 1024] [--wear 0.5]

Для каждой поверхности пишет base_color.jpg (sRGB), normal.jpg (OpenGL),
orm.jpg (R — затенение 1, G — шероховатость, B — металл, как в glTF) и
manifest.json с физическим размером тайла, средними значениями и хешами.
Средние нужны просмотру: он задаёт цвет фракции, а карта несёт только вариацию.
"""
import argparse, hashlib, json, sys, time
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fields import SURFACES

TILES = {'steel': 250., 'wood': 200., 'paint': 400., 'leather': 120.}
# Вес фигуры на доске ограничен: размер карты выбран по самой мелкой видимой детали.
# Кожа ремней — 0,47 мм на пиксель, дерево — 0,39 мм, краска эмблемы — 0,78 мм.
MAX_SIZE = {'leather': 256, 'wood': 512, 'paint': 512}


def srgb(linear):
    linear = np.clip(linear, 0, 1)
    return np.round(np.where(linear <= .0031308, 12.92*linear, 1.055*np.power(linear, 1/2.4)-.055)*255).astype(np.uint8)


def normal_map(height, pixel_mm, strength=1.):
    dx = (np.roll(height, -1, 1)-np.roll(height, 1, 1))/(2*pixel_mm)
    dy = (np.roll(height, 1, 0)-np.roll(height, -1, 0))/(2*pixel_mm)
    n = np.stack([-dx*strength, -dy*strength, np.ones_like(dx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return np.round((n*.5+.5)*255).astype(np.uint8)


def seam_ratio(a):
    edge = (np.abs(a[:, 0]-a[:, -1]).mean()+np.abs(a[0]-a[-1]).mean())/2
    inner = (np.abs(np.diff(a, axis=1)).mean()+np.abs(np.diff(a, axis=0)).mean())/2
    return float(edge/max(inner, 1e-9))


def digest(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def bake(name, out, size, wear, seed=None):
    started = time.monotonic(); tile = TILES[name]
    kwargs = {'tile_mm': tile, 'wear': wear}
    if seed is not None: kwargs['seed'] = seed
    h, rgb, rough, metal = SURFACES[name](size, **kwargs)
    folder = out/name; folder.mkdir(parents=True, exist_ok=True)
    Image.fromarray(srgb(rgb)).save(folder/'base_color.jpg', quality=88, subsampling=0)
    Image.fromarray(normal_map(h, tile/size)).save(folder/'normal.jpg', quality=85, subsampling=0)
    orm = np.stack([np.full_like(rough, 255, dtype=np.uint8), np.round(rough*255).astype(np.uint8), np.round(metal*255).astype(np.uint8)], -1)
    Image.fromarray(orm).save(folder/'orm.jpg', quality=85, subsampling=0)
    lum = rgb@np.array([.2126, .7152, .0722], np.float32)
    info = {'surface': name, 'tile_mm': tile, 'size': size, 'wear': wear, 'pixel_mm': tile/size,
            'mean_color': [float(x) for x in rgb.reshape(-1, 3).mean(0)], 'mean_luminance': float(lum.mean()),
            'mean_roughness': float(rough.mean()), 'mean_metallic': float(metal.mean()),
            'height_range_mm': float(h.max()-h.min()),
            'seam_ratio': {'height': seam_ratio(h), 'roughness': seam_ratio(rough)},
            'files': {f: digest(folder/f) for f in ('base_color.jpg', 'normal.jpg', 'orm.jpg')},
            'seconds': round(time.monotonic()-started, 2)}
    assert max(info['seam_ratio'].values()) < 2, (name, info['seam_ratio'])
    return info


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--size', type=int, default=1024)
    p.add_argument('--wear', type=float, default=.5)
    p.add_argument('--only', nargs='*')
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    manifest = {'schema': 'lazy-chess-forge/1', 'generator_sha256': digest(__file__),
                'fields_sha256': digest(Path(__file__).with_name('fields.py')),
                'normal_convention': 'OpenGL, +Y вдоль возрастания v', 'surfaces': {}}
    # --only пересобирает часть карт и дописывает их в существующий манифест.
    old = a.out/'manifest.json'
    if a.only and old.exists(): manifest['surfaces'] = json.loads(old.read_text()).get('surfaces', {})
    for name in a.only or TILES:
        manifest['surfaces'][name] = bake(name, a.out, min(a.size, MAX_SIZE.get(name, a.size)), a.wear)
        print(json.dumps({name: manifest['surfaces'][name]['seconds']}), flush=True)
    (a.out/'manifest.json').write_text(json.dumps(manifest, indent=1, ensure_ascii=False))


if __name__ == '__main__': main()
