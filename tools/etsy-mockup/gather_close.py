"""Yakın çekim çerçeve sahneleri (tablo görselin büyük kısmını kaplasın)."""
import json, sys, urllib.request, concurrent.futures as cf
from pathlib import Path
import cv2, numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from syscall import start, result
from used import used_ids
D = Path(__file__).parent
Q = ["frame mockup close up", "poster frame mockup close-up", "blank frame close up", "empty picture frame closeup", "white frame mockup minimal",
     "wooden frame mockup close", "black frame mockup close up", "a4 frame mockup", "frame mockup on table", "blank poster close up",
     "empty frame leaning wall close", "picture frame mockup flat lay", "mockup frame neutral", "frame mockup beige", "frame mockup plant shadow",
     "blank canvas close up", "photo frame mockup", "minimal frame mockup", "oak frame mockup", "frame mockup sunlight shadow"]
seen = set(used_ids()); out = []
rids = {(q, pg): start("etsy-listings", {"action": "stock_photos", "query": q, "perPage": 60, "page": pg}) for q in Q for pg in (1, 2)}
for (q, pg), rid in rids.items():
    r = result(rid, 180)
    try: ph = json.loads(r["content"]).get("photos", [])
    except Exception: print("hata", q, r); continue
    for p in ph:
        if p["id"] in seen or min(p["w"], p["h"]) < 2400: continue
        seen.add(p["id"]); out.append(dict(p, q=q))
print(len(out), "aday")
th = D/"thumbs2"; th.mkdir(exist_ok=True)
def dl(p):
    f = th/f"{p['id']}.jpg"
    if not f.exists():
        try: f.write_bytes(urllib.request.urlopen(urllib.request.Request(p["med"], headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read())
        except Exception: return None
    return f
with cf.ThreadPoolExecutor(12) as ex: list(ex.map(dl, out))
def big_quad(path):
    img = cv2.imread(str(path)); 
    if img is None: return 0
    h, w = img.shape[:2]; g = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (5, 5), 0); best = 0
    for lo, hi in [(30, 90), (15, 50), (50, 150)]:
        e = cv2.dilate(cv2.Canny(g, lo, hi), np.ones((3, 3), np.uint8))
        for c in cv2.findContours(e, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0]:
            a = cv2.contourArea(c)
            if a > 0.9*w*h: continue
            ap = cv2.approxPolyDP(c, 0.02*cv2.arcLength(c, True), True)
            if len(ap) == 4 and cv2.isContourConvex(ap):
                x, y, bw, bh = cv2.boundingRect(ap)
                if x > 2 and y > 2 and x+bw < w-2 and y+bh < h-2:  # tamamı görünür
                    best = max(best, a/(w*h))
    return best
for p in out: p["frac"] = big_quad(th/f"{p['id']}.jpg")
out = [p for p in out if p["frac"] >= 0.22]; out.sort(key=lambda p: -p["frac"])
for i, p in enumerate(out): p["n"] = i
(D/"close.json").write_text(json.dumps(out, indent=0), encoding="utf-8")
from PIL import Image, ImageDraw, ImageFont
font = ImageFont.truetype("arial.ttf", 22); per, cols, cw, ch = 40, 8, 250, 300
for s in range(0, len(out), per):
    sub = out[s:s+per]; sheet = Image.new("RGB", (cols*cw, ((len(sub)+cols-1)//cols)*ch), "white"); d = ImageDraw.Draw(sheet)
    for k, p in enumerate(sub):
        im = Image.open(th/f"{p['id']}.jpg").convert("RGB"); im.thumbnail((cw-6, ch-30)); x, y = (k % cols)*cw, (k//cols)*ch
        sheet.paste(im, (x+3, y+28)); d.text((x+4, y+2), f"{p['n']} ({p['frac']:.2f})", fill="red", font=font)
    sheet.save(D/f"csheet_{s//per:02d}.jpg", quality=80)
print(len(out), "yakın çekim")
