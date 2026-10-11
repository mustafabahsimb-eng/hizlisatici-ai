"""Asistandan eklenen ürünler varsayılan kanallara da gider (eksik taraması 3. madde).

 1) Varsayılan kanallar: Kendi Mağazam + Hepsiburada (bağlı, test) + Trendyol (bağlı değil)
 2) Asistana PDF -> "1-2'yi ekle" -> cevapta "Diğer kanallar: Hepsiburada (E2E test): 2 ilan (test)" ve "Trendyol bağlı değil"
 3) Hepsiburada ilanları açıldı ve sync-worker beklemeden prova etti
 4) Onay modu: [Yayınla] sonrası diğer kanallara gönderim
Sonunda test bağlantısı, ürünler ve ayarlar geri alınır.
"""
import base64
import os
import subprocess
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import login, shots_dir, Checks, SITE
import katalog_dosyalari as K

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
CALL = """async (p) => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
  const res = await fetch(HS.SUPABASE_URL + '/functions/v1/assistant', { method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify({ ...p, userAccessToken: tok }) });
  return await res.json().catch(() => ({})); }"""


def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "csv"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=120)
        return (r.stdout or "") + (r.stderr or "")


def main():
    shots = shots_dir()
    fx = Path(shots) / "asistan"
    K.main.__globals__["sys"].argv = ["x", str(fx)]
    K.main()
    pdf = base64.b64encode((fx / "katalog_kodlu.pdf").read_bytes()).decode()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page)
        page.goto(f"{SITE}/dashboard.html")
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")
        before = page.evaluate("async () => (await HS.db.from('products').select('id').order('id', {ascending:false}).limit(1)).data?.[0]?.id || 0")
        old = page.evaluate("async () => (await HS.db.from('assistant_settings').select('*').maybeSingle()).data")
        say = lambda **kw: page.evaluate(CALL, dict(action="test", externalId="kanal", **kw))
        texts = lambda r: "\n".join(x.get("text", "") for x in (r.get("replies") or []))
        ext = "E2E-AK-" + str(int(time.time()))
        out = sql(f"insert into public.store_connections (user_id, marketplace_code, environment, status, label, external_seller_id) values ('{uid}', 'hepsiburada_tr', 'sandbox', 'connected', 'Hepsiburada (E2E test)', '{ext}') returning id;")
        conn = next((x.strip() for x in out.splitlines() if len(x.strip()) == 36), None)
        try:
            c.check("Test pazaryeri bağlantısı açıldı", bool(conn), out[-120:])
            page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
                await HS.db.from('assistant_settings').upsert({ user_id: uid, approval_mode: 'direct', default_channels: ['own_store', 'hepsiburada', 'trendyol'] }); }""")
            code = page.evaluate(CALL, {"action": "link_code", "channel": "test"})["code"]
            say(text=code)
            say(fileBase64=pdf, mime="application/pdf", filename="toptanci.pdf")
            r = say(text="1-2'yi ekle")
            t = texts(r)
            c.check("Cevapta diğer kanal sonucu", "Diğer kanallar" in t and "Hepsiburada (E2E test): 2 ilan (test)" in t, t[-220:])
            c.check("Bağlı olmayan kanal bildirildi", "Trendyol bağlı değil" in t, t[-160:])
            n = 0
            for _ in range(20):
                n = page.evaluate("async (cid) => (await HS.db.from('listings').select('id', { count: 'exact', head: true }).eq('connection_id', cid).not('validated_at', 'is', null)).count", conn)
                if n >= 2:
                    break
                time.sleep(3)
            c.check("Hepsiburada ilanları açıldı ve prova edildi", n >= 2, f"{n} ilan")
            # Onay modu
            page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
                await HS.db.from('assistant_settings').upsert({ user_id: uid, approval_mode: 'approve', default_channels: ['own_store', 'hepsiburada'] }); }""")
            say(fileBase64=pdf, mime="application/pdf", filename="toptanci.pdf")
            r = say(text="3-4'ü ekle")
            c.check("Onay modunda henüz gönderilmedi", "Diğer kanallar" not in texts(r) and "henüz yayında değil" in texts(r), texts(r)[-160:])
            r = say(callback="publish")
            c.check("[Yayınla] sonrası diğer kanallara gitti", "Hepsiburada (E2E test): 2 ilan" in texts(r), texts(r)[-200:])
        finally:
            page.evaluate("""async (a) => {
                const uid = (await HS.db.auth.getUser()).data.user.id;
                if (a.conn) await HS.db.from('listings').update({ deleted_at: new Date().toISOString(), status: 'draft' }).eq('connection_id', a.conn);
                const ids = (await HS.db.from('products').select('id').gt('id', a.before)).data.map(x => x.id);
                if (ids.length) await HS.db.from('products').update({ deleted_at: new Date().toISOString() }).in('id', ids);
                if (a.old) await HS.db.from('assistant_settings').upsert(a.old); else await HS.db.from('assistant_settings').update({ approval_mode: 'direct', default_channels: ['own_store'] }).eq('user_id', uid);
                await HS.db.from('assistant_links').delete().eq('user_id', uid).eq('channel', 'test');
                await HS.db.from('image_job_batches').update({ notified_at: new Date().toISOString() }).eq('user_id', uid).is('notified_at', null);
            }""", {"conn": conn, "before": before, "old": old})
            if conn:
                sql(f"update public.store_connections set deleted_at = now() where id = '{conn}';")
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
