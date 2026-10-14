import json, re, io, urllib.request, concurrent.futures as cf
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
D = Path(__file__).parent
c = json.loads((D/"candidates.json").read_text(encoding="utf-8"))
kw = re.compile(r"frame|poster|canvas|blank|empty|mockup|mock-up|artwork|picture", re.I)
c = [p for p in c if kw.search(p.get("alt") or "") and min(p["w"], p["h"]) >= 2400]
print(len(c), "süzülmüş")
th = D/"thumbs"; th.mkdir(exist_ok=True)
def dl(p):
    f = th/f"{p['id']}.jpg"
    if not f.exists():
        req = urllib.request.Request(p["med"], headers={"User-Agent": "Mozilla/5.0"})
        f.write_bytes(urllib.request.urlopen(req, timeout=30).read())
    return f
with cf.ThreadPoolExecutor(12) as ex: list(ex.map(dl, c))
for i, p in enumerate(c): p["n"] = i
(D/"filtered.json").write_text(json.dumps(c, indent=0), encoding="utf-8")
font = ImageFont.truetype("arial.ttf", 22)
per, cols, cw, ch = 40, 8, 250, 300
for s in range(0, len(c), per):
    sheet = Image.new("RGB", (cols*cw, ((min(per, len(c)-s)+cols-1)//cols)*ch), "white"); d = ImageDraw.Draw(sheet)
    for k, p in enumerate(c[s:s+per]):
        im = Image.open(th/f"{p['id']}.jpg").convert("RGB"); im.thumbnail((cw-6, ch-30))
        x, y = (k % cols)*cw, (k//cols)*ch
        sheet.paste(im, (x+3, y+28)); d.text((x+4, y+2), str(p["n"]), fill="red", font=font)
    sheet.save(D/f"sheet_{s//per:02d}.jpg", quality=80)
