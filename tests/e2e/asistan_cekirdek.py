"""Seltigo Asistan çekirdeği: test kanalıyla uçtan uca konuşma (Telegram / WhatsApp aynı çekirdeği kullanır).

Test kullanıcısının kendi "test" sohbeti (assistant fonksiyonu, action=test). Senaryolar:
 1) Bağlı olmayan sohbet reddedilir; panelden alınan kodla bağlanır (Yardım mesajı gelir)
 2) Toptancı PDF'i -> (kuyrukta okunur) özet + [Yayınla] [Panelde kontrol et]; "%50" -> fiyatlar; [Yayınla] -> 6 ürün yayında, satış = alış × 1,5
 3) Ürün linki -> ürün eklenir (Kendi stoğum)
 4) Fotoğraf + "350'ye sat, 20 tane" -> ilan 350 TL, stok 20
 5) Sorular: "bu ay ne kadar kâr ettim", "en çok ne satıyor", "hangi ürün zarar ediyor"
 6) Onay modu ("yayından önce onay iste"): ürün linki -> [Yayınla] [Fiyatları düzenle]; "%45" -> fiyatlar güncellenir; [Yayınla] -> yayında
 7) Kritik iş: "tüm ürünleri sil" -> ikinci onay; [Vazgeç] -> hiçbir şey silinmez
 8) Yeni sipariş bildirimi (kuyruk, 1 dk'lık görev) -> [Siparişi gör]; "bugün gönderilecekler" listesi
 9) Çalışan yetkisi "Sadece siparişler": ürün ekleyemez / kâr soramaz, gönderilecekleri görür
Sonunda test ürünleri ve bağlantılar kaldırılır.
"""
import base64
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks
import katalog_dosyalari as K

SLUG = "e2e-test-magaza"
CALL = """async (p) => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
  const res = await fetch(HS.SUPABASE_URL + '/functions/v1/assistant', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify({ ...p, userAccessToken: tok }) });
  return await res.json().catch(() => ({})); }"""


def inbox_last(page):
    return page.evaluate("async () => (await HS.db.from('assistant_test_inbox').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")


def inbox_wait(page, needle, since, timeout=240):
    """Asistanın arka planda gönderdiği mesajı test gelen kutusunda bekler (yalnız since'ten sonraki mesajlar)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        hit = page.evaluate("""async (a) => (await HS.db.from('assistant_test_inbox').select('reply').gt('id', a[1]).order('id', {ascending:false}).limit(8)).data
            .map(x => x.reply).find(r => (r.text || '').includes(a[0]))""", [needle, since])
        if hit:
            return hit
        time.sleep(3)
    return None


def main():
    shots = shots_dir()
    fx = Path(shots) / "asistan"
    K.main.__globals__["sys"].argv = ["x", str(fx)]
    K.main()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page)
        page.goto(f"{SITE}/dashboard.html")
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        say = lambda ext, **kw: page.evaluate(CALL, dict(action="test", externalId=ext, **kw))
        texts = lambda r: "\n".join(x.get("text", "") for x in (r.get("replies") or []))
        buttons = lambda r: [b["title"] for x in (r.get("replies") or []) for b in (x.get("buttons") or [])]
        page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
            await HS.db.from('assistant_settings').upsert({ user_id: uid, approval_mode: 'direct' }); }""")
        try:
            # 1) Bağlama
            r = say("sahip", text="merhaba")
            c.check("Bağlı olmayan sohbet reddedildi", not r.get("linked") and "bağlı değil" in texts(r), texts(r)[:120])
            code = page.evaluate(CALL, {"action": "link_code", "channel": "test"})["code"]
            r = say("sahip", text=code)
            c.check("Kodla bağlandı, yardım mesajı geldi", r.get("linked") and "bağlandın" in texts(r) and "PDF" in texts(r))

            # 2) PDF
            t0 = time.time()
            pdf = base64.b64encode((fx / "katalog_kodlu.pdf").read_bytes()).decode()
            # PDF + link ile yükleme motoru (catalog-import): kuyrukta okunur, özet + [Yayınla] [Panelde kontrol et] gelir
            page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
                const r = (await HS.db.from('import_rules').select('rules').eq('user_id', uid).maybeSingle()).data;
                await HS.db.from('import_rules').upsert({ user_id: uid, rules: { ...((r && r.rules) || {}), margin: 30 } }); }""")
            ib = inbox_last(page)
            r = say("sahip", fileBase64=pdf, mime="application/pdf", filename="toptanci.pdf")
            c.check("PDF alındı, arka planda okunuyor", "toptanci.pdf geldi" in texts(r), texts(r)[:200])
            summary = inbox_wait(page, "6 ürün bulundu", ib)
            c.check("Özet: 6 ürün + [Yayınla] [Panelde kontrol et]", bool(summary) and [b["title"] for b in summary.get("buttons", [])] == ["Yayınla", "Panelde kontrol et"], str(summary)[:200])
            r = say("sahip", text="%50")
            c.check("\"%50\" -> fiyatlar güncellendi", "Güncel fiyatlar" in texts(r), texts(r)[:200])
            imp_id = summary["buttons"][0]["id"].split(":")[1] if summary else ""
            ib = inbox_last(page)
            r = say("sahip", callback="cimp_pub:" + imp_id)
            done = inbox_wait(page, "6 ürün Kendi Mağazam'da yayında", ib)
            t_pdf = time.time() - t0
            c.check("[Yayınla] -> 6 ürün yayında", bool(done), str(r)[:200])
            ps = page.evaluate("""async (i) => { const ids = (await HS.db.from('catalog_import_rows').select('product_id').eq('import_id', i).eq('final', true)).data.map(x => x.product_id);
                return (await HS.db.from('products').select('id, name, supplier_price, sale_price, store_visible').in('id', ids).order('id')).data; }""", imp_id)
            ok = len(ps) == 6 and all(abs(float(x["sale_price"]) - float(x["supplier_price"]) * 1.5) < 0.02 and x["store_visible"] for x in ps)
            c.check("Satış fiyatı = alış × 1,5 (kâr oranı mesajdan)", ok, str([(x["supplier_price"], x["sale_price"]) for x in ps]))
            print(f"   PDF gönderiminden 3 ürünün yayına çıkmasına kadar: {t_pdf:.1f} sn")

            # 3) Link
            r = say("sahip", text="https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/")
            c.check("Link -> ürün eklendi", "1 ürün Kendi Mağazam'da yayında" in texts(r) and "All Star" in texts(r), texts(r)[:160])

            # 4) Fotoğraf + fiyat + stok
            img = urllib.request.urlopen(urllib.request.Request("https://demos.flatsome.com/wp-content/uploads/2013/08/282004-0286_2.jpeg",
                                                               headers={"User-Agent": "Mozilla/5.0"}), timeout=30).read()
            r = say("sahip", fileBase64=base64.b64encode(img).decode(), mime="image/jpeg", filename="urun.jpg", text="350'ye sat, 20 tane")
            c.check("Fotoğraf + \"350'ye sat, 20 tane\" -> ilan açıldı", "yayında" in texts(r) and "350" in texts(r), texts(r)[:200])
            last = page.evaluate("async () => (await HS.db.from('products').select('id, name, sale_price, stock_qty, image_url').order('id', {ascending:false}).limit(1)).data[0]")
            c.check("Fotoğraflı ürün: 350 TL, stok 20, görsel var", float(last["sale_price"]) == 350 and last["stock_qty"] == 20 and bool(last["image_url"]), f"{last['name']} {last['sale_price']} {last['stock_qty']}")

            # 5) Sorular
            for q, key in [("bu ay ne kadar kâr ettim", "Bu ay"), ("en çok ne satıyor", ""), ("hangi ürün zarar ediyor", "")]:
                r = say("sahip", text=q)
                c.check(f"Soru: \"{q}\"", bool(texts(r)) and (key in texts(r)) and "Merhaba, ben" not in texts(r), texts(r)[:120])

            # 6) Onay modu
            page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
                await HS.db.from('assistant_settings').upsert({ user_id: uid, approval_mode: 'approve' }); }""")
            r = say("sahip", text="https://demos.flatsome.com/shop/shoes/u-old-skool-vans/")
            c.check("Onay modu: [Yayınla] [Fiyatları düzenle]", buttons(r) == ["Yayınla", "Fiyatları düzenle"] and "henüz yayında değil" in texts(r), texts(r)[:120])
            r = say("sahip", callback="edit_prices")
            r = say("sahip", text="%45")
            c.check("Fiyatları düzenle -> \"%45\" uygulandı", "Güncel fiyatlar" in texts(r), texts(r)[:160])
            r = say("sahip", callback="publish")
            c.check("[Yayınla] -> 1 ürün yayında", "1 ürün Kendi Mağazam'da yayında" in texts(r), texts(r))
            page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
                await HS.db.from('assistant_settings').upsert({ user_id: uid, approval_mode: 'direct' }); }""")

            # 7) Kritik iş -> ikinci onay -> Vazgeç
            n_before = page.evaluate("async () => (await HS.db.from('products').select('id', { count: 'exact', head: true }).is('deleted_at', null)).count")
            r = say("sahip", text="tüm ürünleri sil")
            c.check("Toplu silmede ikinci onay", buttons(r) == ["Evet", "Vazgeç"] and "Emin misin" in texts(r), texts(r)[:120])
            r = say("sahip", callback="deny")
            n_after = page.evaluate("async () => (await HS.db.from('products').select('id', { count: 'exact', head: true }).is('deleted_at', null)).count")
            c.check("[Vazgeç] -> hiçbir ürün silinmedi", "Vazgeçildi" in texts(r) and n_after == n_before, f"{n_before} -> {n_after}")

            # 8) Yeni sipariş bildirimi + gönderilecekler
            store = browser.new_page()
            store.goto(f"{SITE}/magaza.html?slug={SLUG}")
            store.wait_for_selector(".card", timeout=60000)
            store.locator(".card").filter(has_text=last["name"][:15]).first.locator(".buy-btn").click()
            store.wait_for_selector("#orderModalOverlay.open")
            store.fill("#orderName", "E2E Asistan Alıcı"); store.fill("#orderPhone", "05551112233")
            store.fill("#orderAddress", "Test Mah. No 1"); store.fill("#orderCity", "İstanbul"); store.fill("#orderDistrict", "Kadıköy")
            store.wait_for_selector("#preinfoBox", state="visible", timeout=15000)
            store.check("#orderPreinfo")
            store.click("#orderSubmitBtn")
            store.wait_for_selector("#orderDone", state="visible", timeout=30000)
            note = None
            for _ in range(24):  # kuyruk 1 dk'da bir gönderilir
                note = page.evaluate("""async () => (await HS.db.from('assistant_test_inbox').select('reply, created_at').order('id', {ascending:false}).limit(5)).data
                    .map(x => x.reply).find(r => (r.text || '').includes('Yeni sipariş'))""")
                if note:
                    break
                time.sleep(10)
            c.check("Yeni sipariş bildirimi + [Siparişi gör]", bool(note) and any(b["title"] == "Siparişi gör" for b in note.get("buttons", [])), str(note)[:200])
            r = say("sahip", text="bugün gönderilecekler")
            c.check("\"bugün gönderilecekler\" listesi", "Gönderilecekler" in texts(r) and "E2E Asistan Alıcı" in texts(r), texts(r)[:200])

            # 9) Çalışan: Sadece siparişler
            code2 = page.evaluate(CALL, {"action": "link_code", "channel": "test", "role": "orders", "isOwner": False})["code"]
            say("calisan", text=code2)
            r = say("calisan", text="bu ay ne kadar kâr ettim")
            c.check("Çalışan (Sadece siparişler) kâr soramaz", "yetkin yok" in texts(r))
            r = say("calisan", fileBase64=pdf, mime="application/pdf", filename="x.pdf")
            c.check("Çalışan (Sadece siparişler) ürün ekleyemez", "yetkin yok" in texts(r))
            r = say("calisan", text="bugün gönderilecekler")
            c.check("Çalışan gönderilecekleri görür", "Gönderilecekler" in texts(r))
        finally:
            page.evaluate("""async (b) => {
                const uid = (await HS.db.auth.getUser()).data.user.id;
                const ids = (await HS.db.from('products').select('id').gt('id', b)).data.map(x => x.id);
                for (let i = 0; i < ids.length; i += 200) await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids.slice(i, i + 200));
                await HS.db.from('assistant_links').delete().eq('user_id', uid).eq('channel', 'test');
                await HS.db.from('image_job_batches').update({ notified_at: new Date().toISOString() }).eq('user_id', uid).is('notified_at', null);
            }""", before)
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
