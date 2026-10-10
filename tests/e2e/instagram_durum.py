"""Hesaplarım + Panel: Instagram bağlantı durumunun doğru okunması.

Kullanım: instagram_durum.py <ekran_klasoru> <beklenen: expired|ok>
Ön koşul (test öncesi veritabanında, test kullanıcısında): bir Instagram kaydı;
  expired -> token_status='expired' (Meta anahtarı iptal etmiş)
  ok      -> yeniden bağlanmış: token_status='ok', bitiş tarihi ileride
"""
import sys
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks


def main():
    expected = sys.argv[2] if len(sys.argv) > 2 else "ok"
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(f"{page.url}: {e}"))
        login(page)

        page.goto(f"{SITE}/dashboard.html")
        page.wait_for_timeout(6000)
        banner = page.inner_text("#connBanner") if page.is_visible("#connBanner") else ""
        if expected == "expired":
            c.check("Panel: Instagram süresi doldu uyarısı var", "Instagram bağlantının süresi doldu" in banner, banner)
        else:
            c.check("Panel: Instagram uyarısı yok", "Instagram" not in banner, banner or "(uyarı yok)")

        page.goto(f"{SITE}/accounts.html")
        page.wait_for_selector(".conn-list .conn-item", timeout=30000)
        item = page.locator(".conn-list .conn-item").first.inner_text()
        if expected == "expired":
            c.check("Hesaplarım: 'süresi doldu' + 'Yeniden Bağla'", "süresi doldu" in item and "Yeniden Bağla" in item, item.replace("\n", " | "))
        else:
            c.check("Hesaplarım: 'bağlı', yeniden bağla düğmesi yok", "bağlı" in item and "süresi doldu" not in item and "Yeniden Bağla" not in item, item.replace("\n", " | "))
        page.locator(".conn-list").first.scroll_into_view_if_needed()
        page.screenshot(path=str(shots / f"instagram_{expected}.png"))

        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
