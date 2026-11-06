"""Özellik 1 — "🌐 Sitemi Bağla" uçtan uca testi (site-connect + site-api + webhook).

Test siteleri depoda (GitHub Pages): test-site/ (kendi yapımı site: JSON-LD ProductGroup, OpenGraph + mikroveri, yapısal verisiz sayfa)
ve test-site-feed/ (CSV ürün akışı). Doğrulama kodları sayfalara gömülü (test kullanıcısının bağlantılarına ait).
 1) Panel: adres -> altyapı tespiti, doğrulama seçenekleri; doğrulanmadan aktarım başlamaz
 2) Meta etiketiyle doğrulama -> aktarım (ilerleme çubuğu) -> ürünler Seltigo mağazasında; seçenekler; ikinci aktarımda kopya yok
 3) Akış sitesi: CSV akışı bulunur, doğrulama dosyasıyla doğrulanır, aktarım; tükenen ürün stok 0
 4) Bağlantı kodu: API anahtarı (bir kez gösterilir), /ping, POST /products, PATCH, POST /stock, POST /orders (ortak stok düşer), GET /orders, DELETE
 5) Webhook: webhook.site'a imzalı olay; imza depodaki seltigo.js (Node) ile doğrulanır
 6) Güvenlik: iç ağ adresi reddedilir; yanlış anahtar 401
Sonunda test ürünleri silinir (yumuşak), bağlantılar kalır (doğrulama kodları sitelerde sabit).
Çalıştırma: <venv>\\Scripts\\python tests\\e2e\\site_baglama.py [ekran_klasoru]
"""
import json, os, subprocess, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

FN = "https://ytucdrrgxsjhrqmaxckt.supabase.co/functions/v1/"
PUB = "sb_publishable_xJXwqD9NmwU70kv2eFKk0A_O2q9gOcD"
CRAWL = f"{SITE}/test-site/"
FEED = f"{SITE}/test-site-feed/"
ROOT = Path(__file__).resolve().parents[2]


def http(method, url, body=None, headers=None):
    h = {"Content-Type": "application/json", **(headers or {})}
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(r, timeout=90)
        return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw.decode(errors="ignore")


def reset_limits(uid):
    """Art arda çalıştırmada tanıma / doğrulama sınırına (saatte 30) takılmamak için test kullanıcısının sayaçları sıfırlanır (Supabase CLI girişiyle)."""
    import tempfile
    cli = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
    f = Path(tempfile.gettempdir()) / "site_baglama_reset.sql"
    f.write_text(f"delete from rate_limits where key = 'sitec:d:{uid}' or key like 'sitec:v:%' or key like 'siteapi:%';", encoding="utf-8")
    subprocess.run([str(cli), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f)], capture_output=True, timeout=120)


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 1000})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        login(page)
        ev = lambda js, a=None: page.evaluate(js, a)
        call = lambda body: ev("""async (b) => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
            const r = await fetch(HS.SUPABASE_URL + '/functions/v1/site-connect', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + HS.SUPABASE_KEY, apikey: HS.SUPABASE_KEY }, body: JSON.stringify({ ...b, userAccessToken: tok }) });
            return await r.json(); }""", body)
        page.goto(f"{SITE}/site-baglanti.html")
        page.wait_for_function("() => window.HS && HS.user", timeout=30000)
        uid = ev("() => HS.user.id")
        reset_limits(uid)
        before = ev("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")

        # 6) Güvenlik: iç ağ
        r = call({"action": "detect", "url": "http://127.0.0.1/"})
        c.check("İç ağ adresi reddedildi (SSRF koruması)", not r.get("ok"), r.get("error"))
        r = call({"action": "detect", "url": "http://localtest.me/"})
        c.check("Özel IP'ye çözülen alan adı reddedildi", not r.get("ok"), r.get("error"))

        # 1) Panel: tespit
        page.fill("#url", CRAWL)
        page.wait_for_timeout(1500)
        page.fill("#url", CRAWL)
        page.click("#detectBtn")
        page.wait_for_function("() => !document.getElementById('detectBtn').disabled && !document.getElementById('urlMsg').textContent && document.querySelector('.site-chip.on') && document.querySelector('.site-chip.on').textContent.includes('/test-site/ ')", timeout=90000)
        page.wait_for_timeout(500)
        c.check("Altyapı tespiti: kendi yapımı site, tarama yolu", "Kendi yapımı site" in page.inner_text("#platformPill") and "tarama" in page.inner_text("#platformPill").lower(), page.inner_text("#platformPill"))
        conn = call({"action": "status"})["connections"]
        crawl = next(x for x in conn if x["url"].startswith(CRAWL))
        page.screenshot(path=str(shots / "site_1_tespit.png"), full_page=True)

        # Doğrulanmamış bir bağlantıda aktarım başlamaz (yeni adres, kod yok)
        r = call({"action": "detect", "url": f"{SITE}/test-site/urun/keten-gomlek.html"})
        r2 = call({"action": "import", "id": r["connection"]["id"]})
        c.check("Doğrulanmadan aktarım başlamaz", r2.get("needVerify") is True, r2.get("error"))
        call({"action": "delete", "id": r["connection"]["id"]})

        # 2) Doğrula (meta) + aktar
        page.goto(f"{SITE}/site-baglanti.html")
        page.wait_for_selector(".site-chip", timeout=30000)
        page.click(f".site-chip[data-id='{crawl['id']}']")
        if page.is_visible("#verifyBtn"):
            page.click("#verifyBtn")
        page.wait_for_function("() => /Doğrulandı|Verified/.test(document.getElementById('verifyPill').textContent)", timeout=60000)
        c.check("Meta etiketiyle sahiplik doğrulandı", True, page.inner_text("#verifyMsg"))
        if page.is_visible("#consent"): page.check("#consent")
        t0 = time.time()
        page.click("#importBtn")
        page.wait_for_selector("#progress:not(.hidden)", timeout=30000)
        page.wait_for_function("() => /Bitti|Done|Hata|Error/.test(document.getElementById('progLine').textContent)", timeout=600000)
        secs = time.time() - t0
        line = page.inner_text("#progLine")
        page.screenshot(path=str(shots / "site_2_aktarim.png"), full_page=True)
        rows = ev("""async (b) => (await HS.db.from('site_product_map').select('product_id, url, p:products(id, name, sale_price, stock_qty, image_url, source_url, deleted_at)').eq('connection_id', b).is('removed_at', null)).data.filter(x => x.p && !x.p.deleted_at && x.url.startsWith('http'))""", crawl["id"])
        names = sorted((x["p"] or {}).get("name", "") for x in rows)
        c.check("Aktarım bitti; ilerleme çubuğu çalıştı", "Bitti" in line or "Done" in line, f"{line} · {secs:.0f} sn")
        c.check("Tarama: JSON-LD ve OpenGraph/mikroveri ürünleri geldi", any("Keten" in n for n in names) and any("Kadife" in n for n in names), str(names))
        c.check("Yapısal verisiz sayfa (yapay zekâ / sayfa okuma)", any("Bere" in n for n in names), str(names))
        keten = next((x["p"] for x in rows if "Keten" in (x["p"] or {}).get("name", "")), None)
        vars_ = ev("async (i) => (await HS.db.from('product_variants').select('attributes').eq('product_id', i).eq('is_default', false).is('deleted_at', null)).data", keten["id"]) if keten else []
        c.check("Keten Gömlek seçenekleri (S, M, L) geldi", len(vars_) >= 3, str(vars_)[:120])
        kadife = next((x["p"] for x in rows if "Kadife" in (x["p"] or {}).get("name", "")), None)
        c.check("Fiyat sitedeki perakende fiyat (1199)", kadife and abs(float(kadife["sale_price"]) - 1199) < 0.01, str(kadife and kadife["sale_price"]))
        listed = ev("async (ids) => (await HS.db.from('listings').select('id', {count:'exact', head:true}).in('product_id', ids).eq('marketplace_code','own_store').eq('status','published').is('deleted_at', null)).count", [x["product_id"] for x in rows])
        c.check("Ürünler Seltigo mağazasında yayında", listed == len(rows) and listed >= 3, f"{listed}/{len(rows)}")
        # İkinci aktarım: kopya yok
        n1 = ev("async (b) => (await HS.db.from('products').select('id', {count:'exact', head:true}).gt('id', b).is('deleted_at', null)).count", before)
        r = call({"action": "sync_now", "id": crawl["id"]})
        for _ in range(120):
            st = call({"action": "status", "id": crawl["id"]})["connections"][0]["runs"][0]
            if st["status"] in ("done", "error"): break
            time.sleep(3)
        n2 = ev("async (b) => (await HS.db.from('products').select('id', {count:'exact', head:true}).gt('id', b).is('deleted_at', null)).count", before)
        c.check("Yeniden eşitleme: kopya ürün açılmadı", n1 == n2 and st["created"] == 0, f"önce {n1}, sonra {n2}, yeni {st['created']}, değişmeyen/güncel {st['updated']}")

        # Taşıma: aynı site "taşı" amacıyla -> eski adresler için 301 haritası
        call({"action": "detect", "url": CRAWL, "purpose": "migrate"})
        call({"action": "import", "id": crawl["id"]})
        for _ in range(120):
            st = call({"action": "status", "id": crawl["id"]})["connections"][0]["runs"][0]
            if st["status"] in ("done", "error"): break
            time.sleep(3)
        red = ev("async (i) => (await HS.db.from('store_redirects').select('from_path, to_url').eq('connection_id', i)).data", crawl["id"])
        c.check("Taşıma: eski ürün adresleri için 301 haritası", len(red) >= 3 and all(r["to_url"].startswith("/p/") and r["from_path"].startswith("/hizlisatici-ai/test-site/urun/") for r in red), str(red)[:200])
        call({"action": "detect", "url": CRAWL, "purpose": "connect"})

        # 3) Akış sitesi
        r = call({"action": "detect", "url": FEED})
        c.check("Akış sitesi: CSV ürün akışı bulundu", r.get("method") == "feed" and str(r.get("feed", "")).endswith("urunler.csv"), f"{r.get('method')} {r.get('feed')}")
        fid = r["connection"]["id"]
        v = call({"action": "verify", "id": fid, "method": "file"})
        c.check("Doğrulama dosyasıyla sahiplik doğrulandı", v.get("verified"), v.get("detail"))
        call({"action": "import", "id": fid, "consent": True})
        for _ in range(120):
            st = call({"action": "status", "id": fid})["connections"][0]["runs"][0]
            if st["status"] in ("done", "error"): break
            time.sleep(3)
        frows = ev("""async (b) => (await HS.db.from('site_product_map').select('p:products(name, sale_price, stock_qty, stock_status, gtin)').eq('connection_id', b)).data""", fid)
        fp = {x["p"]["name"]: x["p"] for x in frows if x["p"]}
        c.check("Akıştan 3 ürün geldi", len(fp) == 3 and st["status"] == "done", str(list(fp)))
        sw = fp.get("Kapüşonlu Sweatshirt Gri") or {}
        c.check("Akış: indirimli fiyat (649,90), stok (12), barkod", abs(float(sw.get("sale_price") or 0) - 649.9) < 0.01 and sw.get("stock_qty") == 12 and sw.get("gtin") == "8690000001021", str(sw))
        et = fp.get("Kot Etek") or {}
        c.check("Akış: tükenen ürün stok 0", et.get("stock_qty") == 0, str(et))

        # 4) Bağlantı kodu (API)
        page.goto(f"{SITE}/site-baglanti.html")
        page.wait_for_selector(".site-chip", timeout=30000)
        page.click(f".site-chip[data-id='{crawl['id']}']")
        page.once("dialog", lambda d: d.accept())
        page.click("#keyBtn")
        page.wait_for_selector("#keyBox:not(.hidden)", timeout=30000)
        key = page.inner_text("#keyVal").strip()
        c.check("API anahtarı oluşturuldu (bir kez gösterildi)", key.startswith("slt_live_") and len(key) == 57, key[:13] + "…")
        A = {"Authorization": "Bearer " + key}
        s, d = http("GET", FN + "site-api/ping", headers=A)
        c.check("GET /ping", s == 200 and d.get("ok"), str(d)[:120])
        s, d = http("GET", FN + "site-api/ping", headers={"Authorization": "Bearer slt_live_" + "0" * 48})
        c.check("Yanlış anahtar 401", s == 401, str(s))
        s, d = http("POST", FN + "site-api/products", {"name": "API Test Tişört", "price": 349.9, "stock_qty": 5, "sku": "API-TS-1", "images": ["https://static.ticimax.cloud/48063/uploads/urunresimleri/buyuk/beyaz-oversize-gomlek-e29-c2.jpg"]}, A)
        pid = (d.get("products") or [{}])[0].get("id") if isinstance(d, dict) else None
        c.check("POST /products: ürün açıldı ve mağazada", s == 201 and pid, str(d)[:150])
        s, d = http("POST", FN + "site-api/products", {"name": "API Test Tişört", "price": 359.9, "stock_qty": 5, "sku": "API-TS-1"}, A)
        c.check("Aynı SKU ikinci kez: güncellendi (kopya yok)", s == 201 and d["products"][0]["id"] == pid and d["products"][0]["action"] == "updated", str(d)[:150])
        s, d = http("PATCH", FN + f"site-api/products/{pid}", {"price": 399.9}, A)
        s2, d2 = http("GET", FN + f"site-api/products/{pid}", headers=A)
        c.check("PATCH fiyat -> mağaza fiyatı da güncel", s == 200 and abs(d2["product"]["price"] - 399.9) < 0.01, str(d2.get("product", {}).get("price")))
        s, d = http("POST", FN + "site-api/stock", {"items": [{"sku": "API-TS-1", "quantity": 20}]}, A)
        c.check("POST /stock (SKU ile) stok 20", s == 200 and d["results"][0]["ok"], str(d)[:120])
        ext = "SITE-" + str(int(time.time()))
        s, d = http("POST", FN + "site-api/orders", {"external_order_id": ext, "items": [{"sku": "API-TS-1", "quantity": 3, "price": 399.9}], "customer": {"name": "Site Müşterisi", "city": "İzmir"}}, A)
        time.sleep(1)
        s2, d2 = http("GET", FN + f"site-api/products/{pid}", headers=A)
        c.check("POST /orders: sitedeki satış ortak stoğu düşürdü (20 -> 17)", s == 201 and d2["product"]["stock_qty"] == 17, f"{d['results'] if isinstance(d, dict) else d} stok={d2['product']['stock_qty']}")
        s, d = http("POST", FN + "site-api/orders", {"external_order_id": ext, "items": [{"sku": "API-TS-1", "quantity": 3}]}, A)
        s2, d2 = http("GET", FN + f"site-api/products/{pid}", headers=A)
        c.check("Aynı sipariş ikinci kez sayılmadı", d2["product"]["stock_qty"] == 17 and d["results"][0].get("duplicate"), str(d)[:120])
        mo = ev("async (e) => (await HS.db.from('marketplace_orders').select('marketplace_code, quantity').eq('external_order_id', e)).data", ext)
        c.check("Sitedeki sipariş Seltigo siparişlerinde (Web sitem kanalı)", mo and mo[0]["marketplace_code"] == "website", str(mo))
        s, d = http("GET", FN + "site-api/orders", headers=A)
        c.check("GET /orders (diğer kanallar)", s == 200 and "orders" in d, f"{len(d.get('orders', []))} sipariş")

        # 5) Webhook (webhook.site): imzalı olay, Node örnek koduyla doğrulama
        s, tok = http("POST", "https://webhook.site/token", {"default_status": 200})
        hook = f"https://webhook.site/{tok['uuid']}"
        page.fill("#whUrl", hook)
        page.click("#whSave")
        page.wait_for_function("() => /Kaydedildi|Saved/.test(document.getElementById('whMsg').textContent)", timeout=30000)
        if not page.is_visible("#whBox"):  # anahtar önceki çalıştırmada verildi: yenisi alınır
            page.once("dialog", lambda d: d.accept())
            page.click("#whSecret")
            page.wait_for_selector("#whBox:not(.hidden)", timeout=30000)
        secret = page.inner_text("#whVal").strip()
        page.click("#whTest")
        page.wait_for_function("() => /HTTP 2\\d\\d|aldı|received/.test(document.getElementById('whMsg').textContent)", timeout=30000)
        c.check("Webhook deneme olayı (ping) siteye ulaştı", True, page.inner_text("#whMsg"))
        # Seltigo'da stok değişti -> stock.updated olayı (kuyruk dakikada bir)
        ev("async (i) => await HS.db.from('products').update({ stock_qty: 11 }).eq('id', i)", pid)
        got = None
        for _ in range(60):
            s, reqs = http("GET", f"https://webhook.site/token/{tok['uuid']}/requests?sorting=newest", headers={"Accept": "application/json"})
            for rq in (reqs.get("data") or []):
                if '"stock.updated"' in (rq.get("content") or "") and str(pid) in rq["content"]:
                    got = rq; break
            if got: break
            time.sleep(5)
        c.check("stock.updated olayı webhook ile gönderildi", got is not None)
        if got:
            sig = (got["headers"].get("x-seltigo-signature") or [""])[0]
            # Örnek kod (CommonJS) Deno'nun Node uyumluluğuyla çalıştırılır (bu bilgisayarda Node yok)
            deno = str(Path(os.environ["LOCALAPPDATA"]) / "seltigo-e2e" / "venv" / "Scripts" / "deno.exe")
            code = ("import { createRequire } from 'node:module'; const s = createRequire(import.meta.url)(Deno.env.get('SJS'));"
                    "console.log(String(s.verifySignature(Deno.env.get('BODY') + (Deno.env.get('TAMPER') || ''), Deno.env.get('SIG'))));")
            run = lambda tamper: subprocess.run([deno, "eval", "--quiet", code], capture_output=True, text=True, encoding="utf-8",
                env={**os.environ, "SJS": str(ROOT / "tools" / "site-baglanti" / "seltigo.js"), "BODY": got["content"], "SIG": sig, "TAMPER": tamper, "SELTIGO_WEBHOOK_SECRET": secret, "SELTIGO_API_KEY": key}).stdout.strip()
            c.check("İmza seltigo.js örnek koduyla doğrulandı", run("") == "true", run(""))
            c.check("Değiştirilmiş gövde reddedildi", run(" ") == "false", run(" "))
        page.screenshot(path=str(shots / "site_3_baglanti_kodu.png"), full_page=True)
        # API'den gelen değişiklik siteye geri yollanmaz
        echo = ev("async (a) => (await HS.db.from('site_webhook_events').select('id', {count:'exact', head:true}).eq('connection_id', a[0]).eq('event', 'product.created').eq('payload->>product_id', String(a[1]))).count", [crawl["id"], pid])
        c.check("API ile açılan ürün siteye geri yollanmadı", echo == 0, str(echo))
        s, d = http("DELETE", FN + f"site-api/products/{pid}", headers=A)
        c.check("DELETE /products", s == 200, str(d))

        # Temizlik: test ürünleri (yumuşak), webhook adresi
        call({"action": "set", "id": crawl["id"], "webhook_url": ""})
        ids = ev("async (b) => (await HS.db.from('products').select('id').gt('id', b)).data.map(x => x.id)", before)
        if ids: ev("async (ids) => await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids)", ids)
        c.check("Sayfada JavaScript hatası yok", not errs, str(errs)[:200])
        b.close()
    c.finish()


if __name__ == "__main__":
    main()
