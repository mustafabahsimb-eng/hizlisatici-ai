"""Ürün düzenleme sayfası ("✏️ Ürünü düzenle").

Hazırlık: test kullanıcısı WooCommerce demo ayakkabısını (seçenekli, görselli) mağazasına ekler.
1) Panelde ürün kartında "✏️ Ürünü düzenle" -> sayfa açılır; ad, açıklama, fiyat, stok, kaynak ("Kendi stoğum"),
   seçenekler ve görseller ("Görsel kaynağı: ...") görünür.
2) Değiştir + Kaydet: ad, fiyat, stok, kaynak -> Toptancı, bir seçeneğin stoğu 0 ve satışta değil, yeni seçenek,
   bir görsel silinir, ilk görsel "Kendi fotoğrafımla değiştir" (arka plan temizlenir, 1 remove.bg kredisi).
3) Sayfa yenilenince her şey kalıcı; Kendi Mağazam ilanı ve vitrin yeni ad/fiyatı gösterir.
4) Kaynak AliExpress: hatalı linkte kaydetmez; doğru linkte ürün numarası kaydedilir.
Test ürünü sonunda kaldırılır.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks
import katalog_dosyalari as K

SLUG = "e2e-test-magaza"
WOO = "https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/"


def main():
    shots = shots_dir()
    fx = Path(shots) / "duzenle"
    K.main.__globals__["sys"].argv = ["x", str(fx)]
    K.main()
    c = Checks()
    pid = None
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())
        login(page)
        try:
            # Hazırlık
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
            pid = page.evaluate("async (b) => (await HS.db.from('products').select('id').gt('id', b).order('id', {ascending:false}).limit(1)).data?.[0]?.id", before)

            # 1) Panel -> düzenle
            page.goto(f"{SITE}/dashboard.html")
            row = page.locator(f".product-row[data-id='{pid}']")
            row.wait_for(timeout=60000)
            btn = row.get_by_text("✏️ Ürünü düzenle")
            c.check("Ürün kartında '✏️ Ürünü düzenle' düğmesi", btn.count() == 1)
            btn.click()
            page.wait_for_selector("#fName", timeout=30000)
            c.check("Düzenleme sayfası açıldı", f"urun-duzenle.html?id={pid}" in page.url and page.inner_text("h1") == "✏️ Ürünü düzenle")
            src_opts = page.locator("#fSource option").all_inner_texts()
            c.check("Kaynak seçenekleri: Kendi stoğum / Toptancı / AliExpress / CJ", src_opts == ["Kendi stoğum", "Toptancı", "AliExpress", "CJ"], str(src_opts))
            c.check("Kaynak 'Kendi stoğum'", page.eval_on_selector("#fSource", "e => e.options[e.selectedIndex].text") == "Kendi stoğum")
            nvar = page.locator("table.var tbody tr").count()
            c.check("Seçenekler listeleniyor", nvar == 20, f"{nvar} seçenek")
            nimg = page.locator(".img-card").count()
            c.check("Görseller ve kaynakları görünüyor", nimg >= 2 and "Görsel kaynağı: demos.flatsome.com" in page.inner_text(".imgs"), f"{nimg} görsel")
            page.screenshot(path=str(shots / "urun_duzenle_once.png"), full_page=True)

            # 2) Değiştir
            page.fill("#fName", "E2E Düzenlenmiş Ayakkabı")
            page.fill("#fDesc", "Düzenleme testi açıklaması.")
            page.fill("#fPrice", "1234.5")
            page.fill("#fStock", "7")
            page.select_option("#fSource", "wholesaler")
            page.locator("[data-vs='0']").fill("0")
            page.locator("[data-va='1']").uncheck()
            page.get_by_text("+ Seçenek ekle").click()
            last = page.locator("table.var tbody tr").last
            ins = last.locator("input[type=text]")
            ins.nth(0).fill("99")
            ins.nth(1).fill("siyah")
            page.locator(".img-card").nth(1).locator(".del-btn").click()
            with page.expect_file_chooser() as fc:
                page.locator(".img-card").first.get_by_text("Kendi fotoğrafımla değiştir").click()
            fc.value.set_files(str(fx / "ekran.png"))
            page.wait_for_function("() => document.querySelector('.img-card .img-src') && document.querySelector('.img-card .img-src').textContent.includes('kendi fotoğrafın')", timeout=120000)
            page.click("#saveBtn")
            page.wait_for_function("() => document.getElementById('saveMsg').textContent.includes('Kaydedildi')", timeout=60000)

            # 3) Kalıcılık
            page.reload()
            page.wait_for_selector("#fName")
            c.check("Ad, fiyat, stok kaydedildi", page.input_value("#fName") == "E2E Düzenlenmiş Ayakkabı"
                    and abs(float(page.input_value("#fPrice")) - 1234.5) < 0.001 and page.input_value("#fStock") == "7")
            c.check("Kaynak 'Toptancı' kaydedildi", page.eval_on_selector("#fSource", "e => e.options[e.selectedIndex].text") == "Toptancı")
            c.check("Yeni seçenek eklendi, sayılar doğru", page.locator("table.var tbody tr").count() == nvar + 1)
            c.check("Seçenek stoğu / satış durumu kaydedildi", page.input_value("[data-vs='0']") == "0" and not page.is_checked("[data-va='1']"))
            c.check("Görsel silindi ve ilk görsel kendi fotoğrafı", page.locator(".img-card").count() == nimg - 1
                    and "kendi fotoğrafın" in page.locator(".img-card").first.inner_text())
            db = page.evaluate("""async (pid) => {
                const p = (await HS.db.from('products').select('supplier, image_url, stock_status').eq('id', pid).single()).data;
                const l = (await HS.db.from('listings').select('title, price').eq('product_id', pid).eq('marketplace_code', 'own_store').single()).data;
                return { p, l }; }""", pid)
            c.check("Mağaza ilanı güncellendi", db["l"]["title"] == "E2E Düzenlenmiş Ayakkabı" and abs(float(db["l"]["price"]) - 1234.5) < 0.001, str(db)[:200])
            c.check("Ürün kaynağı veritabanında 'wholesaler'", db["p"]["supplier"] == "wholesaler")
            store = browser.new_page()
            store.goto(f"{SITE}/magaza.html?slug={SLUG}")
            store.wait_for_selector(".card", timeout=60000)
            card = store.locator(".card").filter(has_text="E2E Düzenlenmiş Ayakkabı")
            c.check("Vitrinde yeni ad ve fiyat", card.count() == 1 and "1.234,50" in card.first.inner_text(), card.first.inner_text()[:120] if card.count() else "-")
            page.screenshot(path=str(shots / "urun_duzenle_sonra.png"), full_page=True)

            # 4) Kaynak AliExpress
            page.select_option("#fSource", "aliexpress")
            page.fill("#fSrcLink", "https://www.aliexpress.com/store/123")
            page.click("#saveBtn")
            page.wait_for_timeout(1500)
            c.check("Hatalı AliExpress linkinde kaydedilmiyor", "okunamadı" in page.inner_text("#toast"))
            page.fill("#fSrcLink", "https://www.aliexpress.com/item/1005005993561880.html")
            page.click("#saveBtn")
            page.wait_for_function("() => document.getElementById('saveMsg').textContent.includes('Kaydedildi')", timeout=60000)
            sup = page.evaluate("async (pid) => (await HS.db.from('products').select('supplier, supplier_item_id').eq('id', pid).single()).data", pid)
            c.check("AliExpress kaynağı ve ürün numarası kaydedildi", sup == {"supplier": "aliexpress", "supplier_item_id": "1005005993561880"}, str(sup))
        finally:
            if pid:
                page.evaluate("async (pid) => HS.db.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', pid)", pid)
        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
