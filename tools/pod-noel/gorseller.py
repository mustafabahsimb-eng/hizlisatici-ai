"""Giyim ilanı görsel düzeni (Mustafa, 16 Ekim 2026; tüm sweatshirt / tişört ilanlarında varsayılan):
  1) Kapak: renkli giysi (tasarımla en iyi kontrast) gerçek kış / Noel sahnesinde (Pexels, ticari kullanım serbest). Beyaz zemin + beyaz giysi YOK.
     Kapaklar birbirinin aynısı olmaz: her ilan ayrı sahne (used_scenes.json).
  2) Düz ürün fotoğrafı (Printify ön görünüm, kapak rengiyle)
  3) Renk seçenekleri (5 renk yan yana)
  4) Beden tablosu (Printify size guide; inç + cm)
  "Most Likely To" serisinde 2. sıraya grup görseli girer (Mustafa, 16 Ekim 2026): 4 farklı ürün yan yana,
  "Matching Family Christmas Sweatshirts" (group_image; serideki her ilanda aynı görsel) -> seride 5 görsel.
Printify API yalnız düz ön mockup veriyor (manken / ortam mockup'ı yok) -> sahne kompozisyonu burada yapılır.
Kullanım: python gorseller.py uret [kod,...]   (görselleri üretir, önizleme sayfası)
          python gorseller.py uygula [kod,...] (depoya yükler, Etsy'de ilk 4 görseli bunlarla değiştirir; etsy-listings set_images)"""
import json, os, sys, time, urllib.request
from pathlib import Path
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
D = Path(__file__).parent; sys.path.insert(0, str(D)); sys.path.insert(0, str(D.parent / "etsy-mockup"))
ROOT = Path(os.environ["LOCALAPPDATA"]) / "seltigo-pod"; MK = ROOT / "mockups"; SC = ROOT / "scenes"; OUT = ROOT / "ilan_gorselleri"; FD = ROOT / "fonts"
OUT.mkdir(exist_ok=True)
COLORS = [("Sand", "#D8C7A8"), ("Light Pink", "#F2CFD6"), ("Forest Green", "#2F4A3A"), ("Black", "#1E1E1E"), ("White", "#F4F4F2")]
SIZE = 2400
# Kapak rengi (tasarımla en iyi kontrast; açık giysi koyu mürekkep, koyu giysi açık mürekkep). Yalnız sand / light pink / forest green.
COVER_COLOR = {"mlt-cookies": "Forest Green", "mlt-movies": "Sand", "mlt-naughty": "Light Pink", "mlt-burn": "Forest Green", "mlt-presents": "Sand",
               "mlt-asleep": "Forest Green", "mlt-snowball": "Light Pink", "mlt-carols": "Sand", "gingerbread-season": "Sand", "pink-merry": "Forest Green",
               "mama-patchwork": "Light Pink", "animal-frog": "Sand", "animal-cat": "Forest Green", "animal-bird": "Light Pink", "bookish-soul": "Forest Green"}

def F(name, size): return ImageFont.truetype(str(FD / name), int(size))
def mock(key, color): return MK / f"{key}__{color.replace(' ', '-')}.jpg"

def _mask(path, tol=34):  # açık gri gölge de zemin sayılır (sand / pink giysiler bu eşikten ayrışır; White için Sand maskesi)
    img = cv2.imread(str(path)); h, w = img.shape[:2]
    near = (np.abs(img.astype(int) - 255).max(axis=2) < tol).astype(np.uint8)
    mask = np.zeros((h + 2, w + 2), np.uint8); bg = near.copy()
    for pt in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]:
        if near[pt[1], pt[0]]: cv2.floodFill(bg, mask, pt, 2)
    fg = (bg != 2).astype(np.uint8) * 255
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)); fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(fg)
    if n > 1: big = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA])); fg = np.where(lab == big, 255, 0).astype(np.uint8)
    fg = cv2.erode(fg, np.ones((3, 3), np.uint8), iterations=5)   # zeminden kalan beyaz kenar şeridini at
    return img, cv2.GaussianBlur(fg, (0, 0), 1.2)

def cutout(path):
    """Printify mockup'ında giysiyi beyaz zeminden ayır (köşelerden taşan beyaz bölge = zemin). RGBA döner.
    Beyaz giysi beyaz zeminden ayrılamaz: Printify'da tüm renklerin giysi biçimi ve yeri aynı olduğundan maske Sand mockup'ından alınır."""
    img, fg = _mask(path)
    if "White" in str(path):
        sand = Path(str(path).replace("White", "Sand"))
        if sand.exists(): fg = _mask(sand)[1]
    rgba = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA); rgba[..., 3] = fg
    im = Image.fromarray(rgba); return im.crop(im.getbbox())

def scene_light(scene, box):
    """Sahnenin yerleşim bölgesindeki parlaklık: giysiye yalnız çok hafif parlaklık uygulanır (renk ASLA kaydırılmaz; alıcı rengi doğru görmeli)."""
    a = np.asarray(scene.crop(box).convert("L")).astype(float)
    return float(np.clip(a.mean() / 190, 0.96, 1.03))

def compose(scene_path, garment, scale=0.70, rot=0.0, dy=0.0):
    sc = Image.open(scene_path).convert("RGB"); s = min(sc.size); sc = sc.crop(((sc.width - s) // 2, (sc.height - s) // 2, (sc.width + s) // 2, (sc.height + s) // 2)).resize((SIZE, SIZE), Image.LANCZOS)
    g = garment.copy(); r = SIZE * scale / max(g.size); g = g.resize((int(g.width * r), int(g.height * r)), Image.LANCZOS)
    if rot: g = g.rotate(rot, resample=Image.BICUBIC, expand=True)
    x = (SIZE - g.width) // 2; y = int((SIZE - g.height) // 2 + dy * SIZE)
    bright = scene_light(sc, (x, y, x + g.width, y + g.height))
    arr = np.asarray(g).astype(float); arr[..., :3] = np.clip(arr[..., :3] * bright, 0, 255); g = Image.fromarray(arr.astype(np.uint8))
    # Yumuşak gölge (üstten ışık): yakın + geniş iki katman
    alpha = g.split()[3]
    for blur, off, op in [(SIZE * 0.012, (int(SIZE * 0.006), int(SIZE * 0.010)), 0.45), (SIZE * 0.035, (int(SIZE * 0.012), int(SIZE * 0.025)), 0.30)]:
        sh = Image.new("L", sc.size, 0); sh.paste(alpha, (x + off[0], y + off[1]))
        sh = sh.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * op))
        sc = Image.composite(Image.new("RGB", sc.size, (25, 18, 12)), sc, sh)
    sc.paste(g, (x, y), g); return sc

def flat(key, color):
    im = Image.open(mock(key, color)).convert("RGB"); return im.resize((SIZE, SIZE), Image.LANCZOS)

def color_chart(key):
    bg = Image.new("RGB", (SIZE, SIZE), "#F6F1EA"); d = ImageDraw.Draw(bg)
    d.text((SIZE // 2, 170), "Available in 5 colors", font=F("DMSerifDisplay-Regular.ttf", 130), fill="#2B2A28", anchor="mm")
    d.text((SIZE // 2, 300), "Gildan 18000 Heavy Blend Crewneck · Unisex S–3XL", font=F("Poppins-Medium.ttf", 54), fill="#6B6560", anchor="mm")
    cell = 640; pos = [(180, 480), (880, 480), (1580, 480), (530, 1300), (1230, 1300)]
    for (name, hexc), (x, y) in zip(COLORS, pos):
        g = cutout(mock(key, name)); g.thumbnail((cell - 70, cell - 70), Image.LANCZOS)
        bg.paste(g, (x + (cell - g.width) // 2, y + (cell - g.height) // 2), g)
        d.ellipse((x + cell // 2 - 230, y + cell + 30, x + cell // 2 - 180, y + cell + 80), fill=hexc, outline="#B8B0A6", width=3)
        d.text((x + cell // 2 - 160, y + cell + 55), name, font=F("Poppins-SemiBold.ttf", 58), fill="#2B2A28", anchor="lm")
    return bg

def size_chart():
    # Printify size guide (Gildan 18000, mm): genişlik / boy / kol (yaka arkasından)
    sizes = ["S", "M", "L", "XL", "2XL", "3XL"]
    width = [508, 559, 609.6, 660.4, 711.2, 762]; length = [685.8, 711.2, 736.6, 762, 787.4, 812.8]; sleeve = [850.9, 876.3, 901.7, 927.1, 952.5, 977.9]
    bg = Image.new("RGB", (SIZE, SIZE), "#F6F1EA"); d = ImageDraw.Draw(bg)
    d.text((SIZE // 2, 190), "Size Chart", font=F("DMSerifDisplay-Regular.ttf", 150), fill="#2B2A28", anchor="mm")
    d.text((SIZE // 2, 330), "Unisex fit · Measurements of the garment laid flat", font=F("Poppins-Medium.ttf", 56), fill="#6B6560", anchor="mm")
    cols = ["Size", "Width", "Length", "Sleeve*"]; x0, x1 = 230, SIZE - 230; cw = (x1 - x0) / 4; y = 520; rh = 205
    d.rounded_rectangle((x0, y - 90, x1, y + 70), radius=24, fill="#2F4A3A")
    for i, c in enumerate(cols): d.text((x0 + cw * i + cw / 2, y - 10), c, font=F("Poppins-SemiBold.ttf", 66), fill="#F6F1EA", anchor="mm")
    for r, s in enumerate(sizes):
        yy = y + 100 + r * rh
        if r % 2 == 0: d.rounded_rectangle((x0, yy - 10, x1, yy + rh - 30), radius=18, fill="#ECE4D8")
        cy = yy + rh / 2 - 20
        d.text((x0 + cw / 2, cy), s, font=F("Poppins-Bold.ttf", 74), fill="#2B2A28", anchor="mm")
        for i, v in enumerate([width[r], length[r], sleeve[r]]):
            d.text((x0 + cw * (i + 1) + cw / 2, cy - 28), f'{v / 25.4:.1f}"'.replace(".0\"", "\""), font=F("Poppins-SemiBold.ttf", 68), fill="#2B2A28", anchor="mm")
            d.text((x0 + cw * (i + 1) + cw / 2, cy + 44), f"{v / 10:.0f} cm", font=F("Poppins-Regular.ttf", 50), fill="#6B6560", anchor="mm")
    d.text((SIZE // 2, SIZE - 210), "*Sleeve measured from the center back of the neck. Tolerance ±1.5\"", font=F("Poppins-Regular.ttf", 50), fill="#6B6560", anchor="mm")
    d.text((SIZE // 2, SIZE - 130), "For an oversized look, size up 1–2 sizes.", font=F("Poppins-Medium.ttf", 56), fill="#2B2A28", anchor="mm")
    return bg

MLT_KEYS = ["mlt-cookies", "mlt-movies", "mlt-naughty", "mlt-burn", "mlt-presents", "mlt-asleep", "mlt-snowball", "mlt-carols"]
GROUP = [("mlt-cookies", "Forest Green"), ("mlt-movies", "Sand"), ("mlt-naughty", "Light Pink"), ("mlt-presents", "Black")]

def group_image():
    """Aile seti: 4 farklı "Most Likely To" sweatshirt yan yana (farklı renkler), başlık "Matching Family Christmas Sweatshirts"."""
    bg = Image.new("RGB", (SIZE, SIZE), "#F6F1EA"); d = ImageDraw.Draw(bg)
    rnd = np.random.default_rng(12)  # hafif kar taneleri
    for x, y, r in zip(rnd.integers(0, SIZE, 140), rnd.integers(0, SIZE, 140), rnd.integers(5, 14, 140)): d.ellipse((x - r, y - r, x + r, y + r), fill="#ECE3D6")
    d.text((SIZE // 2, 170), "Matching Family Christmas Sweatshirts", font=F("DMSerifDisplay-Regular.ttf", 118), fill="#B3262E", anchor="mm")
    d.text((SIZE // 2, 300), "Mix & match 8 \"Most Likely To\" sayings · 5 colors · Unisex S–3XL", font=F("Poppins-Medium.ttf", 60), fill="#6B6560", anchor="mm")
    gs = [cutout(mock(k, c)) for k, c in GROUP]; w = 960
    gs = [g.resize((w, int(g.height * w / g.width)), Image.LANCZOS) for g in gs]
    for i, g in enumerate(gs):  # 2 x 2, yan yana
        x = 150 + (i % 2) * (SIZE - 300 - w); y = 390 + (i // 2) * 920
        alpha = g.split()[3]; sh = Image.new("L", bg.size, 0); sh.paste(alpha, (x + 14, y + 26)); sh = sh.filter(ImageFilter.GaussianBlur(28)).point(lambda v: int(v * 0.35))
        bg = Image.composite(Image.new("RGB", bg.size, (60, 45, 35)), bg, sh); bg.paste(g, (x, y), g)
    d = ImageDraw.Draw(bg)
    d.text((SIZE // 2, SIZE - 110), "Each sweatshirt sold separately · Choose your saying, color and size", font=F("Poppins-Medium.ttf", 56), fill="#2B2A28", anchor="mm")
    return bg

def scene_plan():
    f = ROOT / "kapak_sahneleri.json"; return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}

def uret(keys):
    plan = scene_plan(); sc = size_chart(); sc.save(OUT / "size_chart.jpg", quality=92)
    for k in keys:
        color = COVER_COLOR[k]; p = plan[k]
        cover = compose(SC / f"{p['scene']}.jpg", cutout(mock(k, color)), p.get("scale", 0.74), p.get("rot", 0), p.get("dy", 0))
        cover.save(OUT / f"{k}_1_cover.jpg", quality=92); flat(k, color).save(OUT / f"{k}_2_flat.jpg", quality=92)
        color_chart(k).save(OUT / f"{k}_3_colors.jpg", quality=92); print(k, "görseller hazır", flush=True)
    if any(k in MLT_KEYS for k in keys): group_image().save(OUT / "mlt_group.jpg", quality=92); print("grup görseli hazır", flush=True)

def sira(k):
    """İlan görsel sırası: kapak, (seride grup), düz ürün, renkler, beden tablosu."""
    return [("1_cover", OUT / f"{k}_1_cover.jpg")] + ([("2_group", OUT / "mlt_group.jpg")] if k in MLT_KEYS else []) +            [("2_flat", OUT / f"{k}_2_flat.jpg"), ("3_colors", OUT / f"{k}_3_colors.jpg"), ("4_size", OUT / "size_chart.jpg")]

def uygula(keys):
    from syscall import call
    st = json.loads((ROOT / "durum.json").read_text(encoding="utf-8")); UID = "92458d1e-1fd7-4cf0-a3ec-9658a949377a"
    BASE = "https://ytucdrrgxsjhrqmaxckt.supabase.co/storage/v1/object/public/product-images/"; t = time.strftime("%Y%m%d%H%M%S")
    paths = {k: [f"{UID}/pod/{k}-{n}-{t}.jpg" for n, _ in sira(k)] for k in keys}
    urls = json.loads(call("etsy-listings", {"action": "signed_upload", "bucket": "product-images", "paths": [x for v in paths.values() for x in v]})["content"])["urls"]
    for k in keys:
        for path, (_, src) in zip(paths[k], sira(k)):
            req = urllib.request.Request(urls[path], data=src.read_bytes(), method="PUT", headers={"Content-Type": "image/jpeg", "x-upsert": "true"})
            assert urllib.request.urlopen(req, timeout=300).status == 200
    res = {}
    for k in keys:
        lid = st["products"][k]["etsy_listing_id"]
        r = json.loads(call("etsy-listings", {"action": "set_images", "userId": UID, "etsyListingId": lid, "urls": [BASE + x for x in paths[k]]}, 600)["content"])
        res[k] = r; print(k, lid, r.get("ok"), r.get("count"), r.get("error") or "", flush=True)
    return res

def plan_eksik(keys, dark_ink_keys=()):
    """Yeni ilan için kapak rengi + daha önce kullanılmamış sahne seçer (kapaklar birbirinin aynısı olmaz).
    Renk: açık mürekkepli tasarım (koyu giysi baskısı) -> Forest Green; diğerleri sırayla Sand / Light Pink."""
    plan = scene_plan(); used = {v["scene"] for v in plan.values()}
    cands = [c for c in json.loads((ROOT / "adaylar.json").read_text(encoding="utf-8")) if c["id"] not in used] if (ROOT / "adaylar.json").exists() else []
    alt = ["Sand", "Light Pink"]
    for i, k in enumerate(keys):
        COVER_COLOR.setdefault(k, "Forest Green" if k in dark_ink_keys else alt[i % 2])
        if k in plan: continue
        if not cands: raise SystemExit("Kullanılmamış kapak sahnesi kalmadı: scenes.py ile yeni sahne ara")
        c = cands.pop(0); plan[k] = {"scene": c["id"], "page": c["page"], "by": c["by"]}
        f = SC / f"{c['id']}.jpg"
        if not f.exists(): f.write_bytes(urllib.request.urlopen(urllib.request.Request(c["src"] + "?auto=compress&cs=tinysrgb&w=3000", headers={"User-Agent": "Mozilla/5.0"}), timeout=90).read())
    (ROOT / "kapak_sahneleri.json").write_text(json.dumps(plan, indent=1), encoding="utf-8")
    cc = ROOT / "kapak_renkleri.json"; cc.write_text(json.dumps(COVER_COLOR, indent=1), encoding="utf-8")

def varsayilan(keys, dark_ink_keys=()):
    """Giyim ilanı varsayılan görsel düzeni: plan + üret + Etsy'ye uygula (yayından hemen sonra çağrılır)."""
    plan_eksik(keys, dark_ink_keys); uret(keys); return uygula(keys)

# Yeni eklenen ilanların kapak renkleri (kapak_renkleri.json) varsayılanların üstüne yazılır
if (ROOT / "kapak_renkleri.json").exists(): COVER_COLOR.update(json.loads((ROOT / "kapak_renkleri.json").read_text(encoding="utf-8")))

if __name__ == "__main__":
    step = sys.argv[1]; keys = sys.argv[2].split(",") if len(sys.argv) > 2 else list(COVER_COLOR)
    (uret if step == "uret" else uygula)(keys)
