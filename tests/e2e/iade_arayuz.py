"""İade otomasyonu — arayüz (Playwright, test kullanıcısı).

 A) Takip sayfası: "↩️ İade talebi" bölümü, iade taşıyıcısı / ücretsiz iade / kalan gün, "İade talebi oluştur" formu
    (fotoğraf yalnız ayıplı nedenlerde, adresten alım seçeneği), "Vazgeçtim" -> "İaden onaylandı"; İade Politikası metni;
    "Cayma hakkı yok" üründe yalnız 4 neden
 B) Siparişler > "↩️ İadeler": Karar bekliyor -> [Onayla]; yasal cayma -> "reddedilemez", [Reddet] yok;
    [Teslim aldım] -> Para iadesi bekliyor -> [Parayı iade ettim] -> İade edildi; [Fotoğrafları gör]
 C) Ayarlar > "↩️ İade Kuralları": TR yasal çerçeve, kargo ücreti kilitli, süre 14'ün altına inmez, sınır kaydedilir, politika önizlemesi
 D) Ürün düzenle: "Cayma hakkı yok" + neden -> kaydedilir (elle)
 E) Vitrin: Ön Bilgilendirme Formu onayı zorunlu, İade Politikası alt bilgide
 F) Asistan (test kanalı): [Onayla] / [Reddet] (ikinci onay) / [Parayı iade ettim]
Sonunda test kayıtları silinir.
"""
import os
import secrets
import subprocess
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
SLUG = "e2e-test-magaza"


def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "csv"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=180)
        return (r.stdout or "") + (r.stderr or "")


FN = """async ([fn, payload, auth]) => {
  if (auth) payload.userAccessToken = (await HS.db.auth.getSession()).data.session.access_token;
  const res = await fetch(HS.SUPABASE_URL + '/functions/v1/' + fn, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify(payload) });
  return await res.json().catch(() => ({})); }"""


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900}, locale="tr-TR")
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        login(page)
        page.goto(f"{SITE}/dashboard.html")
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")
        fn = lambda name, payload, auth=False: page.evaluate(FN, [name, payload, auth])
        tag = "E2E-IADE-UI-" + secrets.token_hex(3)
        out = sql(f"""insert into public.products (user_id, name, sale_price, stock_qty, store_visible, content_language) values
          ('{uid}', '{tag} tisort', 250, 5, false, 'tr'), ('{uid}', '{tag} kozmetik', 90, 5, false, 'tr') returning id;""")
        ids = [int(x) for x in out.split() if x.strip().isdigit()]
        own, hyg = ids[0], ids[1]
        sql(f"update public.products set withdrawal_exempt = true, withdrawal_exempt_reason = 'hygiene', withdrawal_exempt_manual = true where id = {hyg};")
        tokens = []

        def order(pid, days=2):
            t = secrets.token_hex(16)
            sql(f"""insert into public.store_orders (user_id, product_id, customer_name, customer_phone, customer_address, customer_city, customer_district, status, quantity, unit_price, currency, tracking_token, shipped_at, delivered_at)
              values ('{uid}', {pid}, 'E2E Alıcı', '0555{secrets.randbelow(10**7):07d}', 'Caferağa Mah. Test Sok. No 5', 'İstanbul', 'Kadıköy', 'delivered', 1, 250, 'TRY', '{t}', now() - interval '{days + 2} days', now() - interval '{days} days');""")
            tokens.append(t)
            return t

        link_made = False
        try:
            # ---------- A) Takip sayfası ----------
            t1 = order(own)
            cust = browser.new_page(viewport={"width": 420, "height": 900})
            cust.on("pageerror", lambda e: errors.append(str(e)))
            cust.goto(f"{SITE}/takip.html?t={t1}")
            cust.wait_for_selector("#retBox h2", timeout=30000)
            box = cust.inner_text("#retBox")
            c.check("Takip: '↩️ İade talebi' bölümü, taşıyıcı, ücretsiz iade, kalan gün", "↩️ İade talebi" in box and "İade taşıyıcısı: Yurtiçi Kargo" in box and "İade kargo ücretsiz" in box and "12 gün kaldı" in box, box[:200])
            cust.click("#retOpenBtn")
            opts = cust.locator("#retReason option").all_inner_texts()
            c.check("Form: 8 iade nedeni (onaylı adlar)", opts == ["Beden / ölçü uymadı", "Vazgeçtim", "Ürün kusurlu", "Hasarlı geldi", "Yanlış ürün geldi", "Açıklamayla uyuşmuyor", "Geç geldi", "Diğer"], str(opts))
            cust.select_option("#retReason", "defective")
            vis_def = cust.is_visible("#retPhotoBox")
            cust.select_option("#retReason", "changed_mind")
            c.check("Fotoğraf alanı yalnız ayıplı mal nedeninde", vis_def and not cust.is_visible("#retPhotoBox"))
            c.check("Adresten alım seçeneği (TR)", cust.is_visible("#retPickup") and "kargo şubesi yok" in cust.inner_text("#retBox"))
            c.check("İade Politikası metni (ön bilgilendirme) sayfada", "İade taşıyıcısı: Yurtiçi Kargo." in cust.locator("#retBox details pre").text_content())
            cust.fill("#retText", "Fikrim değişti")
            cust.screenshot(path=str(Path(shots) / "iade_takip_form.png"), full_page=True)
            cust.click("#retSendBtn")
            cust.wait_for_function("() => /İaden onaylandı|Talebin alındı/.test(document.getElementById('retBox').innerText)", timeout=180000)
            c.check("Vazgeçtim (yasal cayma) -> 'İaden onaylandı'", "İaden onaylandı" in cust.inner_text("#retBox"), cust.inner_text("#retBox")[:160])
            cust.screenshot(path=str(Path(shots) / "iade_takip_onay.png"), full_page=True)
            t2 = order(hyg)
            cust.goto(f"{SITE}/takip.html?t={t2}")
            cust.wait_for_selector("#retOpenBtn", timeout=30000)
            cust.click("#retOpenBtn")
            o2 = cust.locator("#retReason option").all_inner_texts()
            c.check("'Cayma hakkı yok' ürün: yalnız kusurlu / yanlış ürün nedenleri + açıklama", o2 == ["Ürün kusurlu", "Hasarlı geldi", "Yanlış ürün geldi", "Açıklamayla uyuşmuyor"] and "yalnızca kusurlu" in cust.inner_text("#retBox"), str(o2))

            # ---------- B) Siparişler > İadeler ----------
            t3 = order(own)
            r3 = fn("returns", {"action": "request", "token": t3, "reasonCode": "wrong_item", "text": "Mavi yerine kırmızı geldi"})
            sql(f"insert into public.user_feature_overrides (user_id, key, enabled, note) values ('{uid}', 'returns_auto', false, 'e2e') on conflict (user_id, key) do update set enabled = false;")
            t4 = order(own)
            r4 = fn("returns", {"action": "request", "token": t4, "reasonCode": "size"})
            sql(f"delete from public.user_feature_overrides where user_id = '{uid}' and key = 'returns_auto';")
            page.goto(f"{SITE}/orders.html#returns")
            page.wait_for_selector(f"[data-ret='{r3['return']['id']}']", timeout=30000)
            row3 = page.locator(f"[data-ret='{r3['return']['id']}']")
            row4 = page.locator(f"[data-ret='{r4['return']['id']}']")
            c.check("İadeler sekmesi: 'Karar bekliyor', [Onayla] [Reddet]", "Karar bekliyor" in row3.inner_text() and row3.locator("button", has_text="Onayla").count() == 1 and row3.locator("button", has_text="Reddet").count() == 1, row3.inner_text()[:200])
            c.check("Yasal cayma: 'reddedilemez' işareti, [Reddet] yok", "reddedilemez" in row4.inner_text() and row4.locator("button", has_text="Reddet").count() == 0, row4.inner_text()[:200])
            page.check("#rtPending")
            c.check("'Karar bekleyenler' süzgeci", page.locator("[data-ret]").count() >= 2 and all("Karar bekliyor" in x for x in page.locator("[data-ret]").all_inner_texts()))
            page.uncheck("#rtPending")
            page.screenshot(path=str(Path(shots) / "iade_panel.png"), full_page=True)
            row3.locator("button", has_text="Onayla").click()
            page.wait_for_function(f"() => !/Karar bekliyor/.test(document.querySelector(\"[data-ret='{r3['return']['id']}']\").innerText)", timeout=180000)
            row3 = page.locator(f"[data-ret='{r3['return']['id']}']")
            c.check("[Onayla] -> onaylandı / etiket hazır", any(x in row3.inner_text() for x in ["Etiket hazır", "Onaylandı"]), row3.inner_text()[:160])
            row3.locator("button", has_text="Teslim aldım").click()
            page.wait_for_function(f"() => /Para iadesi bekliyor/.test(document.querySelector(\"[data-ret='{r3['return']['id']}']\").innerText)", timeout=60000)
            row3 = page.locator(f"[data-ret='{r3['return']['id']}']")
            c.check("[Teslim aldım] -> 'Para iadesi bekliyor' + son gün", "Para iadesi bekliyor" in row3.inner_text(), row3.inner_text()[:200])
            row3.locator("button", has_text="Parayı iade ettim").click()
            page.wait_for_function(f"() => /İade edildi/.test(document.querySelector(\"[data-ret='{r3['return']['id']}']\").innerText)", timeout=60000)
            c.check("[Parayı iade ettim] -> 'İade edildi'", True)

            # ---------- C) Ayarlar > İade Kuralları ----------
            page.goto(f"{SITE}/ayarlar.html#iade-kurallari")
            page.wait_for_selector("#rrLaw", timeout=30000)
            page.wait_for_function("() => document.getElementById('rrLaw').textContent.length > 10", timeout=30000)
            c.check("Yasal çerçeve: Mesafeli Sözleşmeler Yönetmeliği (TR)", "Mesafeli Sözleşmeler Yönetmeliği" in page.text_content("#rrLaw"), page.text_content("#rrLaw"))
            c.check("'Kargo ücretini müşteri öder' kilitli + yasal açıklama", page.is_disabled("#rr_customer_pays") and not page.is_checked("#rr_customer_pays") and "Yasal zorunluluk" in page.text_content("#rrPaysHint"))
            c.check("Fotoğraf nedenleri ve cayma nedenleri kilitli", page.locator("#rrPhotoReasons input:disabled").count() == 4 and page.locator("#rrAutoReasons input:disabled").count() == 4)
            page.fill("#rr_window", "10")
            page.fill("#rr_max", "1500")
            page.click("#saveBtn")
            page.wait_for_function("() => /kaydedildi|Kaydedildi|saved/i.test(document.querySelector('.status')?.textContent || '')", timeout=30000)
            rr = page.evaluate("async () => (await HS.db.from('return_rules').select('window_days, max_auto_amount, customer_pays').maybeSingle()).data")
            c.check("Süre yasal minimumun (14) altına inmedi; sınır kaydedildi", rr and rr["window_days"] == 14 and float(rr["max_auto_amount"]) == 1500 and rr["customer_pays"] is False, str(rr))
            page.fill("#rr_window", "30")
            page.click("#saveBtn")
            page.wait_for_function("() => /30 gün/.test(document.getElementById('rrPolicyText').textContent)", timeout=30000)
            c.check("Lehine uzatma (30 gün) politika metnine yansıdı", "30 gün" in page.text_content("#rrPolicyText"))
            page.screenshot(path=str(Path(shots) / "iade_ayarlar.png"), full_page=True)

            # ---------- D) Ürün düzenle: Cayma hakkı yok ----------
            page.goto(f"{SITE}/urun-duzenle.html?id={own}")
            page.wait_for_selector("#fNoWd", timeout=30000)
            c.check("Ürün düzenle: 'Cayma hakkı yok' + istisna açıklaması", "Cayma hakkı yok" in page.inner_text("body") and "akıllı saat istisna DEĞİLDİR" in page.inner_text("body"))
            page.check("#fNoWd")
            page.wait_for_selector("#fWdReason")
            page.select_option("#fWdReason", "personalized")
            page.locator("button", has_text="Kaydet").first.click()
            page.wait_for_timeout(4000)
            pr = page.evaluate(f"async () => (await HS.db.from('products').select('withdrawal_exempt, withdrawal_exempt_reason, withdrawal_exempt_manual').eq('id', {own}).single()).data")
            c.check("Kaydedildi: istisna + neden + elle", pr["withdrawal_exempt"] and pr["withdrawal_exempt_reason"] == "personalized" and pr["withdrawal_exempt_manual"], str(pr))

            # ---------- E) Vitrin ----------
            store = browser.new_page()
            store.on("pageerror", lambda e: errors.append(str(e)))
            store.goto(f"{SITE}/magaza.html?slug={SLUG}")
            store.wait_for_selector("#policyFoot", state="visible", timeout=60000)
            c.check("Vitrin: 'İade Politikası' alt bilgide", "İade Politikası" in store.inner_text("#policyFoot summary"))
            store.wait_for_selector(".card .buy-btn", timeout=60000)
            store.locator(".card .buy-btn").first.click()
            store.wait_for_selector("#orderModalOverlay.open")
            c.check("Sipariş formu: 'Ön Bilgilendirme Formu' onayı zorunlu", store.is_visible("#orderPreinfo") and store.get_attribute("#orderPreinfo", "required") is not None and "Ön Bilgilendirme Formu" in store.inner_text("#preinfoBox"))
            store.click("#preinfoLink")
            c.check("Ön bilgilendirme metni açılır (taşıyıcı + 14 gün)", "İade taşıyıcısı" in store.text_content("#preinfoText") and "14 gün" in store.text_content("#preinfoText"))
            store.screenshot(path=str(Path(shots) / "iade_vitrin.png"), full_page=True)

            # ---------- F) Asistan düğmeleri ----------
            CALL = """async (p) => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
              const res = await fetch(HS.SUPABASE_URL + '/functions/v1/assistant', { method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify({ ...p, userAccessToken: tok }) });
              return await res.json().catch(() => ({})); }"""
            say = lambda **kw: page.evaluate(CALL, dict(action="test", externalId="iade", **kw))
            txt = lambda r: "\n".join(x.get("text", "") for x in (r.get("replies") or []))
            code = page.evaluate(CALL, {"action": "link_code", "channel": "test"})["code"]
            say(text=code); link_made = True
            t5, t6 = order(own), order(own)
            sql(f"update public.products set withdrawal_exempt = false, withdrawal_exempt_reason = null, withdrawal_exempt_manual = false where id = {own};")
            a5 = fn("returns", {"action": "request", "token": t5, "reasonCode": "damaged", "text": "Kırık geldi"})["return"]["id"]
            a6 = fn("returns", {"action": "request", "token": t6, "reasonCode": "not_as_described"})["return"]["id"]
            r = say(callback=f"ret_ok:{a5}")
            c.check("Asistan [Onayla] -> iade onaylandı", "İade onaylandı" in txt(r), txt(r)[:160])
            r = say(callback=f"ret_no:{a6}")
            c.check("Asistan [Reddet] -> ikinci onay ister", "Emin misin" in txt(r), txt(r))
            r = say(callback="confirm")
            st6 = sql(f"select status from public.returns where id = '{a6}';")
            c.check("[Evet] -> iade talebi reddedildi", "reddedildi" in txt(r) and "rejected" in st6, txt(r) + " " + st6[-20:])
            fn("returns", {"action": "received", "returnId": a5}, True)
            r = say(callback=f"ret_paid:{a5}")
            r = say(callback="confirm")
            st5 = sql(f"select refund_status from public.returns where id = '{a5}';")
            c.check("Asistan [Parayı iade ettim] (ikinci onayla) -> kaydedildi", "Para iadesi kaydedildi" in txt(r) and "done" in st5, txt(r) + " " + st5[-20:])
            c.check("Sayfalarda JavaScript hatası yok", not errors, str(errors[:3]))
        finally:
            toks = ",".join(f"'{t}'" for t in tokens) or "''"
            sql(f"""delete from public.refund_ledger where return_id in (select r.id from public.returns r join public.store_orders s on s.id = r.store_order_id where s.tracking_token in ({toks}));
              delete from public.shipments where return_id in (select r.id from public.returns r join public.store_orders s on s.id = r.store_order_id where s.tracking_token in ({toks}));
              delete from public.returns where store_order_id in (select id from public.store_orders where tracking_token in ({toks}));
              delete from public.store_orders where tracking_token in ({toks});
              delete from public.products where id in ({own}, {hyg});
              delete from public.return_rules where user_id = '{uid}';
              delete from public.user_feature_overrides where user_id = '{uid}' and key = 'returns_auto';
              {"delete from public.assistant_links where user_id = '" + uid + "' and channel = 'test';" if link_made else ""}""")
            browser.close()
    c.finish()


if __name__ == "__main__":
    main()
