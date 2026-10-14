"""Mockup araçları: çerçeve içini bul, tasarımı perspektife uygun yerleştir, ışığı koru."""
import json
from pathlib import Path
import cv2, numpy as np
D = Path(__file__).parent
Q = json.loads((D/"quads.json").read_text(encoding="utf-8"))

def order(q):
    q = np.array(q, dtype=np.float32); s = q.sum(1); d = np.diff(q, axis=1).ravel()
    return np.array([q[s.argmin()], q[d.argmin()], q[s.argmax()], q[d.argmax()]], dtype=np.float32)  # tl tr br bl

def inset(q, f):
    c = q.mean(0); return (c + (q - c) * (1 - f)).astype(np.float32)

def region_stats(gray, q):
    m = np.zeros(gray.shape, np.uint8); cv2.fillConvexPoly(m, q.astype(np.int32), 255)
    return gray[m > 0]

def pick_inner(img, n, seed=None):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    best = None
    for q in Q.get(str(n), []):
        q = order(q)
        center = region_stats(g, inset(q, 0.35)); ring_o = region_stats(g, inset(q, 0.01)); ring_i = region_stats(g, inset(q, 0.06))
        if center.size == 0: continue
        cm = np.median(center)
        # halka: dış %1 - iç %6 arası (çerçeve kenarına en yakın şerit)
        m1 = np.zeros(g.shape, np.uint8); cv2.fillConvexPoly(m1, inset(q, 0.01).astype(np.int32), 255); cv2.fillConvexPoly(m1, inset(q, 0.06).astype(np.int32), 0)
        ring = g[m1 > 0]
        if cm < 120 or ring.size == 0: continue
        if np.percentile(ring, 10) < cm - 45: continue   # halkada çerçeve var -> bu dış kenar
        area = cv2.contourArea(q)
        if best is None or area > best[0]: best = (area, q)
    if best is None and seed is not None:
        h, w = g.shape; sx, sy = int(seed[0]*w), int(seed[1]*h)
        m = np.zeros((h+2, w+2), np.uint8)
        cv2.floodFill(g.copy(), m, (sx, sy), 255, 6, 6, cv2.FLOODFILL_MASK_ONLY | (255 << 8) | 4)
        m = m[1:-1, 1:-1]; m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE); c = max(cs, key=cv2.contourArea)
        hull = cv2.convexHull(c); ap = cv2.approxPolyDP(hull, 0.02*cv2.arcLength(hull, True), True)
        if len(ap) != 4: ap = cv2.boxPoints(cv2.minAreaRect(c))
        best = (0, order(ap.reshape(-1, 2)))
    if best is None: raise RuntimeError(f"{n}: çerçeve içi bulunamadı")
    return inset(best[1], 0.004)

def fit_design(design, aspect, bg=None):
    """Tasarımı hedef en/boy oranına zemin rengiyle genişlet (tasarım düz zeminli olduğu için dikişsiz)."""
    h, w = design.shape[:2]
    if bg is None: bg = np.median(np.concatenate([design[:20].reshape(-1, 3), design[-20:].reshape(-1, 3)]), 0)
    if w / h < aspect: W, H = int(h * aspect), h
    else: W, H = w, int(w / aspect)
    out = np.full((H, W, 3), bg, np.uint8); y, x = (H-h)//2, (W-w)//2; out[y:y+h, x:x+w] = design
    return out

def place(img, q, design, shade=True, smooth=False):
    tl, tr, br, bl = q
    wq = (np.linalg.norm(tr-tl) + np.linalg.norm(br-bl)) / 2; hq = (np.linalg.norm(bl-tl) + np.linalg.norm(br-tr)) / 2
    d = fit_design(design, wq / hq)
    dh, dw = d.shape[:2]
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [dw, 0], [dw, dh], [0, dh]]), q)
    H, W = img.shape[:2]
    warped = cv2.warpPerspective(d, M, (W, H), flags=cv2.INTER_AREA if dw > wq else cv2.INTER_CUBIC)
    mask = cv2.warpPerspective(np.full((dh, dw), 255, np.uint8), M, (W, H), flags=cv2.INTER_LINEAR).astype(np.float32) / 255
    out = img.astype(np.float32)
    if shade:
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        inside = g[mask > 0.99]; ref = np.percentile(inside, 92) if inside.size else 255
        sig = max(2, wq / (6 if smooth else 120)); mi = (mask > 0.99).astype(np.float32)
        s = cv2.GaussianBlur(g * mi, (0, 0), sig) / np.maximum(cv2.GaussianBlur(mi, (0, 0), sig), 1e-3) / max(ref, 1)  # sadece çerçeve içi (kenar kararması yok)
        s = np.clip(s, 0.35, 1.12)[..., None]
        warped = np.clip(warped.astype(np.float32) * s, 0, 255)
    m3 = mask[..., None]
    return (out * (1 - m3) + warped * m3).astype(np.uint8)

def square_crop(img, q, frac=0.6, size=2400):
    H, W = img.shape[:2]; c = q.mean(0); hq = q[:, 1].max() - q[:, 1].min(); wq = q[:, 0].max() - q[:, 0].min()
    side = int(min(W, H, max(hq / frac, wq / frac)))
    x = int(np.clip(c[0] - side/2, 0, W - side)); y = int(np.clip(c[1] - side/2, 0, H - side))
    return cv2.resize(img[y:y+side, x:x+side], (size, size), interpolation=cv2.INTER_AREA)

def candidates(n):
    return [order(q) for q in Q.get(str(n), [])]

def refine(img, q, margin=0.06, thr_drop=30):
    """Kenarları düzeltir: her kenar, çerçeveye (koyu/dokulu şerit) değene kadar dışa, çerçevenin üstündeyse içe kaydırılır."""
    tl, tr, br, bl = q
    wq = int((np.linalg.norm(tr-tl) + np.linalg.norm(br-bl)) / 2); hq = int((np.linalg.norm(bl-tl) + np.linalg.norm(br-tr)) / 2)
    mx, my = int(wq*margin), int(hq*margin); RW, RH = wq + 2*mx, hq + 2*my
    src = np.float32([[mx, my], [mx+wq, my], [mx+wq, my+hq], [mx, my+hq]])
    M = cv2.getPerspectiveTransform(q, src)
    R = cv2.cvtColor(cv2.warpPerspective(img, M, (RW, RH)), cv2.COLOR_BGR2GRAY).astype(np.float32)
    ci = np.median(R[my+int(hq*.3):my+int(hq*.7), mx+int(wq*.3):mx+int(wq*.7)]); t = ci - thr_drop
    row = lambda y: np.median(R[y, mx+int(wq*.2):mx+int(wq*.8)])
    col = lambda x: np.median(R[my+int(hq*.2):my+int(hq*.8), x])
    def edge(pos, step, f, lim_in, lim_out):
        p = pos
        for _ in range(lim_in):
            if f(p) >= t: break
            p -= step
        while abs(p - pos) < lim_out and 0 < p + step < (RH if f is row else RW) - 1 and f(p + step) >= t: p += step
        return p
    top = edge(my, -1, row, int(hq*.1), my); bot = edge(my+hq-1, 1, row, int(hq*.1), my)
    lef = edge(mx, -1, col, int(wq*.1), mx); rig = edge(mx+wq-1, 1, col, int(wq*.1), mx)
    pts = np.float32([[lef, top], [rig, top], [rig, bot], [lef, bot]]).reshape(-1, 1, 2)
    back = cv2.perspectiveTransform(pts, np.linalg.inv(M)).reshape(4, 2)
    return inset(back.astype(np.float32), 0.002)
