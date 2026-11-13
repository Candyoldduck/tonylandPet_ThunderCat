"""Cut the drawn eye / mouth variants into small sprite layers.

Input : samples/miko-qipao/variants/{eyes_closed,eyes_smile,eyes_half,mouth_a,mouth_a_half,mouth_i,mouth_o}.png
        (1254x1254, identical to the source outside samples/miko-qipao/variant-masks/*_edit_mask.png)
Output: samples/miko-qipao/built/sprites/<name>[_<eye>].png and samples/miko-qipao/built/sprites/sprites.json

Eyes are split per eye (0 = image-left eye, 1 = image-right eye) so a wink can close one.
Each sprite keeps the drawn pixels inside the edit mask with a few px of feathering at the
edge; outside the mask the variant equals the source, so the feather is invisible.
"""
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
VARIANTS = ROOT / "samples" / "miko-qipao" / "variants"
MASKS = ROOT / "samples" / "miko-qipao" / "variant-masks"
OUT = ROOT / "samples" / "miko-qipao" / "built" / "sprites"
FEATHER = 4  # px

EYE_VARIANTS = ["eyes_closed", "eyes_smile", "eyes_half"]
MOUTH_VARIANTS = ["mouth_a", "mouth_a_half", "mouth_i", "mouth_o"]


def edit_region(name):
    a = np.array(Image.open(MASKS / f"{name}_edit_mask.png"))[..., 3]
    return (a == 0).astype(np.uint8)


def feathered(region):
    dist = cv2.distanceTransform(region, cv2.DIST_L2, 5)
    return np.clip(dist / FEATHER, 0, 1)


def save_sprite(img, weight, name, meta):
    ys, xs = np.where(weight > 0)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    rgba = img[y0:y1, x0:x1].copy()
    rgba[..., 3] = (rgba[..., 3] * weight[y0:y1, x0:x1]).astype(np.uint8)
    Image.fromarray(rgba).save(OUT / f"{name}.png")
    meta[name] = [int(x0), int(y0), int(x1 - x0), int(y1 - y0)]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {}

    eyes = edit_region("eyes")
    n, labels = cv2.connectedComponents(eyes)
    assert n == 3, f"expected two eye regions, got {n - 1}"
    # order the two regions left to right
    comps = sorted(range(1, n), key=lambda k: np.where(labels == k)[1].mean())
    for v in EYE_VARIANTS:
        img = np.array(Image.open(VARIANTS / f"{v}.png").convert("RGBA"))
        for eye, k in enumerate(comps):
            save_sprite(img, feathered((labels == k).astype(np.uint8)), f"{v}_{eye}", meta)

    mouth = feathered(edit_region("mouth"))
    for v in MOUTH_VARIANTS:
        img = np.array(Image.open(VARIANTS / f"{v}.png").convert("RGBA"))
        save_sprite(img, mouth, v, meta)

    build = hashlib.sha1(b"".join((OUT / f"{k}.png").read_bytes() for k in sorted(meta))).hexdigest()[:10]
    (OUT / "sprites.json").write_text(json.dumps({"build": build, "layers": meta}, indent=2))
    print(build, len(meta), "sprites")


if __name__ == "__main__":
    main()
