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
