"""Проверки кузницы без Blender: python3 -m unittest prototypes/forge/test_forge.py (нужны numpy и pillow)."""
import importlib.util, json, sys, tempfile, unittest
from pathlib import Path
import numpy as np
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fields
# Загружаем по пути: при запуске из prototypes/ имя forge занято самой папкой.
_spec = importlib.util.spec_from_file_location('forge_cli', HERE/'forge.py'); forge = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(forge)


class Surfaces(unittest.TestCase):
    def test_every_surface_tiles_without_seam(self):
        for name, make in fields.SURFACES.items():
            h, rgb, rough, metal = make(256, tile_mm=forge.TILES[name], wear=.5)
            self.assertEqual(h.shape, (256, 256), name)
            self.assertLess(forge.seam_ratio(h), 2, name)
            self.assertLess(forge.seam_ratio(rough), 2, name)
            self.assertTrue(np.isfinite(rgb).all() and np.isfinite(h).all(), name)
            self.assertTrue((rough >= .05).all() and (rough <= 1).all(), name)

    def test_metal_is_metal_and_paint_is_not(self):
        steel = fields.steel(256)[3].mean(); wood = fields.wood(256)[3].mean(); paint = fields.paint(256)[3].mean()
        self.assertGreater(steel, .9); self.assertLess(wood, .05); self.assertLess(paint, .1)

    def test_wear_adds_scratches_to_steel(self):
        new = fields.steel(256, wear=.1)[0]; old = fields.steel(256, wear=.9)[0]
        self.assertGreater(np.abs(np.diff(old, axis=1)).mean(), np.abs(np.diff(new, axis=1)).mean())

    def test_shield_face_wears_at_rim(self):
        outline = np.array([[.1, .1], [.9, .1], [.9, .9], [.1, .9]])*600
        h, rgb, rough, metal = fields.shield_face(256, 600, outline, wear=.6)
        u, v = fields.grid(256); d = fields.polygon_distance(u*600, v*600, outline)
        rim = (d > 0) & (d < 25); centre = d > 120
        self.assertGreater(rough[rim].mean(), rough[centre].mean())

    def test_bake_writes_maps_and_means(self):
        with tempfile.TemporaryDirectory() as tmp:
            info = forge.bake('steel', Path(tmp), 128, .5)
            for f in ('base_color.jpg', 'normal.jpg', 'orm.jpg'): self.assertTrue((Path(tmp)/'steel'/f).exists())
            self.assertEqual(len(info['mean_color']), 3)
            json.dumps(info)


if __name__ == '__main__': unittest.main()
