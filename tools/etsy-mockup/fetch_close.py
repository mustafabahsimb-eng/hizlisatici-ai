"""Seçilen yakın çekim fotoğrafları indir + çerçeve dörtgenlerini bul -> quads.json'a 'c<n>' anahtarıyla ekle."""
import json, sys, urllib.request
from pathlib import Path
import cv2, numpy as np
D = Path(__file__).parent
C = {p["n"]: p for p in json.loads((D/"close.json").read_text(encoding="utf-8"))}
Q = json.loads((D/"quads.json").read_text(encoding="utf-8"))
def quads(img):
    h, w = img.shape[:2]; s = 1000 / max(h, w); sm = cv2.resize(img, (int(w*s), int(h*s)))
    g = cv2.GaussianBlur(cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY), (5, 5), 0); out = []
    for lo, hi in [(30, 90), (15, 50), (50, 150), (10, 30)]:
        e = cv2.dilate(cv2.Canny(g, lo, hi), np.ones((3, 3), np.uint8))
        for c in cv2.findContours(e, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0]:
            a = cv2.contourArea(c)
            if a < 0.004*sm.shape[0]*sm.shape[1] or a > 0.85*sm.shape[0]*sm.shape[1]: continue
            ap = cv2.approxPolyDP(c, 0.02*cv2.arcLength(c, True), True)
            if len(ap) == 4 and cv2.isContourConvex(ap):
                q = (ap.reshape(4, 2)/s).astype(int)
                if not any(np.abs(q - o).sum() < 0.03*(w+h)*2 for o in out): out.append(q)
    out.sort(key=lambda q: -cv2.contourArea(q.reshape(-1, 1, 2))); return out[:14]
for n in [int(x) for x in sys.argv[1].split(",")]:
    p = C[n]; f = D/"big"/f"c{n}.jpg"
    if not f.exists():
        f.write_bytes(urllib.request.urlopen(urllib.request.Request(p["src"] + "?auto=compress&cs=tinysrgb&w=4000", headers={"User-Agent": "Mozilla/5.0"}), timeout=90).read())
    img = cv2.imread(str(f)); qs = quads(img); Q[f"c{n}"] = [q.tolist() for q in qs]
    v = img.copy(); t = max(3, img.shape[1]//300)
    for i, q in enumerate(qs):
        col = [(0,0,255),(0,200,0),(255,0,0),(0,200,200),(200,0,200),(255,128,0)][i % 6]
        cv2.polylines(v, [q.reshape(-1, 1, 2)], True, col, t); cv2.putText(v, str(i), tuple(q.mean(0).astype(int)), cv2.FONT_HERSHEY_SIMPLEX, img.shape[1]/600, col, t)
    (D/"prev").mkdir(exist_ok=True); cv2.imwrite(str(D/"prev"/f"c{n}.jpg"), cv2.resize(v, (0, 0), fx=700/max(img.shape[:2]), fy=700/max(img.shape[:2])))
    print(n, p["id"], img.shape, len(qs))
(D/"quads.json").write_text(json.dumps(Q), encoding="utf-8")
