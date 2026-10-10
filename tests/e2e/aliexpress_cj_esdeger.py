"""AliExpress ürünü kaydedilince CJ eşdeğeri araması kendiliğinden başlar + Siparişler etiketi.

1) Ürün Ekle: kanal "Kendi Mağazam" -> AliExpress'te ara -> "Kullan" -> kaydet ->
   cj-alt-match isteği gider ve ürün "eşdeğer aranıyor/bulundu" durumuna geçer.
   (Kaydedilen test ürünü test kullanıcısınındır; test sonunda veritabanından silinir.)
2) Siparişler: CJ eşdeğerinden verilmiş AliExpress siparişi etiketi.
   Ön koşul: test kullanıcısının E2E AliExpress siparişi fulfilled_via='cj' (test öncesi ayarlanır).
Çıktı: kaydedilen ürünün id'si (temizlik için) "URUN_ID=<id>".
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

        # ---------- 1) Ürün Ekle -> kaydet -> eşdeğer araması başlar ----------
        page.goto(f"{SITE}/add-product.html")
        page.wait_for_selector("#platform")
        page.select_option("#platform", "Kendi Mağazam")
        page.fill("#aliKeyword", "phone holder")
        page.click("#aliSearchBtn")
        page.wait_for_selector("#aliResults .cj-use-btn", timeout=90000)
        page.locator("#aliResults .cj-use-btn").first.click()
        page.wait_for_selector("#totalCostNote", state="visible", timeout=90000)
        page.fill("#salePrice", "999")
        before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        page.click("#saveBtn")
        # Kaydedilen ürünün eşdeğer durumu arka planda dolmalı (satıcı beklemez)
        status, pid = None, None
        for _ in range(40):
            page.wait_for_timeout(3000)
            row = page.evaluate("""async (before) => {
                const r = await HS.db.from('products').select('id, cj_alt_status, cj_alt_note').gt('id', before).order('id', {ascending:false}).limit(1);
                return r.data && r.data[0] ? r.data[0] : null;
            }""", before)
            if row:
                pid = row["id"]
                if row.get("cj_alt_status") in ("sourcing", "found", "not_found"):
                    status = row
                    break
        c.check("Kaydedince CJ eşdeğer araması kendiliğinden başladı", status is not None, str(status)[:160])
        if pid:
            print(f"URUN_ID={pid}")

        # ---------- 2) Siparişler: CJ eşdeğerinden verildi etiketi ----------
        page.goto(f"{SITE}/orders.html")
        page.click("button[data-tab='supplier']")
        page.wait_for_selector("#orderList .order-row", timeout=30000)
        txt = page.locator("#orderList .order-row").filter(has_text="AliExpress").first.inner_text()
        c.check("Siparişler: 'AliExpress (CJ eşdeğerinden verildi)' etiketi", "CJ eşdeğerinden verildi" in txt, txt.split("\n")[1] if "\n" in txt else txt)
        page.screenshot(path=str(shots / "siparisler_cj_esdeger.png"))

        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
