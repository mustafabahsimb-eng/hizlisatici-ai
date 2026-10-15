"""Önizleme sayfası verisi: tasarımlar (küçük şeffaf PNG, base64), koleksiyon metinleri, fiyatlar, bahsistore yeni kapakları -> JSON."""
import base64, io, json, os, sys
from pathlib import Path
from PIL import Image
D = Path(__file__).parent; DES = Path(os.environ["LOCALAPPDATA"]) / "seltigo-pod" / "designs"; COV = Path(os.environ["LOCALAPPDATA"]) / "seltigo-etsy-kapak"
def b64(im, fmt="PNG", **kw):
    buf = io.BytesIO(); im.save(buf, fmt, **kw); return f"data:image/{fmt.lower()};base64," + base64.b64encode(buf.getvalue()).decode()
col = json.loads((D / "collection.json").read_text(encoding="utf-8"))
items = []
for it in col["items"]:
    imgs = {}
    for ink in ("dark", "light"):
        im = Image.open(DES / f"{it['key']}_{ink}.png"); im = im.crop(im.getbbox()); im.thumbnail((420, 420), Image.LANCZOS)
        imgs[ink] = b64(im, "PNG", optimize=True)
    items.append({k: it[k] for k in ("key", "group", "title", "tags", "personalized", "season")} | {"img": imgs, "desc": it["description"].split("\n\n")[0]})
covers = []
for n in range(1, 26):
    im = Image.open(COV / f"{n:02d}.jpg").convert("RGB"); im.thumbnail((260, 260)); covers.append(b64(im, "JPEG", quality=78))
out = {"items": items, "comparison": col["comparison"], "fees": col["fees"], "garment": {k: col["garment"][k] for k in ("colors", "sizes", "est_shipping_us")}, "covers": covers}
Path(sys.argv[1]).write_text(json.dumps(out), encoding="utf-8"); print(Path(sys.argv[1]).stat().st_size // 1024, "KB")

# ---- Gerçek Printify verisi (hazirla sonrası): mockup'lar, beden başına maliyet, iki fiyat seçeneği, üretici karşılaştırması ----
REAL = Path(os.environ["LOCALAPPDATA"]) / "seltigo-pod" / "real_page.json"
if REAL.exists():
    from pricing import min_price, charm, breakdown, FEES
    r = json.loads(REAL.read_text(encoding="utf-8"))
    no_ads = dict(FEES, offsite_ads=0.0)
    def opts(cost):
        a = charm(min_price(cost)); b = charm(min_price(cost, fees=no_ads))
        return {"cost": round(cost, 2), "A": breakdown(a, cost, offsite=True) | {"no_ads": breakdown(a, cost, offsite=False)}, "B": breakdown(b, cost, fees=no_ads, offsite=False) | {"if_ads": breakdown(b, cost, offsite=True)}}
    for it in out["items"]:
        R = r["real"].get(it["key"])
        if R: it["mockups"] = R["mockups"]; it["sizes"] = {s: opts(v["cost_usd"]) for s, v in R["pricing"].items()}
    out["provider"] = r["provider"]; out["blueprint"] = r["blueprint"]
    out["providers"] = json.loads((D / "providers_2026-10-16.json").read_text(encoding="utf-8"))
    sys.path.insert(0, str(D.parent / "etsy-mockup")); from syscall import sql, rows
    rr = rows(sql("select rate from public.exchange_rates where base_currency='USD' and quote_currency='TRY' order by rate_date desc limit 1;"))
    out["usd_try"] = float(rr[0]["rate"]) if rr else None
    Path(sys.argv[1]).write_text(json.dumps(out), encoding="utf-8"); print("gerçek veri eklendi", Path(sys.argv[1]).stat().st_size // 1024, "KB", out["usd_try"])
