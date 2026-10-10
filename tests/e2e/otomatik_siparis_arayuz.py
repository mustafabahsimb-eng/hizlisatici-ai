"""Otomatik sipariş arayüzü (CJ + AliExpress), test kullanıcısının sahte siparişleriyle.

Ön koşul (veritabanında, test kullanıcısına ait, note='E2E'):
  - AliExpress siparişi: onay_bekliyor / zarar
  - CJ siparişi: beklemede / cj_hesap_yok
Kontroller: Ayarlar "Otomatik sipariş" bölümü ve AliExpress anahtarının kaydı,
Panel uyarı şeridi, Siparişler durum/sebep/düğmeler, AliExpress siparişini "İptal et".
Gerçek tedarikçiye hiçbir istek gitmez (sahte siparişlerde tedarikçi sipariş no yok).
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
        page.on("dialog", lambda d: d.accept())
        login(page)

        # ---------- Ayarlar ----------
        page.goto(f"{SITE}/ayarlar.html#otomatik-siparis")
        page.wait_for_selector("#ae_auto_pay", state="attached", timeout=30000)
        page.wait_for_timeout(2500)
        c.check("Ayarlar: 'Otomatik sipariş' bölümü var", "Otomatik sipariş" in (page.text_content("#otomatik-siparis") or ""))
        c.check("Ayarlar: AliExpress anahtarının adı doğru", "AliExpress siparişlerini kayıtlı kartımla otomatik öde" in page.inner_text("body"))
        c.check("Ayarlar: AliExpress otomatik ödeme varsayılan açık", page.is_checked("#ae_auto_pay"))
        c.check("Ayarlar: CJ otomatik ödeme varsayılan açık", page.is_checked("#cj_auto_pay"))
        wa = page.inner_text("#waTemplateStatus")
        c.check("Ayarlar: WhatsApp bağlı değilse açıklama", "bağlı değil" in wa, wa)

        page.uncheck("#ae_auto_pay")
        page.click("#saveBtn")
        page.wait_for_function("() => /Kaydedildi|düzelt|Hata/i.test(document.getElementById('status').textContent)", timeout=20000)
        st = page.inner_text("#status")
        c.check("Ayarlar: kaydet çalışıyor", "Kaydedildi" in st, st)
        page.reload()
        page.wait_for_selector("#ae_auto_pay", state="attached")
        page.wait_for_timeout(2500)
        c.check("Ayarlar: kapatılan AliExpress ödemesi kalıcı", not page.is_checked("#ae_auto_pay"))
        page.check("#ae_auto_pay")
        page.click("#saveBtn")
        page.wait_for_function("() => /Kaydedildi/.test(document.getElementById('status').textContent)", timeout=20000)
        page.locator("#otomatik-siparis").scroll_into_view_if_needed()
        page.screenshot(path=str(shots / "ayarlar_otomatik_siparis.png"))

        # ---------- Panel ----------
        page.goto(f"{SITE}/dashboard.html")
        page.wait_for_selector("#orderBanner", state="visible", timeout=30000)
        banner = page.inner_text("#orderSummary")
        c.check("Panel: onay bekleyen sipariş uyarısı", "1 sipariş onayını bekliyor" in banner, banner)
        page.click("#orderSummary")
        page.wait_for_url("**/orders.html", timeout=15000)
        c.check("Panel: uyarıya tıklayınca Siparişler açılıyor", page.url.endswith("orders.html"))

        # ---------- Siparişler ----------
        page.click("button[data-tab='supplier']")
        page.wait_for_selector("#orderList .order-row", timeout=30000)
        rows = page.locator("#orderList .order-row")
        ae = rows.filter(has_text="AliExpress").first
        cj = rows.filter(has_text="CJ Dropshipping").first
        ae_text = ae.inner_text()
        c.check("Siparişler: AliExpress 'Onayını bekliyor'", "Onayını bekliyor" in ae_text)
        c.check("Siparişler: zarar sebebi görünüyor", "Zararlı sipariş: AliExpress maliyeti" in ae_text)
        c.check("Siparişler: 'Onayla ve öde' ve 'İptal et' var", "Onayla ve öde" in ae_text and "İptal et" in ae_text)
        cj_text = cj.inner_text()
        c.check("Siparişler: CJ hesabı yok sebebi görünüyor", "CJ hesabın bağlı değil" in cj_text, cj_text[:200])
        page.screenshot(path=str(shots / "siparisler_otomatik.png"), full_page=True)

        with page.expect_response(lambda r: "/functions/v1/cj-order-worker" in r.url, timeout=60000) as resp_info:
            ae.get_by_text("İptal et").click()
        resp = resp_info.value
        c.check("Siparişler: iptal isteği başarılı", resp.ok, f"HTTP {resp.status}")
        page.wait_for_function(
            "() => [...document.querySelectorAll('#orderList .order-row')].some(r => r.innerText.includes('AliExpress') && !r.innerText.includes('Onayla ve öde'))",
            timeout=30000,
        )
        ae_after = page.locator("#orderList .order-row").filter(has_text="AliExpress").first
        badge = ae_after.locator(".status-badge").inner_text()
        c.check("Siparişler: AliExpress siparişi 'İptal' oldu", badge.strip() == "İptal", badge)

        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
