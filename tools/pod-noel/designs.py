"""Noel sweatshirt koleksiyonu - baskı dosyaları (şeffaf PNG, 4500x5400, 300 dpi).
Her tasarım iki mürekkeple: 'dark' (açık renk giysi: sand / white / light pink) ve 'light' (koyu giysi: black / forest green).
Yazı tipleri OFL / Apache (Google Fonts): %LOCALAPPDATA%/seltigo-pod/fonts. Çıktı: %LOCALAPPDATA%/seltigo-pod/designs (satılık; depoya girmez).
Kullanım: python designs.py [kod,kod,...]   Kişiselleştirilmiş katman: names_layer() (personal.py kullanır)."""
import math, os, random, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
ROOT = Path(os.environ["LOCALAPPDATA"]) / "seltigo-pod"; FD = ROOT / "fonts"; OUT = ROOT / "designs"; OUT.mkdir(parents=True, exist_ok=True)
W, H, DPI, SS = 4500, 5400, 300, 2
def F(name, size): return ImageFont.truetype(str(FD / name), int(size))
SHRIK, XMAS, ARCH, CHERRY, LOB, PAC = "Shrikhand-Regular.ttf", "MountainsofChristmas-Bold.ttf", "ArchivoBlack-Regular.ttf", "CherryBombOne-Regular.ttf", "LobsterTwo-Bold.ttf", "Pacifico-Regular.ttf"

# Renk paletleri: 'dark' mürekkep açık giysi için, 'light' koyu giysi için
PAL = {
 "dark":  {"name": "dark", "ink": "#3A2219", "red": "#B3262E", "green": "#1F5A43", "gold": "#C98A1B", "cream": "#F6EAD6", "pink": "#D9607E", "pink2": "#F2B8C6",
           "teal": "#2F6F6A", "rust": "#C4532D", "mustard": "#E0A526", "white": "#FFFFFF", "outline": "#3A2219"},
 "light": {"name": "light", "ink": "#F6EAD6", "red": "#E5484D", "green": "#7FC29B", "gold": "#F2C14E", "cream": "#F6EAD6", "pink": "#F28DA8", "pink2": "#F9CDD8",
           "teal": "#6FB7AE", "rust": "#E57A4E", "mustard": "#F2C14E", "white": "#FFFFFF", "outline": "#2A1A14"},
}

def canvas(w=W, h=H): return Image.new("RGBA", (w, h), (0, 0, 0, 0))
def hexc(c, a=255):
    c = c.lstrip("#"); return tuple(int(c[i:i+2], 16) for i in (0, 2, 4)) + (a,)

class Layer:
    """Kenarları yumuşak şekiller: SS kat büyük çizilip küçültülür."""
    def __init__(self, w, h): self.w, self.h = int(w), int(h); self.im = Image.new("RGBA", (self.w*SS, self.h*SS), (0, 0, 0, 0)); self.d = ImageDraw.Draw(self.im)
    def s(self, v): return [x*SS for x in v]
    def ellipse(self, box, fill, outline=None, width=0): self.d.ellipse(self.s(box), fill=hexc(fill) if fill else None, outline=hexc(outline) if outline else None, width=int(width*SS))
    def rect(self, box, fill, r=0, outline=None, width=0): self.d.rounded_rectangle(self.s(box), radius=r*SS, fill=hexc(fill) if fill else None, outline=hexc(outline) if outline else None, width=int(width*SS))
    def poly(self, pts, fill, outline=None, width=0):
        p = [(x*SS, y*SS) for x, y in pts]
        if fill: self.d.polygon(p, fill=hexc(fill))
        if outline: self.d.line(p + [p[0], p[1]], fill=hexc(outline), width=int(width*SS), joint="curve")
    def line(self, pts, fill, width): self.d.line([(x*SS, y*SS) for x, y in pts], fill=hexc(fill), width=int(width*SS), joint="curve")
    def arc(self, box, a0, a1, fill, width): self.d.arc(self.s(box), a0, a1, fill=hexc(fill), width=int(width*SS))
    def chord(self, box, a0, a1, fill, outline, width): self.d.chord(self.s(box), a0, a1, fill=hexc(fill), outline=hexc(outline), width=int(width*SS))
    def done(self): return self.im.resize((self.w, self.h), Image.LANCZOS)

def paste(base, im, x, y): base.alpha_composite(im, (int(x), int(y)))

def text_img(txt, font, fill, stroke=0, stroke_fill=None, shadow=None, tracking=0):
    """Tek satır yazı; isteğe bağlı kontur ve retro kaydırmalı gölge (dx, dy, renk). tracking: harf aralığı (px)."""
    pad = stroke + (max(abs(shadow[0]), abs(shadow[1])) if shadow else 0) + 60
    chars = list(txt); widths = [font.getlength(c) for c in chars]
    tw = int(sum(widths) + tracking * (len(chars) - 1)); asc, desc = font.getmetrics()
    im = Image.new("RGBA", (tw + 2*pad, asc + desc + 2*pad), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    def draw(dx, dy, col, st, stc):
        x = pad + dx
        for c, w in zip(chars, widths):
            d.text((x, pad + dy), c, font=font, fill=hexc(col), stroke_width=st, stroke_fill=hexc(stc) if stc else None); x += w + tracking
    if shadow: draw(shadow[0], shadow[1], shadow[2], stroke, shadow[2])
    draw(0, 0, fill, stroke, stroke_fill)
    return im.crop(im.getbbox())

def fit_font(txt, name, max_w, start, tracking=0):
    size = start
    while size > 20:
        f = F(name, size)
        if sum(f.getlength(c) for c in txt) + tracking*(len(txt)-1) <= max_w: return f
        size *= 0.96
    return F(name, 20)

def arc_text(txt, font, fill, radius, stroke=0, stroke_fill=None, shadow=None):
    """Yukarı bombeli kemer yazı."""
    big = canvas(W*2, H)
    widths = [font.getlength(c) for c in txt]; a = -sum(widths)/radius/2; cx, cy = W, H*0.9
    for c, w in zip(txt, widths):
        mid = a + (w/2)/radius
        if c != " ":
            ci = text_img(c, font, fill, stroke, stroke_fill, shadow)
            rot = ci.rotate(-math.degrees(mid), resample=Image.BICUBIC, expand=True)
            x = cx + radius*math.sin(mid); y = cy - radius*math.cos(mid)
            big.alpha_composite(rot, (int(x - rot.width/2), int(y - rot.height/2)))
        a += w/radius
    return big.crop(big.getbbox())

def star(L, cx, cy, r, col, pts=5, inner=0.45, rot=-90):
    P = []
    for i in range(pts*2):
        rr = r if i % 2 == 0 else r*inner; t = math.radians(rot + i*180/pts); P.append((cx + rr*math.cos(t), cy + rr*math.sin(t)))
    L.poly(P, col)

def holly(p, size=900):
    """Çobanpüskülü dalı: iki dalgalı yaprak + üç meyve."""
    s = size; L = Layer(s, s*0.62)
    def leaf(cx, cy, ang):
        top = []
        for i in range(41):
            t = i/40; x = (t - 0.5)*s*0.46; w = math.sin(math.pi*t)*s*0.12*(1 + 0.22*math.sin(t*math.pi*6))
            top.append((x, w))
        pts = top + [(x, -y) for x, y in reversed(top)]
        ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        L.poly([(cx + x*ca - y*sa, cy + x*sa + y*ca) for x, y in pts], p["green"], p["outline"], 10)
        L.line([(cx - s*0.2*ca, cy - s*0.2*sa), (cx + s*0.2*ca, cy + s*0.2*sa)], p["outline"], 6)
    leaf(s*0.29, s*0.34, 200); leaf(s*0.71, s*0.34, -20)
    for dx, dy in [(-0.07, 0.04), (0.07, 0.04), (0, -0.05)]:
        L.ellipse((s*(0.5+dx)-s*0.075, s*(0.33+dy)-s*0.075, s*(0.5+dx)+s*0.075, s*(0.33+dy)+s*0.075), p["red"], p["outline"], 10)
    return L.done()

def stack(parts, gap=60):
    tot = sum(im.height for im in parts) + gap*(len(parts)-1); mw = max(im.width for im in parts)
    out = canvas(mw, tot); y = 0
    for im in parts: paste(out, im, (mw - im.width)//2, y); y += im.height + gap
    return out

# ---------------- 1) Most Likely To (aile seti; aynı tasarım dili) ----------------
MLT = {"mlt-cookies": ["Eat All", "The Cookies"], "mlt-movies": ["Watch Holiday", "Movies All Day"], "mlt-naughty": ["Be On The", "Naughty List"],
       "mlt-burn": ["Burn The", "Cookies"], "mlt-presents": ["Shake Every", "Present"], "mlt-asleep": ["Fall Asleep", "By The Fire"],
       "mlt-snowball": ["Throw The", "First Snowball"], "mlt-carols": ["Sing Carols", "Off Key"]}
def most_likely(lines, p):
    head = text_img("MOST LIKELY TO", fit_font("MOST LIKELY TO", ARCH, 3300, 330, tracking=40), p["green"], tracking=40)
    size = min(fit_font(t, SHRIK, 4000, 760).size for t in lines)  # tüm satırlar aynı boyda (aile seti tutarlı görünsün)
    big = [text_img(t, F(SHRIK, size), p["red"], shadow=(26, 26, p["gold"])) for t in lines]
    rule = Layer(3600, 80); rule.rect((0, 32, 1550, 48), p["green"], 8); rule.rect((2050, 32, 3600, 48), p["green"], 8); star(rule, 1800, 40, 40, p["gold"])
    return stack([holly(p, 1600), head, rule.done()] + big, gap=110)

# ---------------- 2) Retro gingerbread + pembe vintage Noel ----------------
def gingerbread_man(p, s=2000):
    L = Layer(s, s*1.15); brown = "#B0662E"; icing = "#FFFFFF"; o = p["outline"]
    for sx in (-1, 1):  # bacak ve kollar (kontur için önce)
        L.poly([(s*(0.5+sx*0.03), s*0.70), (s*(0.5+sx*0.24), s*0.70), (s*(0.5+sx*0.31), s*1.04), (s*(0.5+sx*0.10), s*1.06)], brown, o, 28)
        L.ellipse((s*(0.5+sx*0.205)-s*0.11, s*0.97, s*(0.5+sx*0.205)+s*0.11, s*1.12), brown, o, 14)
        L.poly([(s*(0.5+sx*0.18), s*0.36), (s*(0.5+sx*0.44), s*0.29), (s*(0.5+sx*0.48), s*0.43), (s*(0.5+sx*0.20), s*0.56)], brown, o, 28)
        L.ellipse((s*(0.5+sx*0.46)-s*0.08, s*0.27, s*(0.5+sx*0.46)+s*0.08, s*0.44), brown, o, 14)
    L.rect((s*0.29, s*0.30, s*0.71, s*0.82), brown, s*0.13, o, 14)
    L.ellipse((s*0.32, s*0.02, s*0.68, s*0.38), brown, o, 14)
    for sx in (-1, 1):  # iç dolgu (konturları kapat)
        L.poly([(s*(0.5+sx*0.05), s*0.72), (s*(0.5+sx*0.22), s*0.72), (s*(0.5+sx*0.29), s*1.03), (s*(0.5+sx*0.11), s*1.04)], brown)
        L.poly([(s*(0.5+sx*0.19), s*0.38), (s*(0.5+sx*0.43), s*0.31), (s*(0.5+sx*0.46), s*0.42), (s*(0.5+sx*0.21), s*0.54)], brown)
    L.rect((s*0.30, s*0.31, s*0.70, s*0.81), brown, s*0.12); L.ellipse((s*0.325, s*0.025, s*0.675, s*0.375), brown)
    for sx in (-1, 1):  # şeker süslemesi
        L.line([(s*(0.5+sx*0.40), s*0.30), (s*(0.5+sx*0.44), s*0.355), (s*(0.5+sx*0.48), s*0.30)], icing, 18)
        L.line([(s*(0.5+sx*0.14), s*0.95), (s*(0.5+sx*0.20), s*1.00), (s*(0.5+sx*0.26), s*0.95)], icing, 18)
        L.ellipse((s*(0.5+sx*0.07)-s*0.028, s*0.14, s*(0.5+sx*0.07)+s*0.028, s*0.20), o)
    L.arc((s*0.41, s*0.17, s*0.59, s*0.30), 20, 160, icing, 18)
    for k, col in enumerate([p["red"], p["green"], p["red"]]): L.ellipse((s*0.455, s*(0.44+k*0.11), s*0.545, s*(0.53+k*0.11)), col, icing, 10)
    return L.done()
def gingerbread(p):
    top = arc_text("Gingerbread", F(XMAS, 900), p["rust"], 3000, stroke=8, stroke_fill=p["outline"], shadow=(24, 24, p["gold"]))
    sub = text_img("SEASON", F(ARCH, 520), p["green"], tracking=120, shadow=(18, 18, p["gold"]))
    return stack([top, gingerbread_man(p, 1900), sub], gap=90)

def pink_tree(p, s=2200):
    L = Layer(s, s*1.1); o = p["outline"]
    tiers = [(0.10, 0.40, 0.18), (0.30, 0.66, 0.30), (0.52, 0.92, 0.42)]
    for t0, t1, half in tiers: L.poly([(s*0.5, s*t0), (s*(0.5+half), s*t1), (s*(0.5-half), s*t1)], p["pink"], o, 14)
    for t0, t1, half in tiers: L.line([(s*(0.5-half*0.62), s*(t1-0.04)), (s*0.5, s*(t1-0.10)), (s*(0.5+half*0.62), s*(t1-0.04))], p["pink2"], 22)
    L.rect((s*0.44, s*0.92, s*0.56, s*1.05), "#8A5A44", 12, o, 12)
    for x, y, c in [(0.44, 0.33, "gold"), (0.60, 0.55, "white"), (0.38, 0.60, "gold"), (0.66, 0.84, "gold"), (0.33, 0.85, "white"), (0.52, 0.78, "white")]:
        L.ellipse((s*x-s*0.035, s*y-s*0.035, s*x+s*0.035, s*y+s*0.035), p[c], o, 8)
    star(L, s*0.5, s*0.10, s*0.09, p["gold"]); return L.done()
def pink_vintage(p):
    sh = "#7A2E45" if p["name"] == "dark" else "#9E3A57"
    top = arc_text("Merry", F(LOB, 1050), p["pink"], 2600, shadow=(26, 26, sh))
    sub = text_img("CHRISTMAS", F(ARCH, 470), p["pink"], tracking=110, shadow=(16, 16, sh))
    return stack([top, pink_tree(p, 2000), sub], gap=80)

# ---------------- 3) İsimli faux patchwork "Mama" ----------------
def patch_texture(w, h, p, seed=7):
    rnd = random.Random(seed); cell = 300; L = Layer(w, h)
    cols = [p["pink2"], p["rust"], p["mustard"], p["teal"], p["cream"], p["pink"], p["green"], p["red"]]
    for gy in range(0, h, cell):
        for gx in range(0, w, cell):
            c = rnd.choice(cols); k = rnd.randint(0, 3); alt = rnd.choice([x for x in cols if x != c]); L.rect((gx, gy, gx+cell, gy+cell), c)
            if k == 1:
                for i in range(0, cell, 60): L.rect((gx+i, gy, gx+i+26, gy+cell), alt)
            elif k == 2:
                for iy in range(30, cell, 75):
                    for ix in range(30 + (iy//75 % 2)*37, cell, 75): L.ellipse((gx+ix-13, gy+iy-13, gx+ix+13, gy+iy+13), alt)
            elif k == 3:
                for i in range(0, cell, 75): L.rect((gx+i, gy, gx+i+35, gy+cell), alt); L.rect((gx, gy+i, gx+cell, gy+i+35), alt)
    im = L.done(); d = ImageDraw.Draw(im)
    for gy in range(0, h, cell):
        for x in range(0, w, 40): d.line([(x, gy+10), (x+20, gy+10)], fill=hexc("#FFFFFF", 210), width=7)
    for gx in range(0, w, cell):
        for y in range(0, h, 40): d.line([(gx+10, y), (gx+10, y+20)], fill=hexc("#FFFFFF", 210), width=7)
    return im
def patch_word(word, p, max_w=4100, size=1500):
    f = fit_font(word, CHERRY, max_w, size, tracking=40)
    mask = text_img(word, f, "#FFFFFF", tracking=40).split()[3]
    tex = patch_texture(mask.width, mask.height, p)
    out = canvas(mask.width + 100, mask.height + 100)
    edge = Image.new("L", out.size, 0); edge.paste(mask, (50, 50)); edge = edge.filter(ImageFilter.MaxFilter(41))
    out.paste(Image.new("RGBA", out.size, hexc(p["outline"])), (0, 0), edge)
    tex.putalpha(mask); out.alpha_composite(tex, (50, 50))
    return out
def names_layer(names, p, max_w=4100):
    """Kişiselleştirilmiş katman: çocuk isimleri (her sipariş için personal.py üretir)."""
    names = [n.strip() for n in names if n and n.strip()][:8]
    sep = "  •  "
    lines = [sep.join(names)] if sum(len(n) for n in names) <= 24 else [sep.join(names[i:i+3]) for i in range(0, len(names), 3)]
    ims = [text_img(l, fit_font(l, PAC, max_w, 430), p["ink"]) for l in lines]
    return stack(ims, gap=40)
def mama(p, word="Mama", names=("Emma", "Liam", "Noah")):
    return stack([patch_word(word, p), names_layer(list(names), p)], gap=170)

# ---------------- 4) Bereli retro hayvanlar ----------------
def beanie(L, cx, top, w, p, col):
    h = w*0.62; o = p["outline"]
    L.chord((cx-w/2, top, cx+w/2, top+h*1.6), 180, 360, p[col], o, 14)
    for i in range(1, 7): x = cx - w/2 + i*w/7; L.line([(x, top+h*0.36), (x, top+h*0.78)], p["cream"] if col != "cream" else p["rust"], 10)
    L.rect((cx-w*0.56, top+h*0.70, cx+w*0.56, top+h*1.02), p["cream"], h*0.12, o, 14)
    for i in range(1, 12): x = cx - w*0.56 + i*w*1.12/12; L.line([(x, top+h*0.75), (x, top+h*0.97)], p["mustard"], 8)
    r = w*0.15; L.ellipse((cx-r, top-r*1.5, cx+r, top+r*0.5), p["cream"], o, 14)
def frog(p, s=2400):
    L = Layer(s, s); g = "#6BAA5A"; dg = "#3F7A3A"; o = p["outline"]
    for ex in (0.30, 0.70): L.ellipse((s*ex-s*0.15, s*0.24, s*ex+s*0.15, s*0.54), g, o, 16)
    L.ellipse((s*0.12, s*0.40, s*0.88, s*0.95), g, o, 16)
    for ex in (0.30, 0.70):
        L.ellipse((s*ex-s*0.137, s*0.40, s*ex+s*0.137, s*0.53), g)
        L.ellipse((s*ex-s*0.09, s*0.31, s*ex+s*0.09, s*0.49), "#FFFFFF", o, 10)
        L.ellipse((s*ex-s*0.045, s*0.36, s*ex+s*0.045, s*0.46), o)
    L.arc((s*0.32, s*0.55, s*0.68, s*0.78), 20, 160, o, 18)
    for cx in (0.24, 0.76): L.ellipse((s*cx-s*0.06, s*0.62, s*cx+s*0.06, s*0.68), "#F08A8A")
    for x, y in [(0.25, 0.80), (0.70, 0.84), (0.45, 0.88)]: L.ellipse((s*x-s*0.03, s*y-s*0.02, s*x+s*0.03, s*y+s*0.02), dg)
    beanie(L, s*0.5, s*0.03, s*0.66, p, "red"); return L.done()
def cat(p, s=2400):
    L = Layer(s, s); org = "#E59A4C"; lo = "#F6C99A"; o = p["outline"]
    for sx in (-1, 1): L.poly([(s*(0.5+sx*0.40), s*0.50), (s*(0.5+sx*0.37), s*0.17), (s*(0.5+sx*0.12), s*0.36)], org, o, 16)
    L.ellipse((s*0.10, s*0.28, s*0.90, s*0.94), org, o, 16)
    L.ellipse((s*0.30, s*0.62, s*0.70, s*0.92), lo)
    for ex in (0.34, 0.66): L.arc((s*ex-s*0.07, s*0.50, s*ex+s*0.07, s*0.62), 200, 340, o, 18)
    L.poly([(s*0.47, s*0.655), (s*0.53, s*0.655), (s*0.5, s*0.695)], "#E06C7A", o, 8)
    L.arc((s*0.42, s*0.65, s*0.50, s*0.74), 0, 160, o, 12); L.arc((s*0.50, s*0.65, s*0.58, s*0.74), 20, 180, o, 12)
    for sx in (-1, 1):
        for k in range(3): L.line([(s*(0.5+sx*0.16), s*(0.69+k*0.03)), (s*(0.5+sx*0.38), s*(0.65+k*0.05))], o, 8)
    for cx in (0.27, 0.73): L.ellipse((s*cx-s*0.05, s*0.66, s*cx+s*0.05, s*0.71), "#F08A8A")
    beanie(L, s*0.5, s*0.03, s*0.62, p, "teal"); return L.done()
def bird(p, s=2400):
    L = Layer(s, s); b = "#8A5A44"; o = p["outline"]
    L.poly([(s*0.80, s*0.60), (s*0.98, s*0.50), (s*0.96, s*0.74)], b, o, 16)
    L.ellipse((s*0.12, s*0.26, s*0.86, s*0.92), b, o, 16)
    L.ellipse((s*0.17, s*0.50, s*0.64, s*0.90), "#E0573A")
    L.ellipse((s*0.50, s*0.52, s*0.84, s*0.82), "#6E4433", o, 12)
    L.ellipse((s*0.31, s*0.42, s*0.43, s*0.54), "#FFFFFF", o, 10); L.ellipse((s*0.345, s*0.455, s*0.405, s*0.515), o)
    L.poly([(s*0.16, s*0.50), (s*0.03, s*0.555), (s*0.17, s*0.59)], p["mustard"], o, 10)
    for x in (0.40, 0.54): L.line([(s*x, s*0.91), (s*x, s*0.98), (s*(x-0.05), s*0.99)], p["mustard"], 16)
    beanie(L, s*0.47, s*0.06, s*0.56, p, "green"); return L.done()
ANIMALS = {"animal-frog": (frog, "Stay Cozy"), "animal-cat": (cat, "Nap Season"), "animal-bird": (bird, "Cozy Mode")}
def animal(kind, p):
    fn, word = ANIMALS[kind]
    return stack([fn(p, 2900), text_img(word, fit_font(word, SHRIK, 3900, 820), p["rust"], shadow=(24, 24, p["mustard"]))], gap=40)

# ---------------- 5) Kitapsever ----------------
def books(p, s=2600):
    L = Layer(s, s*0.9); cols = ["teal", "rust", "mustard", "pink", "green"]; o = p["outline"]; y = s*0.88
    for k, (w, h, dx) in enumerate([(0.86, 0.13, 0.0), (0.78, 0.12, 0.03), (0.82, 0.14, -0.02), (0.70, 0.11, 0.04), (0.76, 0.12, -0.03)]):
        x0 = s*(0.5 - w/2 + dx); x1 = x0 + s*w; y0 = y - s*h
        L.rect((x0, y0, x1, y), p[cols[k]], 18, o, 14)
        L.rect((x1 - s*0.05, y0 + 16, x1 - 16, y - 16), p["cream"], 6)
        L.rect((x0 + s*0.08, y0 + s*h*0.35, x0 + s*0.30, y0 + s*h*0.65), p["cream"], 10)
        y = y0
    L.arc((s*0.55, y - s*0.17, s*0.69, y - s*0.04), 270, 90, o, 18)
    L.rect((s*0.36, y - s*0.20, s*0.60, y), p["cream"], 30, o, 14)
    L.rect((s*0.36, y - s*0.13, s*0.60, y - s*0.09), p["red"])
    for x in (0.43, 0.49, 0.55): L.line([(s*x, y - s*0.24), (s*(x+0.02), y - s*0.30), (s*x, y - s*0.36)], p["ink"] if p["name"] == "light" else p["teal"], 12)
    return L.done()
def bookish(p):
    top = arc_text("Bookish Soul", F(SHRIK, 620), p["rust"], 2800, shadow=(20, 20, p["mustard"]))
    sub = text_img("ALWAYS READING", F(ARCH, 330), p["teal"], tracking=60)
    return stack([top, books(p, 2700), sub], gap=90)

DESIGNS = {**{k: (lambda p, v=v: most_likely(v, p)) for k, v in MLT.items()},
           "gingerbread-season": gingerbread, "pink-merry": pink_vintage, "mama-patchwork": mama,
           **{k: (lambda p, k=k: animal(k, p)) for k in ANIMALS}, "bookish-soul": bookish}

TOP = 200  # içerik üst boşluğu (göğüs hizası)
def place(c):
    """İçeriği 4500x5400 baskı alanına yerleştir: yatayda ortalı, üstte; en fazla 4200 x 5000."""
    c = c.crop(c.getbbox()); sc = min(4200 / c.width, 5000 / c.height, 1.0)
    if sc < 1: c = c.resize((int(c.width*sc), int(c.height*sc)), Image.LANCZOS)
    out = canvas(); out.alpha_composite(c, ((W - c.width)//2, TOP)); return out, sc
def save(im, path): place(im)[0].save(path, dpi=(DPI, DPI), optimize=True)

NAMES_GAP = 170
def mama_parts(word="Mama"):
    """Kişiselleştirme için: isimsiz taban görseller (dark / light) + isim katmanının yerleşimi (pod-personalize bunu kullanır).
    Taban, örnek isimli tam tasarımla aynı ölçek ve konumdadır; isim katmanı names.top_px'ten başlar."""
    meta = {"canvas": [W, H]}
    for ink in ("dark", "light"):
        p = PAL[ink]; word_im = patch_word(word, p); sample = names_layer(["Emma", "Liam", "Noah"], p)
        full = stack([word_im, sample], gap=NAMES_GAP); bb = full.getbbox()
        out, sc = place(full)
        base = canvas(); w = word_im.crop((0, 0, word_im.width, word_im.height))
        wb = w.getbbox(); wc = w.crop(wb)
        wc = wc.resize((int(wc.width*sc), int(wc.height*sc)), Image.LANCZOS)
        left = (W - int((bb[2]-bb[0])*sc))//2 + int(((full.width - word_im.width)//2 + wb[0] - bb[0])*sc)
        base.alpha_composite(wc, (left, TOP + int((wb[1] - bb[1])*sc)))
        base.save(OUT / f"mama-patchwork-base_{ink}.png", dpi=(DPI, DPI), optimize=True)
        meta["names"] = {"top_px": int(TOP + (word_im.height + NAMES_GAP - bb[1])*sc), "max_w_px": int(4100*sc), "font_px": int(430*sc), "line_gap_px": int(40*sc)}
        meta.setdefault("ink", {})[ink] = p["ink"]
    return meta

if __name__ == "__main__":
    keys = sys.argv[1].split(",") if len(sys.argv) > 1 else list(DESIGNS)
    for k in keys:
        for ink in ("dark", "light"):
            save(DESIGNS[k](PAL[ink]), OUT / f"{k}_{ink}.png"); print(k, ink, flush=True)
