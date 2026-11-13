"""Периодические поля поверхностей для снаряжения на CPU.

Каждое поле задано в физических миллиметрах на тайле tile_mm и возвращает
(height_mm, albedo linear RGB, roughness, metallic). Тайл бесшовный: все шумы
и штрихи замкнуты по модулю тайла. Шум и поры взяты из навыка forge-materials
(Lazy-skills-lab); металл, краска по дереву и древесина добавлены здесь.

Поверхность описывает обработку и износ, а не цвет фракции: цвет задаёт
просмотр (белая сталь, обсидиан, бронза), карта несёт вариацию вокруг среднего.
"""
import numpy as np


def lattice(ix, iy, seed):
    x = np.asarray(ix, dtype=np.uint64)
    y = np.asarray(iy, dtype=np.uint64)
    seed_word = np.uint64((int(seed)*1442695041) & 0xffffffff)
    h = (x*np.uint64(374761393)+y*np.uint64(668265263)+seed_word) & np.uint64(0xffffffff)
    h = ((h ^ (h >> np.uint64(13)))*np.uint64(1274126177)) & np.uint64(0xffffffff)
    return ((h ^ (h >> np.uint64(16))) & np.uint64(0xffffff)).astype(np.float32)/np.float32(16777215.0)


def noise(u, v, nx, ny, seed):
    x, y = u*nx, v*ny
    ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = x-ix, y-iy
    sx = fx*fx*fx*(fx*(fx*6-15)+10)
    sy = fy*fy*fy*(fy*(fy*6-15)+10)
    a = lattice(ix % nx, iy % ny, seed)
    b = lattice((ix+1) % nx, iy % ny, seed)
    c = lattice(ix % nx, (iy+1) % ny, seed)
    d = lattice((ix+1) % nx, (iy+1) % ny, seed)
    return ((a+(b-a)*sx)*(1-sy)+(c+(d-c)*sx)*sy).astype(np.float32)


def fbm(u, v, base, octaves, seed, gain=.5):
    total = np.zeros(np.broadcast_shapes(np.shape(u), np.shape(v)), np.float32); amp = 1.; norm = 0.
    for i in range(octaves):
        n = base*2**i
        total += amp*noise(u, v, n, n, seed+i*13); norm += amp; amp *= gain
    return total/norm


def cells(u, v, count, seed, jitter=.8):
    """Расстояние до ближайшего и второго центра в периодической сетке (в долях клетки)."""
    x, y = u*count, v*count
    ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    shape = np.broadcast_shapes(x.shape, y.shape)
    f1 = np.full(shape, 9, np.float32); f2 = np.full(shape, 9, np.float32); idx = np.zeros(shape, np.int64)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            gx, gy = ix+dx, iy+dy
            hx, hy = gx % count, gy % count
            px = gx+.5+jitter*(lattice(hx, hy, seed)-.5)
            py = gy+.5+jitter*(lattice(hx, hy, seed+7)-.5)
            d = np.sqrt((x-px)**2+(y-py)**2).astype(np.float32)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d)); idx = np.where(closer, hx*count+hy, idx); f1 = np.where(closer, d, f1)
    return f1, f2, idx


def pores(u, v, count, seed):
    x, y = u*count, v*count
    ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    best = np.full(np.broadcast_shapes(x.shape, y.shape), 100, dtype=np.float32)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            gx, gy = ix+dx, iy+dy; hx, hy = gx % count, gy % count
            jx = .12+.76*lattice(hx, hy, seed); jy = .12+.76*lattice(hx, hy, seed+17)
            width = .10+.12*lattice(hx, hy, seed+41)
            best = np.minimum(best, ((x-gx-jx)/width)**2+((y-gy-jy)/(width*.65))**2)
    return np.exp(-best*1.5).astype(np.float32)


class Strokes:
    """Прямые царапины на периодическом тайле.

    Царапина — канавка с гауссовым профилем и низким валиком по краям. Длина,
    ширина и глубина в мм. Направления группируются вокруг нескольких «ударов»,
    как у реального доспеха, а не равномерно по кругу.
    """

    def __init__(self, size, tile_mm, seed, count, length=(6, 60), width=(.08, .35), depth=(.004, .03), families=3):
        rng = np.random.default_rng(seed)
        self.size, self.tile = size, tile_mm
        dirs = rng.uniform(0, np.pi, families)
        self.items = []
        for _ in range(count):
            a = dirs[rng.integers(families)]+rng.normal(0, .22)
            ln = np.exp(rng.uniform(np.log(length[0]), np.log(length[1])))
            self.items.append((rng.uniform(0, tile_mm), rng.uniform(0, tile_mm), a, ln,
                               rng.uniform(*width), rng.uniform(*depth), rng.uniform(.3, 1)))

    def render(self):
        n, tile = self.size, self.tile; px = tile/n
        height = np.zeros((n, n), np.float32); fresh = np.zeros((n, n), np.float32)
        for cx, cy, a, ln, w, d, age in self.items:
            dx, dy = np.cos(a), np.sin(a)
            half = ln/2+3*w
            x0, x1 = cx-abs(dx)*half-3*w, cx+abs(dx)*half+3*w
            y0, y1 = cy-abs(dy)*half-3*w, cy+abs(dy)*half+3*w
            cols = np.arange(int(np.floor(x0/px)), int(np.ceil(x1/px))+1)
            rows = np.arange(int(np.floor(y0/px)), int(np.ceil(y1/px))+1)
            X = (cols[None, :]+.5)*px-cx; Y = (rows[:, None]+.5)*px-cy
            along = X*dx+Y*dy; across = -X*dy+Y*dx
            # Канавка мелеет к концам: царапина начинается и уходит на нет.
            t = np.clip(along/(ln/2), -1, 1); taper = np.where(np.abs(along) <= ln/2, (1-t*t)**.5, 0)
            r = across/max(w, px*.7)
            groove = (-d*np.exp(-r*r)+.25*d*np.exp(-((np.abs(r)-1.6)/.6)**2))*taper
            mark = np.exp(-r*r)*taper*age
            rr, cc = np.ix_(rows % n, cols % n)
            np.add.at(height, (rr, cc), groove.astype(np.float32))
            np.maximum.at(fresh, (rr, cc), mark.astype(np.float32))
        return height, fresh


def grid(size):
    u = (np.arange(size, dtype=np.float32)[None, :]+.5)/size
    v = 1-(np.arange(size, dtype=np.float32)[:, None]+.5)/size
    return np.broadcast_to(u, (size, size)), np.broadcast_to(v, (size, size))


def steel(size, tile_mm=250., seed=7, wear=.5):
    """Кованая сталь: плоскости молотка, следы шлифовки, царапины, точечная коррозия."""
    u, v = grid(size)
    # Кованая поверхность: неглубокие лунки от молотка около 14 мм.
    f1, f2, idx = cells(u, v, max(4, round(tile_mm/14)), seed)
    # Глубина лунки 0,1–0,3 мм: след видим в скользящем свете, силуэт не меняет.
    depth = .10+.20*lattice(idx // 7919, idx % 7919, seed+2)
    dimple = -depth*(1-np.clip(f1/.7, 0, 1))**2
    facet = .03*np.clip((f2-f1)/.25, 0, 1)
    # Шлифовка: тонкие вытянутые полосы вдоль u, неровные по длине.
    streak = noise(u, v*0+v, max(4, round(tile_mm/40)), max(16, round(tile_mm/.35)), seed+3)
    streak2 = noise(u, v, max(4, round(tile_mm/18)), max(16, round(tile_mm/.9)), seed+5)
    polish = .6*streak+.4*streak2
    # Крупные пятна — по искажённым координатам: без следов сетки шума, которые
    # на стыках проекций читались прямоугольниками.
    wu = u+.12*(fbm(u, v, 2, 2, seed+51)-.5); wv = v+.12*(fbm(u, v, 2, 2, seed+53)-.5)
    large = fbm(wu, wv, 3, 3, seed+11)
    grime = np.clip((fbm(wu, wv, 4, 4, seed+17)-.42)*1.5, 0, 1)**1.5
    stroke = Strokes(size, tile_mm, seed+23, int(40+420*wear), length=(4, 70), width=(.07, .32), depth=(.003, .025))
    s_height, fresh = stroke.render()
    deep = Strokes(size, tile_mm, seed+29, int(3+22*wear), length=(15, 90), width=(.25, .7), depth=(.03, .09), families=2)
    d_height, d_fresh = deep.render()
    pits = pores(u, v, max(8, round(tile_mm/2.2)), seed+31)
    rust_mask = np.clip((fbm(u, v, 5, 3, seed+37)-(.70-.18*wear))*6, 0, 1)
    pit = pits*rust_mask
    height = dimple+facet+.004*(polish-.5)+s_height+d_height-.03*pit
    shine = np.maximum(fresh, d_fresh)
    lum = .80+.06*(large-.5)+.05*(polish-.5)-.24*grime*(.4+.6*wear)-.10*(1-np.clip(f1/.7, 0, 1))**2*depth/.3+.18*shine-.30*pit
    # Цвет побежалости и окалины: едва заметный тёплый/холодный сдвиг по крупным пятнам.
    temper = fbm(u, v, 2, 3, seed+41)-.5
    tint = np.stack([1+.05*temper, np.ones_like(temper), 1-.06*temper], -1)
    rust = np.array([.55, .30, .16], np.float32)
    rgb = lum[..., None]*tint
    rgb = rgb*(1-.55*pit[..., None])+rust*(.55*pit[..., None])*lum[..., None]
    rough = .42+.07*(large-.5)+.08*(polish-.5)+.18*grime*(.3+.7*wear)-.15*shine+.30*pit
    metal = 1-.7*pit
    return height.astype(np.float32), np.clip(rgb, 0, 1.2), np.clip(rough, .08, .95), np.clip(metal, 0, 1)


def wood_field(u, v, tile_mm, seed, plank_mm=None):
    """Ясень: годовые кольца вдоль v, поры, лучи. Возвращает (рельеф, тон, поры)."""
    warp = fbm(u, v, 2, 3, seed)
    # Ширина годовых слоёв неровная: фаза растёт неравномерно поперёк волокна.
    spacing = fbm(u, v*0, 6, 3, seed+3)
    rings = (u*tile_mm/3.0+5*spacing+1.4*warp+.5*noise(u, v, 3, 1, seed+2)) % 1
    late = np.exp(-((rings-.82)/.07)**2)
    vessels = pores(u, v*.25, max(16, round(tile_mm/1.1)), seed+5)*late
    fiber = noise(u, v, max(8, round(tile_mm/.5)), max(4, round(tile_mm/9)), seed+7)
    tone = .80-.30*late+.08*(fiber-.5)+.10*(warp-.5)
    height = .02*(fiber-.5)-.03*vessels+.01*late
    if plank_mm:
        count = max(1, round(tile_mm/plank_mm)); x = u*count; f = x-np.floor(x)
        seam = np.exp(-(np.minimum(f, 1-f)*tile_mm/count/.6)**2)
        board = lattice(np.floor(x).astype(np.int64) % count, 0, seed+9)
        tone = tone*(.9+.2*board)-.25*seam; height = height-.25*seam
    return height, tone, vessels


def wood(size, tile_mm=200., seed=11, wear=.5):
    """Древко из ясеня, промасленное, затёртое руками."""
    u, v = grid(size)
    h, tone, vessels = wood_field(u, v, tile_mm, seed)
    grime = np.clip((fbm(u, v, 3, 3, seed+21)-.4)*2, 0, 1)
    stroke = Strokes(size, tile_mm, seed+25, int(10+120*wear), length=(3, 30), width=(.1, .4), depth=(.01, .05))
    s_h, fresh = stroke.render()
    base = np.array([.46, .29, .15], np.float32)
    lum = tone*(1-.25*grime*wear)+.12*fresh
    rgb = lum[..., None]*base
    rough = .55+.12*vessels-.10*grime*wear+.05*fresh
    return (h+s_h).astype(np.float32), np.clip(rgb, 0, 1), np.clip(rough, .2, .95), np.zeros_like(rough)


def paint_layer(u, v, x_mm, y_mm, size, tile_mm, seed, wear, chip_bias=0., scratches=None):
    """Краска по доскам. u,v — тайловые координаты, x_mm,y_mm — те же точки в мм."""
    w_h, w_tone, _ = wood_field(u, v, tile_mm, seed, plank_mm=130)
    brush = noise(u, v, max(4, round(tile_mm/60)), max(16, round(tile_mm/1.6)), seed+3)
    brush2 = noise(u, v, max(4, round(tile_mm/25)), max(16, round(tile_mm/.8)), seed+4)
    large = fbm(u, v, max(3, round(tile_mm/130)), 4, seed+5)
    wb = max(8, round(tile_mm/50))
    wu = u+.02*(fbm(u, v, wb, 3, seed+9)-.5); wv = v+.02*(fbm(u, v, wb, 3, seed+10)-.5)
    cb = max(4, round(tile_mm/100))
    chip_field = .7*fbm(wu, wv, cb, 6, seed+7, gain=.55)+.3*fbm(wu, wv, cb*10, 3, seed+8)+chip_bias
    threshold = .70-.06*wear
    chips = np.clip((chip_field-threshold)*40, 0, 1)
    primer = np.clip((chip_field-threshold+.02)*40, 0, 1)
    if scratches is None:
        scratches = Strokes(size, tile_mm, seed+11, int(20+260*wear), length=(5, 80), width=(.12, .45), depth=(.03, .09)).render()
    s_h, fresh = scratches
    scratch = np.clip(fresh*1.4, 0, 1)
    grime = np.clip((fbm(u, v, max(4, round(tile_mm/100)), 4, seed+17)-.42)*2.2, 0, 1)
    height = w_h+.18*(1-primer)+.02*(brush-.5)+.01*(brush2-.5)+s_h*(1-chips)
    paint_c = (.93+.04*(large-.5)+.03*(brush-.5)-.10*grime*wear)
    ground = np.array([.80, .76, .66], np.float32); wood_c = np.array([.42, .27, .14], np.float32)
    rgb = paint_c[..., None]*np.ones(3, np.float32)
    exposed = np.maximum(primer, scratch*.85)
    rgb = rgb*(1-exposed[..., None])+ground*(exposed[..., None])
    rgb = rgb*(1-chips[..., None])+(wood_c*w_tone[..., None])*chips[..., None]
    rough = .42+.06*(brush-.5)+.10*grime*wear+.25*primer+.08*chips
    return height, rgb, rough, chips


def paint(size, tile_mm=400., seed=13, wear=.5):
    """Тайловая краска по доскам (для мелких крашеных деталей)."""
    u, v = grid(size)
    height, rgb, rough, _ = paint_layer(u, v, u*tile_mm, v*tile_mm, size, tile_mm, seed, wear)
    return height.astype(np.float32), np.clip(rgb, 0, 1), np.clip(rough, .2, .95), np.zeros_like(rough)


def polygon_distance(x, y, outline):
    """Знаковое расстояние до замкнутого контура (мм): >0 внутри."""
    px = np.asarray(outline, np.float64); inside = np.zeros(x.shape, bool); best = np.full(x.shape, 1e9)
    for i in range(len(px)):
        ax, ay = px[i]; bx, by = px[(i+1) % len(px)]
        dx, dy = bx-ax, by-ay; ll = max(dx*dx+dy*dy, 1e-12)
        t = np.clip(((x-ax)*dx+(y-ay)*dy)/ll, 0, 1)
        best = np.minimum(best, np.hypot(x-ax-t*dx, y-ay-t*dy))
        cross = ((ay > y) != (by > y)) & (x < (bx-ax)*(y-ay)/np.where(by == ay, 1e-12, by-ay)+ax)
        inside ^= cross
    return np.where(inside, best, -best).astype(np.float32)


def shield_face(size, span_mm, outline, tile_mm=400., seed=13, wear=.5, impacts=7):
    """Лицо конкретного щита: тайловая краска + износ по форме.

    Сколы гуще у кромки (щит принимает удары краем и трётся о землю), в верхней
    и центральной части — следы уколов: вмятина, сорванная краска, трещины в дереве.
    UV щита нормирован: [0,1] покрывает квадрат со стороной span_mm.
    """
    rng = np.random.default_rng(seed+101)
    u0, v0 = grid(size); x = u0*span_mm; y = v0*span_mm
    tile_mm = span_mm
    u, v = u0, v0
    d = polygon_distance(x, y, outline)
    edge = np.exp(-np.clip(d, 0, None)/(18+30*wear))
    lo = np.min(outline, 0); hi = np.max(outline, 0)
    crater_h = np.zeros_like(x); crater_mask = np.zeros_like(x); crack = np.zeros_like(x)
    for _ in range(impacts):
        for _ in range(50):
            cx, cy = rng.uniform(lo[0], hi[0]), lo[1]+(hi[1]-lo[1])*rng.beta(2.6, 1.6)
            if polygon_distance(np.array([[cx]]), np.array([[cy]]), outline)[0, 0] > 60: break
        r = rng.uniform(4, 9); spread = rng.uniform(10, 24)
        # Укол приходит под углом: след вытянут по направлению удара.
        hit = rng.uniform(0, np.pi); stretch = rng.uniform(1.4, 2.6)
        dx0, dy0 = x-cx, y-cy
        dx = (dx0*np.cos(hit)+dy0*np.sin(hit))/stretch; dy = -dx0*np.sin(hit)+dy0*np.cos(hit)
        rr = np.hypot(dx, dy); ang = np.arctan2(dy, dx)
        crater_h += -1.2*np.exp(-(rr/r)**2)
        rag = spread*(.75+.5*noise((ang/(2*np.pi)) % 1, np.zeros_like(ang), 9, 1, int(seed+cx)))
        crater_mask = np.maximum(crater_mask, np.clip((rag-rr)/2.5, 0, 1))
        for k in range(rng.integers(3, 6)):
            a = rng.uniform(0, 2*np.pi); ln = rng.uniform(15, 45)
            along = dx*np.cos(a)+dy*np.sin(a); across = -dx*np.sin(a)+dy*np.cos(a)
            wob = across+1.5*np.sin(along/4+k)
            crack = np.maximum(crack, np.exp(-(wob/.5)**2)*(along > 0)*(along < ln)*(1-along/ln))
    scr = Strokes(size, span_mm, seed+11, int(40+500*wear), length=(8, 160), width=(.15, .6), depth=(.03, .12), families=4).render()
    bias = .30*edge+.35*crater_mask
    height, rgb, rough, chips = paint_layer(u, v, x, y, size, tile_mm, seed, wear, chip_bias=bias, scratches=scr)
    height = height+crater_h-.25*crack
    dark = np.clip(crack*.9-.4*crater_h, 0, 1)
    rgb = rgb*(1-.6*dark[..., None])
    # Грязь у нижней кромки: щит ставят на землю.
    soil = np.clip(edge*1.2*(1-v0*1.6), 0, 1)*wear
    rgb = rgb*(1-.35*soil[..., None])+np.array([.24, .19, .13], np.float32)*.35*soil[..., None]
    rough = rough+.15*soil
    return height.astype(np.float32), np.clip(rgb, 0, 1), np.clip(rough, .2, .95), np.zeros_like(rough)


def leather(size, tile_mm=120., seed=17, wear=.5):
    u, v = grid(size)
    large = noise(u, v, 5, 5, seed); medium = noise(u, v, 19, 19, seed+2)
    wu = u+.006*(noise(u, v, 11, 11, seed+3)-.5); wv = v+.006*(noise(u, v, 11, 11, seed+4)-.5)
    n = max(8, round(tile_mm/.6))
    grain = noise(wu, wv, n, n, seed+5); fine = noise(wu, wv, n*3, n*3, seed+6)
    pits = pores(wu, wv, max(8, round(tile_mm/.45)), seed+11)
    wr = noise(wu, wv, 37, 37, seed+8); wrinkles = np.exp(-((wr-.5)/.037)**2)*(.4+.6*medium)
    scuff = np.clip((fbm(u, v, 6, 3, seed+21)-.6)*4, 0, 1)*wear
    height = .085*(grain-.5)+.025*(fine-.5)-.040*pits-.018*wrinkles-.02*scuff
    lum = .84+.20*large+.10*medium+.06*(grain-.5)-.045*pits+.25*scuff
    rgb = lum[..., None]*np.array([.36, .22, .13], np.float32)
    rough = .52+.12*(grain-.5)+.07*(large-.5)+.035*pits+.18*scuff
    return height.astype(np.float32), np.clip(rgb, 0, 1), np.clip(rough, .3, .9), np.zeros_like(rough)


SURFACES = {'steel': steel, 'wood': wood, 'paint': paint, 'leather': leather}
