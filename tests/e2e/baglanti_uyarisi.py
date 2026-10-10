"""Panel: bağlantı sağlığı uyarısı.

Ön koşul: test kullanıcısında süresi dolmuş bir AliExpress bağlantısı (test öncesi eklenir,
sonra silinir). Kontroller: panelde Türkçe uyarı, tıklayınca Hesaplarım, AliExpress satırında
"süresi doldu" + "Yeniden Bağla".
"""
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(f"{page.url}: {e}"))
        login(page)

        page.goto(f"{SITE}/dashboard.html")
        page.wait_for_selector("#connBanner [data-conn]", timeout=30000)
        txt = page.inner_text("#connBanner")
        c.check("Panel: AliExpress süresi doldu uyarısı", "AliExpress bağlantının süresi doldu" in txt, txt)
        page.screenshot(path=str(shots / "panel_baglanti_uyarisi.png"))
        page.locator("#connBanner [data-conn]").filter(has_text="AliExpress").first.click()
        page.wait_for_url("**/accounts.html", timeout=15000)
        c.check("Panel: uyarıya tıklayınca Hesaplarım açılıyor", page.url.endswith("accounts.html"))

        page.wait_for_selector("#right-aliexpress button", timeout=30000)
        page.wait_for_function("() => !document.body.innerText.includes('yükleniyor')", timeout=30000)
        row = page.inner_text("#right-aliexpress")
        c.check("Hesaplarım: AliExpress 'süresi doldu' + 'Yeniden Bağla'", "süresi doldu" in row and "Yeniden Bağla" in row, row)

        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
