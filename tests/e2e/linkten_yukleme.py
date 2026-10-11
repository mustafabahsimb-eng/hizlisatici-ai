"""Linkten ürün yükleme: varyantlı ürün + "Fiyat ve stoğu otomatik güncel tut".

Adımlar: giriş -> Toplu Ürün Yükleme -> WooCommerce demo ürün linki -> "Ürünleri Çek"
-> önizlemede "{n} seçenek" -> onay + "Fiyat ve stoğu otomatik güncel tut" (6 saatte bir) -> aktar
-> veritabanında: kaynak platform/numara, takip açık, seçenekler (beden/renk) kaydedilmiş.
Kaydedilen ürün test kullanıcısınındır; çıktı "URUN_ID=<id>" (temizlik için).
"""
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

URL = "https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/"


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)
        page.goto(f"{SITE}/toplu-yukleme.html")
        page.wait_for_selector("#srcUrl")
        page.fill("#srcUrl", URL)
        page.click("#fetchBtn")
        page.wait_for_selector("#previewBox .pname", timeout=120000)
        row = page.locator("#previewBox tbody tr").first.inner_text()
        c.check("Önizlemede ürün ve seçenek sayısı görünüyor", "seçenek" in row, row.replace("\n", " ")[:160])

        # ✨ Metni kanala göre yaz (Trendyol kuralları: Türkçe, emojisiz, en fazla 100 karakter)
        old_name = page.inner_text("#previewBox .pname")
        c.check("'✨ Metni kanala göre yaz' düğmesi görünüyor", page.inner_text("#copyBtn") == "✨ Metni kanala göre yaz")
        page.select_option("#copyChannel", "trendyol")
        page.click("#copyBtn")
        page.wait_for_function("() => { const b = document.getElementById('copyBtn'); return b && b.textContent.startsWith('✨'); }", timeout=120000)
        new_name = page.inner_text("#previewBox .pname")
        import re
        c.check("Başlık Trendyol'a göre yeniden yazıldı", new_name != old_name and len(new_name) <= 100
                and not re.search(r"[\U0001F300-\U0001FAFF]", new_name), f"{old_name} → {new_name}")
        page.screenshot(path=str(shots / "linkten_yukleme_metin.png"))

        c.check("'Fiyat ve stoğu otomatik güncel tut' görünüyor ve seçili",
                page.is_visible("#syncChk") and page.is_checked("#syncChk"), page.inner_text("label:has(#syncChk)"))
        page.select_option("#syncHours", "6")
        opts = page.locator("#syncHours option").all_inner_texts()
        c.check("Aralık seçenekleri '6 saatte bir' / 'Günde bir'", opts == ["6 saatte bir", "Günde bir"], str(opts))

        before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        page.check("#consentChk")
        page.click("#importBtn")
        page.wait_for_selector("#resultBox.ok, #resultBox.err", timeout=120000)
        c.check("Aktarım başarılı", "ok" in (page.get_attribute("#resultBox", "class") or ""), page.inner_text("#resultBox")[:160])
        page.screenshot(path=str(shots / "linkten_yukleme.png"))

        prod = page.evaluate("""async (before) => {
            const r = await HS.db.from('products').select('id, source_platform, source_item_id, source_sync, source_sync_hours, cost_currency').gt('id', before).order('id', {ascending:false}).limit(1);
            const p = r.data && r.data[0];
            if (!p) return null;
            const v = await HS.db.from('product_variants').select('attributes, cost, supplier_variant_id').eq('product_id', p.id).eq('is_default', false);
            p.variants = v.data || [];
            return p;
        }""", before)
        if prod:
            print(f"URUN_ID={prod['id']}")
        c.check("Kaynak platform ve numarası kaydedildi", bool(prod) and prod["source_platform"] == "woocommerce" and bool(prod["source_item_id"]), str(prod)[:200])
        c.check("Otomatik takip açık, 6 saatte bir", bool(prod) and prod["source_sync"] is True and prod["source_sync_hours"] == 6)
        nv = len(prod["variants"]) if prod else 0
        c.check("Seçenekler kaydedildi (beden/renk)", nv >= 2 and all(v["attributes"] and v["supplier_variant_id"] for v in prod["variants"]),
                f"{nv} seçenek, ör. {prod['variants'][0] if nv else '-'}")
        c.check("Sayfada JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
