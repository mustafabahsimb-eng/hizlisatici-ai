import sys, json, cv2, numpy as np
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent)); from mock import *
P = Path(r"C:\Projeler\hizlisatici-ai\bahsistore_etsy_paket\bahsistore_etsy_paket")
L = json.loads((P/"ilanlar.json").read_text(encoding="utf-8"))["listings"]
def design(no): return cv2.imread(str(next((P/"tekli").glob(f"{no:02d}_*"))/"fotograflar"/"onizleme_tasarim.jpg"))
# set no: (foto, düzen, çerçeve rengi BGR)
# mod: cover = yeni çerçeveler eskilerin tamamını örter (duvar yaması yok); clean = eskiyi sil, yeni dizilim
plan = {21: (287, (2, 2), (120, 160, 196), "cover", [2], 0), 22: (74, (2, 2), (28, 28, 30), "clean", None, 1.1), 23: (256, (2, 2), (105, 140, 178), "clean", None, 0.15),
        24: (334, (2, 2), (110, 150, 190), "cover", [0], 0), 25: (228, "real", None, None, None, 0)}

def render_frames(img, rects, designs, color):
    out = img.astype(np.float32); H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    allr = np.array(rects); x0, y0 = allr[:, 0].min(), allr[:, 1].min(); x1, y1 = allr[:, 2].max(), allr[:, 3].max()
    # duvar ışığı: önce mevcut çerçeveleri yumuşakça "sil" (büyük bulanıklık) -> ışık haritası
    light = cv2.GaussianBlur(g, (0, 0), (x1 - x0) / 4); ref = np.median(light[int(y0):int(y1), int(x0):int(x1)])
    sh = np.clip(light / max(ref, 1), 0.7, 1.15)[..., None]
    # gölgeler
    shadow = np.zeros((H, W), np.float32)
    for (a, b, c, d) in rects:
        bw = (c - a) * 0.045; ox, oy = int(bw * 0.5), int(bw * 0.9)
        cv2.rectangle(shadow, (int(a) + ox, int(b) + oy), (int(c) + ox, int(d) + oy), 1, -1)
    bwm = (rects[0][2] - rects[0][0]) * 0.045
    shadow = cv2.GaussianBlur(shadow, (0, 0), bwm * 0.9)
    # mevcut çerçeveleri örtecek duvar dolgusu: grid alanını duvar rengiyle kapat (gölge + çerçeveler üstüne gelir)
    wall = cv2.inpaint(img, np.zeros((H, W), np.uint8), 3, cv2.INPAINT_TELEA)
    out = out * (1 - 0.35 * shadow[..., None])
    for (a, b, c, d), dz in zip(rects, designs):
        a, b, c, d = map(int, (a, b, c, d)); bw = int((c - a) * 0.045)
        fr = np.zeros((d - b, c - a, 3), np.float32); fr[:] = color
        noise = cv2.GaussianBlur(np.random.default_rng(a).normal(0, 9, (d - b, c - a)).astype(np.float32), (0, 0), 1.2)
        fr += noise[..., None] * (0.4 if max(color) < 60 else 1)
        fr[:max(2, bw // 6)] *= 1.18; fr[:, :max(2, bw // 6)] *= 1.1; fr[-max(2, bw // 6):] *= 0.8; fr[:, -max(2, bw // 6):] *= 0.88
        iw, ih = c - a - 2 * bw, d - b - 2 * bw
        dd = fit_design(dz, iw / ih); dd = cv2.resize(dd, (iw, ih), interpolation=cv2.INTER_AREA).astype(np.float32)
        # iç kenarda ince gölge (derinlik)
        inner = np.ones((ih, iw), np.float32); k = max(2, bw // 3)
        for i in range(k): f = 0.82 + 0.18 * i / k; inner[i, :] *= f; inner[:, i] *= min(1, f + 0.08)
        dd *= inner[..., None]
        fr[bw:bw + ih, bw:bw + iw] = dd
        out[b:d, a:c] = np.clip(fr * sh[b:d, a:c], 0, 255)
    return out.astype(np.uint8)

def clean_wall(img, quads, exp=0.26):
    """Mevcut çerçeveleri sil: deliği çevredeki duvardan 2. derece yüzey + doğal grenle doldur."""
    H, W = img.shape[:2]; m = np.zeros((H, W), np.uint8)
    for q in quads: cv2.fillConvexPoly(m, inset(q, -exp).astype(np.int32), 255)  # iç alan + çerçeve kenarı
    k = int(0.012 * max(H, W)); m = cv2.dilate(m, np.ones((k, k), np.uint8))
    ring = cv2.dilate(m, np.ones((3 * k, 3 * k), np.uint8)) - m
    ys, xs = np.nonzero(ring); px = img[ys, xs].astype(np.float32)
    med = np.median(px, 0); ok = np.abs(px - med).sum(1) < 60; ys, xs, px = ys[ok], xs[ok], px[ok]
    A = lambda x, y: np.stack([np.ones_like(x), x, y, x * x, y * y, x * y], 1)
    xn, yn = xs / W, ys / H; coef = np.linalg.lstsq(A(xn, yn), px, rcond=None)[0]
    hy, hx = np.nonzero(m); fill = A(hx / W, hy / H) @ coef
    resid = (px - A(xn, yn) @ coef).std(0)
    out = img.astype(np.float32); fl = out.copy()
    grain = cv2.GaussianBlur(np.random.default_rng(1).normal(0, 1, (H, W)).astype(np.float32), (0, 0), 0.8)
    fl[hy, hx] = fill + grain[hy, hx, None] * resid * 0.8
    mf = cv2.GaussianBlur(m.astype(np.float32) / 255, (0, 0), k / 3)[..., None]
    return np.clip(out * (1 - mf) + fl * mf, 0, 255).astype(np.uint8)

def grid(union, layout, H, W, frame_aspect=2 / 3, cover=False, down=0):
    rows, cols = layout; ux0, uy0, ux1, uy1 = union; uw, uh = ux1 - ux0, uy1 - uy0
    gap_f = 0.12
    fw = 1.0; fh = fw / frame_aspect; gap = fw * gap_f
    gw, gh = cols * fw + (cols - 1) * gap, rows * fh + (rows - 1) * gap
    if cover:
        s = max(uw / gw, uh / gh) * 1.03; cx, cy = (ux0 + ux1) / 2, (uy0 + uy1) / 2
        x0, y0 = cx - gw * s / 2, cy - gh * s / 2
        return [(x0 + j * (fw + gap) * s, y0 + i * (fh + gap) * s, x0 + j * (fw + gap) * s + fw * s, y0 + i * (fh + gap) * s + fh * s) for i in range(rows) for j in range(cols)]
    bx0, bx1 = max(0.04 * W, ux0 - 0.35 * uw), min(0.96 * W, ux1 + 0.35 * uw)
    by0, by1 = max(0.05 * H, uy0 - 0.2 * uh), min(0.95 * H, uy1 + down * uh)
    s = min((bx1 - bx0) / gw, (by1 - by0) / gh) * 0.95
    cx, cy = (ux0 + ux1) / 2, (by0 + by1) / 2
    x0, y0 = cx - gw * s / 2, cy - gh * s / 2
    return [(x0 + j * (fw + gap) * s, y0 + i * (fh + gap) * s, x0 + j * (fw + gap) * s + fw * s, y0 + i * (fh + gap) * s + fh * s) for i in range(rows) for j in range(cols)]

EXP = {22: 0.42, 24: 0.05}
out = D/"covers"
for no in [int(x) for x in sys.argv[1].split(",")] if len(sys.argv) > 1 else plan:
    n, layout, color, mode, pick, down = plan[no]; st = next(l for l in L if l["no"] == no); ds = [design(k) for k in st["includes"]]
    img = cv2.imread(str(D/"big"/f"{n}.jpg")); H, W = img.shape[:2]
    cs = [c for c in candidates(n) if cv2.contourArea(c) < 0.3 * W * H]
    if layout == "real":
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY); groups = []
        for c in sorted(cs, key=cv2.contourArea, reverse=True):
            if cv2.contourArea(c) < 0.01 * W * H: continue
            cen = c.mean(0)
            for gr in groups:
                if np.linalg.norm(gr[0].mean(0) - cen) < 0.05 * W: gr.append(c); break
            else: groups.append([c])
        qs = []
        for gr in groups[:4]:
            ok = []
            for c in gr:
                m1 = np.zeros(g.shape, np.uint8); cv2.fillConvexPoly(m1, inset(c, 0.01).astype(np.int32), 255); cv2.fillConvexPoly(m1, inset(c, 0.06).astype(np.int32), 0)
                if np.percentile(g[m1 > 0], 10) > 150: ok.append(c)
            qs.append(inset(max(ok or gr, key=cv2.contourArea) if ok else min(gr, key=cv2.contourArea), 0.004))
        qs = sorted(qs, key=lambda q: (round(q.mean(0)[1] / (H / 4)), q.mean(0)[0]))
        res = img
        for q, dz in zip(qs, ds): res = place(res, q, dz, shade=False)
        allq = np.concatenate(qs)
    else:
        big = sorted(cs, key=cv2.contourArea, reverse=True)
        # mevcut çerçevelerin kapladığı alan (dış kenarlar)
        frames = []
        for c in big:
            cen = c.mean(0)
            if cv2.contourArea(c) < 0.01 * W * H or any(cv2.pointPolygonTest(f.reshape(-1, 1, 2), (float(cen[0]), float(cen[1])), False) > 0 for f in frames): continue
            frames.append(c)
        sel = [cs[i] for i in pick] if pick else [f for f in frames if cv2.contourArea(f) > 0.25 * cv2.contourArea(frames[0])]
        a = np.concatenate(sel); pad = 0.03 * (a[:, 0].max() - a[:, 0].min())
        union = (a[:, 0].min() - pad, a[:, 1].min() - pad, a[:, 0].max() + pad, a[:, 1].max() + pad)
        rects = grid(union, layout, H, W, cover=(mode == "cover"), down=down)
        assert all(0 <= r[0] and 0 <= r[1] and r[2] <= W and r[3] <= H for r in rects), f"{no}: çerçeveler resmin dışına taşıyor"
        res = render_frames(clean_wall(img, sel, EXP.get(no, 0.26)), rects, ds, color)
        allq = np.array([[r[0], r[1]] for r in rects] + [[r[2], r[3]] for r in rects], np.float32)
    cv2.imwrite(str(D/f"full_{no}.jpg"), cv2.resize(res, (0, 0), fx=0.15, fy=0.15))
    cv2.imwrite(str(out/f"{no:02d}.jpg"), square_crop(res, allq, frac=0.72), [cv2.IMWRITE_JPEG_QUALITY, 92]); print(no, "ok")
