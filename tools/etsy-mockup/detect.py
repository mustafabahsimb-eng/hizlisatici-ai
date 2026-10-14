import json, sys, urllib.request, concurrent.futures as cf
from pathlib import Path
import cv2, numpy as np
D = Path(__file__).parent
F = {p["n"]: p for p in json.loads((D/"filtered.json").read_text(encoding="utf-8"))}
picks = [int(x) for x in sys.argv[1].split(",")]
big = D/"big"; big.mkdir(exist_ok=True); prev = D/"prev"; prev.mkdir(exist_ok=True)
def dl(n):
    p = F[n]; f = big/f"{n}.jpg"
    if not f.exists():
        req = urllib.request.Request(p["src"] + "?auto=compress&cs=tinysrgb&w=3200", headers={"User-Agent": "Mozilla/5.0"})
        f.write_bytes(urllib.request.urlopen(req, timeout=60).read())
    return f
with cf.ThreadPoolExecutor(8) as ex: list(ex.map(dl, picks))
def quads(img):
    h, w = img.shape[:2]; s = 1000 / max(h, w); sm = cv2.resize(img, (int(w*s), int(h*s)))
    g = cv2.cvtColor(sm, cv2.COLOR_BGR2GRAY); g = cv2.GaussianBlur(g, (5, 5), 0)
    out = []
    for lo, hi in [(30, 90), (15, 50), (50, 150)]:
        e = cv2.dilate(cv2.Canny(g, lo, hi), np.ones((3, 3), np.uint8))
        cs, _ = cv2.findContours(e, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for c in cs:
            a = cv2.contourArea(c)
            if a < 0.004 * sm.shape[0] * sm.shape[1] or a > 0.6 * sm.shape[0] * sm.shape[1]: continue
            ap = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
            if len(ap) == 4 and cv2.isContourConvex(ap):
                q = (ap.reshape(4, 2) / s).astype(int)
                if not any(np.abs(q - o).sum() < 0.03 * (w+h) * 2 for o in out): out.append(q)
    return out
res = {}
for n in picks:
    img = cv2.imread(str(big/f"{n}.jpg")); qs = quads(img)
    qs.sort(key=lambda q: -cv2.contourArea(q.reshape(-1, 1, 2)))
    qs = qs[:12]; res[n] = [q.tolist() for q in qs]
    v = img.copy(); t = max(3, img.shape[1] // 400)
    for i, q in enumerate(qs):
        col = [(0,0,255),(0,200,0),(255,0,0),(0,200,200),(200,0,200),(255,128,0)][i % 6]
        cv2.polylines(v, [q.reshape(-1, 1, 2)], True, col, t)
        cv2.putText(v, str(i), tuple(q.mean(0).astype(int)), cv2.FONT_HERSHEY_SIMPLEX, img.shape[1]/700, col, t)
    cv2.imwrite(str(prev/f"{n}.jpg"), cv2.resize(v, (0, 0), fx=900/max(img.shape[:2]), fy=900/max(img.shape[:2])))
(D/"quads.json").write_text(json.dumps(res), encoding="utf-8")
print({n: len(v) for n, v in res.items()})
