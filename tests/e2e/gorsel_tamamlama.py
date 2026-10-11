"""Görsel tamamlama ARKA PLANDA + görsel telif güvencesi.

Görselsiz tablo yüklenir; önizleme beklemeden gelir ("arka planda aranacak" notu), ürünler eklenir.
image-complete-worker (2 dk'da bir) zinciri çalıştırır:
  1) Philips Airfryer HD9252/90  -> markanın resmi sitesinden
  2) markasız araç telefon tutucu -> CJ / AliExpress eşleşmesi
  3) uydurma ürün (Kırmızı Seramik Kupa) -> "Görsel eksik"
Bitince panelde bildirim çıkar, kapatılabilir; ürün kartında "Görsel eksik" etiketi.
İlk kullanım onayı ve "Seçilenleri ekle ({n})" de denetlenir. Test ürünleri sonunda kaldırılır.
"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

CSV = ("Marka;Ürün;Kod;Fiyat\n"
       "Philips;Philips Airfryer Essential HD9252/90;HD9252/90;3.999,00\n"
       ";Magnetic Car Phone Holder Dashboard Mount 360 Rotation;;150,00\n"
       "EvKeyfi;Kırmızı Seramik Kupa 350 ml;KT-101;149,90\n")


def main():
    shots = shots_dir()
    fx = Path(shots) / "gorsel"
    fx.mkdir(parents=True, exist_ok=True)
    (fx / "gorselsiz.csv").write_text(CSV, encoding="utf-8")
    c = Checks()
    ids = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)
        try:
            page.goto(f"{SITE}/toplu-yukleme.html")
            page.wait_for_selector("#srcUrl")
            page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
                await HS.db.from('user_profiles').update({ image_terms_accepted_at: null, image_terms_text: null }).eq('user_id', uid); }""")
            page.reload()
            page.wait_for_selector("#srcUrl")
            page.get_by_text("📄 Katalog / fiyat listesi yükle").click()
            t0 = time.time()
            page.set_input_files("#fileInput", str(fx / "gorselsiz.csv"))
            page.wait_for_function("() => items.length >= 3 && !running", timeout=120000)
            c.check("Önizleme beklemeden geldi (görsel aranmadan)", time.time() - t0 < 60, f"{time.time() - t0:.0f} sn")
            prices = page.evaluate("() => items.map(i => i.price).join('|')")
            c.check("Tablodaki Türkçe fiyatlar doğru (3.999,00 / 150,00 / 149,90)", prices == "3999|150|149.9", prices)
            note = page.inner_text("#lookupBar")
            c.check("Önizlemede 'arka planda aranacak' notu", "arka planda" in note and "3" in note, note[:160])
            c.check("İlk kullanım onayı görünüyor (onaylı metin)", page.is_visible("#imageTermsRow") and
                    page.inner_text("#imageTermsRow").strip() == "Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir")
            c.check("Ekle düğmesi 'Seçilenleri ekle (3)'", page.inner_text("#importBtn").strip() == "Seçilenleri ekle (3)")
            page.check("#consentChk")
            c.check("Onay işaretlenmeden eklenemiyor", page.is_disabled("#importBtn"))
            page.check("#imageTermsChk")
            before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
            page.click("#importBtn")
            page.wait_for_selector("#resultBox.ok, #resultBox.err", timeout=120000)
            c.check("Sonuçta 'arka planda aranıyor' bilgisi", "arka planda" in page.inner_text("#resultBox"), page.inner_text("#resultBox")[:160])
            prods = page.evaluate("async (b) => (await HS.db.from('products').select('id, name').gt('id', b)).data", before)
            ids = [x["id"] for x in prods]
            terms = page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
                return (await HS.db.from('user_profiles').select('image_terms_accepted_at').eq('user_id', uid).maybeSingle()).data; }""")
            c.check("Onay tarihi kaydedildi", bool(terms and terms["image_terms_accepted_at"]))

            # Panel: sürerken bildirim
            page.goto(f"{SITE}/dashboard.html")
            page.wait_for_selector("#imgBanner", state="visible", timeout=60000)
            c.check("Panelde 'arka planda aranıyor' bildirimi", "aranıyor" in page.inner_text("#imgSummary"), page.inner_text("#imgSummary"))

            # Arka plan görevinin bitmesini bekle (en fazla 15 dk)
            batch = None
            for _ in range(90):
                batch = page.evaluate("async () => (await HS.db.from('image_job_batches').select('status, total, found, missing').order('created_at', {ascending:false}).limit(1)).data[0]")
                if batch["status"] == "done":
                    break
                time.sleep(10)
            c.check("Arka plan görevi bitti", bool(batch) and batch["status"] == "done", str(batch))
            info = page.evaluate("""async (ids) => {
                const ps = (await HS.db.from('products').select('id, name, image_url, image_missing').in('id', ids)).data;
                const im = (await HS.db.from('product_images').select('product_id, source_kind, source_url').in('product_id', ids).is('deleted_at', null)).data;
                return ps.map(p => Object.assign(p, { kinds: [...new Set(im.filter(i => i.product_id === p.id).map(i => i.source_kind))], urls: im.filter(i => i.product_id === p.id).map(i => i.source_url) }));
            }""", ids)
            pick = lambda pre: next((i for i in info if i["name"].startswith(pre)), None)
            ph, car, mug = pick("Philips Airfryer"), pick("Magnetic Car"), pick("Kırmızı Seramik")
            c.check("Marka ürünü: görsel markanın resmi sitesinden", bool(ph) and any(k in ("brand_site", "brand_media_kit") for k in ph["kinds"]) and bool(ph["image_url"]), str(ph)[:200])
            c.check("Markasız ürün: görsel CJ / AliExpress'ten", bool(car) and any(k in ("cj", "aliexpress") for k in car["kinds"]), str(car)[:200])
            c.check("Bulunamayan ürün: 'Görsel eksik' işaretli", bool(mug) and mug["image_missing"] and not mug["kinds"], str(mug)[:200])
            c.check("Görsel kaynak sayfaları kaydedildi", all(u for i in info for u in i["urls"]))

            # Panel: bitiş bildirimi + Görsel eksik etiketi
            page.reload()
            page.wait_for_selector("#imgBanner", state="visible", timeout=60000)
            summ = page.inner_text("#imgSummary")
            c.check("Panelde bitiş bildirimi (bulunan / bulunamayan)", "bitti" in summ and "2 ürünün" in summ and "1 ürün için" in summ, summ)
            row = page.locator(f".product-row[data-id='{mug['id']}']")
            row.wait_for(timeout=30000)
            c.check("Ürün kartında 'Görsel eksik' etiketi", "Görsel eksik" in row.inner_text())
            page.screenshot(path=str(shots / "gorsel_bildirim.png"))
            page.click("#imgClose")
            page.wait_for_timeout(1000)
            c.check("Bildirim kapatılabiliyor", not page.is_visible("#imgBanner"))
        finally:
            if ids:
                page.evaluate("async (ids) => HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids)", ids)
        c.check("Sayfalarda JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
