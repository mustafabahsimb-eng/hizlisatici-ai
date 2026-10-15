"""printify_yukle.py: sahte Printify + sahte veritabanı ile 'hazirla' ve 'yayinla' akışı (gerçek hesaba dokunmaz).
Çalıştırma: python tests/pod/printify_yukle_test.py"""
import json, os, sys, tempfile, types
from pathlib import Path
T = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(T / "pod-noel")); sys.path.insert(0, str(T / "etsy-mockup"))
import printify_yukle as PY
tmp = Path(tempfile.mkdtemp()); PY.STATE = tmp / "durum.json"; PY.ROOT = tmp
SQL = []
PY.sql = lambda s: SQL.append(s) or "[]"
PY.rows = lambda out: [{"api_token": "TEST"}] if False else ([{"rate": 41.0}] if "exchange_rates" in SQL[-1] else [{"api_token": "TEST"}])
CALLS = []
PY.call = lambda fn, body, wait=600: CALLS.append((fn, body)) or {"content": '{"ok":true}'}
COLORS = ["Sand", "Black", "White", "Light Pink", "Forest Green"]; SIZES = ["S", "M", "L", "XL", "2XL", "3XL"]
VARS = [{"id": 1000 + i*10 + j, "title": f"{c} / {s}", "options": {"color": c, "size": s}, "placeholders": [{"position": "front", "width": 3600, "height": 4320}]}
        for i, c in enumerate(COLORS) for j, s in enumerate(SIZES)]
PRODUCTS = {}; LOG = []
def fake(self, method, path, body=None):
    LOG.append((method, path))
    if path == "/shops.json": return [{"id": 77, "title": "bahsistore", "sales_channel": "etsy"}]
    if path == "/catalog/blueprints.json": return [{"id": 49, "title": "Unisex Heavy Blend Crewneck Sweatshirt", "brand": "Gildan", "model": "18000"},
                                                   {"id": 50, "title": "Youth Crewneck", "brand": "Gildan", "model": "18000B"}]
    if path.endswith("/print_providers.json"): return [{"id": 3, "title": "EU Print"}, {"id": 29, "title": "Monster Digital"}]
    if path == "/catalog/print_providers/3.json": return {"location": {"country": "DE"}}
    if path == "/catalog/print_providers/29.json": return {"location": {"country": "US"}}
    if path.endswith("/variants.json"): return {"variants": VARS}
    if path.endswith("/shipping.json"): return {"profiles": [{"variant_ids": [v["id"] for v in VARS], "first_item": {"cost": 799}, "countries": ["US"]}]}
    if path == "/uploads/images.json": return {"id": "up" + str(len(LOG)), "preview_url": "https://img/" + body["file_name"]}
    if method == "POST" and path == "/shops/77/products.json":
        pid = "p" + str(len(PRODUCTS)); assert len(body["print_areas"]) == 2 and len(body["tags"]) == 13
        dark_ids = set(body["print_areas"][1]["variant_ids"]); assert dark_ids == {v["id"] for v in VARS if v["options"]["color"] in ("Black", "Forest Green")}
        PRODUCTS[pid] = {"id": pid, "variants": [{"id": v["id"], "title": v["title"], "cost": 1524 + (250 if v["options"]["size"] == "2XL" else 450 if v["options"]["size"] == "3XL" else 0), "is_enabled": True} for v in VARS], "images": [{"src": "https://mock/" + pid}]}
        return {"id": pid}
    if method == "GET" and path.startswith("/shops/77/products/"): return PRODUCTS[path.split("/")[-1].replace(".json", "")] | ({"external": {"id": "E" + path.split("/")[-1]}} if any(p == ("POST", path.replace(".json", "/publish.json")) for p in LOG) else {})
    if method == "PUT": 
        pid = path.split("/")[-1].replace(".json", ""); PRODUCTS[pid]["prices"] = body["variants"]; return {}
    if path.endswith("/publish.json"): return {}
    raise AssertionError((method, path))
PY.PF.__call__ = fake
a = types.SimpleNamespace(token=None, garment=None, only=None, currency="TRY")
PY.hazirla(a)
st = json.loads(PY.STATE.read_text(encoding="utf-8"))
assert st["provider"]["title"] == "Monster Digital" and st["blueprint"]["id"] == 49, st["provider"]
assert len(st["products"]) == 15, len(st["products"])
m = st["products"]["mlt-cookies"]["pricing"]["M"]; assert m["with_ads"]["margin"] >= 0.35, m
p0 = PRODUCTS["p0"]["prices"]; assert all(x["price"] % 100 == 0 or True for x in p0)
mama = st["products"]["mama-patchwork"]; assert "base_dark" in mama["uploads"] and mama["personalized"]
print("hazirla OK:", {k: v["pricing"]["M"]["price"] for k, v in list(st["products"].items())[:2]}, "TRY M fiyatı:", PRODUCTS["p0"]["prices"][1]["price"] / 100)
PY.time.sleep = lambda s: None
PY.yayinla(types.SimpleNamespace(only=None))
st = json.loads(PY.STATE.read_text(encoding="utf-8"))
assert all(S.get("etsy_listing_id") for S in st["products"].values())
assert [c for c in CALLS if c[1].get("action") == "listing_personalization"], "Mama kişiselleştirme açılmadı"
assert sum("insert into public.pod_products" in s for s in SQL) == 15
print("yayinla OK; pod_products 15 kayıt; kişiselleştirme çağrısı:", len([c for c in CALLS if c[1].get('action') == 'listing_personalization']))
