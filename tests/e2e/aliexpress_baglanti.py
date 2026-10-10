"""Hesaplarım: AliExpress satırı ve bağlama akışı (AliExpress'e giriş yapılmaz).

Adımlar: giriş -> Hesaplarım -> AliExpress satırı "Kendi Hesabını Bağla" -> tıkla ->
AliExpress izin adresine gidiyor mu (client_id, state, doğru dönüş adresi) -> dönüş sayfası
kodsuz/sahte kodla açılınca anlaşılır hata veriyor mu.
"""
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        login(page)
        page.goto(f"{SITE}/accounts.html")
        page.wait_for_selector("#right-aliexpress button", timeout=30000)
        # Sayfa satırları birden fazla kez çizebilir: tüm "yükleniyor" yazıları bitene kadar bekle
        page.wait_for_function("() => !document.body.innerText.includes('yükleniyor')", timeout=30000)
        c.check("Hiçbir satır 'yükleniyor'da takılı kalmıyor", True)
        row = page.locator("#right-aliexpress")
        c.check("AliExpress satırında 'Kendi Hesabını Bağla' var", "Kendi Hesabını Bağla" in row.inner_text(), row.inner_text())
        page.locator("#right-aliexpress").scroll_into_view_if_needed()
        page.screenshot(path=str(shots / "hesaplarim_aliexpress.png"))

        # AliExpress'e gitmeden yönlendirme adresini yakala
        target = {}
        def stop_at_aliexpress(route):
            target["url"] = route.request.url
            route.fulfill(status=200, body="ok")
        page.route("https://api-sg.aliexpress.com/oauth/**", stop_at_aliexpress)
        page.click("#right-aliexpress button")
        page.wait_for_timeout(5000)
        u = urlparse(target.get("url", ""))
        q = parse_qs(u.query)
        c.check("Bağla -> AliExpress izin sayfası", u.netloc == "api-sg.aliexpress.com" and u.path == "/oauth/authorize", target.get("url", "")[:120])
        c.check("İzin adresinde uygulama kimliği var", bool(q.get("client_id", [""])[0]))
        c.check("İzin adresinde güvenlik kodu (state) var", len(q.get("state", [""])[0]) >= 40)
        c.check("Dönüş adresi doğru", q.get("redirect_uri", [""])[0] == f"{SITE}/aliexpress-callback.html", q.get("redirect_uri", [""])[0])

        # Dönüş sayfası: kodsuz
        page.unroute("https://api-sg.aliexpress.com/oauth/**")
        page.goto(f"{SITE}/aliexpress-callback.html")
        page.wait_for_selector("#msg.error", timeout=20000)
        c.check("Kodsuz dönüşte anlaşılır hata", "izin vermedi" in page.inner_text("#msg"), page.inner_text("#msg"))

        # Dönüş sayfası: sahte state -> sunucu reddetmeli
        page.goto(f"{SITE}/aliexpress-callback.html?code=sahte&state=sahte")
        page.wait_for_selector("#msg.error", timeout=30000)
        msg = page.inner_text("#msg")
        c.check("Sahte güvenlik kodu reddediliyor", "Güvenlik kodu geçersiz" in msg, msg)
        page.screenshot(path=str(shots / "aliexpress_callback_hata.png"))

        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
