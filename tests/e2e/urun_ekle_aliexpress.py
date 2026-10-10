"""Ürün Ekle: AliExpress ürününde Türkiye'ye gönderilebilir arama, kargo dahil maliyet, zarar uyarısı.

Adımlar: giriş -> Ürün Ekle -> kanal "Kendi Mağazam" -> AliExpress'te ara -> ilk ürünü "Kullan"
-> AliExpress fiyatı TL'ye çevrilmiş, kargo dahil toplam maliyet görünür -> düşük fiyatta zarar
uyarısı -> minimumun üstünde kaybolur. Ürün KAYDEDİLMEZ.
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
        requests = []
        page.on("request", lambda r: requests.append(r.post_data or "") if "aliexpress-search" in r.url else None)

        login(page)
        page.goto(f"{SITE}/add-product.html")
        page.wait_for_selector("#platform")
        page.select_option("#platform", "Kendi Mağazam")

        page.fill("#aliKeyword", "phone holder")
        page.click("#aliSearchBtn")
        page.wait_for_selector("#aliResults .cj-use-btn", timeout=90000)
        c.check("AliExpress araması Türkiye için yapılıyor", any('"country":"TR"' in r for r in requests))
        page.locator("#aliResults .cj-use-btn").first.click()

        page.wait_for_selector("#totalCostNote", state="visible", timeout=90000)
        total_text = page.inner_text("#totalCostNote")
        total = price_of(total_text)
        c.check("AliExpress kargo dahil toplam maliyet görünüyor", "AliExpress toplam maliyet" in total_text and total and total > 0, total_text)
        fx = page.inner_text("#supplierFxNote") if page.is_visible("#supplierFxNote") else ""
        c.check("AliExpress dolar fiyatı TL'ye çevrilmiş", "AliExpress" in fx and "$" in fx and "₺" in fx, fx)

        page.fill("#salePrice", "1")
        page.wait_for_selector("#lossWarn", state="visible", timeout=15000)
        warn = page.inner_text("#lossWarn")
        c.check("Düşük fiyatta zarar uyarısı", "zarar edersin" in warn, warn)
        min_price = price_of(warn.split("minimum fiyat:")[-1]) if "minimum fiyat:" in warn else None
        c.check("Önerilen minimum fiyat >= toplam maliyet", min_price and total and min_price >= total, f"{min_price} / {total}")
        page.screenshot(path=str(shots / "urun_ekle_aliexpress_zarar.png"), full_page=False)

        page.fill("#salePrice", str(round((min_price or total) + 50, 2)))
        page.wait_for_timeout(2500)
        c.check("Minimumun üstünde uyarı kayboluyor", not page.is_visible("#lossWarn"))

        c.check("Sayfada JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
