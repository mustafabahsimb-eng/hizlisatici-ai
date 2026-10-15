"""Kargo: satıcının kendi Yurtiçi hesabıyla otomatik gönderi (Yurtiçi TEST ortamı; gerçek gönderi oluşmaz).

1) Test kullanıcısı Yurtiçi test hesabını bağlar (YKTEST; bilgiler şifreli kasaya) -> varsayılan kargo hesabı
2) WooCommerce demo ürünü "Kendi stoğum" olarak mağazaya eklenir, vitrinden sipariş verilir
3) Sipariş gelince gönderi kuyruğa otomatik girer; gönderi Yurtiçi test ortamında oluşturulur
4) Etiket PDF'i (barkodlu) indirilebilir; sipariş ve müşteri takip sayfasında kargo firması görünür; takip sorgusu çalışır
5) AliExpress kaynaklı üründe kargo işi AÇILMAZ (tedarikçi gönderir)
Sonunda test kayıtları temizlenir.
"""
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

SLUG = "e2e-test-magaza"
WOO = "https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/"


def main():
    shots = shots_dir()
    c = Checks()
    pid = None
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)
        call = """async (payload) => {
            const res = await fetch(HS.SUPABASE_URL + '/functions/v1/shipping-hub', { method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY },
              body: JSON.stringify(payload) });
            return { status: res.status, body: await res.json().catch(() => null) }; }"""
        try:
            page.goto(f"{SITE}/dashboard.html")
            page.wait_for_function("() => window.HS && HS.db", timeout=30000)
            # 1) Yanlış şifre reddedilir, doğru test hesabı bağlanır
            bad = page.evaluate(call, {"action": "connect", "provider": "yurtici", "mode": "test", "credentials": {"wsUserName": "YKTEST", "wsPassword": "yanlis"}})
            c.check("Yanlış Yurtiçi şifresi reddedildi", bad["body"] and bad["body"].get("ok") is False, str(bad["body"])[:160])
            r = page.evaluate(call, {"action": "connect", "provider": "yurtici", "mode": "test",
                                     "credentials": {"wsUserName": "YKTEST", "wsPassword": "YK"},
                                     "settings": {"sender": {"name": "E2E Test Mağaza", "phone": "05550000000", "address": "Test Mah. Depo Sok. No 2", "city": "İstanbul", "district": "Kadıköy"}}})
            c.check("Yurtiçi test hesabı bağlandı (varsayılan)", r["body"] and r["body"].get("ok") is True, str(r["body"])[:160])
            acc = page.evaluate("async () => (await HS.db.from('shipping_accounts').select('provider, mode, is_default, status, credentials_secret_id').eq('provider','yurtici').maybeSingle()).data")
            c.check("Hesap kayıtlı, bilgiler kasada (tarayıcıda şifre yok)", bool(acc) and acc["is_default"] and acc["credentials_secret_id"] and "wsPassword" not in str(acc), str(acc)[:160])

            # 2) Kendi stoğum ürünü + vitrin siparişi
            page.goto(f"{SITE}/toplu-yukleme.html")
            page.wait_for_selector("#srcUrl")
            page.fill("#srcUrl", WOO)
            page.click("#fetchBtn")
            page.wait_for_selector("#previewBox .pname", timeout=120000)
            page.check("#consentChk")
            if page.is_visible("#imageTermsRow"):
                page.check("#imageTermsChk")
            before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
            page.click("#importBtn")
            page.wait_for_selector("#resultBox.ok", timeout=120000)
            prod = page.evaluate("async (b) => (await HS.db.from('products').select('id, name, generated_title').gt('id', b).order('id', {ascending:false}).limit(1)).data?.[0]", before)
            pid = prod["id"]
            store = browser.new_page()
            store.goto(f"{SITE}/magaza.html?slug={SLUG}")
            store.wait_for_selector(".card", timeout=60000)
            store.locator(".card").filter(has_text=(prod["generated_title"] or prod["name"])[:20]).first.locator(".buy-btn").click()
            store.wait_for_selector("#orderModalOverlay.open")
            for sel in store.locator("#variantFields select").all():
                opts = [o for o in sel.locator("option").all() if o.get_attribute("value") and o.get_attribute("disabled") is None]
                sel.select_option(opts[0].get_attribute("value"))
            store.fill("#orderName", "E2E Alıcı")
            store.fill("#orderPhone", "05551112233")
            store.fill("#orderAddress", "Caferağa Mah. Test Sok. No 5")
            store.fill("#orderCity", "İstanbul")
            store.fill("#orderDistrict", "Kadıköy")
            store.wait_for_selector("#preinfoBox", state="visible", timeout=15000)
            store.check("#orderPreinfo")
            store.click("#orderSubmitBtn")
            store.wait_for_selector("#orderDone", state="visible", timeout=30000)
            track_href = store.get_attribute("#orderTrackLink", "href")
            so = page.evaluate("async (pid) => (await HS.db.from('store_orders').select('id').eq('product_id', pid).order('created_at', {ascending:false}).limit(1)).data[0]", pid)
            sh = page.evaluate("async (id) => (await HS.db.from('shipments').select('id, status, provider, test').eq('store_order_id', id).maybeSingle()).data", so["id"])
            c.check("Sipariş gelince gönderi kuyruğa otomatik girdi", bool(sh) and sh["provider"] == "yurtici" and sh["test"] is True, str(sh))

            # 3) Gönderiyi oluştur (görev 10 dk'da bir de yapar; testte hemen)
            # Yurtiçi test sunucusu zaman zaman geç yanıt veriyor; canlıda kuyruk tekrar dener, testte de 3 deneme
            for attempt in range(3):
                r = page.evaluate(call, {"action": "create", "storeOrderId": so["id"]})
                res = (r["body"] or {}).get("result") or {}
                if res.get("created"):
                    break
                print("   deneme", attempt + 1, str(res.get("error"))[:100])
                page.evaluate("async (id) => HS.db.from('shipments').select('id').eq('store_order_id', id)", so["id"])
                page.wait_for_timeout(15000)
            c.check("Gönderi Yurtiçi test ortamında oluşturuldu", res.get("created") is True and str(res.get("ref", "")).startswith("SLT"), str(r["body"])[:200])
            sh = page.evaluate("async (id) => (await HS.db.from('shipments').select('*').eq('store_order_id', id).maybeSingle()).data", so["id"])
            c.check("Gönderi kaydı: durum, firma, etiket", sh["status"] == "created" and sh["carrier"] == "Yurtiçi Kargo" and bool(sh["label_path"]), f"{sh['status']} {sh['carrier']} {sh['label_path']}")

            # 4) Etiket PDF'i
            lbl = page.evaluate(call, {"action": "label", "shipmentId": sh["id"]})
            url = (lbl["body"] or {}).get("url")
            head = page.evaluate("async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return String.fromCharCode(...b.slice(0, 5)) + '|' + b.length; }", url) if url else ""
            c.check("Etiket PDF'i indirilebiliyor", head.startswith("%PDF-"), head)
            pdf_page = browser.new_page()
            pdf_bytes = pdf_page.request.get(url).body() if url else b""
            (shots / "kargo_etiket.pdf").write_bytes(pdf_bytes)

            so2 = page.evaluate("async (id) => (await HS.db.from('store_orders').select('tracking_carrier').eq('id', id).single()).data", so["id"])
            c.check("Siparişe kargo firması işlendi", so2["tracking_carrier"] == "Yurtiçi Kargo", str(so2))
            tp = browser.new_page()
            tp.goto(f"{SITE}/{track_href}")
            tp.wait_for_timeout(4000)
            c.check("Müşteri takip sayfasında kargo firması", "Yurtiçi" in tp.inner_text("body"), tp.inner_text("body")[:200].replace("\n", " "))
            tp.screenshot(path=str(shots / "kargo_takip.png"))

            # 5) AliExpress kaynaklı üründe kargo işi açılmaz
            page.evaluate("async (pid) => HS.db.from('products').update({ supplier: 'aliexpress', supplier_item_id: '1005005993561880' }).eq('id', pid)", pid)
            store.goto(f"{SITE}/magaza.html?slug={SLUG}")
            store.wait_for_selector(".card", timeout=60000)
            store.locator(".card").filter(has_text=(prod["generated_title"] or prod["name"])[:20]).first.locator(".buy-btn").click()
            store.wait_for_selector("#orderModalOverlay.open")
            for sel in store.locator("#variantFields select").all():
                opts = [o for o in sel.locator("option").all() if o.get_attribute("value") and o.get_attribute("disabled") is None]
                sel.select_option(opts[0].get_attribute("value"))
            store.fill("#orderName", "E2E Alıcı")
            store.fill("#orderPhone", "05551112233")
            store.fill("#orderAddress", "Caferağa Mah. Test Sok. No 5")
            store.fill("#orderCity", "İstanbul")
            store.fill("#orderDistrict", "Kadıköy")
            store.wait_for_selector("#preinfoBox", state="visible", timeout=15000)
            store.check("#orderPreinfo")
            store.click("#orderSubmitBtn")
            store.wait_for_selector("#orderDone", state="visible", timeout=30000)
            n = page.evaluate("""async (pid) => { const so = (await HS.db.from('store_orders').select('id').eq('product_id', pid).order('created_at', {ascending:false}).limit(1)).data[0];
                return (await HS.db.from('shipments').select('id', { count: 'exact', head: true }).eq('store_order_id', so.id)).count; }""", pid)
            c.check("AliExpress kaynaklı üründe kargo işi açılmadı (tedarikçi gönderir)", n == 0, str(n))
        finally:
            if pid:
                page.evaluate("""async (pid) => {
                    await HS.db.from('orders').update({ status: 'iptal' }).eq('product_id', pid);
                    await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', pid); }""", pid)
        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
