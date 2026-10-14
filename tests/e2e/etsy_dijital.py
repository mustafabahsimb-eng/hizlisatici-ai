"""Etsy bağlantısı (güvenlik) + dijital ürün dosyaları.

Bağlantı:
 1) etsy-token-exchange: oturum yoksa 401; gövdedeki userId oturumla uyuşmazsa 403 ("eşleşmiyor") — başkası adına bağlanma açığı kapalı
 2) etsy-callback.html: güvenlik kodu (state) gelmezse bağlantı kurulmaz
 3) Hesaplarım > Etsy [Mağazanı Bağla]: Etsy onay adresi PKCE + mağaza izinleri (shops_r, listings_w, listings_d) ile
Dijital ürün (urun-duzenle.html):
 4) "Ürün tipi": Fiziksel / Dijital; Dijital seçilip kaydedilir
 5) "İndirilebilir dosyalar (en fazla 5)": dosya eklenir (özel depo + product_files), 20 MB üstü reddedilir, 5'ten fazlası eklenemez, silinir
"""
import os
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

CALL = """async (p) => { const res = await fetch(HS.SUPABASE_URL + '/functions/v1/etsy-token-exchange', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify(p) });
  return { status: res.status, body: await res.json().catch(() => ({})) }; }"""


def main():
    shots = shots_dir()
    c = Checks()
    tmp = Path(tempfile.mkdtemp())
    small = [tmp / f"dosya{i}.pdf" for i in range(1, 7)]
    for i, f in enumerate(small):
        f.write_bytes(b"%PDF-1.4\n" + os.urandom(2048 + i))
    big = tmp / "buyuk.zip"
    with open(big, "wb") as fh:
        fh.seek(21 * 1024 * 1024)
        fh.write(b"\0")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        page = ctx.new_page()
        login(page)
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        tok = page.evaluate("async () => (await HS.db.auth.getSession()).data.session.access_token")
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")

        # 1) Güvenlik
        # Oturumsuz istek: tarayıcı dışından (app.js giriş yapmış kullanıcıya oturum anahtarını kendisi ekler)
        import json as _j, urllib.request as _u, urllib.error as _e
        req = _u.Request("https://ytucdrrgxsjhrqmaxckt.supabase.co/functions/v1/etsy-token-exchange", data=_j.dumps({"code": "x", "codeVerifier": "y"}).encode(),
                         headers={"Content-Type": "application/json", "apikey": "sb_publishable_xJXwqD9NmwU70kv2eFKk0A_O2q9gOcD"}, method="POST")
        try:
            st = _u.urlopen(req, timeout=30).status
        except _e.HTTPError as he:
            st = he.code
        c.check("Oturumsuz istek reddedildi (401)", st == 401, str(st))
        r = page.evaluate(CALL, {"code": "x", "codeVerifier": "y", "userAccessToken": tok})
        c.check("Etsy anahtar + gizli anahtar kabul ediliyor (sahte kod -> kod hatası, anahtar hatası değil)", "API key" not in r["body"].get("error", "") and "shared secret" not in r["body"].get("error", ""), str(r["body"])[:160])
        r = page.evaluate(CALL, {"code": "x", "codeVerifier": "y", "userAccessToken": tok, "userId": "00000000-0000-0000-0000-000000000001"})
        c.check("Başkasının userId'si ile istek reddedildi (403)", r["status"] == 403 and "eşleşmiyor" in r["body"].get("error", ""), str(r)[:140])

        # 2) state zorunlu
        page.evaluate("() => { sessionStorage.setItem('etsy_code_verifier', 'v'); sessionStorage.removeItem('etsy_oauth_state'); }")
        page.goto(f"{SITE}/etsy-callback.html?code=abc")
        page.wait_for_timeout(2500)
        c.check("Güvenlik kodu (state) yoksa bağlanmaz", "Güvenlik doğrulaması başarısız" in page.inner_text("body"), page.inner_text("body")[:120])

        # 3) Onay adresi ve izinler
        seen = []
        ctx.route("https://www.etsy.com/**", lambda route: (seen.append(route.request.url), route.abort()))
        page.goto(f"{SITE}/accounts.html")
        page.wait_for_selector("#right-etsy button", timeout=30000)
        page.evaluate("() => connectEtsy()")
        page.wait_for_timeout(3000)
        u = seen[0] if seen else ""
        cfg = page.evaluate("""async () => (await fetch(HS.SUPABASE_URL + '/functions/v1/etsy-token-exchange', { method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify({ action: 'config' }) })).json()""")
        if cfg.get("configured"):
            c.check("Etsy onay adresi: tek kaynaktaki keystring + PKCE + mağaza izinleri", "oauth/connect" in u and ("client_id=" + cfg["clientId"]) in u and "code_challenge_method=S256" in u and "shops_r" in u and "listings_d" in u, u[:160])
        else:
            c.check("Keystring tanımlı değilken Etsy'ye yanlış anahtarla gidilmez (uyarı)", not u and "henüz hazır değil" in page.inner_text("#toast"), page.inner_text("#toast")[:100])

        # 4-5) Dijital ürün
        page.unroute_all() if hasattr(page, "unroute_all") else None
        ctx.unroute("https://www.etsy.com/**")
        page.goto(f"{SITE}/dashboard.html")
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        pid = page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
            const r = await HS.db.from('products').insert({ user_id: uid, name: 'E2E Dijital Baskı', sale_price: 5 }).select('id').single(); return r.data.id; }""")
        try:
            page.goto(f"{SITE}/urun-duzenle.html?id={pid}")
            page.wait_for_selector("input[name=ptype]", timeout=30000)
            c.check("\"Ürün tipi\": Fiziksel / Dijital", page.locator(".type-opt").all_inner_texts() == ["Fiziksel ürün", "Dijital ürün"], str(page.locator(".type-opt").all_inner_texts()))
            page.check("input[name=ptype][value=digital]")
            page.wait_for_selector("#fileAddBtn", timeout=5000)
            c.check("Dosya alanı başlığı", "İndirilebilir dosyalar (en fazla 5)" in page.inner_text("#content"))
            page.click("#saveBtn")
            page.wait_for_function("() => !document.getElementById('saveBtn').disabled", timeout=30000)
            page.wait_for_timeout(1500)
            ptype = page.evaluate("async (id) => (await HS.db.from('products').select('product_type').eq('id', id).single()).data.product_type", pid)
            c.check("Dijital tip kaydedildi", ptype == "digital", ptype)

            page.set_input_files("#fileInput", [str(small[0]), str(small[1])])
            page.wait_for_function("() => document.querySelectorAll('.file-row').length === 2", timeout=60000)
            rows = page.evaluate("async (id) => (await HS.db.from('product_files').select('name, size_bytes, path, rank').eq('product_id', id).order('rank')).data", pid)
            c.check("2 dosya eklendi (özel depo + kayıt)", len(rows) == 2 and rows[0]["rank"] == 1 and rows[0]["path"].startswith(uid + "/"), str(rows)[:160])
            dl = page.evaluate("async (path) => { const r = await HS.db.storage.from('product-files').download(path); return r.data ? r.data.size : -1; }", rows[0]["path"])
            c.check("Dosya depoda (sahibi indirebiliyor)", dl == rows[0]["size_bytes"], str(dl))

            msgs = []
            page.set_input_files("#fileInput", [str(big)])
            page.wait_for_timeout(2000)
            c.check("20 MB üstü dosya reddedildi", page.locator(".file-row").count() == 2 and "20 MB" in page.inner_text("#toast"), page.inner_text("#toast")[:80])

            page.set_input_files("#fileInput", [str(f) for f in small[2:6]])
            page.wait_for_function("() => document.querySelectorAll('.file-row').length === 5", timeout=90000)
            page.wait_for_timeout(1000)
            c.check("En fazla 5 dosya; düğme gizlendi", page.locator(".file-row").count() == 5 and page.locator("#fileAddBtn").count() == 0)
            n_db = page.evaluate("async (id) => (await HS.db.from('product_files').select('id', { count: 'exact', head: true }).eq('product_id', id)).count", pid)
            c.check("Veritabanında da 5 dosya", n_db == 5, str(n_db))
            err = page.evaluate("""async (a) => { const r = await HS.db.from('product_files').insert({ user_id: a.uid, product_id: a.pid, path: a.uid + '/x', name: 'x', size_bytes: 10, rank: 5 }); return r.error ? r.error.message : null; }""", {"uid": uid, "pid": pid})
            c.check("6. dosya veritabanında da engelli", bool(err), str(err)[:80])
            page.screenshot(path=str(Path(shots) / "etsy_dijital_dosyalar.png"), full_page=True)

            page.on("dialog", lambda d: d.accept())
            page.locator(".file-row .del-btn").first.click()
            page.wait_for_function("() => document.querySelectorAll('.file-row').length === 4", timeout=30000)
            c.check("Dosya silindi; ekleme düğmesi geri geldi", page.locator("#fileAddBtn").count() == 1)
        finally:
            page.evaluate("""async (id) => {
                const fs = (await HS.db.from('product_files').select('path').eq('product_id', id)).data || [];
                if (fs.length) await HS.db.storage.from('product-files').remove(fs.map(f => f.path));
                await HS.db.from('product_files').delete().eq('product_id', id);
                await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', id); }""", pid)
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
