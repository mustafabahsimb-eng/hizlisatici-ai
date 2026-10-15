"""📣 Reklamlar (ads.html) — arayüz (test kullanıcısı; Meta bağlantısı olmadan).

 1) Panel menüsünde "📣 Reklamlar"; sayfa: test notu, ⚡ Tam otomatik, "Facebook'u reklam izniyle bağla"
 2) Varsayılanlar (Mustafa, 18 Ekim): bütçe boş, otomatik reklam ve otomatik artırma kapalı, onay açık, ROAS 3, kâr %25, durdurma 3 gün
 3) Kurallar kaydedilir; tam otomatik tek tık: sınırlar + otomatik aç + otomatik artır + doğrudan yayın
 4) Bağlı (sandbox) hesap: test etiketi, piksel; önerilen ürünler (kâr, başabaş) + reklama uygun olmayanlar nedenleriyle; "Reklam aç"
 5) Kampanyalar: Onay bekliyor / Yayında / Durdu, düğmeler ve son 7 gün (Harcama, Satış, ROAS); bütçe sınırı aşılamaz
"""
import os
import secrets
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"


def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "csv"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=180)
        return (r.stdout or "") + (r.stderr or "")


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")
        sql(f"delete from public.ad_rules where user_id = '{uid}'; delete from public.ad_campaigns where user_id = '{uid}'; delete from public.ad_accounts where user_id = '{uid}';")
        tag = "E2E-ADS-UI-" + secrets.token_hex(3)
        out = sql(f"""insert into public.products (user_id, name, sale_price, supplier_price, cost_currency, stock_qty, store_visible, image_url) values
          ('{uid}', '{tag} karli', 1000, 5, 'USD', 10, true, 'https://picsum.photos/400'),
          ('{uid}', '{tag} maliyetsiz', 500, null, null, 10, true, 'https://picsum.photos/400') returning id;""")
        ids = [int(x) for x in out.split() if x.strip().isdigit()]
        try:
            page.goto(f"{SITE}/dashboard.html")
            page.wait_for_selector("[data-i18n='menu.ads']", state="attached", timeout=30000)
            c.check("Panel menüsünde '📣 Reklamlar'", "📣 Reklamlar" in page.text_content("[data-i18n='menu.ads']"))
            page.goto(f"{SITE}/ads.html")
            page.wait_for_selector("#rulesCard", timeout=30000)
            body = page.inner_text("main")
            c.check("Sayfa: başlık, test notu, ⚡ Tam otomatik, Facebook reklam izni düğmesi",
                    "📣 Reklamlar" in body and "reklam yayınlanmaz, para harcanmaz" in body and "⚡ Tam otomatik" in body and page.is_visible("#fbBtn") and "Facebook'u reklam izniyle bağla" in page.text_content("#fbBtn"))
            vals = page.evaluate("() => ['rDaily','rMonthly','rRoas','rMargin','rPause'].map(i => document.getElementById(i).value)")
            chk = page.evaluate("() => ['rAuto','rScale','rApproval'].map(i => document.getElementById(i).checked)")
            c.check("Varsayılanlar: bütçe boş (0), ROAS 3, kâr %25, 3 gün; otomatik aç / artır kapalı, onay açık", vals == ["0", "0", "3", "25", "3"] and chk == [False, False, True], f"{vals} {chk}")
            labels = page.inner_text("#rulesCard")
            c.check("Kural adları (onaylı)", all(x in labels for x in ["Günlük bütçe sınırı", "Aylık bütçe sınırı", "Hedef ROAS (satış / harcama)", "En düşük kâr oranı (%)",
                    "Kârlı ürünlere otomatik reklam aç", "İyi giden reklamın bütçesini otomatik artır", "Hedefin altında kalırsa durdur (gün)", "Yeni reklamı yayından önce onayıma sun", "Kaydet"]))
            page.screenshot(path=str(Path(shots) / "reklam_bos.png"), full_page=True)
            # Kuralları kaydet
            page.fill("#rDaily", "200"); page.fill("#rMonthly", "4000"); page.fill("#rRoas", "3.5")
            page.click("#saveBtn")
            page.wait_for_function("() => document.getElementById('rDaily') && document.getElementById('rDaily').value === '200'", timeout=30000)
            rr = page.evaluate("async () => (await HS.db.from('ad_rules').select('daily_cap, monthly_cap, target_roas, auto_launch, approval_mode').maybeSingle()).data")
            c.check("Kurallar kaydedildi", rr and float(rr["daily_cap"]) == 200 and float(rr["monthly_cap"]) == 4000 and float(rr["target_roas"]) == 3.5 and rr["auto_launch"] is False and rr["approval_mode"] == "approve", str(rr))

            # Bağlı sandbox hesap + kampanyalar
            sql(f"""insert into public.ad_accounts (user_id, platform, external_id, name, currency, sandbox, pixel_id, page_id, status) values
              ('{uid}', 'meta', 'act_e2e_ui', 'E2E Sandbox', 'TRY', true, '1234567890123', 'PAGE_E2E', 'connected');
              insert into public.ad_campaigns (user_id, account_id, name, status, daily_budget, currency, product_ids, spend_7d, revenue_7d, roas_7d)
              select '{uid}', id, n, st, 100, 'TRY', array[{ids[0]}]::bigint[], sp, rv, ro from public.ad_accounts,
              (values ('{tag} onay', 'pending_approval', 0, 0, null), ('{tag} yayin', 'active', 700, 2800, 4), ('{tag} durdu', 'paused', 300, 300, 1)) v(n, st, sp, rv, ro)
              where user_id = '{uid}';""")
            page.reload()
            page.wait_for_selector("#prodCard", timeout=30000)
            acc = page.inner_text("#accCard")
            c.check("Hesap kartı: bağlı, test etiketi, piksel", "E2E Sandbox" in acc and "Bağlı" in acc and "reklam yayınlanmaz" in acc and "1234567890123" in acc, acc[:200])
            prod = page.inner_text("#prodCard")
            c.check("Önerilen ürünler: kârlı ürün (kâr, başabaş ROAS) + 'Reklam aç'", f"{tag} karli" in prod and "Başabaş ROAS" in prod and page.is_visible("#launchBtn"), prod[:200])
            page.click("#prodCard details summary")
            c.check("Reklama uygun olmayanlar nedenleriyle", "Maliyet bilinmiyor" in page.inner_text("#prodCard"))
            camp = page.inner_text("#campCard")
            c.check("Kampanyalar: Onay bekliyor / Yayında / Durdu + son 7 gün Harcama / Satış / ROAS", all(x in camp for x in ["Onay bekliyor", "Yayında", "Durdu", "Harcama", "Satış", "ROAS", "4"]), camp[:300])
            btns = page.locator("#campCard button").all_inner_texts()
            c.check("Düğmeler: Onayla, Durdur, Devam ettir, Bütçeyi değiştir", all(x in btns for x in ["Onayla", "Durdur", "Devam ettir", "Bütçeyi değiştir"]), str(btns))
            page.screenshot(path=str(Path(shots) / "reklam_dolu.png"), full_page=True)
            # Bütçe sınırı: 500 istenince sınır (200 - diğer aktif 100) uygulanır; Meta bağlantısı yoksa yapılamaz mesajı
            page.once("dialog", lambda d: d.accept("500"))
            page.locator("#campCard [data-act='budget']").first.click()
            page.wait_for_selector("#toast", state="visible", timeout=30000)
            c.check("Bütçe değişikliği: Meta bağlantısı olmadan yapılamaz (anlaşılır mesaj)", "Facebook" in page.text_content("#toast"), page.text_content("#toast"))

            # Tam otomatik tek tık
            sql(f"delete from public.ad_rules where user_id = '{uid}'; update public.ad_campaigns set status = 'stopped' where user_id = '{uid}';")
            page.reload()
            page.wait_for_selector("#autoBtn", timeout=30000)
            c.check("⚡ Tam otomatik: 'Tam otomatik moda geç' düğmesi", "Tam otomatik moda geç" in page.text_content("#autoBtn"))
            page.click("#autoBtn")
            page.wait_for_selector("#toast", state="visible", timeout=10000)
            c.check("Sınır girilmeden tam otomatiğe geçilmez", "bütçe sınırı" in page.text_content("#toast"), page.text_content("#toast"))
            page.fill("#qDaily", "150"); page.fill("#qMonthly", "3000")
            page.click("#autoBtn")
            page.wait_for_function("() => /Tam otomatik mod açık/.test(document.getElementById('autoCard').innerText)", timeout=60000)
            rr = page.evaluate("async () => (await HS.db.from('ad_rules').select('daily_cap, monthly_cap, auto_launch, auto_scale, approval_mode').maybeSingle()).data")
            c.check("Tek tıkla tam otomatik: sınırlar + otomatik aç + otomatik artır + doğrudan yayın", rr and float(rr["daily_cap"]) == 150 and float(rr["monthly_cap"]) == 3000 and rr["auto_launch"] and rr["auto_scale"] and rr["approval_mode"] == "direct", str(rr))
            page.screenshot(path=str(Path(shots) / "reklam_tam_otomatik.png"), full_page=True)
            c.check("Sayfada JavaScript hatası yok", not errors, str(errors[:3]))
        finally:
            sql(f"""delete from public.ad_campaigns where user_id = '{uid}'; delete from public.ad_accounts where user_id = '{uid}'; delete from public.ad_rules where user_id = '{uid}';
              delete from public.products where id in ({','.join(map(str, ids)) or '0'});""")
            browser.close()
    c.finish()


if __name__ == "__main__":
    main()
