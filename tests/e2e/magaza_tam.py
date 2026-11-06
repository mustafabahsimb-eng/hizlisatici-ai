"""Özellik 2 — tam mağaza uçtan uca testi (store-admin, store-checkout, store-customer, magaza-pro.js).

 1) 🛍️ Mağaza Ayarları: hazır tema, yapay zekâ tasarımı (yoksa kurallı), kaydet; kargo seçenekleri; ödeme yöntemleri
    (geçersiz IBAN reddi); kupon; alan adı (DNS kaydı gösterilir); SEO
 2) Kartla ödeme hesabı: iyzico ve PayTR sandbox'a gerçek istek — sahte anahtar reddedilir (bağlantı kodu çalışıyor)
 3) Vitrin (giriş yapmamış müşteri): tema renkleri, duyuru bandı, SEO başlığı, schema.org OnlineStore; ürün sayfası
    (?p=) + Product JSON-LD; sepet, kargo seçimi, kupon, kapıda ödeme ücreti, sipariş -> takip bağlantısı
 4) Müşteri hesabı: üye ol -> sipariş ver -> Siparişlerim'de görünür
 5) Site haritası: ürün adresleri
 6) Ortak stok: vitrin siparişi stoğu düşürür
Sonunda: siparişler iptal (stok geri gelir), kupon silinir, tema / ayarlar eski haline döner.
Çalıştırma: <venv>\\Scripts\\python tests\\e2e\\magaza_tam.py [ekran_klasoru]
"""
import json, time, urllib.request
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

FN = "https://ytucdrrgxsjhrqmaxckt.supabase.co/functions/v1/"
PID = 88  # test mağazasının yayındaki ürünü


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 1280, "height": 1000})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        login(page)
        page.goto(f"{SITE}/magaza-yonetimi.html")
        page.wait_for_selector("#app:not(.hidden)", timeout=30000)
        ev = lambda js, a=None: page.evaluate(js, a)
        call = lambda body: ev("""async (b) => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
            const r = await fetch(HS.SUPABASE_URL + '/functions/v1/store-admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + HS.SUPABASE_KEY, apikey: HS.SUPABASE_KEY }, body: JSON.stringify({ ...b, userAccessToken: tok }) });
            return await r.json(); }""", body)
        uid = ev("() => HS.user.id")
        orig = ev("async (u) => (await HS.db.from('store_settings').select('store_slug, theme, seo, shipping_options, checkout').eq('user_id', u).single()).data", uid)
        slug = orig["store_slug"]
        stock0 = ev("async (i) => (await HS.db.from('products').select('stock_qty').eq('id', i).single()).data.stock_qty", PID)
        ev("async (i) => await HS.db.from('products').update({ stock_qty: 20 }).eq('id', i)", PID)

        # 1) Tasarım
        page.click(".preset[data-p='butik']")
        page.wait_for_function("() => document.querySelector('.preset.on')?.dataset.p === 'butik'", timeout=20000)
        c.check("Hazır tema seçildi (Butik), önizleme güncel", "rgb(250, 247, 242)" in page.eval_on_selector("#preview", "e => getComputedStyle(e).backgroundColor"))
        page.fill("#aiPrompt", "el yapımı seramik ve doğal ürünler, sıcak görünüm")
        page.click("#aiBtn")
        page.wait_for_function("() => /Hazır|Ready|Hata/.test(document.getElementById('aiMsg').textContent)", timeout=90000)
        ai_theme = ev("() => readTheme()")
        c.check("Yapay zekâ / kurallı tasarım tema üretti", ai_theme["colors"]["bg"].startswith("#") and (ai_theme.get("ai") or {}).get("model"), f"model={ (ai_theme.get('ai') or {}).get('model') } preset={ai_theme['preset']}")
        page.fill("#thAnn", "500 TL üzeri kargo bedava")
        page.fill("#thHeroSub", "Test atölyesinden seçme ürünler")
        page.click("#saveTheme")
        page.wait_for_function("() => /Kaydedildi|Saved/.test(document.getElementById('themeMsg').textContent)", timeout=20000)
        saved = ev("async (u) => (await HS.db.from('store_settings').select('theme').eq('user_id', u).single()).data.theme", uid)
        c.check("Tema kaydedildi (duyuru + alt yazı)", saved.get("announcement") == "500 TL üzeri kargo bedava", str(saved.get("announcement")))
        page.screenshot(path=str(shots / "magaza_1_tasarim.png"), full_page=True)

        # Kargo + ödeme
        page.click(".tab[data-tab='checkout']")
        ev("() => { ship = [{ id: 'std', name: 'Standart', price: 49.9, free_over: 1000, days: '2-4 gün' }, { id: 'hiz', name: 'Hızlı kargo', price: 99, free_over: null, days: '1 gün' }]; renderShip(); }")
        page.click("#shipSave")
        page.wait_for_function("() => /Kaydedildi|Saved/.test(document.getElementById('shipMsg').textContent)", timeout=20000)
        page.check("#mCod"); page.check("#mBank"); page.fill("#codFee", "15"); page.fill("#iban", "TR33 0006 1005 1978 6457 8413 99")
        page.click("#paySave")
        page.wait_for_function("() => document.getElementById('payMsg').textContent", timeout=20000)
        c.check("Geçersiz IBAN reddedildi", "IBAN" in page.inner_text("#payMsg"), page.inner_text("#payMsg"))
        page.fill("#iban", "TR33 0006 1005 1978 6457 8413 26")
        page.click("#paySave")
        page.wait_for_function("() => /Kaydedildi|Saved/.test(document.getElementById('payMsg').textContent)", timeout=20000)
        c.check("Ödeme yöntemleri kaydedildi (kapıda + havale)", True)
        # 2) Kartla ödeme: sahte anahtar -> sağlayıcı reddeder
        r1 = call({"action": "payment_set", "provider": "iyzico", "environment": "sandbox", "keys": {"api_key": "sandbox-sahteanahtar", "secret_key": "sandbox-sahtegizli"}})
        c.check("iyzico sandbox'a imzalı istek gitti, sahte anahtar reddedildi", not r1.get("ok") and "iyzico" in str(r1.get("error")), str(r1.get("error"))[:120])
        r2 = call({"action": "payment_set", "provider": "paytr", "environment": "sandbox", "keys": {"merchant_id": "000000", "merchant_key": "sahteanahtar", "merchant_salt": "sahtetuz"}})
        c.check("PayTR'ye token isteği gitti, sahte anahtar reddedildi", not r2.get("ok") and "PayTR" in str(r2.get("error")), str(r2.get("error"))[:120])
        page.screenshot(path=str(shots / "magaza_2_odeme.png"), full_page=True)

        # Kupon
        page.click(".tab[data-tab='coupons']")
        code = "TESTUI" + str(int(time.time()) % 10000)
        page.fill("#cpCode", code); page.select_option("#cpKind", "percent"); page.fill("#cpValue", "15")
        page.click("#cpAdd")
        page.wait_for_function("(c) => document.getElementById('cpRows').textContent.includes(c)", arg=code, timeout=20000)
        c.check("Kupon eklendi", True, code)

        # Alan adı
        page.click(".tab[data-tab='domain']")
        page.fill("#domIn", "seltigo-test-alanadi.com")
        page.click("#domAdd")
        page.wait_for_function("() => document.getElementById('domMsg').textContent", timeout=40000)
        page.wait_for_function("() => document.getElementById('domList').textContent.includes('www.seltigo-test-alanadi.com')", timeout=30000)
        dl = page.inner_text("#domList")
        c.check("Alan adı eklendi: kök yerine www, CNAME kaydı gösterildi", "www.seltigo-test-alanadi.com" in dl and "CNAME" in dl, page.inner_text("#domMsg")[:150])
        page.screenshot(path=str(shots / "magaza_3_alanadi.png"), full_page=True)
        dom = ev("async () => (await HS.db.from('store_domains').select('id').ilike('hostname', 'www.seltigo-test-alanadi.com').neq('status','removed').maybeSingle()).data")
        if dom: call({"action": "domain_remove", "id": dom["id"]})

        # SEO
        page.click(".tab[data-tab='seo']")
        page.fill("#seoT", "Test Atölyesi — el yapımı ürünler")
        page.fill("#seoD", "Seltigo test mağazası: el yapımı ürünler, hızlı kargo.")
        page.click("#seoSave")
        page.wait_for_function("() => /Kaydedildi|Saved/.test(document.getElementById('seoMsg').textContent)", timeout=20000)

        # 3) Vitrin (giriş yapmamış müşteri)
        cpage = b.new_page(viewport={"width": 1280, "height": 1000})
        cpage.on("pageerror", lambda e: errs.append("vitrin: " + str(e)))
        cpage.goto(f"{SITE}/magaza.html?slug={slug}")
        cpage.wait_for_selector("#spCartBtn", timeout=40000)
        bg = cpage.evaluate("() => getComputedStyle(document.documentElement).getPropertyValue('--bg-dark').trim()")
        c.check("Vitrinde tema uygulandı", bg.lower() == saved["colors"]["bg"].lower(), f"{bg} = {saved['colors']['bg']}")
        c.check("Duyuru bandı görünüyor", "500 TL üzeri" in cpage.inner_text(".sp-ann"))
        c.check("SEO başlığı ve açıklaması", cpage.title() == "Test Atölyesi — el yapımı ürünler" and "el yapımı" in (cpage.get_attribute("meta[name=description]", "content") or ""), cpage.title())
        ld = cpage.evaluate("() => JSON.parse(document.getElementById('sp-ld-store')?.textContent || '{}')")
        c.check("schema.org OnlineStore + ürün listesi", ld.get("@type") == "OnlineStore" and cpage.evaluate("() => !!document.getElementById('sp-ld-list')"))
        cpage.screenshot(path=str(shots / "magaza_4_vitrin.png"), full_page=True)
        # Müşteri hesabı: üye ol
        email = f"musteri{int(time.time())}@seltigo.test"
        cpage.click("#spAccBtn")
        cpage.click("[data-tab=register]")
        cpage.fill("#spAName", "Ayşe Deneme"); cpage.fill("#spAPhone", "05321112233"); cpage.fill("#spAEmail", email); cpage.fill("#spAPass", "parola12345")
        cpage.click("#spAGo")
        cpage.wait_for_function("() => /Merhaba|Hello/.test(document.getElementById('spAccBody').textContent)", timeout=30000)
        c.check("Müşteri üye oldu", True, email)
        cpage.click("#spAcc [data-close]")
        # Ürün sayfası
        cpage.goto(f"{SITE}/magaza.html?slug={slug}&p={PID}")
        cpage.wait_for_selector("#spPP.open #spPPAdd", timeout=40000)
        pld = cpage.evaluate("() => JSON.parse(document.getElementById('sp-ld-product')?.textContent || '{}')")
        c.check("Ürün sayfası (?p=) + Product JSON-LD (fiyat, stok)", pld.get("@type") == "Product" and pld.get("offers", {}).get("availability", "").endswith("InStock"), str(pld.get("offers"))[:150])
        cpage.screenshot(path=str(shots / "magaza_5_urun.png"), full_page=True)
        cpage.fill("#spPPQty", "2")
        cpage.click("#spPPAdd")
        cpage.wait_for_selector("#spCart.open #spPlace", timeout=30000)
        cpage.wait_for_function("() => !document.getElementById('spPlace').disabled", timeout=30000)
        cpage.check("input[name=spShip][value=hiz]")
        cpage.wait_for_function("() => document.querySelector('input[name=spShip][value=hiz]')?.checked && !document.getElementById('spPlace').disabled", timeout=30000)
        cpage.fill("#spCoupon", code); cpage.click("#spCouponBtn")
        cpage.wait_for_function("(c) => document.getElementById('spCartBody').textContent.includes('✓ ' + c)", arg=code, timeout=30000)
        cpage.wait_for_timeout(1500)
        txt = cpage.inner_text("#spCartBody")
        price = float(ev("async (i) => (await HS.db.from('listings').select('price').eq('product_id', i).eq('marketplace_code','own_store').is('deleted_at', null).single()).data.price", PID))
        want = round(round(price * 2 * 0.85, 2) + 99 + 15, 2)
        q = cpage.evaluate("async (a) => (await (await fetch(a[0] + 'store-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, body: JSON.stringify({ action: 'quote', store_slug: a[1], items: [{ product_id: a[2], qty: 2 }], coupon: a[3], shipping_option: 'hiz', payment_method: 'cod' }) })).json())", [FN, slug, PID, code])
        c.check("Sepet: kupon %15 + hızlı kargo 99 + kapıda 15 = sunucu toplamı", abs(q["total"] - want) < 0.02, f"{q['total']} = {want}")
        shown = cpage.inner_text("#spPlace")
        c.check("Sepet ekranındaki toplam sunucu toplamıyla aynı (indirim satırı görünüyor)", ("İndirim" in txt or "Discount" in txt) and f"{want:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") in shown, shown)
        cpage.screenshot(path=str(shots / "magaza_6_sepet.png"), full_page=True)
        cpage.fill("#spAddr", "Deneme Mah. Test Sok. No:5"); cpage.fill("#spCity", "İstanbul"); cpage.fill("#spDistrict", "Beşiktaş")
        cpage.check("#spTerms")
        cpage.click("#spPlace")
        cpage.wait_for_function("() => /Siparişini aldık|We received/.test(document.getElementById('spCartBody').textContent)", timeout=40000)
        track = cpage.get_attribute("#spCartBody a[href*='takip.html']", "href")
        c.check("Sipariş verildi, takip bağlantısı var", bool(track), track)
        cpage.screenshot(path=str(shots / "magaza_7_siparis.png"), full_page=True)
        stock1 = ev("async (i) => (await HS.db.from('products').select('stock_qty').eq('id', i).single()).data.stock_qty", PID)
        c.check("Ortak stok düştü (20 -> 18)", stock1 == 18, str(stock1))
        cpage.click("#spCart [data-close]")
        cpage.click("#spAccBtn")
        cpage.wait_for_function("() => /Siparişlerim|My orders/.test(document.getElementById('spAccBody').textContent) && document.querySelectorAll('#spAccBody .sp-line').length > 0", timeout=30000)
        c.check("Siparişlerim'de sipariş ve takip bağlantısı", "takip" in (cpage.inner_html("#spAccBody") or ""), cpage.inner_text("#spAccBody")[:120])
        cpage.screenshot(path=str(shots / "magaza_8_hesabim.png"), full_page=True)

        # 5) Site haritası
        with urllib.request.urlopen(FN + f"store-checkout?action=sitemap&slug={slug}", timeout=30) as r:
            sm = r.read().decode()
        c.check("Site haritası ürün adreslerini içeriyor", f"p={PID}" in sm and "<urlset" in sm)

        # Temizlik
        cos = ev("async (e) => (await HS.db.from('store_checkouts').select('id, order_ids').eq('email', e)).data", email)
        oids = [o for x in cos for o in (x["order_ids"] or [])]
        ev("async (ids) => await HS.db.from('store_orders').update({ status: 'cancelled' }).in('id', ids)", oids)
        time.sleep(1)
        ev("async (a) => await HS.db.from('marketplace_orders').update({ status: 'cancelled' }).in('source_id', a)", oids)
        stock2 = ev("async (i) => (await HS.db.from('products').select('stock_qty').eq('id', i).single()).data.stock_qty", PID)
        c.check("İptalde ortak stok geri geldi (18 -> 20)", stock2 == 20, str(stock2))
        ev("async (c) => await HS.db.from('store_coupons').delete().eq('code', c)", code)
        ev("async (a) => await HS.db.from('store_settings').update({ theme: a[1].theme, seo: a[1].seo, shipping_options: a[1].shipping_options, checkout: a[1].checkout }).eq('user_id', a[0])", [uid, orig])
        ev("async (a) => await HS.db.from('products').update({ stock_qty: a[1] }).eq('id', a[0])", [PID, stock0])
        c.check("Sayfalarda JavaScript hatası yok", not errs, str(errs)[:300])
        b.close()
    c.finish()


if __name__ == "__main__":
    main()
