"""📁 Klasörden yükle -> Seltigo + Etsy (Toplu Yükleme).

Test klasörü: 3 ürün (1: JSON'da dosya adları, 2: "folder" alt klasörü, 3: eksik dosya -> hata), görseller (PNG), PDF dosyaları, urunler.json.
Test kullanıcısına geçici bir Etsy bağlantısı (sahte anahtar) açılır; Etsy gerçek çağrıyı reddeder ama zincir doğrulanır:
 1) Sekme "📁 Klasörden yükle", [Klasör seç]; JSON okunur, önizleme (görsel / dosya sayıları), eksik dosya hatası
 2) "Taslak olarak gönder" varsayılan seçili; "Gönder ve yayınla" seçilir; [Etsy'ye gönder]
 3) Geçerli 2 ürün: ürün (dijital) + görseller + dosyalar (özel depo) + Etsy ilanı (etsy_publish=true) oluşur; eksik açıklama/etiketleri AI tamamlar
 4) İlan kuyruğu Etsy'ye devreder (sync-worker -> etsy-listings) ve Etsy'nin cevabı ilana yazılır (gerçek anahtar gelince "Etsy'de yayında")
Sonunda ürünler, dosyalar ve geçici bağlantı silinir.
"""
import base64
import os
import subprocess
import tempfile
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "csv"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=120)
        return (r.stdout or "") + (r.stderr or "")


def make_folder():
    root = Path(tempfile.mkdtemp()) / "etsy-test-klasor"
    (root / "fern").mkdir(parents=True)
    (root / "cover-sun.png").write_bytes(PNG)
    (root / "sun-8x10.pdf").write_bytes(b"%PDF-1.4 sun 8x10")
    (root / "sun-A4.pdf").write_bytes(b"%PDF-1.4 sun A4")
    (root / "fern" / "1.png").write_bytes(PNG)
    (root / "fern" / "2.png").write_bytes(PNG)
    (root / "fern" / "fern-5x7.pdf").write_bytes(b"%PDF-1.4 fern")
    (root / "moon.png").write_bytes(PNG)
    (root / "urunler.json").write_text(json.dumps({"products": [
        {"title": "Sun Wall Art Printable Boho Sun Print", "description": "Minimal boho sun printable in two sizes.", "tags": ["sun print", "boho wall art"], "price": 4.99,
         "images": ["cover-sun.png"], "files": ["sun-8x10.pdf", "sun-A4.pdf"]},
        {"title": "Fern Botanical Print Digital Download", "price": 3.5, "folder": "fern"},
        {"title": "Moon Print", "price": 2.0, "images": ["moon.png"], "files": ["moon-yok.pdf"]},
    ]}), encoding="utf-8")
    return root


def main():
    shots = shots_dir()
    c = Checks()
    folder = make_folder()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page)
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")
        before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        out = sql(f"""insert into public.store_connections (user_id, marketplace_code, environment, status, label, external_seller_id) values ('{uid}', 'etsy', 'live', 'connected', 'Etsy · e2e-shop', '99999999') returning id;""")
        conn = next((x.strip() for x in out.splitlines() if len(x.strip()) == 36), None)
        if conn:
            sql(f"""select public.store_connection_set_credentials('{conn}', '{{"access_token":"e2e.fake","refresh_token":"e2e.fake","expires_at":"2099-01-01T00:00:00Z","shop_id":"99999999","shop_name":"e2e-shop"}}'::jsonb);""")
        try:
            c.check("Geçici Etsy bağlantısı açıldı", bool(conn), out[-120:])
            page.goto(f"{SITE}/toplu-yukleme.html")
            page.wait_for_selector("#tabFolderBtn", timeout=30000)
            page.wait_for_function("() => document.getElementById('tabFolderBtn').textContent.trim() !== ''")
            c.check("Sekme \"📁 Klasörden yükle\"", page.text_content("#tabFolderBtn") == "📁 Klasörden yükle")
            page.click("#tabFolderBtn")
            c.check("[Klasör seç]", page.text_content("#folderPickBtn") == "Klasör seç")
            page.set_input_files("#folderInput", str(folder))
            page.wait_for_selector("#folderPreview tr[data-fi]", timeout=30000)
            rows = page.locator("#folderPreview tbody tr").all_inner_texts()
            c.check("JSON okundu: 3 ürün", len(rows) == 3 and "urunler.json" in page.inner_text("#folderMsg"), page.inner_text("#folderMsg"))
            c.check("1. ürün: 1 görsel, 2 dosya", "\t1\t2\t" in rows[0], rows[0][:120])
            c.check("2. ürün (alt klasör): 2 görsel, 1 dosya", "\t2\t1\t" in rows[1], rows[1][:120])
            c.check("3. ürün: eksik dosya hatası", "moon-yok.pdf" in rows[2], rows[2][:120])
            c.check("Varsayılan \"Taslak olarak gönder\"", page.is_checked("input[name=etsyMode][value=draft]"))
            page.wait_for_function("() => document.getElementById('folderEtsyNote').textContent.includes('e2e-shop')", timeout=15000)
            c.check("Etsy mağazası ve ücret notu", "e2e-shop" in page.inner_text("#folderEtsyNote") and "2 ürün" in page.inner_text("#folderEtsyNote"), page.inner_text("#folderEtsyNote"))
            page.check("input[name=etsyMode][value=publish]")
            c.check("[Etsy'ye gönder]", page.text_content("#folderSendBtn") == "Etsy'ye gönder")
            page.screenshot(path=str(Path(shots) / "etsy_klasor_onizleme.png"), full_page=True)
            t0 = time.time()
            page.click("#folderSendBtn")
            page.wait_for_function("() => [...document.querySelectorAll('#folderPreview .fstat')].slice(0,2).every(td => /Etsy|ETSY|etsy|hata|Hata|Error|ayında|aslak/.test(td.textContent) && !/gönderiliyor|Yükleniyor/.test(td.textContent))", timeout=300000)
            took = time.time() - t0
            data = page.evaluate("""async (b) => {
                const ps = (await HS.db.from('products').select('id, name, product_type, generated_description, image_url').gt('id', b).order('id')).data;
                const out = [];
                for (const p of ps) {
                  const fs = (await HS.db.from('product_files').select('name, rank').eq('product_id', p.id).order('rank')).data;
                  const im = (await HS.db.from('product_images').select('url').eq('product_id', p.id)).data;
                  const li = (await HS.db.from('listings').select('marketplace_code, attributes, keywords, price, last_sync_error, validation').eq('product_id', p.id).eq('marketplace_code', 'etsy').maybeSingle()).data;
                  out.push({ p, fs, im: im.length, li });
                }
                return out; }""", before)
            c.check("2 ürün eklendi (3. hatalı ürün eklenmedi)", len(data) == 2, str([d["p"]["name"] for d in data]))
            if len(data) == 2:
                a, b = data
                c.check("Dijital tip + dosyalar (2 ve 1) + görseller", a["p"]["product_type"] == "digital" and [f["name"] for f in a["fs"]] == ["sun-8x10.pdf", "sun-A4.pdf"] and a["im"] == 1 and len(b["fs"]) == 1 and b["im"] == 2)
                c.check("Etsy ilanı: \"Gönder ve yayınla\" seçimi kayıtlı", a["li"] and a["li"]["attributes"].get("etsy_publish") is True and float(a["li"]["price"]) == 4.99)
                c.check("AI eksik açıklama / etiketleri tamamladı (2. ürün)", bool(b["p"]["generated_description"]) and len(b["li"]["keywords"] or []) >= 5, f"{len(b['li']['keywords'] or [])} etiket")
                err = (a["li"]["last_sync_error"] or "")
                c.check("İlan Etsy'ye devredildi ve Etsy cevabı ilana yazıldı", "Etsy" in err or (a["li"]["validation"] or {}).get("etsy", {}).get("listing_id"), err[:140])
                print(f"   2 ürün {took:.0f} sn'de eklendi ve Etsy'ye gönderildi")
            page.screenshot(path=str(Path(shots) / "etsy_klasor_sonuc.png"), full_page=True)
        finally:
            page.evaluate("""async (b) => {
                const ids = (await HS.db.from('products').select('id').gt('id', b)).data.map(x => x.id);
                for (const id of ids) {
                  const fs = (await HS.db.from('product_files').select('path').eq('product_id', id)).data || [];
                  if (fs.length) await HS.db.storage.from('product-files').remove(fs.map(f => f.path));
                  await HS.db.from('product_files').delete().eq('product_id', id);
                }
                if (ids.length) await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids); }""", before)
            if conn:
                sql(f"update public.listings set deleted_at = now(), status = 'removed' where connection_id = '{conn}'; update public.store_connections set deleted_at = now(), status = 'revoked' where id = '{conn}';")
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
