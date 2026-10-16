"""Noel sweatshirt koleksiyonu -> Printify -> Etsy. Yalnız resmi API'ler (Printify Public API, Etsy Open API v3 / etsy-listings).

ADIM 1 (token gelince, tek komut):  python printify_yukle.py hazirla
   - Token: depo kökündeki .env (PRINTIFY_TOKEN_BAHSISTORE; GitHub'a gitmez). Veritabanına yazılmaz; Seltigo'nun HizliSatici token'ına dokunulmaz.
   - Printify'da bağlı Etsy mağazasını bulur; Gildan 18000 kalıbını ve 5 renk x S-3XL'i karşılayan hızlı ABD üreticisini seçer.
   - 15 tasarımı (koyu/açık mürekkep) yükler, ürünleri TASLAK oluşturur (Etsy'ye henüz gitmez, ücret yok).
   - Gerçek maliyet + ABD kargo ile fiyatı hesaplar (pricing.py; %35 net kâr, Offsite Ads dahil), ürünlere yazar.
   - Sonuç: durum.json + onizleme_gercek.html (Printify mockup'ları, gerçek maliyet / fiyat / net kâr).
ADIM 2 (onaydan sonra, tek komut):   python printify_yukle.py yayinla
   - Hepsini Etsy'ye yayınlar (Printify publish), Etsy ilan numaralarını bekler; Mama ilanında Etsy kişiselleştirme kutusunu açar
     (etsy-listings listing_personalization), pod_products + season_listings kayıtlarını yazar (kişiselleştirme ve sezon takvimi için).
Seçenekler: --garment comfort-colors-1566 (karşılaştırma için), --only kod,kod
"""
import argparse, base64, json, math, os, sys, time, urllib.error, urllib.request
from pathlib import Path
D = Path(__file__).parent
sys.path.insert(0, str(D)); sys.path.insert(0, str(D.parent / "etsy-mockup"))
from pricing import PRICE_TRY, choose, price_try, to_try
from syscall import sql, rows, call
ROOT = Path(os.environ["LOCALAPPDATA"]) / "seltigo-pod"; DES = ROOT / "designs"; STATE = ROOT / "durum.json"
UID = "92458d1e-1fd7-4cf0-a3ec-9658a949377a"  # Mustafa (bahsistore)
API = "https://api.printify.com/v1"

def q(s): return "'" + str(s).replace("'", "''") + "'"
def load_state(): return json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
def save_state(s): STATE.write_text(json.dumps(s, indent=1, ensure_ascii=False), encoding="utf-8")

class PF:
    def __init__(self, token): self.token = token.strip()
    def __call__(self, method, path, body=None):
        for i in range(5):
            req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                         headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "User-Agent": "Seltigo"})
            try:
                with urllib.request.urlopen(req, timeout=180) as r: t = r.read().decode(); return json.loads(t) if t else {}
            except urllib.error.HTTPError as e:
                t = e.read().decode(errors="replace")
                if e.code in (429, 500, 502, 503) and i < 4: time.sleep(2 * 2 ** i); continue
                raise RuntimeError(f"Printify {e.code} {path}: {t[:400]}")

def bahsistore_token():
    """Printify "Bahsistore" token'ı: yalnız depo kökündeki .env (PRINTIFY_TOKEN_BAHSISTORE). Veritabanına YAZILMAZ;
    Seltigo'nun printify_connections kaydındaki "HizliSatici" token'ına dokunulmaz."""
    env = Path(__file__).resolve().parents[2] / ".env"
    for line in (env.read_text(encoding="utf-8").splitlines() if env.exists() else []):
        if line.startswith("PRINTIFY_TOKEN_BAHSISTORE="): return line.split("=", 1)[1].strip()
    return os.environ.get("PRINTIFY_TOKEN_BAHSISTORE")

def usd_rate(cur):
    if cur == "USD": return 1.0
    r = rows(sql(f"select rate from public.exchange_rates where base_currency='USD' and quote_currency={q(cur)} order by rate_date desc limit 1;"))
    if not r: raise SystemExit(f"Kur yok: USD->{cur}")
    return float(r[0]["rate"])

def pick_blueprint(pf, brand, model):
    bps = pf("GET", "/catalog/blueprints.json")
    hits = [b for b in bps if b.get("brand", "").lower() == brand.lower() and model.lower() in (b.get("model", "") + " " + b.get("title", "")).lower()]
    if not hits: raise SystemExit(f"Printify kataloğunda {brand} {model} bulunamadı")
    hits.sort(key=lambda b: ("youth" in b["title"].lower(), "hood" in b["title"].lower(), len(b["title"])))
    return hits[0]

def pick_provider(pf, bp_id, G, force=None):
    want_c = [c.lower() for c in G["colors"]]; want_s = G["sizes"]
    provs = pf("GET", f"/catalog/blueprints/{bp_id}/print_providers.json"); cands = []
    for p in provs:
        det = pf("GET", f"/catalog/print_providers/{p['id']}.json")
        if (det.get("location") or {}).get("country") != "US": continue
        vs = pf("GET", f"/catalog/blueprints/{bp_id}/print_providers/{p['id']}/variants.json").get("variants", [])
        have = {(v["options"].get("color", "").lower(), v["options"].get("size", "")): v for v in vs}
        missing = [(c, s) for c in want_c for s in want_s if (c, s) not in have]
        if missing: continue
        if force and force.lower() != p["title"].lower(): continue
        rank = next((i for i, n in enumerate(G["provider_preference"]) if n.lower() in p["title"].lower()), 99)
        cands.append((rank, p, {k: v for k, v in have.items() if k[0] in want_c and k[1] in want_s}))
    if not cands: raise SystemExit("5 renk x S-3XL'in hepsini basan ABD üreticisi bulunamadı (renk adları farklı olabilir)")
    cands.sort(key=lambda x: x[0]); r, p, variants = cands[0]
    ship = pf("GET", f"/catalog/blueprints/{bp_id}/print_providers/{p['id']}/shipping.json")
    us = {}
    for prof in ship.get("profiles", []):
        if "US" in prof.get("countries", []):
            for vid in prof.get("variant_ids", []): us[vid] = prof["first_item"]["cost"] / 100
    return p, variants, us, [c[1]["title"] for c in cands]

def us_shipping(pf, bp_id, prov_id):
    """Varyant başına ABD ilk ürün kargosu (USD)."""
    ship = pf("GET", f"/catalog/blueprints/{bp_id}/print_providers/{prov_id}/shipping.json"); us = {}
    for prof in ship.get("profiles", []):
        if "US" in prof.get("countries", []):
            for vid in prof.get("variant_ids", []): us[vid] = prof["first_item"]["cost"] / 100
    return us

def upload(pf, path):
    return pf("POST", "/uploads/images.json", {"file_name": path.name, "contents": base64.b64encode(path.read_bytes()).decode()})

def hazirla(a):
    col = json.loads((D / "collection.json").read_text(encoding="utf-8")); G = col["garment"]
    token = bahsistore_token()
    if not token: raise SystemExit("Printify token yok: depo kökündeki .env dosyasına PRINTIFY_TOKEN_BAHSISTORE=... yaz")
    pf = PF(token); st = load_state()
    shops = pf("GET", "/shops.json"); etsy_shops = [s for s in shops if str(s.get("sales_channel", "")).lower() == "etsy"]
    if not etsy_shops: raise SystemExit("Printify'da bağlı Etsy mağazası yok. Printify > My stores > Etsy'yi bağla, sonra tekrar çalıştır.")
    shop = etsy_shops[0]; st["shop"] = shop
    gk = a.garment or G["chosen"]; g = G[gk]
    bp = pick_blueprint(pf, g["brand"], g["model"]); prov, variants, ship, alts = pick_provider(pf, bp["id"], G, a.provider)
    if st.get("provider", {}).get("id") not in (None, prov["id"]):  # üretici değişti: eski taslaklar silinir (görseller yeniden kullanılır)
        for k, S in st.get("products", {}).items():
            if S.get("product_id") and not S.get("published"):
                pf("DELETE", f"/shops/{shop['id']}/products/{S['product_id']}.json"); S.pop("product_id"); S.pop("pricing", None)
        save_state(st)
    st.update({"garment": gk, "blueprint": {"id": bp["id"], "title": bp["title"]}, "provider": {"id": prov["id"], "title": prov["title"], "alternatives": alts}})
    print("Mağaza:", shop["title"], "| Kalıp:", bp["title"], "| Üretici:", prov["title"])
    dark = {c.lower() for c in G["dark_garments"]}
    vid_dark = [v["id"] for (c, s), v in variants.items() if c in dark]; vid_light = [v["id"] for (c, s), v in variants.items() if c not in dark]
    # Yerleşim için baskı alanı oranı (ön yüz)
    ph = next((p for v in variants.values() for p in v.get("placeholders", []) if p["position"] == "front"), None)
    area_ratio = ph["height"] / ph["width"] if ph else 1.2
    cur = a.currency.upper(); rate = usd_rate(cur)
    items = [it for it in col["items"] if not a.only or it["key"] in a.only.split(",")]
    st.setdefault("products", {})
    for it in items:
        k = it["key"]; S = st["products"].setdefault(k, {})
        if not S.get("uploads"):
            S["uploads"] = {}
            for ink in ("dark", "light"):
                f = DES / f"{k}_{ink}.png"; r = upload(pf, f); S["uploads"][ink] = {"id": r["id"], "url": r.get("preview_url")}
            if it.get("personalized"):
                for ink in ("dark", "light"):
                    r = upload(pf, DES / f"mama-patchwork-base_{ink}.png"); S["uploads"][f"base_{ink}"] = {"id": r["id"], "url": r.get("preview_url")}
            save_state(st)
        img = lambda ink: [{"id": S["uploads"][ink]["id"], "x": 0.5, "y": 0.5, "scale": 1, "angle": 0}]
        body = {"title": it["title"], "description": it["description"], "tags": it["tags"], "blueprint_id": bp["id"], "print_provider_id": prov["id"],
                "variants": [{"id": v["id"], "price": 9999, "is_enabled": True} for v in variants.values()],
                "print_areas": [{"variant_ids": vid_light, "placeholders": [{"position": "front", "images": img("dark")}]},
                                {"variant_ids": vid_dark, "placeholders": [{"position": "front", "images": img("light")}]}]}
        if not S.get("product_id"):
            S["product_id"] = pf("POST", f"/shops/{shop['id']}/products.json", body)["id"]; save_state(st)
        prod = pf("GET", f"/shops/{shop['id']}/products/{S['product_id']}.json")
        prices, rep = price_variants(prod, ship, G, col, cur, rate)
        pf("PUT", f"/shops/{shop['id']}/products/{S['product_id']}.json", {"variants": prices})
        prod = pf("GET", f"/shops/{shop['id']}/products/{S['product_id']}.json")
        S.update({"title": it["title"], "pricing": rep, "currency": cur, "mockups": [i["src"] for i in prod.get("images", [])[:4]],
                  "dark_variant_ids": vid_dark, "area_ratio": area_ratio, "personalized": bool(it.get("personalized")), "season": it["season"]})
        save_state(st); print(k, "taslak hazır;", {s: r["price"] for s, r in rep.items() if s in ("M", "2XL", "3XL")})
    write_report(st, col); print("Bitti. Önizleme:", ROOT / "onizleme_gercek.html")

def price_variants(prod, ship, G, col, cur, rate):
    """Gerçek Printify ürün maliyeti + ABD kargo -> TL mağazada bant fiyatı (pricing.PRICE_TRY; temkinli hesapta zarar yoksa),
    diğerlerinde pricing.choose (net en az 10 $, ,99) -> mağaza para birimi."""
    prices, rep = [], {}
    for v in prod["variants"]:
        if not v.get("is_enabled", True): continue
        c, sh = v["cost"] / 100, ship.get(v["id"], col["garment"]["est_shipping_us"])
        parts = [x.strip() for x in v["title"].split("/")]  # Printify: "S / Light Pink"
        size = next((x for x in parts if x in G["sizes"]), parts[0])
        if cur == "TRY" and size in PRICE_TRY: r = price_try(size, c, sh, rate); local = r["price_local"]
        else: r = choose(c, sh); local = r["price"] if cur == "USD" else to_try(r["price"], rate)
        prices.append({"id": v["id"], "price": int(round(local * 100)), "is_enabled": True})
        if c >= rep.get(size, {}).get("cost", 0): rep[size] = {**r, "price_local": local, "currency": cur}  # renkler arasında en yüksek maliyet
    return prices, rep

def tasarim_yukle(pf, shop_id, k, S):
    """Yeniden üretilen baskı dosyalarını (designs.py) Printify'a yükler ve ürünün ön baskı alanını değiştirir.
    Açık giysiler 'dark', koyu giysiler (Black / Forest Green) 'light' mürekkepli dosyayı kullanır; Etsy ilanı aynı kalır (yayın = güncelleme)."""
    ups = {ink: upload(pf, DES / f"{k}_{ink}.png") for ink in ("dark", "light")}
    S["uploads"].update({ink: {"id": r["id"], "url": r.get("preview_url")} for ink, r in ups.items()})
    prod = pf("GET", f"/shops/{shop_id}/products/{S['product_id']}.json")
    dark = set(S["dark_variant_ids"]); vids = [v["id"] for v in prod["variants"]]  # Printify tüm kalıp varyantlarını ister (kapalılar dahil)
    img = lambda ink: [{"id": S["uploads"][ink]["id"], "x": 0.5, "y": 0.5, "scale": 1, "angle": 0}]
    return [{"variant_ids": [v for v in vids if v not in dark], "placeholders": [{"position": "front", "images": img("dark")}]},
            {"variant_ids": [v for v in vids if v in dark], "placeholders": [{"position": "front", "images": img("light")}]}]

def publish_wait(pf, shop_id, pid, timeout=900):
    """Printify yayını bitene kadar bekler (ürün kilidi kalkınca); Etsy ilan numarasını döndürür (değişmemeli)."""
    time.sleep(15); t0 = time.time()
    while time.time() - t0 < timeout:
        p = pf("GET", f"/shops/{shop_id}/products/{pid}.json")
        if not p.get("is_locked"): return str((p.get("external") or {}).get("id") or "")
        time.sleep(10)
    raise RuntimeError(f"{pid}: Printify yayını {timeout} sn'de bitmedi")

def holiday_line():
    """season-calendar'ın ilanlara yazdığı güncel Noel teslim satırı (app_cache). Printify yayını açıklamayı ezdiği için başa eklenir."""
    r = rows(sql(f"select value->>'line' line from public.app_cache where key like {q('holiday_notice:' + UID + ':%')} order by updated_at desc limit 1;"))
    return (r[0].get("line") or None) if r else None

def guncelle(a):
    """Fiyat (pricing.py) ve açıklamayı (collection.json) Printify'a yazar; yayındaki ürünlerde fiyat + açıklama Etsy'ye gider.
    --metin: başlık + etiketler de; --tasarim: baskı dosyaları yeniden yüklenir (designs.py çıktısı).
    Görsellere ve kargo profiline dokunulmaz (Etsy görselleri gorseller.py ile yönetilir). YENİ İLAN AÇILMAZ: Printify yayını mevcut Etsy
    ilanını günceller; sonrasında ilan numarasının aynı kaldığı doğrulanır, değiştiyse durur."""
    col = json.loads((D / "collection.json").read_text(encoding="utf-8")); G = col["garment"]; items = {it["key"]: it for it in col["items"]}
    st = load_state(); pf = PF(bahsistore_token()); shop = st["shop"]
    ship = us_shipping(pf, st["blueprint"]["id"], st["provider"]["id"])  # kayıtlı üretici (tüm kataloğu taramaz; Printify katalog sınırı)
    cur = a.currency.upper(); rate = usd_rate(cur); hl = holiday_line()
    flags = {"title": bool(a.metin), "description": True, "images": False, "variants": True, "tags": bool(a.metin), "keyFeatures": False, "shipping_template": False}
    for k, S in st["products"].items():
        if a.only and k not in a.only.split(","): continue
        it = items[k]; prod = pf("GET", f"/shops/{shop['id']}/products/{S['product_id']}.json")
        before = str((prod.get("external") or {}).get("id") or "")
        prices, rep = price_variants(prod, ship, G, col, cur, rate)
        body = {"variants": prices, "description": f"{hl}\n\n{it['description']}" if hl else it["description"]}
        if a.metin: body.update({"title": it["title"], "tags": it["tags"]})
        if a.tasarim: body["print_areas"] = tasarim_yukle(pf, shop["id"], k, S)
        pf("PUT", f"/shops/{shop['id']}/products/{S['product_id']}.json", body)
        S["pricing"] = rep; S["currency"] = cur; S["title"] = it["title"]; save_state(st)
        after = before
        if S.get("published") and not a.yayinlama_yok:
            pf("POST", f"/shops/{shop['id']}/products/{S['product_id']}/publish.json", flags)
            after = publish_wait(pf, shop["id"], S["product_id"])
            if before and after != before: raise SystemExit(f"DUR: {k} Etsy ilan numarası değişti {before} -> {after}")
        print(k, "güncellendi" + (f" + Etsy ilanı {after} (numara aynı)" if S.get("published") else ""), {s: r["price_local"] if "price_local" in r else r["price"] for s, r in rep.items() if s in ("M", "2XL", "3XL")}, flush=True)

def mockup_indir(st, keys):
    """Printify ön mockup'larını (renk başına) gorseller.py'nin kullandığı klasöre indirir."""
    import re, urllib.request
    pf = PF(bahsistore_token()); shop = st["shop"]["id"]; out = ROOT / "mockups"; out.mkdir(exist_ok=True)
    COL = ["Sand", "Black", "White", "Light Pink", "Forest Green"]
    for k in keys:
        p = pf("GET", f"/shops/{shop}/products/{st['products'][k]['product_id']}.json")
        color_of = {v["id"]: next((c for c in COL if c in [x.strip() for x in v["title"].split("/")]), None) for v in p["variants"]}
        for im in p.get("images", []):
            m = re.search(r"/mockup/[^/]+/(\d+)/", im["src"]); c = color_of.get(int(m.group(1))) if m else None
            f = out / f"{k}__{c.replace(' ', '-')}.jpg" if c else None
            if f and not f.exists(): f.write_bytes(urllib.request.urlopen(urllib.request.Request(im["src"].replace("?", "?s=2048&"), headers={"User-Agent": "Mozilla/5.0"}), timeout=90).read())

def write_report(st, col):
    rowsh = []
    for it in col["items"]:
        S = st.get("products", {}).get(it["key"]);
        if not S or not S.get("pricing"): continue
        m = S["pricing"].get("M") or next(iter(S["pricing"].values())); m = {"cost_usd": m.get("cost"), "price": m["price"], "with_ads": {"net": m["net"], "margin": m["margin"]}}
        imgs = "".join(f'<img src="{u}" loading="lazy">' for u in S.get("mockups", [])[:3])
        rowsh.append(f'<tr><td>{imgs}</td><td><b>{it["title"]}</b><br><small>{", ".join(it["tags"])}</small></td>'
                     f'<td>{m["cost_usd"]} $</td><td>{m["price"]} $</td><td>{m["with_ads"]["net"]} $ (%{round(m["with_ads"]["margin"]*100)})</td></tr>')
    html = ("<!doctype html><meta charset=utf-8><title>Noel koleksiyonu (Printify gerçek)</title><style>body{font-family:sans-serif;background:#0f1724;color:#e6edf3;padding:16px}"
            "table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #2a3442;padding:8px;vertical-align:top}img{width:110px;margin:2px;border-radius:6px}</style>"
            f"<h2>Printify taslakları — {st.get('provider', {}).get('title', '')} / {st.get('blueprint', {}).get('title', '')}</h2>"
            "<table><tr><th>Mockup</th><th>Başlık / etiketler</th><th>Maliyet (M)</th><th>Satış (M)</th><th>Net kâr (Offsite Ads dahil)</th></tr>" + "".join(rowsh) + "</table>")
    (ROOT / "onizleme_gercek.html").write_text(html, encoding="utf-8")

def yayinla(a):
    st = load_state(); pf = PF(bahsistore_token()); shop = st["shop"]
    flags = {"title": True, "description": True, "images": True, "variants": True, "tags": True, "keyFeatures": True, "shipping_template": True}
    col = {it["key"]: it for it in json.loads((D / "collection.json").read_text(encoding="utf-8"))["items"]}
    for k, S in st["products"].items():
        if a.only and k not in a.only.split(","): continue
        if not S.get("published"):
            pf("POST", f"/shops/{shop['id']}/products/{S['product_id']}/publish.json", flags); S["published"] = time.time(); save_state(st)
    for _ in range(60):  # Etsy ilan numaraları (Printify yayınlayınca external.id gelir)
        left = [k for k, S in st["products"].items() if S.get("published") and not S.get("etsy_listing_id")]
        if not left: break
        for k in left:
            p = pf("GET", f"/shops/{shop['id']}/products/{st['products'][k]['product_id']}.json")
            if (p.get("external") or {}).get("id"): st["products"][k]["etsy_listing_id"] = str(p["external"]["id"]); save_state(st)
        time.sleep(10)
    season_of = {"christmas": "christmas", "evergreen": None}
    for k, S in st["products"].items():
        if a.only and k not in a.only.split(","): continue
        if not S.get("etsy_listing_id"): print(k, "Etsy ilan numarası henüz yok (Printify yayını sürüyor); komutu tekrar çalıştır"); continue
        it = col[k]; season = "christmas" if it["season"] == "christmas" else {"mama-patchwork": "ev_mama", "bookish-soul": "ev_bookish"}.get(k, "ev_beanie_animals")
        perso = None
        if S.get("personalized"):
            L = json.loads((D / "mama_layout.json").read_text())
            perso = {**L, "area_ratio": S["area_ratio"], "dark_variant_ids": S["dark_variant_ids"],
                     "base_urls": {"dark": S["uploads"]["base_dark"]["url"], "light": S["uploads"]["base_light"]["url"]}}
            r = call("etsy-listings", {"action": "listing_personalization", "userId": UID, "etsyListingId": S["etsy_listing_id"],
                                       "question": "Personalization (kids' names)", "instructions": it["personalization"]["instructions"], "charMax": it["personalization"]["char_max"], "required": True}, 300)
            print(k, "Etsy kişiselleştirme:", r and r.get("content", "")[:200])
        sql(f"""insert into public.pod_products (user_id, provider_shop_id, provider_product_id, blueprint_id, print_provider_id, design_key, season_key, external_listing_id, personalized, personalization, status)
values ({q(UID)}, {q(shop['id'])}, {q(S['product_id'])}, {st['blueprint']['id']}, {st['provider']['id']}, {q(k)}, {q(season)}, {q(S['etsy_listing_id'])}, {str(bool(S.get('personalized'))).lower()},
        {q(json.dumps(perso)) + '::jsonb' if perso else 'null'}, 'published')
on conflict (provider, provider_product_id) do update set external_listing_id = excluded.external_listing_id, personalization = excluded.personalization, status = 'published', updated_at = now();
insert into public.season_listings (user_id, season_key, external_listing_id, title, state) values ({q(UID)}, {q(season)}, {q(S['etsy_listing_id'])}, {q(S['title'])}, 'active')
on conflict (user_id, marketplace_code, external_listing_id) do nothing;""")
        print(k, "yayında:", S["etsy_listing_id"])
        S["registered"] = True; save_state(st)
    # Giyim ilanı varsayılanları (Mustafa, 16 Ekim 2026): 4 görsel düzeni, yalnız ABD + ücretsiz kargo, iade politikası
    yeni = [k for k, S in st["products"].items() if S.get("etsy_listing_id") and not S.get("defaults_at") and (not a.only or k in a.only.split(","))]
    if yeni:
        import gorseller
        mockup_indir(st, yeni)
        gorseller.varsayilan(yeni)
        ids = [st["products"][k]["etsy_listing_id"] for k in yeni]
        print("kargo:", call("etsy-listings", {"action": "us_shipping_profile", "userId": UID, "title": "Sweatshirts - US only - Free shipping", "listingIds": ids, "primary": 0, "secondary": 0}, 600)["content"][:160])
        print("iade:", call("etsy-listings", {"action": "return_policy", "userId": UID, "listingIds": ids}, 600)["content"][:160])
        for k in yeni: st["products"][k]["defaults_at"] = time.time()
        save_state(st)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("adim", choices=["hazirla", "yayinla", "guncelle"]); ap.add_argument("--garment"); ap.add_argument("--provider", help="üretici adı (ör. SwiftPOD)")
    ap.add_argument("--only"); ap.add_argument("--metin", action="store_true"); ap.add_argument("--tasarim", action="store_true"); ap.add_argument("--yayinlama-yok", action="store_true", help="yalnız Printify ürünü (Etsy'ye gönderme)"); ap.add_argument("--currency", default="TRY", help="Etsy mağazasının para birimi (bahsistore: TRY)")
    a = ap.parse_args(); {"hazirla": hazirla, "yayinla": yayinla, "guncelle": guncelle}[a.adim](a)
