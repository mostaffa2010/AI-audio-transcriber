"""Generates the PWA icons (run: python3 tools/make_icons.py)."""
from PIL import Image, ImageDraw
import os
OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BARS = [0.30, 0.55, 0.85, 0.50, 0.70, 0.38]   # relative bar heights

def make(size, maskable=False, ss=4):
    S = size * ss
    img = Image.new('RGB', (S, S))
    px = img.load()
    c1, c2 = (20, 184, 166), (15, 94, 89)       # teal gradient
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    d = ImageDraw.Draw(img)
    scale = 0.60 if maskable else 0.74            # maskable: keep inside the 80% safe zone
    box = S * scale
    left = (S - box) / 2
    n = len(BARS)
    step = box / n
    bw = step * 0.52
    for i, h in enumerate(BARS):
        cx = left + step * (i + 0.5)
        bh = box * 0.62 * h
        cy = S / 2
        color = (245, 158, 11) if i == 2 else (255, 255, 255)
        d.rounded_rectangle([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], radius=bw / 2, fill=color)
    img = img.resize((size, size), Image.LANCZOS)
    return img

def rounded(img, r_frac=0.22):
    size = img.size[0]
    m = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=int(size * 4 * r_frac), fill=255)
    m = m.resize((size, size), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), m)
    return out

os.makedirs(OUT, exist_ok=True)
rounded(make(192)).save(os.path.join(OUT, 'icon-192.png'))
rounded(make(512)).save(os.path.join(OUT, 'icon-512.png'))
make(512, maskable=True).save(os.path.join(OUT, 'icon-maskable-512.png'))
make(180).save(os.path.join(OUT, 'apple-touch-icon.png'))       # iOS rounds it itself
rounded(make(64)).resize((32, 32), Image.LANCZOS).save(os.path.join(OUT, 'favicon-32.png'))
print('ok')
