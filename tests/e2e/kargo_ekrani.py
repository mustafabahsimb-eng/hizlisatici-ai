"""Panel kargo ekranları (eksik taraması 5. madde).

Ayarlar > 🚚 Kargo:
 1) Bölüm ve kargo firması listesi (8 firma), firmaya göre alanlar (Yurtiçi: web servis kullanıcı adı / şifre)
 2) Yurtiçi test hesabı bağlanır (YKTEST / YK) -> listede "Test" + "Bağlı" ya da "Doğrulama bekliyor" + "Varsayılan"
 3) "Siparişlere kargo gönderisini otomatik oluştur" kaydedilir
Siparişler:
 4) Etiketi olan siparişte [🏷️ Etiket] -> imzalı PDF adresi açılır
 5) [🏷️ Bekleyen etiketleri indir (PDF)] -> birleştirilmiş PDF açılır (bekleyen etiket yoksa uyarı)
 6) Telefonda yatay kaydırma yok
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        page = ctx.new_page()
        login(page)
        page.goto(f"{SITE}/ayarlar.html#kargo")
        page.wait_for_selector("#ship_provider option", state="attached", timeout=30000)
        c.check("Ayarlar: \"🚚 Kargo\" bölümü", page.text_content("#kargo") == "🚚 Kargo")
        opts = page.locator("#ship_provider option").all_text_contents()
        c.check("8 kargo firması", len(opts) == 8 and opts[0] == "Yurtiçi Kargo" and "Geliver" in opts, str(opts))
        page.click("#shipAddBtn")
        labels = page.locator("#shipCredFields label").all_text_contents()
        c.check("Yurtiçi alanları", labels == ["Web servis kullanıcı adı", "Web servis şifresi"], str(labels))
        page.select_option("#ship_provider", "geliver")
        c.check("Geliver alanı: API anahtarı", page.locator("#shipCredFields label").all_text_contents() == ["API anahtarı"])
        page.select_option("#ship_provider", "yurtici")
        page.select_option("#ship_mode", "test")
        inputs = page.locator("#shipCredFields input")
        inputs.nth(0).fill("YKTEST")
        inputs.nth(1).fill("YK")
        page.fill("#ship_s_name", "E2E Gönderen")
        page.fill("#ship_s_phone", "05550000000")
        page.fill("#ship_s_address", "Test Mah. 1")
        page.fill("#ship_s_district", "Kadıköy")
        page.fill("#ship_s_city", "İstanbul")
        page.click("#shipConnectBtn")
        page.wait_for_function("() => document.getElementById('shipForm').style.display === 'none' || document.getElementById('shipError').style.display === 'block'", timeout=150000)
        err = page.text_content("#shipError") if page.is_visible("#shipError") else ""
        item = page.locator(".ship-item").filter(has_text="Yurtiçi Kargo").first.inner_text() if page.locator(".ship-item").count() else ""
        c.check("Yurtiçi test hesabı bağlandı", not err and "Test" in item and ("Bağlı" in item or "Doğrulama bekliyor" in item), (err or item)[:120])
        c.check("Varsayılan hesap işaretli", "Varsayılan" in page.locator("#shipList").inner_text())
        page.screenshot(path=str(Path(shots) / "kargo_ayarlar.png"), full_page=True)
        # Otomatik gönderi anahtarı
        was = page.is_checked("#shipping_auto")
        page.set_checked("#shipping_auto", not was)
        page.click("#saveBtn")
        page.wait_for_timeout(2500)
        page.reload()
        page.wait_for_selector("#ship_provider option", state="attached", timeout=30000)
        page.wait_for_timeout(1500)
        c.check("Otomatik gönderi ayarı kaydedildi", page.is_checked("#shipping_auto") == (not was))
        page.set_checked("#shipping_auto", was)
        page.click("#saveBtn")
        page.wait_for_timeout(2000)

        # Siparişler
        page.goto(f"{SITE}/orders.html")
        page.wait_for_selector("#msList .order-row, #msList .empty-state", timeout=60000)
        page.wait_for_timeout(2000)
        lbl = page.locator("#msList .btn-mini", has_text="🏷️ Etiket")
        c.check("Siparişte [🏷️ Etiket] düğmesi", lbl.count() >= 1, str(lbl.count()))
        # Başsız tarayıcı PDF'i indirir; açılan adres yakalanır
        page.evaluate("() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; }")
        if lbl.count():
            lbl.first.click()
            page.wait_for_function("() => window.__opened.length > 0", timeout=30000)
            u = page.evaluate("() => window.__opened[0]")
            c.check("Etiket PDF'i açıldı (imzalı adres)", "shipping-labels" in u and "token=" in u, u[:90])
        c.check("Üstte [🏷️ Bekleyen etiketleri indir (PDF)]", page.text_content("#labelsBtn") == "🏷️ Bekleyen etiketleri indir (PDF)")
        msgs = []
        page.on("dialog", lambda d: (msgs.append(d.message), d.accept()))
        page.click("#labelsBtn")
        page.wait_for_function("() => window.__opened.length > 1", timeout=90000)
        u2 = page.evaluate("() => window.__opened[1]")
        if u2:
            import urllib.request
            pdf = urllib.request.urlopen(u2, timeout=60).read()
            c.check("Bekleyen etiketler tek PDF", "toplu-" in u2 and pdf[:5] == b"%PDF-", f"{len(pdf)} bayt")
        else:
            c.check("Bekleyen etiketler (yoksa uyarı)", any("Bekleyen etiket yok" in m for m in msgs), str(msgs))
        page.set_viewport_size({"width": 375, "height": 800})
        sw = page.evaluate("() => document.documentElement.scrollWidth")
        c.check("Telefonda yatay kaydırma yok (Siparişler)", sw <= 376, str(sw))
        page.screenshot(path=str(Path(shots) / "kargo_siparisler_telefon.png"), full_page=False)
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
