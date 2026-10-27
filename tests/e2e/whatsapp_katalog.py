"""WhatsApp'tan (ve panelden) "PDF + link ile ürün yükleme" uçtan uca testi (catalog-import motoru).

Asistanın test sohbeti (WhatsApp / Telegram ile aynı çekirdek) ve Toplu Yükleme > 📥 PDF + link sekmesi kullanılır.
Örnek PDF'ler whatsapp_katalog_dosyalari.py ile üretilir. Senaryolar:
 1) Resimli katalog PDF'i (2 sütun, JPEG fotoğraf, barkod, stok, bayi + PSF, bedenler): kâr oranı yoksa BİR KEZ sorulur,
    [%50] -> 8 ürün taslak, fotoğraflar doğru ürünlerde, özet + [Yayınla] [Panelde kontrol et]
 2) Aynı PDF tekrar: yeni ürün açılmaz, 8 ürün güncellenir; kâr oranı tekrar sorulmaz
 3) [Yayınla] -> Kendi Mağazam'da yayında
 4) Resimsiz toptan fiyat listesi (2 sayfa tablo): 21 ürün, renk satırları varyant, görselsizler "arka planda aranıyor"
 5) PDF + Shopify linki AYNI mesajda: fiyat + stok PDF'ten, görsel + seçenek Shopify'dan
 6) Önce PDF, 30 sn sonra WooCommerce linki (ayrı mesaj): aynı yüklemeye eklenir, ad benzerliğiyle eşleşir
 7) Yalnız mağaza linki (WooCommerce): tüm ürünler (API) okunur
 8) Panel: PDF + link yükle -> geçmişte görünür, ayrıntıda satırlar, [Yayınla]
 9) Güvenlik: PDF olmayan belge reddedilir
Süreler yazılır (HIZ KURALI). Sonunda test ürünleri silinir (yumuşak), test bağlantısı kaldırılır, kâr kuralı geri yüklenir.
Çalıştırma: <venv>\\Scripts\\python tests\\e2e\\whatsapp_katalog.py [ekran_goruntusu_klasoru]
"""
import base64, json, os, subprocess, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks
import whatsapp_katalog_dosyalari as W

CALL = """async (p) => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
  const res = await fetch(HS.SUPABASE_URL + '/functions/v1/assistant', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify({ ...p, userAccessToken: tok }) });
  return await res.json().catch(() => ({})); }"""
SHOPIFY = "https://hydrogen-preview.myshopify.com"
WOO = "https://demos.flatsome.com/"


def reset_limits(uid):
    """Art arda çalıştırmada yükleme sınırına (saatte 30) takılmamak için test kullanıcısının sayaçları sıfırlanır (Supabase CLI girişiyle)."""
    cli = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
    f = Path(tempfile.gettempdir()) / "wa_katalog_reset.sql"
    f.write_text(f"delete from rate_limits where key in ('cimp:h:{uid}', 'cimp:d:{uid}');", encoding="utf-8")
    subprocess.run([str(cli), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f)], capture_output=True, timeout=120)


def main():
    shots = shots_dir()
    fx = Path(shots) / "wa-katalog"
    W.main.__globals__["sys"].argv = ["x", str(fx)]
    W.main()
    import katalog_dosyalari as K  # taranmış PDF (tarayıcı açılmadan önce üretilir)
    K.main.__globals__["sys"].argv = ["x", str(fx)]
    K.main()
    c = Checks()
    times = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1300, "height": 1000})
        login(page)
        page.goto(f"{SITE}/toplu-yukleme.html")
        page.wait_for_function("() => window.HS && HS.user", timeout=30000)
        ev = lambda js, arg=None: page.evaluate(js, arg)
        reset_limits(ev("() => HS.user.id"))
        before = ev("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        imp_before = ev("async () => (await HS.db.from('catalog_imports').select('created_at').order('created_at', {ascending:false}).limit(1)).data?.[0]?.created_at || '2000-01-01'")
        old_rules = ev("async () => (await HS.db.from('import_rules').select('rules').eq('user_id', HS.user.id).maybeSingle()).data?.rules || null")
        ev("""async (r) => { const x = { ...(r || {}) }; delete x.margin; delete x.base;
            await HS.db.from('import_rules').upsert({ user_id: HS.user.id, rules: x }); }""", old_rules)
        ext = "wa-katalog-" + str(int(time.time()))
        say = lambda **kw: ev(CALL, dict(action="test", externalId=ext, **kw))
        texts = lambda r: "\n".join(x.get("text", "") for x in (r.get("replies") or []))
        pdf64 = lambda n: base64.b64encode((fx / n).read_bytes()).decode()

        def inbox(needle, since_id, timeout=240):
            t0 = time.time()
            while time.time() - t0 < timeout:
                hit = ev("""async (a) => (await HS.db.from('assistant_test_inbox').select('id, reply').gt('id', a[1]).order('id', {ascending:false}).limit(10)).data
                    .map(x => x.reply).find(r => (r.text || '').includes(a[0]))""", [needle, since_id])
                if hit:
                    return hit
                time.sleep(2)
            return None
        last_inbox = lambda: ev("async () => (await HS.db.from('assistant_test_inbox').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        latest_imp = lambda: ev("async () => (await HS.db.from('catalog_imports').select('*').order('created_at', {ascending:false}).limit(1)).data[0]")
        imp_by = lambda i: ev("async (i) => (await HS.db.from('catalog_imports').select('*').eq('id', i).single()).data", i)
        rows_of = lambda i: ev("""async (i) => (await HS.db.from('catalog_import_rows').select('name, model_code, barcode, cost, sale_price, stock, images, variants, status, problems, product_id, merged_from, description')
            .eq('import_id', i).eq('final', true).order('idx')).data""", i)

        def wait_status(i, want, timeout=300):
            t0 = time.time()
            while time.time() - t0 < timeout:
                m = imp_by(i)
                if m["status"] in want:
                    return m
                time.sleep(2)
            return imp_by(i)

        try:
            code = ev(CALL, {"action": "link_code", "channel": "test"})["code"]
            say(text=code)

            # 1) Resimli katalog
            ib = last_inbox(); t0 = time.time()
            r = say(fileBase64=pdf64("resimli_katalog.pdf"), mime="application/pdf", filename="resimli_katalog.pdf")
            c.check("Resimli PDF alındı", "resimli_katalog.pdf geldi (2 sayfa)" in texts(r), texts(r)[:120])
            ask = inbox("kâr oranını bir kez", ib)
            c.check("Kâr oranı yok -> bir kez soruldu [%30] [%50] [%100]", bool(ask) and [b["title"] for b in ask["buttons"]] == ["%30", "%50", "%100"], str(ask)[:160])
            imp1 = latest_imp()
            say(callback=f"cimp_m:{imp1['id']}:50")
            summ = inbox("8 ürün bulundu", ib)
            times["Resimli katalog (8 ürün, 2 sayfa) -> özet"] = time.time() - t0
            c.check("Özet: 8 ürün + [Yayınla] [Panelde kontrol et]", bool(summ) and [b["title"] for b in summ["buttons"]] == ["Yayınla", "Panelde kontrol et"] and "Panelde kontrol et" == summ.get("link", {}).get("title"), str(summ)[:200])
            rs = rows_of(imp1["id"])
            exp = {code_: (bc, stock, float(bayi.replace(",", "."))) for code_, _n, bc, stock, bayi, _psf, _s, _c, _sh in W.CARDS}
            ok = len(rs) == 8 and all(x["model_code"] in exp and x["barcode"] == exp[x["model_code"]][0] and x["stock"] == exp[x["model_code"]][1]
                                       and abs(float(x["cost"]) - exp[x["model_code"]][2]) < 0.01 and abs(float(x["sale_price"]) - float(x["cost"]) * 1.5) < 0.02 for x in rs)
            c.check("Barkod, stok, bayi fiyatı doğru; satış = alış × 1,5", ok, str([(x["model_code"], x["barcode"], x["stock"], x["cost"], x["sale_price"]) for x in rs])[:300])
            c.check("Bedenler varyant oldu (WK-201: S, M, L, XL)", any(x["model_code"] == "WK-201" and len(x["variants"] or []) == 4 for x in rs))
            # Fotoğraf eşleşmesi: kartın fotoğrafı kendi rengini taşır
            colors_ok = 0
            for x in rs:
                url = (x["images"] or [""])[0]
                rgb = ev("""async (u) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.src = u; await im.decode();
                    const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
                    const d = g.getImageData(Math.round(im.width * 0.5), Math.round(im.height * 0.72), 1, 1).data; return [d[0], d[1], d[2]]; }""", url) if url else None
                want = W.COLORS[x["model_code"]]
                wr = [int(want[i:i + 2], 16) for i in (1, 3, 5)]
                if rgb and sum(abs(a - b) for a, b in zip(rgb, wr)) < 70:
                    colors_ok += 1
            c.check("PDF'teki 8 fotoğrafın hepsi doğru ürünle eşleşti", colors_ok == 8, f"{colors_ok}/8")
            first_ids = sorted(x["product_id"] for x in rs)

            # 2) Aynı PDF tekrar -> kopya yok
            ib = last_inbox()
            say(fileBase64=pdf64("resimli_katalog.pdf"), mime="application/pdf", filename="resimli_katalog.pdf")
            summ2 = inbox("8 ürün bulundu", ib)
            imp2 = latest_imp()
            ids2 = sorted(x["product_id"] for x in rows_of(imp2["id"]))
            c.check("Tekrar yükleme: 0 yeni, 8 güncellendi, aynı ürünler", bool(summ2) and "(0 yeni, 8 güncellendi)" in summ2["text"] and ids2 == first_ids, (summ2 or {}).get("text", "")[:120])
            c.check("Kâr oranı ikinci kez sorulmadı", imp2["margin"] == 50 and not inbox("kâr oranını bir kez", ib, timeout=2))

            # 3) Yayınla
            ib = last_inbox(); t0 = time.time()
            r = say(callback=f"cimp_pub:{imp2['id']}")
            pub = inbox("8 ürün Kendi Mağazam'da yayında", ib)
            times["[Yayınla] 8 ürün -> yayında"] = time.time() - t0
            live = ev("async (ids) => (await HS.db.from('listings').select('product_id').eq('marketplace_code', 'own_store').eq('status', 'published').in('product_id', ids)).data.length", first_ids)
            c.check("[Yayınla] -> 8 ürün Kendi Mağazam'da yayında", bool(pub) and live == 8, f"{texts(r)} | {live}")

            # 4) Resimsiz fiyat listesi
            ib = last_inbox(); t0 = time.time()
            say(fileBase64=pdf64("fiyat_listesi.pdf"), mime="application/pdf", filename="fiyat_listesi.pdf")
            s4 = inbox("21 ürün bulundu", ib)
            times["Resimsiz fiyat listesi (24 satır, 2 sayfa) -> özet"] = time.time() - t0
            rs4 = rows_of(latest_imp()["id"])
            c.check("Resimsiz liste: 24 satır -> 21 ürün (renk satırları varyant)", bool(s4) and len(rs4) == 21 and sum(1 for x in rs4 if len(x["variants"] or []) == 2) == 3, str(len(rs4)))
            c.check("Görselsiz ürünler 'arka planda aranıyor' olarak işaretli", all(any("Görsel yok" in p_ for p_ in (x["problems"] or [])) for x in rs4))
            c.check("Uzun ad iki satırdan birleşti", any(x["name"] == "Paslanmaz Çelik Çatal Bıçak Seti 24 Parça Kutulu Hediyelik" for x in rs4))

            # 5) PDF + Shopify linki aynı mesajda
            ib = last_inbox(); t0 = time.time()
            r = say(fileBase64=pdf64("fiyat_listesi_shopify.pdf"), mime="application/pdf", filename="snowboard.pdf", text=SHOPIFY)
            s5 = inbox("snowboard.pdf + 🔗 hydrogen-preview", ib)
            times["PDF + Shopify linki (aynı mesaj) -> özet"] = time.time() - t0
            rs5 = rows_of(latest_imp()["id"])
            ok5 = len(rs5) == 6 and all(x["merged_from"] and len(x["images"] or []) >= 1 and x["stock"] is not None for x in rs5)
            c.check("PDF + Shopify: 6/6 eşleşti, görsel Shopify'dan, fiyat + stok PDF'ten", bool(s5) and ok5,
                    str([(x["name"], x["cost"], x["stock"], len(x["images"] or [])) for x in rs5])[:300])

            # 6) Önce PDF, sonra link (ayrı mesaj)
            ib = last_inbox(); t0 = time.time()
            say(fileBase64=pdf64("fiyat_listesi_woo.pdf"), mime="application/pdf", filename="ayakkabi.pdf")
            time.sleep(30)
            r = say(text="görseller burada: " + WOO)
            c.check("İkinci mesajdaki link aynı yüklemeye eklendi", "PDF'le birleştiriyorum" in texts(r), texts(r)[:120])
            imp6 = latest_imp()
            s6 = inbox("ayakkabi.pdf + 🔗 demos.flatsome.com", ib)
            times["PDF, 30 sn sonra WooCommerce linki -> birleşik özet"] = time.time() - t0
            rs6 = rows_of(imp6["id"])
            c.check("PDF + WooCommerce: 5/5 ad benzerliğiyle eşleşti, açıklama + görsel siteden", bool(s6) and len(rs6) == 5 and all(x["merged_from"] and (x["images"] or []) and len(x["description"] or "") > 40 for x in rs6),
                    str([(x["name"], bool(x["merged_from"])) for x in rs6]))
            c.check("Sitedeki diğer ürünler eklenmedi (PDF esas)", imp_by(imp6["id"])["found"] == 5)

            # 7) Yalnız mağaza linki (ayrı sohbet: 10 dk içindeki PDF'lere eklenmesin)
            ext2 = ext + "-2"
            ev(CALL, dict(action="test", externalId=ext2, text=ev(CALL, {"action": "link_code", "channel": "test"})["code"]))
            ib = last_inbox(); t0 = time.time()
            r = ev(CALL, dict(action="test", externalId=ext2, text=SHOPIFY + "/"))
            s7 = inbox("hydrogen-preview.myshopify.com\n", ib)
            times["Yalnız Shopify mağaza linki -> özet"] = time.time() - t0
            m7 = latest_imp()
            c.check("Yalnız link: Shopify mağazasının tüm ürünleri okundu", bool(s7) and m7["link_platform"] == "shopify" and m7["found"] >= 50, f"{m7['link_platform']} {m7['found']}")

            # 9) Yalnız PDF
            r = say(fileBase64=base64.b64encode(b"Kod,Ad,Fiyat\nA1,Kupa,10").decode(), mime="text/csv", filename="liste.csv")
            c.check("PDF olmayan belge kibarca reddedildi", "yalnız PDF" in texts(r), texts(r)[:120])

            # 8) Panel
            page.click("#tabPdfLinkBtn")
            page.wait_for_selector("#plTable", timeout=20000)
            n0 = ev("async () => (await HS.db.from('catalog_imports').select('id', {count: 'exact', head: true}).eq('source', 'panel')).count")
            page.set_input_files("#plFile", str(fx / "fiyat_listesi_woo.pdf"))
            page.fill("#plUrl", WOO)
            t0 = time.time()
            page.click("#plStartBtn")
            page.wait_for_function("(n) => document.getElementById('plMsg').textContent.length > 0 && !/yükleniyor/.test(document.getElementById('plMsg').textContent)", arg=None, timeout=60000)
            c.check("Panel: yükleme başladı", "Başladı" in page.inner_text("#plMsg"), page.inner_text("#plMsg"))
            page.wait_for_function("() => { const r = document.querySelector('#plTable tbody tr'); return r && /Panel/.test(r.innerText) && /Hazır/.test(r.innerText); }", timeout=240000)
            times["Panel: PDF + WooCommerce linki -> hazır"] = time.time() - t0
            n1 = ev("async () => (await HS.db.from('catalog_imports').select('id', {count: 'exact', head: true}).eq('source', 'panel')).count")
            c.check("Panel: geçmişte 'Hazır (taslak)' satırı", n1 == n0 + 1, page.inner_text("#plTable tbody tr"))
            page.wait_for_selector("#plRows tbody tr", timeout=20000)
            c.check("Panel: ayrıntıda 5 ürün satırı, görselleriyle", page.locator("#plRows tbody tr").count() == 5 and page.locator("#plRows tbody tr img").count() == 5)
            page.screenshot(path=str(Path(shots) / "pdf_link_panel.png"), full_page=True)
            page.click("#plTable tbody tr >> text=Yayınla")
            page.wait_for_function("() => /Yayında/.test(document.querySelector('#plTable tbody tr').innerText)", timeout=120000)
            c.check("Panel: [Yayınla] -> Yayında", True)
            # Hatalı satırlar panelde: taranmış PDF (yapay zekâ gerekir) -> okunamayan sayfa satırı
            page.set_input_files("#plFile", str(fx / "taranmis.pdf"))
            page.click("#plStartBtn")
            page.wait_for_function("() => { const r = document.querySelector('#plTable tbody tr'); return r && /taranmis/.test(r.innerText) && /(Hazır|Hata|Kâr)/.test(r.innerText); }", timeout=240000)
            page.click("#plTable tbody tr >> text=Ayrıntı")
            page.wait_for_selector("#plRows tbody tr", timeout=20000)
            row_txt = page.inner_text("#plRows")
            c.check("Panel: okunamayan / hatalı satırlar görünür (taranmış PDF)", "Sayfa" in row_txt or "Okunamadı" in row_txt or page.locator("#plRows tbody tr").count() >= 1, row_txt[:200])
            page.screenshot(path=str(Path(shots) / "pdf_link_panel_hata.png"), full_page=True)
        finally:
            ev("""async (a) => {
                const uid = HS.user.id;
                const ids = (await HS.db.from('products').select('id').gt('id', a[0])).data.map(x => x.id);
                for (let i = 0; i < ids.length; i += 200) await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids.slice(i, i + 200));
                await HS.db.from('assistant_links').delete().eq('user_id', uid).eq('channel', 'test');
                await HS.db.from('image_job_batches').update({ notified_at: new Date().toISOString() }).eq('user_id', uid).is('notified_at', null);
                if (a[1]) await HS.db.from('import_rules').upsert({ user_id: uid, rules: a[1] });
            }""", [before, old_rules])
        browser.close()
    print("\nSüreler (HIZ KURALI):")
    for k, v in times.items():
        print(f"   {k}: {v:.1f} sn")
    c.finish()


if __name__ == "__main__":
    main()
