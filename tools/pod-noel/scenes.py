"""Kapak sahneleri: Pexels'te (ticari kullanım serbest) ortası boş, kenarları kış / Noel süslü üstten çekim (flat lay) sahneleri bulur.
Ortadaki alanın kenar yoğunluğu düşük olanlar seçilir; daha önce kullanılan fotoğraflar (used_scenes.json + etsy kapakları) dışlanır.
Çıktı: %LOCALAPPDATA%/seltigo-pod/scenes/<id>.jpg + adaylar.json + aday sayfası (görsel kontrol)."""
import json, os, sys, urllib.request, concurrent.futures as cf
from pathlib import Path
import cv2, numpy as np
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "etsy-mockup"))
from syscall import start, result
ROOT = Path(os.environ["LOCALAPPDATA"]) / "seltigo-pod"; SC = ROOT / "scenes"; SC.mkdir(parents=True, exist_ok=True)
Q = ["christmas flat lay top view copy space", "christmas mockup flat lay", "cozy christmas flat lay wooden background", "christmas border flat lay wood",
     "knitted sweater flat lay christmas", "plaid blanket flat lay top view", "winter flat lay knit blanket copy space", "christmas decorations frame wooden table top view",
     "flat lay pine branches and ornaments wooden", "christmas cookies flat lay wood copy space", "christmas gifts flat lay top view space", "white fur blanket top view",
     "linen bed sheets top view", "wooden floor top view", "rustic wooden planks background", "cozy bed flat lay", "christmas tree branches frame copy space",
     "christmas candles flat lay", "hot cocoa marshmallows flat lay", "pine cones cinnamon flat lay"]

def used_ids():
    f = ROOT / "used_scenes.json"; u = set(json.loads(f.read_text())) if f.exists() else set()
    for p in [Path(r"C:\Users\mustafa\AppData\Local\Temp\claude\C--Projeler-hizlisatici-ai\7501caa7-0f20-4d22-b424-cacd94187cf9\scratchpad\etsy\close.json")]:
        if p.exists(): u |= {x["id"] for x in json.loads(p.read_text())}
    return u

def center_empty(img):
    """Kare kırpılmış görüntüde ortadaki %56'lık alanda kenar oranı (düşük = boş zemin) ve çevre süs oranı."""
    h, w = img.shape[:2]; s = min(h, w); img = img[(h - s) // 2:(h + s) // 2, (w - s) // 2:(w + s) // 2]
    g = cv2.cvtColor(cv2.resize(img, (600, 600)), cv2.COLOR_BGR2GRAY); e = cv2.Canny(g, 60, 160) > 0
    c = e[132:468, 132:468].mean(); ring = (e.sum() - e[132:468, 132:468].sum()) / (600 * 600 - 336 * 336)
    return float(c), float(ring)

if __name__ == "__main__":
    seen = used_ids(); cands = {}
    rids = {(q, pg): start("etsy-listings", {"action": "stock_photos", "query": q, "perPage": 40, "page": pg}) for q in Q for pg in (1, 2)}
    for (q, pg), rid in rids.items():
        r = result(rid, 180)
        try: ph = json.loads(r["content"]).get("photos", [])
        except Exception: continue
        for p in ph:
            if p["id"] not in seen and min(p["w"], p["h"]) >= 2000 and not __import__("re").search(r"(?i)kermit|muppet|disney|grinch|santa claus costume", p.get("alt") or ""): cands[p["id"]] = dict(p, q=q)
    def dl(p):
        f = SC / f"thumb_{p['id']}.jpg"
        if not f.exists():
            try: f.write_bytes(urllib.request.urlopen(urllib.request.Request(p["med"], headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read())
            except Exception: return None
        img = cv2.imread(str(f)); return (p["id"], *center_empty(img)) if img is not None else None
    with cf.ThreadPoolExecutor(12) as ex: stats = [s for s in ex.map(dl, cands.values()) if s]
    good = sorted([s for s in stats if s[1] < 0.06 and s[2] > 0.025], key=lambda s: s[1])
    out = [dict(cands[i], center=round(c, 4), ring=round(r, 4), n=k) for k, (i, c, r) in enumerate(good)]
    (ROOT / "adaylar.json").write_text(json.dumps(out, indent=0), encoding="utf-8")
    font = ImageFont.truetype("arial.ttf", 20); per, cols, t = 48, 8, 240
    for s in range(0, len(out), per):
        sub = out[s:s+per]; sheet = Image.new("RGB", (cols*t, ((len(sub)+cols-1)//cols)*(t+24)), "white"); d = ImageDraw.Draw(sheet)
        for k, p in enumerate(sub):
            im = Image.open(SC / f"thumb_{p['id']}.jpg").convert("RGB"); im.thumbnail((t-4, t-4)); x, y = (k % cols)*t, (k//cols)*(t+24)
            sheet.paste(im, (x+2, y+22)); d.text((x+4, y+1), str(p["n"]), fill="red", font=font)
        sheet.save(ROOT / f"aday_{s//per}.jpg", quality=80)
    print(len(cands), "aday,", len(out), "ortası boş")
