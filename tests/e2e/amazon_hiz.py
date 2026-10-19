"""Amazon hızlı yükleme ölçümü: "ürün ekle -> Amazon'a gönder" baştan sona, 5 kategoriden ürünle (HIZ KURALI).

Akış (satıcının yaptığı): Toplu Yükleme sayfasına ürün linkini yapıştır -> [Seçilenleri ekle]. Pazaryerlerine gönderim, bir kez seçilen
varsayılan kanallardan kendiliğinden yapılır (ilk seferde "Amazon" kutusu işaretlenir; sonra hatırlanır).
Ölçülen: linkin yapıştırılmasından ürünün bağlı TÜM Amazon pazarlarında (TR, DE, UK, FR, US) kabul edilmesine kadar geçen süre,
satıcının tıklama sayısı, her ilanın adım süreleri (validation.amazon.timings), uyarı / otomatik düzeltme sayıları.
Amazon tarafı: test kullanıcısının sandbox bağlantısı (python tools/amazon/amazon_ac.py test-baglan). Satıcı hesabı olmadığı için Amazon'un
cevapları benzetimden gelir (_shared/amazon-sim.ts, istek başına 300 ms); giriş anahtarı, ürün okuma, AI, görsel düzeltme, kuyruk ve işçi gerçektir.
Hedef: ürün başına < 60 sn, satıcı en fazla 2 tıklama. Test ürünleri sonunda kaldırılır.
"""
import json, sys, time
from ortak import SITE, login, Checks

LINKS = [
    ("Ayakkabı", "https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/"),
    ("Çanta", "https://demos.flatsome.com/shop/bags/classic-bag-svea/"),
    ("Pantolon (kot)", "https://demos.flatsome.com/shop/women/jeans/lucy-slim-jeans-nok-379-noisy-may/"),
    ("Tişört", "https://demos.flatsome.com/shop/men/t-shirts/bjorn-tee-ss-jack-jones/"),
    ("Poster", "https://demos.flatsome.com/shop/posters/flying-ninja/"),
]
TARGET_S = 60
TARGET_TAPS = 2
from playwright.sync_api import sync_playwright


def amazon_listings(page, pid):
    return page.evaluate("""async (pid) => (await HS.db.from('listings').select('id, marketplace_code, status, last_sync_error, validation, price, currency, title')
        .eq('product_id', pid).like('marketplace_code', 'amazon_%').is('deleted_at', null)).data || []""", pid)


def main():
    c = Checks()
    rows, made = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        login(page)
        n_conn = page.evaluate("async () => (await HS.db.from('store_connections').select('id').like('marketplace_code','amazon_%').eq('status','connected').is('deleted_at', null)).data.length")
        c.check("Test kullanıcısında Amazon sandbox bağlantıları", n_conn >= 5, f"{n_conn} pazar")
        setup_taps = 0
        try:
            for i, (cat, link) in enumerate(LINKS):
                page.goto(f"{SITE}/toplu-yukleme.html")
                page.wait_for_selector("#srcUrl")
                page.wait_for_selector("#chanRow", state="visible", timeout=20000)
                amz = page.locator(".chanChk[value='amazon']")
                if not amz.is_checked():           # bir kerelik ayar (sonra hatırlanır)
                    amz.check(); setup_taps += 1
                    page.wait_for_timeout(800)
                taps = 0
                before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
                t0 = time.time()
                page.fill("#srcUrl", link)
                page.dispatch_event("#srcUrl", "paste")   # yapıştırma: okuma kendiliğinden başlar
                page.wait_for_selector("#previewBox .pname", timeout=120000)
                t_preview = time.time() - t0
                if not page.is_checked("#consentChk"):
                    page.check("#consentChk"); setup_taps += 1
                if page.is_visible("#imageTermsRow") and not page.is_checked("#imageTermsChk"):
                    page.check("#imageTermsChk"); setup_taps += 1
                page.click("#importBtn"); taps += 1        # "ekle"
                page.wait_for_selector("#resultBox.ok", timeout=180000)
                t_added = time.time() - t0
                sent_note = page.inner_text("#resultBox")
                pid = page.evaluate("async (b) => (await HS.db.from('products').select('id').gt('id', b).order('id', {ascending:false}).limit(1)).data?.[0]?.id", before)
                made.append(pid)
                # Bağlı tüm Amazon pazarlarında kabul (ya da kesin hata) bekle
                first_ok, ls = None, []
                while time.time() - t0 < 300:
                    ls = amazon_listings(page, pid)
                    acc = [l for l in ls if (l.get("validation") or {}).get("amazon", {}).get("accepted")]
                    if acc and first_ok is None:
                        first_ok = time.time() - t0
                    done = [l for l in ls if (l.get("validation") or {}).get("amazon", {}).get("accepted") or (l.get("last_sync_error") and l["last_sync_error"] not in ("prova_ok",))]
                    if ls and len(done) == len(ls) and len(ls) >= n_conn:
                        break
                    time.sleep(1)
                t_all = time.time() - t0
                acc = [l for l in ls if (l.get("validation") or {}).get("amazon", {}).get("accepted")]
                tim = [(l.get("validation") or {}).get("amazon", {}).get("timings") or {} for l in acc]
                worst = max(tim, key=lambda x: x.get("total", 0)) if tim else {}
                warns = sum(len((l.get("validation") or {}).get("warnings") or []) for l in ls)
                fixes = sum(len((l.get("validation") or {}).get("amazon", {}).get("fixes") or []) for l in ls)
                types = sorted({(l.get("validation") or {}).get("amazon", {}).get("productType") for l in acc} - {None})
                errs = [f"{l['marketplace_code']}: {l.get('last_sync_error')} {json.dumps((l.get('validation') or {}).get('errors') or [], ensure_ascii=False)[:200]}" for l in ls if l not in acc]
                rows.append({"cat": cat, "preview": t_preview, "added": t_added, "first": first_ok, "all": t_all, "taps": taps, "markets": f"{len(acc)}/{len(ls)}",
                             "types": ",".join(types), "worst": worst, "fixes": fixes, "warns": warns, "errs": errs,
                             "titles": {l["marketplace_code"]: (l.get("validation") or {}).get("amazon", {}).get("content", {}).get("title", "")[:70] for l in acc},
                             "prices": {l["marketplace_code"]: f"{l['price']} {l['currency']}" for l in ls}})
                c.check(f"{cat}: tüm Amazon pazarlarında kabul", len(acc) == len(ls) and len(ls) >= n_conn, rows[-1]["markets"] + (" | " + "; ".join(errs[:2]) if errs else ""))
                c.check(f"{cat}: süre < {TARGET_S} sn", t_all < TARGET_S, f"{t_all:.1f} sn")
                c.check(f"{cat}: tıklama ≤ {TARGET_TAPS}", taps <= TARGET_TAPS, f"{taps}")
        finally:
            if made:
                page.evaluate("""async (ids) => { await HS.db.from('listings').update({ deleted_at: new Date().toISOString() }).in('product_id', ids).like('marketplace_code', 'amazon_%');
                    await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids); }""", made)
        browser.close()
    print("\nSÜRE TABLOSU (link yapıştırma -> tüm Amazon pazarlarında kabul)")
    print(f"{'Kategori':16} {'Önizleme':>9} {'Eklendi':>8} {'İlk pazar':>10} {'5 pazar':>8} {'Tık':>4} {'Pazar':>6}  Amazon türü / en yavaş ilanın adımları")
    for r in rows:
        print(f"{r['cat']:16} {r['preview']:8.1f}s {r['added']:7.1f}s {(r['first'] or 0):9.1f}s {r['all']:7.1f}s {r['taps']:>4} {r['markets']:>6}  {r['types']} {json.dumps(r['worst'])} düzeltme {r['fixes']}, uyarı {r['warns']}")
    if rows:
        print(f"ORTALAMA: {sum(r['all'] for r in rows) / len(rows):.1f} sn / ürün (5 pazar), ilk pazar {sum((r['first'] or 0) for r in rows) / len(rows):.1f} sn; bir kerelik ayar tıklaması: {setup_taps}")
        for r in rows[:1]:
            print("Örnek başlıklar:", json.dumps(r["titles"], ensure_ascii=False))
            print("Örnek fiyatlar:", json.dumps(r["prices"], ensure_ascii=False))
        json.dump(rows, open(sys.argv[1] if len(sys.argv) > 1 else "amazon_hiz_sonuc.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=str)
    c.finish()


if __name__ == "__main__":
    main()
