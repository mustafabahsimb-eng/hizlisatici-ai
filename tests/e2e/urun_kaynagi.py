"""Ürün kaynağı kuralı: yalnız AliExpress / CJ kaynaklı ürünlerin siparişi tedarikçiye gider.

1) WooCommerce linki -> kaynak sorusu çıkmaz, "Kendi stoğum" (supplier boş); vitrinden sipariş -> tedarikçi siparişi YOK
2) AliExpress linki -> "AliExpress ürünleri için kaynak" sorusu çıkar, seçmeden eklenemez;
   "Kendi stoğum" seçilir -> supplier boş; sipariş -> tedarikçi siparişi YOK
3) AliExpress linki, "AliExpress" seçilir -> supplier aliexpress; sipariş -> tedarikçi siparişi VAR
4) Kaynağı "Toptancı" (wholesaler) olan ürün -> sipariş -> tedarikçi siparişi YOK
Para harcanmaz (test kullanıcısının AliExpress hesabı bağlı değil). Test kayıtları sonunda temizlenir.
"""
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

SLUG = "e2e-test-magaza"
WOO = "https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/"
AE = "https://www.aliexpress.com/item/1005005993561880.html"


def fetch_preview(page, url):
    page.goto(f"{SITE}/toplu-yukleme.html")
    page.wait_for_selector("#srcUrl")
    page.fill("#srcUrl", url)
    page.click("#fetchBtn")
    page.wait_for_selector("#previewBox .pname", timeout=120000)
    page.check("#consentChk")
    if page.is_visible("#imageTermsRow"):
        page.check("#imageTermsChk")


def do_import(page):
    before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
    page.click("#importBtn")
    page.wait_for_selector("#resultBox.ok, #resultBox.err", timeout=120000)
    return page.evaluate("""async (before) => (await HS.db.from('products').select('id, name, generated_title, supplier')
        .gt('id', before).order('id', {ascending:false}).limit(1)).data?.[0]""", before)


def order_and_count(store, page, prod):
    store.goto(f"{SITE}/magaza.html?slug={SLUG}")
    store.wait_for_selector(".card", timeout=60000)
    card = store.locator(".card").filter(has_text=(prod["generated_title"] or prod["name"])[:20]).first
    card.locator(".buy-btn").click()
    store.wait_for_selector("#orderModalOverlay.open")
    for sel in store.locator("#variantFields select").all():
        opts = [o for o in sel.locator("option").all() if o.get_attribute("value") and o.get_attribute("disabled") is None]
        sel.select_option(opts[0].get_attribute("value"))
    store.fill("#orderName", "E2E Test")
    store.fill("#orderPhone", "05550000000")
    store.fill("#orderAddress", "Test Mah. Deneme Sok. No 1")
    store.fill("#orderCity", "Istanbul")
    store.fill("#orderDistrict", "Kadikoy")
    store.wait_for_selector("#preinfoBox", state="visible", timeout=15000)
    store.check("#orderPreinfo")
    store.click("#orderSubmitBtn")
    store.wait_for_selector("#orderDone", state="visible", timeout=30000)
    return page.evaluate("""async (pid) => ({
        store: (await HS.db.from('store_orders').select('id', { count: 'exact', head: true }).eq('product_id', pid)).count,
        supplier: (await HS.db.from('orders').select('id', { count: 'exact', head: true }).eq('product_id', pid)).count })""", prod["id"])


def main():
    shots = shots_dir()
    c = Checks()
    made = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        store = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        store.on("pageerror", lambda e: errors.append(str(e)))
        login(page)
        try:
            # 1) WooCommerce linki
            fetch_preview(page, WOO)
            c.check("Woo linki: kaynak sorusu çıkmıyor", not page.is_visible("#aeSourceRow"))
            woo = do_import(page)
            made.append(woo["id"])
            c.check("Woo linki: kaynak 'Kendi stoğum' (supplier boş)", woo["supplier"] is None, str(woo["supplier"]))
            n = order_and_count(store, page, woo)
            c.check("Kendi stoğum ürününde tedarikçi siparişi oluşmadı", n["store"] >= 1 and n["supplier"] == 0, str(n))

            # 2) AliExpress linki -> Kendi stoğum
            fetch_preview(page, AE)
            c.check("AliExpress linki: kaynak sorusu çıkıyor", page.is_visible("#aeSourceRow"), page.inner_text("#aeSourceRow")[:120])
            opts = page.locator("#aeSourceRow label").all_inner_texts()
            c.check("Seçenekler 'AliExpress' / 'Kendi stoğum'", [o.strip() for o in opts] == ["AliExpress", "Kendi stoğum"], str(opts))
            c.check("Kaynak seçilmeden eklenemiyor", page.is_disabled("#importBtn"))
            page.check("input[name=aeSrc][value=own]")
            ae_own = do_import(page)
            made.append(ae_own["id"])
            c.check("AliExpress + 'Kendi stoğum': supplier boş", ae_own["supplier"] is None, str(ae_own["supplier"]))
            n = order_and_count(store, page, ae_own)
            c.check("AliExpress + 'Kendi stoğum': tedarikçi siparişi oluşmadı", n["store"] >= 1 and n["supplier"] == 0, str(n))
            page.evaluate("async (id) => HS.db.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', id)", ae_own["id"])

            # 3) AliExpress linki -> AliExpress
            fetch_preview(page, AE)
            page.check("input[name=aeSrc][value=aliexpress]")
            ae = do_import(page)
            made.append(ae["id"])
            c.check("AliExpress + 'AliExpress': supplier aliexpress", ae["supplier"] == "aliexpress", str(ae["supplier"]))
            n = order_and_count(store, page, ae)
            c.check("AliExpress kaynaklı üründe tedarikçi siparişi oluştu", n["supplier"] == 1, str(n))

            # 4) Toptancı
            page.evaluate("async (id) => HS.db.from('products').update({ supplier: 'wholesaler' }).eq('id', id)", woo["id"])
            before = page.evaluate("async (id) => (await HS.db.from('orders').select('id', { count: 'exact', head: true }).eq('product_id', id)).count", woo["id"])
            n = order_and_count(store, page, woo)
            c.check("Toptancı kaynaklı üründe tedarikçi siparişi oluşmadı", n["supplier"] == before == 0, str(n))
        finally:
            # Temizlik: test ürünleri kaldırılır, tedarikçi siparişleri iptal edilir
            page.evaluate("""async (ids) => {
                if (!ids.length) return;
                await HS.db.from('orders').update({ status: 'iptal' }).in('product_id', ids);
                await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids);
            }""", made)
        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
