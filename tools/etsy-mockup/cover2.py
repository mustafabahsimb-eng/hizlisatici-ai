"""Kapak v2: tablo (dış çerçeve) kare görselin en az %60'ını kaplar. Sahne önce büyütülür, tasarım büyütülmüş sahneye yerleştirilir (yazı keskin kalır)."""
import sys, json, cv2, numpy as np
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent)); from mock import *
P = Path(r"C:\Projeler\hizlisatici-ai\bahsistore_etsy_paket\bahsistore_etsy_paket")
D = Path(__file__).parent; OUT = D/"covers2"; OUT.mkdir(exist_ok=True)
# ilan: (sahne anahtarı, ayar)
PLAN = {1: ("c82", {"idx": 3, "raw": 1}), 6: ("279", {}), 11: ("333", {"smooth": 1}), 16: ("248", {"smooth": 1}),
        2: ("5", {"mat": 1}), 7: ("302", {"idx": 0}), 12: ("245", {}), 17: ("264", {}),
        3: ("24", {}), 8: ("c53", {"idx": 0}), 13: ("c1", {"idx": 1, "raw": 1}), 18: ("107", {"mat": 1, "pad": 0.55}),
        4: ("251", {"idx": 0}), 9: ("246", {}), 14: ("259", {}), 19: ("169", {}),
        5: ("13", {}), 10: ("115", {"idx": 2}), 15: ("352", {}), 20: ("88", {})}
SIZE, TARGET = 2400, 0.60
def get_q(img, key, o):
    cs = candidates(key)
    if "idx" in o: return refine(img, cs[o["idx"]]) if not o.get("raw") else inset(cs[o["idx"]], 0.004)
    if "mat" in o:
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY); big = max(cv2.contourArea(c) for c in cs)
        ok = [c for c in cs if cv2.contourArea(c) > 0.12*big and np.median(region_stats(g, inset(c, .3))) > 120]
        return inset(min(ok, key=cv2.contourArea), 0.003)
    return refine(img, pick_inner(img, key))
def outer_of(key, q):
    a = cv2.contourArea(q); c = q.mean(0); best = None
    for x in candidates(key):
        ax = cv2.contourArea(x)
        if 1.02*a < ax < 3.2*a and all(cv2.pointPolygonTest(x.reshape(-1, 1, 2), (float(p[0]), float(p[1])), False) >= 0 for p in inset(q, 0.02)):
            if best is None or ax > cv2.contourArea(best): best = x
    return best if best is not None else inset(q, -0.12)
def render(no, key, o):
    design = cv2.imread(str(next((P/"tekli").glob(f"{no:02d}_*"))/"fotograflar"/"onizleme_tasarim.jpg"))
    img = cv2.imread(str(D/"big"/f"{key}.jpg")); H, W = img.shape[:2]
    q = get_q(img, key, o); oq = inset(q, -o["pad"]) if "pad" in o else outer_of(key, q)
    x0, y0 = oq.min(0); x1, y1 = oq.max(0); bw, bh = x1-x0, y1-y0
    area = cv2.contourArea(oq.astype(np.float32))
    side = max(bw, bh) * 1.05
    side = min(side, max(max(bw, bh) * 1.02, (area / TARGET) ** 0.5))
    side = int(min(side, W, H)); cx, cy = (x0+x1)/2, (y0+y1)/2
    x = int(np.clip(cx - side/2, 0, W - side)); y = int(np.clip(cy - side/2, 0, H - side))
    crop = img[y:y+side, x:x+side]; s = SIZE / side
    up = cv2.resize(crop, (SIZE, SIZE), interpolation=cv2.INTER_LANCZOS4 if s > 1 else cv2.INTER_AREA)
    qq = ((q - [x, y]) * s).astype(np.float32)
    res = place(up, qq, design, smooth="smooth" in o)
    frac = area / side**2
    cv2.imwrite(str(OUT/f"{no:02d}.jpg"), res, [cv2.IMWRITE_JPEG_QUALITY, 93])
    return frac, side
if __name__ == "__main__":
    nos = [int(x) for x in sys.argv[1].split(",")] if len(sys.argv) > 1 else sorted(PLAN)
    rep = {}
    for no in nos:
        try: f, sd = render(no, *PLAN[no]); rep[no] = round(f, 2); print(no, PLAN[no][0], f"kaplama {f:.2f}", "kaynak kenar", sd, flush=True)
        except Exception as e: print(no, "HATA", e)
    json.dump(rep, open(D/"cover2_frac.json", "w"))
