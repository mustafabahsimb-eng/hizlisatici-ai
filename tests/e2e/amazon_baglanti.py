"""Amazon bağlantısı (Hesaplarım + amazon-callback.html).

Seltigo'nun Amazon geliştirici uygulaması henüz tanımlı değilken:
 1) Türkiye bölümünde Amazon TR: elle anahtar formu YOK, [Mağazanı Bağla] -> "çok yakında" uyarısı
 2) Uluslararası bölümünde Amazon: [Mağazanı Bağla] -> bölge seçimi (Avrupa / Kuzey Amerika / Uzak Doğu) -> "çok yakında"
 3) amazon-callback.html: sahte / süresi geçmiş onay -> anlaşılır hata, Hesaplarım'a döner
 4) amazon-connect status: uygulama hazır değil, sandbox modunda
 5) Telefon genişliğinde yatay kaydırma yok
Uygulama tanımlanınca (AMAZON_* secrets) 1-2 Seller Central onay sayfasına yönlendirmeli; test bunu da kabul eder.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page)
        page.goto(f"{SITE}/accounts.html")
        page.wait_for_selector("#connect-amazontr", timeout=30000)

        st = page.evaluate("""async () => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
            const r = await fetch(HS.SUPABASE_URL + '/functions/v1/amazon-connect', { method: 'POST', headers: { 'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify({ action: 'status', userAccessToken: tok }) });
            return await r.json(); }""")
        c.check("amazon-connect durum: sandbox modunda, 23 pazar", st.get("ok") and st.get("live") is False and len(st.get("markets", [])) == 23, str(st)[:160])
        ready = bool(st.get("configured"))

        # 1) Amazon TR
        page.click("#connect-amazontr")
        if ready:
            page.wait_for_url("**/apps/authorize/consent**", timeout=20000)
            c.check("Amazon TR -> Seller Central onay sayfası", "sellercentral.amazon.com.tr" in page.url)
            page.goto(f"{SITE}/accounts.html"); page.wait_for_selector("#connect-amazon", timeout=30000)
        else:
            page.wait_for_selector("#toast:has-text('yakında')", timeout=15000)
            c.check("Amazon TR [Mağazanı Bağla] -> \"çok yakında\" (elle anahtar formu yok)", not page.is_visible("#connectModalOverlay"))

        # 2) Amazon global
        page.click("#connect-amazon")
        page.wait_for_selector("#amazonRegionOverlay", state="visible", timeout=5000)
        regions = page.locator(".amz-region b").all_inner_texts()
        c.check("Bölge seçimi: Avrupa / Kuzey Amerika / Uzak Doğu", regions == ["Avrupa", "Kuzey Amerika", "Uzak Doğu"], str(regions))
        page.screenshot(path=str(Path(shots) / "amazon_bolge.png"))
        page.locator(".amz-region").first.click()
        if ready:
            page.wait_for_url("**/apps/authorize/consent**", timeout=20000)
            c.check("Avrupa -> sellercentral-europe onay sayfası", "sellercentral-europe.amazon.com" in page.url)
        else:
            page.wait_for_selector("#amazonRegionError:has-text('yakında')", timeout=15000)
            c.check("Avrupa -> \"çok yakında\" (pencerede)", True)
            page.click("#amazonRegionOverlay .modal-actions button")
            c.check("[Vazgeç] pencereyi kapatır", not page.is_visible("#amazonRegionOverlay"))

        # 5) Telefon
        page.goto(f"{SITE}/accounts.html")
        page.wait_for_selector("#connect-amazon", timeout=30000)
        page.set_viewport_size({"width": 375, "height": 800})
        sw = page.evaluate("() => document.documentElement.scrollWidth")
        c.check("Telefonda yatay kaydırma yok", sw <= 376, str(sw))
        page.wait_for_timeout(1500)
        page.screenshot(path=str(Path(shots) / "amazon_hesaplarim_telefon.png"), full_page=True)
        page.set_viewport_size({"width": 1280, "height": 900})

        # 3) Geri dönüş sayfası: sahte onay
        page.goto(f"{SITE}/amazon-callback.html?spapi_oauth_code=FAKE&state=gecersiz&selling_partner_id=A1TEST")
        page.wait_for_selector("#message.error", timeout=30000)
        msg = page.inner_text("#message")
        c.check("Sahte onay -> anlaşılır hata", "geçersiz" in msg or "süresi doldu" in msg, msg[:120])
        page.goto(f"{SITE}/amazon-callback.html")
        page.wait_for_selector("#message.error", timeout=30000)
        c.check("Onay bilgisi yok -> hata", "tamamlanmadı" in page.inner_text("#message"))
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
