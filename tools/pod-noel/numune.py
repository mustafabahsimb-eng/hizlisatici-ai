"""Numune siparişi (Mustafa'nın adresine): yayın numunesiz yapılır, en çok satması beklenen 2 tasarımın numunesi ayrıca gelir.
Adres ve seçimler depoda DEĞİL: %LOCALAPPDATA%/seltigo-pod/numune.json
  {"address_to": {"first_name", "last_name", "email", "phone", "country": "TR", "region", "address1", "address2", "city", "zip"},
   "items": [{"key": "mlt-cookies", "color": "Sand", "size": "L"},
             {"key": "mama-patchwork", "color": "Light Pink", "size": "L", "names": ["Emma", "Liam"]}]}
Adımlar (her biri ayrı komut, hiçbiri kendiliğinden para harcamaz):
  python numune.py fiyat        -> Printify'dan bu adrese kargo + ürün maliyeti (sipariş açılmaz)
  python numune.py olustur      -> siparişi TASLAK açar (üretime gitmez, ücret çekilmez)
  python numune.py uretime      -> Mustafa onaylayınca üretime gönderir (Printify bakiyesinden / kartından ücret çekilir)
Mama numunesi, gerçek siparişteki gibi isimli basılır (taban + isim katmanı; isim çizimi designs.py ile aynı)."""
import json, os, sys, time
from pathlib import Path
D = Path(__file__).parent; sys.path.insert(0, str(D))
from printify_yukle import PF, bahsistore_token, upload, load_state, save_state, ROOT
import designs

CFG = ROOT / "numune.json"

def variant_id(pf, shop, pid, color, size):
    p = pf("GET", f"/shops/{shop}/products/{pid}.json")
    for v in p["variants"]:
        t = [x.strip().lower() for x in v["title"].split("/")]
        if color.lower() in t and size.lower() in t: return v["id"], p
    raise SystemExit(f"Seçenek yok: {color} / {size}")

def line_items(pf, st, cfg):
    shop = st["shop"]["id"]; items = []
    for it in cfg["items"]:
        S = st["products"][it["key"]]; vid, p = variant_id(pf, shop, S["product_id"], it["color"], it["size"])
        if it.get("names"):  # isimli: tam tasarımı isimlerle çiz, tek görsel olarak bas
            ink = "light" if it["color"] in ("Black", "Forest Green") else "dark"
            f = ROOT / f"numune-{it['key']}-{ink}.png"; designs.save(designs.mama(designs.PAL[ink], names=it["names"]), f)
            up = upload(pf, f)
            items.append({"print_provider_id": p["print_provider_id"], "blueprint_id": p["blueprint_id"], "variant_id": vid, "quantity": 1,
                          "print_areas": {"front": [{"src": up["preview_url"], "x": 0.5, "y": 0.5, "scale": 1, "angle": 0}]}})
        else:
            items.append({"product_id": S["product_id"], "variant_id": vid, "quantity": 1})
    return items

if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "fiyat"
    if not CFG.exists(): raise SystemExit(f"Önce adres ve seçimler: {CFG}")
    cfg = json.loads(CFG.read_text(encoding="utf-8")); st = load_state(); pf = PF(bahsistore_token()); shop = st["shop"]["id"]
    if step == "fiyat":
        items = [{"product_id": st["products"][i["key"]]["product_id"], "variant_id": variant_id(pf, shop, st["products"][i["key"]]["product_id"], i["color"], i["size"])[0], "quantity": 1} for i in cfg["items"]]
        ship = pf("POST", f"/shops/{shop}/orders/shipping.json", {"line_items": items, "address_to": cfg["address_to"]})
        cost = sum(next(v["cost"] for v in pf("GET", f"/shops/{shop}/products/{x['product_id']}.json")["variants"] if v["id"] == x["variant_id"]) for x in items)
        print(json.dumps({"urun_maliyeti_usd": cost / 100, "kargo_usd": {k: v / 100 for k, v in ship.items() if isinstance(v, (int, float))}}, ensure_ascii=False))
    elif step == "olustur":
        if st.get("numune_order_id"): raise SystemExit(f"Zaten var: {st['numune_order_id']}")
        o = pf("POST", f"/shops/{shop}/orders.json", {"external_id": f"numune-{int(time.time())}", "label": "Numune (bahsistore)", "line_items": line_items(pf, st, cfg),
                                                       "shipping_method": 1, "send_shipping_notification": False, "address_to": cfg["address_to"]})
        st["numune_order_id"] = o["id"]; save_state(st); print("Taslak numune siparişi:", o["id"], "(üretime gitmedi)")
    elif step == "uretime":
        pf("POST", f"/shops/{shop}/orders/{st['numune_order_id']}/send_to_production.json"); print("Üretime gönderildi:", st["numune_order_id"])
