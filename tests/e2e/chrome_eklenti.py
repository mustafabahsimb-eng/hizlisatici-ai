"""Chrome eklentisi: ürün sayfasından tek tıkla Seltigo'ya ekleme (satıcının kendi tarayıcısından okuma).

Eklenti yüklü gerçek Chromium açılır (pencereli; bot korumalı siteler için gerçek tarayıcı gibi).
1) Giriş (test kullanıcısı) -> oturum eklentide saklanır
2) Trendyol ürün sayfası: Türkiye fiyatı (TL), Türkçe ad, görseller, seçenekler okunur -> eklenir -> kaynak trendyol,
   para birimi TRY, ürün Kendi stoğum; "✏️ Ürünü düzenle" bağlantısı
3) AliExpress ürün sayfası: kaynak sorusu çıkar (AliExpress / Kendi stoğum); seçmeden eklenmez; "Kendi stoğum" -> tedarikçisiz
4) Eklentinin okuma izni olmayan bir site (WooCommerce demo): sunucudaki okuyucuyla eklenir
5) Diğer pazaryerleri (Hepsiburada, n11, Amazon): sayfa açılabildiyse okunan ad/fiyat raporlanır (bot koruması olabilir)
Test ürünleri sonunda kaldırılır.
"""
import re
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import test_user, shots_dir, Checks

EXT = str(Path(__file__).resolve().parents[2] / "chrome-extension")
REST = "https://ytucdrrgxsjhrqmaxckt.supabase.co/rest/v1"
KEY = "sb_publishable_xJXwqD9NmwU70kv2eFKk0A_O2q9gOcD"


def main():
    shots = shots_dir()
    c = Checks()
    email, password = test_user()
    made = []
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix="seltigo-ext-"), headless=False, locale="tr-TR",
                                                   viewport={"width": 1280, "height": 900},
                                                   args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker", timeout=90000)
        ext_id = sw.url.split("/")[2]
        c.check("Eklenti yüklendi", bool(ext_id), ext_id)

        helper = ctx.new_page()
        helper.goto(f"chrome-extension://{ext_id}/background.js")  # eklenti yetkili yardımcı sayfa (arka plan çalışanı uyuyabilir)

        def tab_id(url_part):
            return helper.evaluate("(u) => new Promise(r => chrome.tabs.query({}, ts => r((ts.find(t => (t.url || '').includes(u)) || {}).id)))", url_part)

        def popup_for(url_part):
            tid = tab_id(url_part)
            pop = ctx.new_page()
            pop.set_viewport_size({"width": 360, "height": 620})
            pop.goto(f"chrome-extension://{ext_id}/popup.html?tab={tid}")
            return pop

        def rest(pop, path):
            return pop.evaluate("""async (a) => { const s = (await chrome.storage.local.get('session')).session;
                const r = await fetch(a.rest + a.path, { headers: { apikey: a.key, Authorization: 'Bearer ' + s.access_token } }); return await r.json(); }""",
                                {"rest": REST, "path": path, "key": KEY})

        # 1) Giriş
        page = ctx.new_page()
        page.goto("https://www.trendyol.com/sr?q=termos", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(5000)
        links = page.eval_on_selector_all("a[href*='-p-']", "els => els.map(e => e.href)")
        c.check("Trendyol arama sayfası açıldı (gerçek tarayıcı)", len(links) > 0, f"{len(links)} ürün linki")
        prod_url = links[0].split("?")[0] if links else "https://www.trendyol.com/"
        page.goto(prod_url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(4000)
        pop = popup_for("trendyol.com")
        pop.wait_for_selector("#loginView", state="visible", timeout=15000)
        pop.fill("#email", email)
        pop.fill("#password", password)
        pop.click("#loginBtn")
        pop.wait_for_selector("#preview", state="visible", timeout=60000)
        c.check("Giriş yapıldı, ürün okundu", pop.is_visible("#preview"))

        # 2) Trendyol
        name = pop.inner_text("#pName"); price = pop.inner_text("#pPrice"); meta = pop.inner_text("#pMeta")
        c.check("Trendyol: Türkiye fiyatı (TL) ve Türkçe ad", "₺" in price and bool(re.search(r"[çğıöşüÇĞİÖŞÜ]|[a-z]", name)), f"{name[:60]} | {price} | {meta}")
        pop.screenshot(path=str(shots / "eklenti_trendyol.png"))
        pop.click("#addBtn")
        pop.wait_for_selector("#done", state="visible", timeout=60000)
        href = pop.get_attribute("#editLink", "href") or ""
        pid = int(href.split("id=")[-1]) if "id=" in href else None
        made.append(pid)
        c.check("Trendyol: eklendi + '✏️ Ürünü düzenle' bağlantısı", bool(pid) and pop.inner_text("#editLink") == "✏️ Ürünü düzenle", href)
        row = rest(pop, f"/products?id=eq.{pid}&select=source_platform,cost_currency,supplier,sale_price,supplier_price,image_url,store_visible")[0]
        c.check("Trendyol: kaynak trendyol, TRY, Kendi stoğum, mağazada", row["source_platform"] == "trendyol" and row["cost_currency"] == "TRY"
                and row["supplier"] is None and row["store_visible"] and float(row["sale_price"]) > float(row["supplier_price"]) > 0, str(row)[:200])
        pop.close()

        # 3) AliExpress
        page.goto("https://www.aliexpress.com/item/1005005993561880.html", wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(3000)
        pop = popup_for("aliexpress.com")
        pop.wait_for_selector("#preview", state="visible", timeout=90000)
        c.check("AliExpress: kaynak sorusu görünüyor", pop.is_visible("#aeBox"), pop.inner_text("#aeBox")[:100])
        pop.click("#addBtn")
        pop.wait_for_timeout(1500)
        c.check("AliExpress: kaynak seçilmeden eklenmiyor", "kaynağı seç" in pop.inner_text("#err"))
        pop.check("input[name=aeSrc][value=own]")
        pop.click("#addBtn")
        pop.wait_for_selector("#done", state="visible", timeout=60000)
        pid = int(pop.get_attribute("#editLink", "href").split("id=")[-1]); made.append(pid)
        row = rest(pop, f"/products?id=eq.{pid}&select=source_platform,supplier,source_item_id")[0]
        c.check("AliExpress + 'Kendi stoğum': tedarikçisiz", row["source_platform"] == "aliexpress" and row["supplier"] is None, str(row))
        pop.close()

        # 4) İzinsiz site -> sunucu okuyucusu
        page.goto("https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/", wait_until="domcontentloaded", timeout=60000)
        # Eklentinin izni olmayan sitede tarayıcı sekme adresini göstermez; gerçekte simgeye tıklama (activeTab) bunu sağlar.
        # Testte tıklama taklit edilemediği için adres parametreyle verilir.
        pop = ctx.new_page()
        pop.set_viewport_size({"width": 360, "height": 620})
        pop.goto(f"chrome-extension://{ext_id}/popup.html?tab=none&url=" + __import__("urllib.parse").parse.quote("https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/", safe=""))
        try:
            pop.wait_for_selector("#preview", state="visible", timeout=90000)
        except Exception:
            print("   DURUM:", pop.inner_text("#status"), "| HATA:", pop.inner_text("#err"))
            raise
        c.check("İzinsiz site: sunucu okuyucusuyla okundu", "All Star" in pop.inner_text("#pName") and "seçenek" in pop.inner_text("#pMeta"), pop.inner_text("#pMeta"))
        pop.click("#addBtn")
        pop.wait_for_selector("#done", state="visible", timeout=60000)
        made.append(int(pop.get_attribute("#editLink", "href").split("id=")[-1]))
        pop.close()

        # 5) Diğer pazaryerleri (bilgi amaçlı)
        report = []
        for site, url in [("Hepsiburada", "https://www.hepsiburada.com/ara?q=termos"), ("n11", "https://www.n11.com/arama?q=termos"), ("Amazon TR", "https://www.amazon.com.tr/s?k=termos")]:
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(4000)
                sel = {"Hepsiburada": "a[href*='-p-']", "n11": "a[href*='/urun/'], a[href*='urun.n11.com']", "Amazon TR": "a[href*='/dp/']"}[site]
                hrefs = page.eval_on_selector_all(sel, "els => els.map(e => e.href)")
                if not hrefs:
                    report.append(f"{site}: ürün listesi açılmadı (bot koruması olabilir)"); continue
                page.goto(hrefs[0], wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(4000)
                host = {"Hepsiburada": "hepsiburada.com", "n11": "n11.com", "Amazon TR": "amazon.com.tr"}[site]
                pop = popup_for(host)
                pop.wait_for_function("() => document.getElementById('preview').style.display !== 'none' || /bulunamadı|Hata/.test(document.getElementById('status').textContent + document.getElementById('err').textContent)", timeout=90000)
                report.append(f"{site}: {pop.inner_text('#pName')[:50] if pop.is_visible('#preview') else pop.inner_text('#status')[:60]} | {pop.inner_text('#pPrice') if pop.is_visible('#preview') else ''}")
                pop.close()
            except Exception as e:
                report.append(f"{site}: {str(e)[:80]}")
        print("Diğer pazaryerleri:\n  " + "\n  ".join(report))

        # Temizlik
        cleanup = ctx.new_page()
        cleanup.goto(f"chrome-extension://{ext_id}/popup.html?tab=0")
        cleanup.evaluate("""async (a) => { const s = (await chrome.storage.local.get('session')).session;
            for (const id of a.ids) await fetch(a.rest + '/products?id=eq.' + id, { method: 'PATCH', headers: { apikey: a.key, Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ deleted_at: new Date().toISOString() }) }); }""", {"rest": REST, "key": KEY, "ids": [m for m in made if m]})
        ctx.close()
    c.finish()


if __name__ == "__main__":
    main()
