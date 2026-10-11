"""Mağaza vitrininde seçenek (beden/renk) seçimi ve siparişe aktarımı.

1) Test kullanıcısı Toplu Ürün Yükleme ile iki seçenekli ürün ekler (kendi mağazasında yayında):
   WooCommerce demo ayakkabı (beden + renk) ve AliExpress ürünü (tedarikçili; sipariş AliExpress/CJ'ye gider).
2) Vitrin (giriş yok): kartta seçenek özeti, sipariş penceresinde seçenek kutuları; seçmeden gönderilemez.
3) Seçip sipariş verilir -> store_orders'da seçenek + etiket + fiyat; AliExpress ürününde tedarikçi
   siparişine (orders) seçenek ve etiket geçer, seçenek AliExpress SKU numarasını taşır.
4) Vitrin yanıtında alış fiyatı / tedarikçi bilgisi yok.
Para harcanmaz: test kullanıcısının AliExpress/CJ hesabı bağlı değil, tedarikçi siparişi verilmez.
Çıktı: URUN_ID=... ve SIPARIS_ID=... (temizlik için).
"""
import json
TR = {"size": "Beden", "color": "Renk", "colour": "Renk", "material": "Malzeme", "style": "Model"}
label = lambda d: " · ".join(f"{TR.get(k.lower(), k)}: {v}" for k, v in d.items())
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

SLUG = "e2e-test-magaza"
WOO = "https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/"
AE = "https://www.aliexpress.com/item/1005005993561880.html"


def import_link(page, url):
    page.goto(f"{SITE}/toplu-yukleme.html")
    page.wait_for_selector("#srcUrl")
    page.fill("#srcUrl", url)
    page.click("#fetchBtn")
    page.wait_for_selector("#previewBox .pname", timeout=120000)
    before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
    page.check("#consentChk")
    page.click("#importBtn")
    page.wait_for_selector("#resultBox.ok, #resultBox.err", timeout=120000)
    return page.evaluate("""async (before) => {
        const r = await HS.db.from('products').select('id, name, generated_title, supplier, supplier_item_id').gt('id', before).order('id', {ascending:false}).limit(1);
        return r.data && r.data[0];
    }""", before)


def order(store, title_part, fill_variant=True):
    store.goto(f"{SITE}/magaza.html?slug={SLUG}")
    store.wait_for_selector(".card", timeout=60000)
    card = store.locator(".card").filter(has_text=title_part).first
    summary = card.locator(".card-options").inner_text() if card.locator(".card-options").count() else ""
    card.locator(".buy-btn").click()
    store.wait_for_selector("#orderModalOverlay.open")
    labels = store.locator("#variantFields label").all_inner_texts()
    chosen = {}
    if fill_variant:
        for sel in store.locator("#variantFields select").all():
            opts = [o for o in sel.locator("option").all() if o.get_attribute("value") and o.get_attribute("disabled") is None]
            val = opts[-1].get_attribute("value")
            sel.select_option(val)
            chosen[sel.get_attribute("data-key")] = val
    store.fill("#orderName", "E2E Test")
    store.fill("#orderPhone", "05550000000")
    store.fill("#orderAddress", "Test Mah. Deneme Sok. No 1")
    store.fill("#orderCity", "Istanbul")
    store.fill("#orderDistrict", "Kadikoy")
    return summary, labels, chosen


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)

        woo = import_link(page, WOO)
        ae = import_link(page, AE)
        print(f"URUN_ID={woo and woo['id']},{ae and ae['id']}")
        c.check("AliExpress ürünü tedarikçili kaydedildi", bool(ae) and ae["supplier"] == "aliexpress" and bool(ae["supplier_item_id"]), str(ae)[:160])

        store = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        store.on("pageerror", lambda e: errors.append(str(e)))

        # Vitrin yanıtında gizli alan yok
        raw = store.evaluate("""async (slug) => {
            const r = await fetch('https://ytucdrrgxsjhrqmaxckt.supabase.co/functions/v1/get-store?slug=' + slug);
            return await r.text(); }""", SLUG)
        c.check("Vitrin yanıtında alış fiyatı / tedarikçi bilgisi yok",
                all(k not in raw for k in ['"supplier_price"', '"supplier_cost"', '"supplier_item_id"', '"business_tax_number"', '"user_id"']))

        # 1) Seçmeden gönderilemez
        title_woo = (woo["generated_title"] or woo["name"])[:20]
        summary, labels, _ = order(store, title_woo, fill_variant=False)
        c.check("Kartta seçenek özeti var", "Beden" in summary, summary)
        c.check("Sipariş penceresinde 'Beden' ve 'Renk' kutuları", labels == ["Beden", "Renk"], str(labels))
        store.click("#orderSubmitBtn")
        store.wait_for_timeout(1500)
        c.check("Seçenek seçmeden sipariş gönderilmiyor", store.is_visible("#orderForm"))
        store.screenshot(path=str(shots / "vitrin_secenek_secilmedi.png"))

        # 2) Seçip gönder (WooCommerce ürünü)
        summary, labels, chosen = order(store, title_woo)
        store.screenshot(path=str(shots / "vitrin_secenek_secildi.png"))
        store.click("#orderSubmitBtn")
        store.wait_for_selector("#orderDone", state="visible", timeout=30000)
        so = page.evaluate("""async (pid) => {
            const r = await HS.db.from('store_orders').select('id, variant_id, variant_label, unit_price').eq('product_id', pid).order('created_at', {ascending:false}).limit(1);
            return r.data && r.data[0]; }""", woo["id"])
        print(f"SIPARIS_ID={so and so['id']}")
        want = label(chosen)
        c.check("Mağaza siparişinde seçilen seçenek", bool(so) and so["variant_id"] and so["variant_label"] == want, f"{so and so['variant_label']} (beklenen {want})")
        c.check("Seçenek fiyatı sunucuda hesaplandı", bool(so) and float(so["unit_price"] or 0) > 0, str(so and so["unit_price"]))

        # 3) AliExpress ürünü: tedarikçi siparişine seçenek geçer
        title_ae = (ae["generated_title"] or ae["name"])[:20]
        summary, labels, chosen = order(store, title_ae)
        store.click("#orderSubmitBtn")
        store.wait_for_selector("#orderDone", state="visible", timeout=30000)
        o = page.evaluate("""async (pid) => {
            const r = await HS.db.from('orders').select('id, variant_id, variant_label, supplier').eq('product_id', pid).order('created_at', {ascending:false}).limit(1);
            const o = r.data && r.data[0];
            if (o && o.variant_id) {
              const v = await HS.db.from('product_variants').select('supplier_variant_id, supplier_sku').eq('id', o.variant_id).maybeSingle();
              o.v = v.data;
            }
            return o; }""", ae["id"])
        print(f"SIPARIS_ID={o and o['id']}")
        want = label(chosen)
        c.check("Tedarikçi siparişine seçenek geçti", bool(o) and o["supplier"] == "aliexpress" and o["variant_label"] == want, json.dumps(o, ensure_ascii=False)[:220])
        c.check("Seçenek AliExpress SKU numarasını taşıyor", bool(o) and bool((o.get("v") or {}).get("supplier_variant_id")), str(o and o.get("v")))

        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
