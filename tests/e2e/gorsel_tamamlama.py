"""Görseli olmayan ürünlerde otomatik görsel tamamlama zinciri + görsel telif güvencesi.

Tablo (görselsiz) yüklenir:
  1) Philips Airfryer HD9252/90  -> markanın resmi sitesinden (basın sayfası ya da ürün sayfası)
  2) markasız araç telefon tutucu -> CJ / AliExpress eşleşmesi
  3) uydurma ürün (Kırmızı Seramik Kupa KT-101) -> "Görsel eksik" + "📷 Fotoğraf çek / yükle";
     satıcı fotoğraf yükler, arka plan temizlenir, kaynak "kendi fotoğrafın"
Her görselin kaynağı önizlemede "Görsel kaynağı: ..." olarak görünür.
İlk kullanım onayı ("Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir") işaretlenip ürünler eklenir;
veritabanında onay tarihi, görsel kaynakları ve "Görsel eksik" bayrağı kontrol edilir.
Çıktı: URUN_ID=... (temizlik için). Görsel arka plan temizleme 1 remove.bg kredisi harcar.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks
import katalog_dosyalari as K

CSV = ("Marka;Ürün;Kod;Fiyat\n"
       "Philips;Philips Airfryer Essential HD9252/90;HD9252/90;3.999,00\n"
       ";Magnetic Car Phone Holder Dashboard Mount 360 Rotation;;150,00\n"
       "EvKeyfi;Kırmızı Seramik Kupa 350 ml;KT-101;149,90\n")


def main():
    shots = shots_dir()
    fx = Path(shots) / "gorsel"
    fx.mkdir(parents=True, exist_ok=True)
    (fx / "gorselsiz.csv").write_text(CSV, encoding="utf-8")
    K.main.__globals__["sys"].argv = ["x", str(fx)]
    K.main()  # ekran.png: satıcının çektiği "fotoğraf" yerine
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)
        page.goto(f"{SITE}/toplu-yukleme.html")
        page.wait_for_selector("#srcUrl")
        # Test kullanıcısı her seferinde "ilk kullanım" durumundan başlar
        page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
            await HS.db.from('user_profiles').update({ image_terms_accepted_at: null, image_terms_text: null }).eq('user_id', uid); }""")
        page.reload()
        page.wait_for_selector("#srcUrl")
        page.get_by_text("📄 Katalog / fiyat listesi yükle").click()
        page.set_input_files("#fileInput", str(fx / "gorselsiz.csv"))
        page.wait_for_function("() => items.length >= 3 && !running && items.every(i => i.lookupDone || i.images.length)", timeout=900000)
        info = page.evaluate("() => items.map(i => ({ name: i.name, n: i.images.length, src: i.imgSrc, missing: !!i.imageMissing }))")
        pick = lambda pre: next((i for i in info if i["name"].startswith(pre)), None)
        ph, car, mug = pick("Philips Airfryer"), pick("Magnetic Car"), pick("Kırmızı Seramik")
        prices = page.evaluate("() => items.map(i => i.price).join('|')")
        c.check("Tablodaki Türkçe fiyatlar doğru (3.999,00 / 150,00 / 149,90)", prices == "3999|150|149.9", prices)
        c.check("Marka ürünü: görsel markanın resmi sitesinden", bool(ph) and ph["n"] > 0 and (ph["src"] or {}).get("kind") in ("brand_site", "brand_media_kit"), str(ph)[:200])
        c.check("Markasız ürün: görsel CJ / AliExpress eşleşmesinden", bool(car) and car["n"] > 0 and (car["src"] or {}).get("kind") in ("cj", "aliexpress"), str(car)[:200])
        c.check("Bulunamayan ürün: 'Görsel eksik'", bool(mug) and mug["n"] == 0 and mug["missing"], str(mug)[:200])
        rows = page.locator("#previewBox tbody tr")
        txt = rows.filter(has_text="Philips").first.inner_text()
        c.check("Önizlemede 'Görsel kaynağı: ...' görünüyor", "Görsel kaynağı:" in txt and "philips" in txt.lower(), txt.replace("\n", " ")[:160])
        mug_row = rows.filter(has_text="Kırmızı Seramik").first
        c.check("Eksik üründe 'Görsel eksik' etiketi ve '📷 Fotoğraf çek / yükle' düğmesi",
                "Görsel eksik" in mug_row.inner_text() and mug_row.get_by_text("📷 Fotoğraf çek / yükle").count() == 1)
        page.screenshot(path=str(shots / "gorsel_tamamlama.png"), full_page=True)

        # Kendi fotoğrafı (arka plan temizlenir)
        with page.expect_file_chooser() as fc:
            mug_row.get_by_text("📷 Fotoğraf çek / yükle").click()
        fc.value.set_files(str(fx / "ekran.png"))
        page.wait_for_function("() => { const i = items.find(x => x.name.startsWith('Kırmızı')); return i && i.images.length > 0; }", timeout=120000)
        mug_row = page.locator("#previewBox tbody tr").filter(has_text="Kırmızı Seramik").first
        c.check("Kendi fotoğrafı eklendi, kaynak 'kendi fotoğrafın'", "Görsel kaynağı: kendi fotoğrafın" in mug_row.inner_text(), mug_row.inner_text().replace("\n", " ")[:160])
        c.check("Fotoğrafı olan üründe 'Kendi fotoğrafımla değiştir'", rows.filter(has_text="Magnetic Car").first.get_by_text("Kendi fotoğrafımla değiştir").count() == 1)

        # İlk kullanım onayı + ekle
        c.check("İlk kullanım onayı görünüyor (onaylı metin)", page.is_visible("#imageTermsRow") and
                page.inner_text("#imageTermsRow").strip() == "Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir")
        c.check("Ekle düğmesi 'Seçilenleri ekle (3)'", page.inner_text("#importBtn").strip() == "Seçilenleri ekle (3)", page.inner_text("#importBtn"))
        before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        page.check("#consentChk")
        c.check("Onay işaretlenmeden eklenemiyor", page.is_disabled("#importBtn"))
        page.check("#imageTermsChk")
        page.click("#importBtn")
        page.wait_for_selector("#resultBox.ok, #resultBox.err", timeout=180000)
        db = page.evaluate("""async (before) => {
            const uid = (await HS.db.auth.getUser()).data.user.id;
            const pr = await HS.db.from('user_profiles').select('image_terms_accepted_at, image_terms_text').eq('user_id', uid).maybeSingle();
            const ps = await HS.db.from('products').select('id, name, image_missing').gt('id', before);
            const ids = (ps.data || []).map(x => x.id);
            const im = await HS.db.from('product_images').select('product_id, source_kind, source_url').in('product_id', ids);
            return { terms: pr.data, products: ps.data, images: im.data };
        }""", before)
        print("URUN_ID=" + ",".join(str(x["id"]) for x in db["products"] or []))
        c.check("Onay tarihi ve metni kaydedildi", bool(db["terms"] and db["terms"]["image_terms_accepted_at"]) and
                db["terms"]["image_terms_text"] == "Orijinal ürün satıyorum, görsel kullanım sorumluluğu bana aittir")
        kinds = sorted({i["source_kind"] for i in db["images"] or []})
        c.check("Görsel kaynakları kaydedildi", "seller_photo" in kinds and any(k in kinds for k in ("brand_site", "brand_media_kit")), str(kinds))
        c.check("Kaynak sayfası adresleri kaydedildi", all(i["source_url"] for i in db["images"] or [] if i["source_kind"] != "seller_photo"))
        # Temizlik: test ürünleri kaldırılır
        page.evaluate("async (ids) => { if (ids.length) await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids); }",
                      [x["id"] for x in db["products"] or []])
        c.check("Sayfada JavaScript hatası yok", not errors, "; ".join(errors)[:300])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
