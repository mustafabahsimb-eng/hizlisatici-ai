"""HIZ KURALI ölçümü: ürün ekleme / yayınlama süreleri (her ürün ekleme / yayınlama değişikliğinden sonra çalıştır).

Hedefler (CLAUDE.md): tek ürün bağlı tüm kanallarda < 30 sn; 100 ürünlük katalog < 10 dk; satıcı en fazla 2 dokunuş.
Ölçülenler:
  A) Tek ürün, link: linki yapıştırma anından ürünün mağaza vitrininde görünmesine kadar (+ dokunuş sayısı)
  B) 100 ürünlük katalog (tablo dosyası): dosya seçiminden 100 ürünün vitrinde görünmesine kadar (+ dokunuş sayısı)
Kanal notu: şu an canlı bağlı tek kanal Kendi Mağazam; pazaryeri gönderimleri canlıya geçince bu teste eklenir.
Çıktı: süre tablosu + hedefle karşılaştırma. Test ürünleri sonunda kaldırılır.
"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

SLUG = "e2e-test-magaza"
LINK = "https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/"
TARGET_SINGLE = 30
TARGET_CATALOG = 600
TARGET_TAPS = 2


def store_count(page, ids):
    return page.evaluate("""async (args) => {
        const r = await fetch(HS.SUPABASE_URL + '/functions/v1/get-store?slug=' + args.slug);
        const d = await r.json();
        const set = new Set(args.ids);
        return (d.products || []).filter(p => set.has(p.id)).length; }""", {"slug": SLUG, "ids": ids})


def main():
    shots = shots_dir()
    c = Checks()
    made = []
    rows = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        login(page)
        try:
            # ---------- A) Tek ürün, link ----------
            page.goto(f"{SITE}/toplu-yukleme.html")
            page.wait_for_selector("#srcUrl")
            taps = 0
            before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
            t0 = time.time()
            page.fill("#srcUrl", LINK)                      # yapıştırma (içerik girişi; çekme kendiliğinden başlar)
            page.dispatch_event("#srcUrl", "paste")
            page.wait_for_selector("#previewBox .pname", timeout=120000)
            t_preview = time.time() - t0
            if not page.is_checked("#consentChk"):
                page.check("#consentChk"); taps += 1
            if page.is_visible("#imageTermsRow") and not page.is_checked("#imageTermsChk"):
                page.check("#imageTermsChk"); taps += 1
            page.click("#importBtn"); taps += 1
            page.wait_for_selector("#resultBox.ok", timeout=180000)
            pid = page.evaluate("async (b) => (await HS.db.from('products').select('id').gt('id', b).order('id', {ascending:false}).limit(1)).data?.[0]?.id", before)
            made.append(pid)
            while store_count(page, [pid]) < 1 and time.time() - t0 < 180:
                time.sleep(1)
            t_single = time.time() - t0
            rows.append(("Tek ürün (link) → vitrinde", t_single, TARGET_SINGLE, taps, f"önizleme {t_preview:.1f} sn"))

            # ---------- B) 100 ürünlük katalog ----------
            fx = Path(shots) / "hiz"
            fx.mkdir(parents=True, exist_ok=True)
            csv = "Ürün Adı;Model Kodu;Bayi Fiyatı;Marka\n" + "\n".join(
                f"Hız Testi Ürünü {i:03d} Çelik Termos 500 ml;HZ-{i:04d};{100 + i},50;EvKeyfi" for i in range(1, 101))
            (fx / "katalog100.csv").write_text(csv, encoding="utf-8")
            page.goto(f"{SITE}/toplu-yukleme.html")
            page.wait_for_selector("#srcUrl")
            taps = 0
            before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
            t0 = time.time()
            # Dosyayı sayfaya bırakma (sekme değiştirmeden) = 1 dokunuş
            page.set_input_files("#fileInput", str(fx / "katalog100.csv")); taps += 1
            page.wait_for_function("() => items.length >= 100 && !running", timeout=600000)
            t_preview = time.time() - t0
            if not page.is_checked("#consentChk"):
                page.check("#consentChk"); taps += 1
            if page.is_visible("#imageTermsRow") and not page.is_checked("#imageTermsChk"):
                page.check("#imageTermsChk"); taps += 1
            page.click("#importBtn"); taps += 1
            page.wait_for_selector("#resultBox.ok, #resultBox.err", timeout=900000)
            ids = page.evaluate("async (b) => (await HS.db.from('products').select('id').gt('id', b)).data.map(x => x.id)", before)
            made += ids
            while store_count(page, ids) < 100 and time.time() - t0 < 900:
                time.sleep(2)
            t_cat = time.time() - t0
            rows.append(("100 ürünlük katalog → vitrinde", t_cat, TARGET_CATALOG, taps, f"önizleme {t_preview:.1f} sn, {len(ids)} ürün"))
        finally:
            if made:
                page.evaluate("async (ids) => { for (let i = 0; i < ids.length; i += 200) await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids.slice(i, i + 200)); }", made)
                page.evaluate("async () => { const u = (await HS.db.auth.getUser()).data.user.id; await HS.db.from('image_job_batches').update({ notified_at: new Date().toISOString() }).eq('user_id', u).is('notified_at', null); }")
        browser.close()

    print("\nSÜRE RAPORU")
    print(f"{'Senaryo':34} {'Süre':>9} {'Hedef':>8} {'Dokunuş':>8}  Not")
    for name, sec, target, taps, note in rows:
        print(f"{name:34} {sec:8.1f}s {target:7d}s {taps:>5}/{TARGET_TAPS}  {note}")
        c.check(f"{name}: süre hedefi", sec <= target, f"{sec:.1f} sn (hedef {target} sn)")
        c.check(f"{name}: dokunuş hedefi", taps <= TARGET_TAPS, f"{taps} dokunuş (hedef {TARGET_TAPS})")
    c.finish()


if __name__ == "__main__":
    main()
