import json, sys, concurrent.futures as cf
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from syscall import start, result
Q = ["blank frame on wall", "empty picture frame mockup", "poster frame mockup interior", "frame mockup living room", "frame mockup bedroom",
     "blank poster frame", "empty frame shelf", "frame leaning against wall", "white frame mockup", "home office frame on wall",
     "gallery wall empty frames", "multiple empty frames wall", "four frames on wall", "dark room frame mockup", "boho interior blank frame",
     "minimalist room blank poster", "scandinavian interior frame", "beige living room empty frame", "plants room blank frame", "black frame mockup",
     "frame on dresser", "frame on console table", "wooden frame mockup", "empty canvas wall interior", "frame above sofa",
     "frame above bed", "rattan chair frame wall", "concrete wall frame", "green wall frame mockup", "terracotta wall interior frame"]
out = {}
rids = {q: start("etsy-listings", {"action": "stock_photos", "query": q, "perPage": 40}) for q in Q}
for q, rid in rids.items():
    r = result(rid, 120)
    try:
        d = json.loads(r["content"]); 
        for p in d.get("photos", []):
            if p["id"] not in out: out[p["id"]] = dict(p, q=q)
    except Exception as e:
        print("hata", q, r)
Path(__file__).with_name("candidates.json").write_text(json.dumps(list(out.values()), indent=0), encoding="utf-8")
print(len(out), "aday")
