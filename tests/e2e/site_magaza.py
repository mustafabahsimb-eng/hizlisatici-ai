"""Link ver, mağazan hazır (Mağazanı Kur -> "Web sitenin adresi" -> "Ürünlerimi getir").

Gerçek bir WooCommerce demo sitesi (demos.flatsome.com) test kullanıcısının mağazasına taşınır:
 1) Mağazanı Kur'da site adresi -> arka plan işi -> ilerleme -> "N ürün mağazanda yayında" (süre ölçülür; HIZ hedefi 100 ürün < 10 dk)
 2) Panelde bildirim (site.done)
 3) Mağaza: başlıkta site bağlantısı, ürün kartında "Satıcının sitesinde gör" (yalnız satıcının kendi sitesi)
 4) Ayarlar: "Web sitem" + "Satın Al düğmesi kendi siteme gitsin" -> mağazada Satın Al siteye gider, tıklama kaydedilir
 5) "Bu ürünleri diğer kanallara da gönder": test pazaryeri bağlantısına ilanlar açılır; sync-worker beklemeden prova eder
Sonunda: ürünler silinir, test bağlantısı ve ayarlar geri alınır.
"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks
import os
import subprocess
import tempfile

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"


def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "csv"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=120)
        return (r.stdout or "") + (r.stderr or "")

SITE_URL = "demos.flatsome.com"


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        page = ctx.new_page()
        login(page)
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")
        before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        old_store = page.evaluate("async () => (await HS.db.from('store_settings').select('store_slug, website_url, buy_on_website').maybeSingle()).data")
        conn_id = None
        try:
            # 1) Mağazanı Kur
            page.goto(f"{SITE}/store-builder.html")
            page.wait_for_selector("#siteInput", timeout=30000)
            page.wait_for_function("() => document.getElementById('siteBtn').textContent.trim() !== ''", timeout=20000)
            c.check("Mağazanı Kur: \"Web sitenin adresi\" + [Ürünlerimi getir]",
                    page.text_content("label[for=siteInput]") == "Web sitenin adresi" and page.text_content("#siteBtn") == "Ürünlerimi getir")
            page.fill("#siteInput", SITE_URL)
            if page.is_visible("#siteConsentRow"):
                page.check("#siteConsent")
            t0 = time.time()
            page.click("#siteBtn")
            page.wait_for_selector("#siteProgress", state="visible", timeout=30000)
            page.screenshot(path=str(Path(shots) / "site_ilerleme.png"))
            page.wait_for_selector("#siteDone", state="visible", timeout=600000)
            took = time.time() - t0
            title = page.inner_text("#siteDoneTitle")
            n = int(title.split(" ")[0]) if title.split(" ")[0].isdigit() else 0
            c.check("Site ürünleri mağazada yayında", n >= 10 and "mağazanda yayında" in title, title)
            per100 = took / max(n, 1) * 100
            c.check("HIZ: 100 ürün başına < 10 dk", per100 < 600, f"{n} ürün {took:.0f} sn (100 ürün ≈ {per100:.0f} sn)")
            print(f"   {n} ürün {took:.1f} sn'de mağazada (100 ürün için ≈ {per100/60:.1f} dk)")
            page.screenshot(path=str(Path(shots) / "site_bitti.png"), full_page=True)
            slug = page.get_attribute("#siteOpenStore", "href").split("slug=")[1]

            # 2) Panel bildirimi
            page.goto(f"{SITE}/dashboard.html")
            page.wait_for_selector("#siteBanner", state="visible", timeout=30000)
            c.check("Panelde bildirim", "mağazanda yayında" in page.inner_text("#siteSummary"), page.inner_text("#siteSummary")[:100])

            # 3) Mağaza
            store = ctx.new_page()
            store.goto(f"{SITE}/magaza.html?slug={slug}")
            store.wait_for_selector(".card", timeout=60000)
            c.check("Mağaza başlığında site bağlantısı", store.is_visible("#storeWebsite") and "demos.flatsome.com" in store.inner_text("#storeWebsite"))
            links = store.locator(".seller-link")
            c.check("Ürün kartında \"Satıcının sitesinde gör\"", links.count() >= 10 and links.first.inner_text() == "Satıcının sitesinde gör"
                    and "demos.flatsome.com" in (links.first.get_attribute("href") or ""), str(links.count()))

            # 4) Ayarlar
            page.goto(f"{SITE}/ayarlar.html")
            page.wait_for_selector("#website_url", timeout=30000)
            page.wait_for_function("() => document.getElementById('website_url').value !== ''", timeout=20000)
            c.check("Ayarlar: \"Web sitem\" dolu", "demos.flatsome.com" in page.input_value("#website_url") and page.text_content("label[for=website_url]") == "Web sitem")
            page.check("#buy_on_website")
            page.click("#saveBtn")
            page.wait_for_timeout(2500)
            store.reload()
            store.wait_for_selector(".card .seller-link", timeout=60000)
            card = store.locator(".card").filter(has=store.locator(".seller-link")).first
            pid = None
            with ctx.expect_page(timeout=15000) as pop:
                card.locator(".buy-btn").click()
            newp = pop.value
            newp.wait_for_load_state("domcontentloaded", timeout=30000)
            c.check("Satın Al -> satıcının sitesi (yeni sekme)", "demos.flatsome.com" in newp.url, newp.url[:80])
            c.check("Sipariş penceresi açılmadı", not store.is_visible("#orderModalOverlay.open"))
            newp.close()
            time.sleep(2)
            clicks = page.evaluate("async () => (await HS.db.from('store_outbound_clicks').select('kind').gt('created_at', new Date(Date.now()-120000).toISOString())).data")
            c.check("Tıklama kaydedildi (buy)", any(x["kind"] == "buy" for x in clicks or []), str(clicks)[:80])

            # 5) Diğer kanallara gönder (test pazaryeri bağlantısı)
            # Bağlantılar tarayıcıdan açılamaz (yalnız sunucu); test bağlantısı veritabanından açılır
            ext = "E2E-" + str(int(time.time()))
            out = sql(f"insert into public.store_connections (user_id, marketplace_code, environment, status, label, external_seller_id) values ('{uid}', 'hepsiburada_tr', 'sandbox', 'connected', 'Hepsiburada (E2E test)', '{ext}') returning id;")
            conn_id = next((x.strip() for x in out.splitlines() if len(x.strip()) == 36), "ERR " + out[-200:])
            if str(conn_id).startswith("ERR"):
                c.check("Test pazaryeri bağlantısı açılabildi", False, conn_id)
                conn_id = None
            else:
                page.goto(f"{SITE}/store-builder.html")
                page.wait_for_selector("#siteDone", state="visible", timeout=30000)
                page.wait_for_selector("#distList input", timeout=30000)
                names = page.locator("#distList label").all_inner_texts()
                c.check("Kanal listesi: test bağlantısı görünüyor", any("Hepsiburada (E2E test)" in x for x in names), str(names))
                page.locator("#distList input").evaluate_all("els => els.forEach(e => e.checked = false)")
                page.locator("#distList label", has_text="Hepsiburada (E2E test)").locator("input").check()
                c.check("Düğme \"Bu ürünleri diğer kanallara da gönder\"", page.text_content("#distBtn") == "Bu ürünleri diğer kanallara da gönder")
                page.click("#distBtn")
                page.wait_for_selector("#distNote:has-text('Gönderildi')", timeout=60000)
                note = page.inner_text("#distNote")
                c.check("İlanlar açıldı", f"{n} ilan" in note and "Hepsiburada (E2E test)" in note, note)
                t1 = time.time()
                validated = 0
                for _ in range(30):
                    validated = page.evaluate("async (cid) => (await HS.db.from('listings').select('id', { count: 'exact', head: true }).eq('connection_id', cid).not('validated_at', 'is', null)).count", conn_id)
                    if validated >= n:
                        break
                    time.sleep(3)
                c.check("sync-worker beklemeden işledi (prova)", validated >= n, f"{validated}/{n} ilan {time.time()-t1:.0f} sn'de kontrol edildi")
                page.screenshot(path=str(Path(shots) / "site_dagitim.png"), full_page=True)

            # Telefon genişliği
            page.set_viewport_size({"width": 375, "height": 800})
            sw = page.evaluate("() => document.documentElement.scrollWidth")
            c.check("Telefonda yatay kaydırma yok (Mağazanı Kur)", sw <= 376, str(sw))
        finally:
            page.evaluate("""async (a) => {
                const uid = (await HS.db.auth.getUser()).data.user.id;
                if (a.conn) await HS.db.from('listings').update({ deleted_at: new Date().toISOString(), status: 'draft' }).eq('connection_id', a.conn);
                const ids = (await HS.db.from('products').select('id').gt('id', a.before)).data.map(x => x.id);
                for (let i = 0; i < ids.length; i += 200) await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids.slice(i, i + 200));
                await HS.db.from('store_settings').update({ website_url: a.old ? a.old.website_url : null, buy_on_website: a.old ? !!a.old.buy_on_website : false }).eq('user_id', uid);
                await HS.db.from('site_import_jobs').update({ notified_at: new Date().toISOString() }).is('notified_at', null);
                await HS.db.from('image_job_batches').update({ notified_at: new Date().toISOString() }).eq('user_id', uid).is('notified_at', null);
            }""", {"conn": conn_id, "before": before, "old": old_store})
            if conn_id:
                sql(f"update public.store_connections set deleted_at = now() where id = '{conn_id}';")
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
