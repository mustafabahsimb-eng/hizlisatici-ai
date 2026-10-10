"""Ürün Ekle: CJ ürününde kargo dahil maliyet ve zarar uyarısı.

Adımlar: giriş -> Ürün Ekle -> kanal "Kendi Mağazam" -> CJ'de ara -> ilk ürünü "Kullan"
-> kargo dahil maliyet görünür -> düşük fiyatta kırmızı zarar uyarısı + önerilen minimum
-> önerilen minimumun üstünde uyarı kaybolur. Ürün KAYDEDİLMEZ.
"""
import re
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks


def price_of(text):
    m = re.search(r"([\d.]+,\d{2})", text or "")
    return float(m.group(1).replace(".", "").replace(",", ".")) if m else None


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        login(page)
        page.goto(f"{SITE}/add-product.html")
        page.wait_for_selector("#platform")
        page.select_option("#platform", "Kendi Mağazam")
        c.check("Kanal listesinde 'Kendi Mağazam' seçilebiliyor", page.input_value("#platform") == "Kendi Mağazam")
        c.check("Kendi Mağazam'da bağlı değil uyarısı çıkmıyor", not page.is_visible("#platformWarn"))

        page.fill("#cjKeyword", "silicone phone case")
        page.click("#cjSearchBtn")
        page.wait_for_selector("#cjResults .cj-use-btn", timeout=60000)
        page.locator("#cjResults .cj-use-btn").first.click()

        page.wait_for_selector("#totalCostNote", state="visible", timeout=60000)
        total_text = page.inner_text("#totalCostNote")
        total = price_of(total_text)
        c.check("Kargo dahil toplam maliyet görünüyor", total and total > 0, total_text)
        fx_text = page.inner_text("#supplierFxNote") if page.is_visible("#supplierFxNote") else ""
        c.check("CJ dolar fiyatı TL'ye çevrilmiş", "$" in fx_text and "₺" in fx_text, fx_text)

        page.fill("#salePrice", "1")
        page.wait_for_selector("#lossWarn", state="visible", timeout=15000)
        warn = page.inner_text("#lossWarn")
        c.check("Düşük fiyatta zarar uyarısı çıkıyor", "zarar edersin" in warn, warn)
        color = page.eval_on_selector("#lossWarn", "el => getComputedStyle(el).color")
        c.check("Uyarı kırmızı", color.replace(" ", "") == "rgb(242,139,139)", color)
        min_price = price_of(warn.split("minimum fiyat:")[-1]) if "minimum fiyat:" in warn else None
        c.check("Önerilen minimum fiyat yazıyor", min_price and min_price >= total, f"{min_price}")
        page.screenshot(path=str(shots / "urun_ekle_zarar_var.png"), full_page=True)

        page.fill("#salePrice", str(round((min_price or total) + 50, 2)))
        page.wait_for_timeout(2500)
        c.check("Minimumun üstünde uyarı kayboluyor", not page.is_visible("#lossWarn"))
        page.screenshot(path=str(shots / "urun_ekle_zarar_yok.png"), full_page=True)

        c.check("Sayfada JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
