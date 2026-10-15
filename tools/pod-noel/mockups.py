"""Önizleme sayfası için Printify mockup'ları (renk başına ön görünüm) + gerçek fiyatlar -> %LOCALAPPDATA%/seltigo-pod/real_page.json"""
import base64, io, json, os, re, urllib.request, concurrent.futures as cf
from pathlib import Path
from PIL import Image
from printify_yukle import PF, bahsistore_token, load_state
COLORS = ["Sand", "Black", "White", "Light Pink", "Forest Green"]
def b64(url):
    im = Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read())).convert("RGB")
    im.thumbnail((440, 440)); buf = io.BytesIO(); im.save(buf, "JPEG", quality=76); return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
if __name__ == "__main__":
    st = load_state(); pf = PF(bahsistore_token()); shop = st["shop"]["id"]; real = {}; jobs = []
    for k, S in st["products"].items():
        p = pf("GET", f"/shops/{shop}/products/{S['product_id']}.json")
        color_of = {v["id"]: next((c for c in COLORS if c in [x.strip() for x in v["title"].split("/")]), None) for v in p["variants"]}
        pick = {}
        for im in p.get("images", []):
            m = re.search(r"/mockup/[^/]+/(\d+)/(\d+)/", im["src"])
            if m and "camera_label=front" in im["src"]:
                c = color_of.get(int(m.group(1)))
                if c and c not in pick: pick[c] = im["src"]; jobs.append((k, c, im["src"]))
        real[k] = {"mockups": {}, "pricing": S["pricing"], "etsy_listing_id": S.get("etsy_listing_id")}
    with cf.ThreadPoolExecutor(10) as ex:
        for (k, c, u), d in zip(jobs, ex.map(lambda j: b64(j[2]), jobs)): real[k]["mockups"][c] = d
    Path(os.environ["LOCALAPPDATA"], "seltigo-pod", "real_page.json").write_text(json.dumps({"provider": st["provider"]["title"], "blueprint": st["blueprint"]["title"], "real": real}), encoding="utf-8")
    print(len(jobs), "mockup")
