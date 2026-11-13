"""Split the single illustration into animatable layers.

Outputs (samples/miko-qipao/built/):
  base.png      full image with hand/forearm and tassels removed (inpainted)
  hand.png      hand + forearm layer (cropped)
  tassel_l.png  left tassel (cropped)
  tassel_r.png  right tassel (cropped)
  eye{0,1}_ball.png / _lash.png / _low.png
                eye white+iris, upper lash, lower lash of each eye (the base gets
                plain lid skin underneath so the lash can slide down over it)
  hairmask.png  soft mask of hair strands (limits hair sway to actual hair)
  layers.json   crop rectangles of each layer in source-image pixels
"""
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "samples" / "miko-qipao" / "source.png"
OUT = ROOT / "samples" / "miko-qipao" / "built"

# Hand + forearm outline, traced in source pixels (clockwise from the index knuckle).
HAND_POLY = [
    (472, 609), (492, 608), (515, 618), (535, 633), (552, 653), (566, 668),
    (575, 690), (579, 715), (577, 745), (575, 772), (565, 772), (550, 762),
    (546, 790), (547, 830), (543, 870), (536, 920), (521, 975), (506, 1025),
    (491, 1075), (476, 1125), (461, 1175), (448, 1215), (436, 1254),
    (241, 1254), (253, 1215), (273, 1175), (298, 1130), (326, 1094),
    (352, 1082), (380, 1046), (412, 1004), (440, 952), (462, 904), (464, 860),
    (458, 815), (445, 780), (430, 748), (421, 715), (426, 690), (441, 660),
    (458, 630),
]

# Only the part hanging below the knot is cut out; the cord loop stays in the base
# layer because it overlaps hair and could not be inpainted cleanly.
# Behind the fingertips: the chin contour and the empty background under it.
# The contour is visible on both sides of the fingers (measured in the source); a smooth
# curve through those points continues it behind them. Above it the skin is filled from the
# surrounding shading, below it (left of the neck) is empty background.
JAW_VISIBLE = [(470, 585.5), (476, 585.5), (482, 592.5), (488, 598.5),
               # where the index finger rests on the chin (the line both share in the source)
               (502, 610.5), (514, 618.5), (526, 624.5), (538, 628.5), (550, 634.5),
               (560, 638.5), (566, 640.5), (572, 641.5), (578, 644)]
JAW_X = (470, 600)
BG_BEHIND_HAND = [(440, 560), (560, 626), (556, 638), (552, 665), (535, 700), (440, 700)]

TASSELS = {
    "tassel_l": (236, 416, 348, 610),   # x0, y0, x1, y1 search box (y0 = knot top)
    "tassel_r": (856, 279, 952, 474),
}


def polygon_mask(shape, poly):
    m = np.zeros(shape, np.uint8)
    cv2.fillPoly(m, [np.array(poly, np.int32)], 255)
    return m


def red_mask(rgb, box):
    x0, y0, x1, y1 = box
    r, g, b = [rgb[..., i].astype(np.float32) for i in range(3)]
    redness = (r - np.maximum(g, b)) / np.maximum(r, 1)
    m = ((redness > 0.5) & (r > 60)).astype(np.uint8) * 255
    box_m = np.zeros_like(m)
    box_m[y0:y1, x0:x1] = 255
    m &= box_m
    # keep only the biggest connected blob (the tassel), close small holes
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    if n > 1:
        big = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
        m = np.where(lab == big, 255, 0).astype(np.uint8)
    # grab the anti-aliased dark outline around the red
    return cv2.dilate(m, np.ones((3, 3), np.uint8), iterations=1)


def crop_layer(rgba, mask, pad=4, soft=True):
    ys, xs = np.where(mask > 0)
    x0, y0 = max(xs.min() - pad, 0), max(ys.min() - pad, 0)
    x1, y1 = min(xs.max() + pad + 1, rgba.shape[1]), min(ys.max() + pad + 1, rgba.shape[0])
    layer = rgba.copy()
    soft = (cv2.GaussianBlur(mask, (3, 3), 0) if soft else mask).astype(np.float32) / 255
    layer[..., 3] = (layer[..., 3].astype(np.float32) * soft).astype(np.uint8)
    return layer[y0:y1, x0:x1], [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]


def inpaint_rgba(rgba, mask):
    rgb = cv2.inpaint(np.ascontiguousarray(rgba[..., :3]), mask, 9, cv2.INPAINT_TELEA)
    a = cv2.inpaint(np.ascontiguousarray(rgba[..., 3]), mask, 9, cv2.INPAINT_TELEA)
    out = np.dstack([rgb, a])
    return out


# Eyes, traced in source pixels:
#   opening = the visible eye white + iris (lower edge of the upper lash, upper edge of the lower lid)
#   roi     = everything that belongs to the eye: lash flicks, corner wedges, the crease above
EYES = [
    dict(opening=[(446, 488), (450, 472), (458, 464), (468, 457), (480, 452), (495, 450), (510, 450),
                  (522, 452), (532, 457), (538, 464), (541, 475), (541, 488), (535, 495), (520, 501),
                  (505, 506), (488, 508), (470, 507), (457, 503), (449, 497)],
         roi=[(424, 478), (432, 458), (445, 440), (470, 428), (500, 424), (530, 426), (552, 436),
              (556, 452), (552, 470), (548, 495), (540, 505), (520, 512), (495, 516), (465, 514),
              (445, 506), (430, 500)]),
    dict(opening=[(666, 402), (672, 393), (685, 387), (700, 384), (718, 383), (735, 385), (752, 388),
                  (764, 392), (768, 402), (768, 420), (762, 430), (748, 438), (730, 443), (712, 447),
                  (695, 451), (682, 451), (672, 445), (667, 432), (665, 418)],
         roi=[(648, 400), (652, 380), (665, 366), (690, 356), (720, 354), (748, 358), (763, 366),
              (766, 390), (766, 402), (764, 428), (758, 440), (740, 448), (715, 454), (690, 458),
              (672, 456), (658, 442), (650, 420)]),
]
EYE_SAMPLES = 24


def column_span(poly, x):
    """min / max y where the vertical line at x crosses the polygon."""
    ys = []
    n = len(poly)
    for i in range(n):
        (ax, ay), (bx, by) = poly[i], poly[(i + 1) % n]
        if (ax - x) * (bx - x) <= 0 and ax != bx:
            ys.append(ay + (by - ay) * (x - ax) / (bx - ax))
    return min(ys), max(ys)


def eye_curves(e):
    """Top / bottom edge of the opening sampled at EYE_SAMPLES columns (for the renderer)."""
    xs = [p[0] for p in e["opening"]]
    x0, x1 = min(xs), max(xs)
    top, bot = [], []
    for i in range(EYE_SAMPLES):
        x = x0 + (x1 - x0) * min(max(i / (EYE_SAMPLES - 1), 0.002), 0.998)
        t, b = column_span(e["opening"], x)
        top.append(round(t, 2)); bot.append(round(b, 2))
    # the ends are the eye corners: top and bottom meet there
    for k in (0, -1):
        top[k] = bot[k] = round((top[k] + bot[k]) / 2, 2)
    return dict(x0=x0, x1=x1, top=top, bot=bot)


def eye_classes(rgba, e):
    """Sort every pixel of the eye region into ball / lash / low / crease. A pixel counts as skin
    only if it matches the skin colour estimated from outside the region, so faint strokes are
    not left behind on the lid when the lash moves."""
    h, w = rgba.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    c = eye_curves(e)
    xs = np.linspace(c["x0"], c["x1"], EYE_SAMPLES)
    top = np.interp(xx, xs, c["top"])
    inside_x = (xx >= c["x0"]) & (xx <= c["x1"])
    rgb = rgba[..., :3].astype(np.float32)
    lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
    white = (rgb.min(-1) > 190) & (rgb[..., 0] - rgb[..., 2] <= 14)
    region = polygon_mask((h, w), e["roi"]) > 0
    core = polygon_mask((h, w), e["opening"])
    ball = cv2.dilate(core, np.ones((3, 3), np.uint8)) > 0
    # lines may overlap the ball's 1px rim: the rim pixels are half lash, half white, and a
    # pixel that belongs to neither layer shows up as a light seam
    core = core > 0
    est = fill_skin(rgba, region.astype(np.uint8) * 255)[..., :3].astype(np.float32)
    skin = np.abs(rgb - est).max(-1) < 22
    ink = region & ~skin & ~core
    # upper side: above the opening's top edge (+ a little), or above the corner line outside it
    corner_line = np.interp(xx, [c["x0"], c["x1"]], [c["top"][0], c["top"][-1]])
    upper = np.where(inside_x, yy <= top + 3, yy <= corner_line + 2)
    crease = ink & inside_x & (yy < top - 9) & (lum > 120) & ~white
    lash = ink & upper & ~crease & ~white
    low = ink & ~upper & ~white
    stray = ink & white
    m8 = lambda m: m.astype(np.uint8) * 255
    return m8(ball), m8(lash), m8(low), m8(crease), m8(stray & ~ball), m8(core)


# darkest colour of each kind of line, used to split its pixels into colour + alpha
INK = {"lash": (30, 10, 8), "low": (110, 45, 40), "crease": (175, 95, 85)}


def unblend(rgba, skin_rgb, mask, ink):
    """RGBA layer that reproduces rgba where it lies over skin_rgb (soft line edges keep
    their antialiasing instead of carrying a halo of the old background)."""
    orig = rgba[..., :3].astype(np.float32)
    sk = skin_rgb.astype(np.float32)
    ref = np.array(ink, np.float32)
    a = np.clip(((sk - orig) / np.maximum(sk - ref, 1)).max(-1), 0, 1)
    a *= (mask > 0)
    col = np.clip((orig - sk * (1 - a[..., None])) / np.maximum(a[..., None], 1e-3), 0, 255)
    out = np.zeros_like(rgba)
    out[..., :3] = col.astype(np.uint8)
    out[..., 3] = (a * 255).astype(np.uint8)
    return out


def fill_skin(img, hole):
    """Fill the hole with skin that continues the shading around it.
    1. dark hair / lash pixels and eye white next to the hole are not skin: they are
       replaced by a normalised-convolution estimate so they cannot bleed in;
    2. the hole is then solved as a membrane (Laplace equation) with the surrounding skin
       as the boundary, so the fill meets the lid shadow and blush without a visible edge
       (a plain average looked like a flat, lighter patch)."""
    rgb = img[..., :3].astype(np.float32)
    lum = rgb @ np.array([0.3, 0.59, 0.11], np.float32)
    redness = rgb[..., 0] - rgb[..., 2]
    skin = (hole == 0) & (lum > 150) & (redness > 8) & (img[..., 3] > 200)
    est = rgb.copy()
    known = skin.astype(np.float32)
    for sigma in (3, 6, 12, 24, 48):
        num = cv2.GaussianBlur(rgb * known[..., None], (0, 0), sigma)
        den = cv2.GaussianBlur(known, (0, 0), sigma)[..., None]
        fill = (known == 0) & (den[..., 0] > 0.02)
        est[fill] = (num / np.maximum(den, 1e-4))[fill]
        known = np.maximum(known, fill.astype(np.float32) * 0.5)
    solve = (hole > 0) | ((cv2.dilate(hole, np.ones((17, 17), np.uint8)) > 0) & ~skin)
    ys, xs = np.where(solve)
    out = rgb.copy()
    if len(ys):
        y0, y1, x0, x1 = max(ys.min() - 2, 0), ys.max() + 3, max(xs.min() - 2, 0), xs.max() + 3
        cur = np.where(solve[..., None], est, rgb)[y0:y1, x0:x1].copy()
        m = solve[y0:y1, x0:x1]
        fixed = cur.copy()
        for _ in range(600):   # Jacobi iterations from a good start: converges quickly
            avg = cv2.blur(cur, (3, 3))
            cur = np.where(m[..., None], avg, fixed)
        out[y0:y1, x0:x1] = cur
    k = cv2.GaussianBlur((hole > 0).astype(np.float32), (0, 0), 1.0)[..., None]
    res = img.copy()
    res[..., :3] = np.clip(img[..., :3] * (1 - k) + out * k, 0, 255).astype(np.uint8)
    res[..., 3] = np.maximum(img[..., 3], (k[..., 0] * 255).astype(np.uint8))
    return res


def hair_mask(rgba):
    r, g, b, al = [rgba[..., i].astype(np.float32) for i in range(4)]
    lum = 0.3 * r + 0.59 * g + 0.11 * b
    m = ((lum < 150) & (r >= g) & (g >= b * 0.85) & (r - b < 110) & (al > 200)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))  # drop thin contour lines
    # eyes, brows and mouth are dark too but must never sway
    for cx, cy, rx, ry in [(493, 480, 70, 45), (713, 415, 65, 50), (700, 324, 100, 26), (635, 568, 50, 20)]:
        cv2.ellipse(m, (cx, cy), (rx, ry), 0, 0, 360, 0, -1)
    # wide blur: the sway offset must stay well below the width of the falloff or the mesh folds
    return cv2.GaussianBlur(m, (0, 0), 9)


def main():
    rgba = np.array(Image.open(SRC).convert("RGBA"))
    a = rgba[..., 3]
    rgba[..., 3] = np.where(a > 240, 255, a)  # source alpha is 248-254 on opaque areas
    h, w = a.shape
    OUT.mkdir(parents=True, exist_ok=True)
    # build id lets the page bypass stale cached copies of the images
    meta = {"size": [w, h], "build": hashlib.sha1(SRC.read_bytes() + Path(__file__).read_bytes()).hexdigest()[:10], "layers": {}}

    remove = np.zeros((h, w), np.uint8)
    tassel_bg = np.zeros((h, w), np.uint8)

    hand = polygon_mask((h, w), HAND_POLY)
    layer, rect = crop_layer(rgba, hand)
    Image.fromarray(layer).save(OUT / "hand.png")
    meta["layers"]["hand"] = rect
    remove |= cv2.dilate(hand, np.ones((5, 5), np.uint8))
    # the finger outline hugs the jaw line; take a wider margin there (it gets repainted below)
    tips = cv2.dilate(hand, np.ones((11, 11), np.uint8))
    tips[665:] = 0
    remove |= tips

    for name, box in TASSELS.items():
        m = red_mask(rgba[..., :3], box)
        layer, rect = crop_layer(rgba, m)
        Image.fromarray(layer).save(OUT / f"{name}.png")
        meta["layers"][name] = rect
        tassel_bg |= cv2.dilate(m, np.ones((5, 5), np.uint8))

    # eyes: sort the pixels into parts, paint plain lid skin underneath, and split the
    # lines into colour + alpha against that skin
    eye_hole = np.zeros((h, w), np.uint8)
    eye_parts = []
    for i, e in enumerate(EYES):
        ball, lash, low, crease, stray, core = eye_classes(rgba, e)
        # grow the line classes 2px into the surrounding skin (in priority order, no overlaps)
        # so their soft antialiased edges go with them instead of staying behind as a trace
        # lines may reach 1px into the white's rim: that pixel row is the antialiased edge of
        # the lash, and cutting it on the polygon left a staircase along the closed lid
        taken = cv2.erode(core, np.ones((3, 3), np.uint8))
        lines = {}
        for part, m in (("lash", lash), ("low", low), ("crease", crease)):
            grown = cv2.dilate(m, np.ones((5, 5), np.uint8)) & ~taken
            region = polygon_mask((h, w), e["roi"])
            lines[part] = grown & cv2.dilate(region, np.ones((5, 5), np.uint8))
            taken |= lines[part]
        eye_parts.append((i, ball, lines))
        # bits of eye white just outside the traced opening would stay on the closed lid
        rgb = rgba[..., :3].astype(np.int32)
        whiteish = ((rgb.min(-1) > 200) & (rgb[..., 0] - rgb[..., 2] < 20)).astype(np.uint8) * 255
        near = cv2.dilate(core, np.ones((15, 15), np.uint8)) & ~core
        eye_hole |= taken | core | stray | (whiteish & near)
    skin_under = fill_skin(rgba, eye_hole)[..., :3]
    for i, ball, lines in eye_parts:
        # hard edge: a feathered edge let the skin underneath show through as a light seam
        layer, rect = crop_layer(rgba, ball, pad=3, soft=False)
        Image.fromarray(layer).save(OUT / f"eye{i}_ball.png")
        meta["layers"][f"eye{i}_ball"] = rect
        for part, m in lines.items():
            full = unblend(rgba, skin_under, m, INK[part])
            # soften the cut-out edge a touch (the colour split keeps the line itself crisp)
            edge = np.clip(cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), 0.7) * 1.6, 0, 1)
            full[..., 3] = (full[..., 3] * edge).astype(np.uint8)
            ys, xs = np.where(full[..., 3] > 0)
            x0, y0, x1, y1 = xs.min() - 2, ys.min() - 2, xs.max() + 3, ys.max() + 3
            Image.fromarray(full[y0:y1, x0:x1]).save(OUT / f"eye{i}_{part}.png")
            meta["layers"][f"eye{i}_{part}"] = [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]
    meta["eyes"] = [eye_curves(e) for e in EYES]

    # paint what is known to be behind the fingers, then inpaint only the rest
    prefill = rgba.copy()
    yy, xx = np.mgrid[0:h, 0:w]
    jx, jy = np.array(JAW_VISIBLE, float).T
    coef = np.polyfit(jx, jy, 4)
    curve = np.polyval(coef, xx)
    slope = np.polyval(np.polyder(coef), xx)
    dist = (yy - curve) / np.sqrt(1 + slope ** 2)          # signed normal distance, + below
    in_x = (xx >= JAW_X[0]) & (xx <= JAW_X[1])
    hole = remove > 0
    face = hole & in_x & (dist < 0) & (yy > 540)
    bg = hole & (polygon_mask((h, w), BG_BEHIND_HAND) > 0) & (dist >= 0)
    # skin above the jaw: continue the surrounding shading into the gap
    filled = fill_skin(rgba, face.astype(np.uint8) * 255)
    prefill[face] = filled[face]
    prefill[face, 3] = 255
    prefill[bg] = (0, 0, 0, 0)
    # the contour: colour and width taken from the visible part of the line
    def darkest(x, y):
        col = rgba[int(y) - 3:int(y) + 4, int(x), :3].astype(float)
        return col[np.argmin(col @ np.array([0.3, 0.59, 0.11]))]
    line_col = np.median(np.array([darkest(x, y) for x, y in JAW_VISIBLE[:4] + JAW_VISIBLE[-4:]]), axis=0)
    lw = (np.clip(1.7 - np.abs(dist - 0.2), 0, 1) * (hole & in_x))[..., None]
    prefill[..., :3] = (prefill[..., :3] * (1 - lw) + line_col * lw).astype(np.uint8)
    prefill[..., 3] = np.maximum(prefill[..., 3], (lw[..., 0] * 255).astype(np.uint8))
    painted = (face | bg | (lw[..., 0] > 0)).astype(np.uint8) * 255 & remove
    base = inpaint_rgba(prefill, (remove & ~painted) | tassel_bg | eye_hole)
    base = fill_skin(base, eye_hole)
    # the hanging tassels only cover empty background: fade alpha out within a few px
    # of the kept pixels (a hard cut left a stair-stepped edge along the hair)
    kept = ((rgba[..., 3] > 128) & (tassel_bg == 0)).astype(np.uint8)
    dist = cv2.distanceTransform(1 - kept, cv2.DIST_L2, 5)
    fade = np.clip(1 - dist / 2.5, 0, 1)
    base[..., 3] = np.where(tassel_bg > 0, (base[..., 3] * fade).astype(np.uint8), base[..., 3])
    Image.fromarray(base).save(OUT / "base.png")
    Image.fromarray(hair_mask(rgba)).save(OUT / "hairmask.png")
    (OUT / "layers.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
