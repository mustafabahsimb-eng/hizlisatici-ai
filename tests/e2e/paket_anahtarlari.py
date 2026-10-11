"""Ücretli olabilecek özellikler: tek yerden aç / kapa (feature_flags + user_feature_overrides).

 1) Varsayılan: tüm anahtarlar açık (HS.feature)
 2) Test kullanıcısında link_import, multi_channel, ai_copy kapatılır (veritabanından, satıcıya özel):
    - HS.feature(...) false
    - product-import 403 + "paketinde kapalı"; channel-copy 403; site-store distribute "paketinde kapalı"
 3) Geri açılır -> yeniden çalışır
"""
import os
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, Checks

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
KEYS = ["link_import", "multi_channel", "ai_copy"]


def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "csv"],
                           cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=120)
        return (r.stdout or "") + (r.stderr or "")


CALLS = """async () => {
  const tok = (await HS.db.auth.getSession()).data.session.access_token;
  const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok, 'apikey': HS.SUPABASE_KEY };
  const imp = await fetch(HS.SUPABASE_URL + '/functions/v1/product-import', { method: 'POST', headers: h, body: JSON.stringify({ url: 'https://demos.flatsome.com/shop/shoes/all-star-canvas-hi-converse/' }) });
  const cc = await fetch(HS.SUPABASE_URL + '/functions/v1/channel-copy', { method: 'POST', headers: h, body: JSON.stringify({ channel: 'trendyol', product: { name: 'Test' } }) });
  const hp = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY };
  const ss = await fetch(HS.SUPABASE_URL + '/functions/v1/site-store', { method: 'POST', headers: hp, body: JSON.stringify({ action: 'distribute', jobId: '00000000-0000-0000-0000-000000000000', channels: [], userAccessToken: tok }) });
  return { imp: imp.status, impBody: (await imp.text()).slice(0, 120), cc: cc.status, ss: (await ss.text()).slice(0, 160) };
}"""


def main():
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page)
        page.wait_for_function("() => window.HS && HS.feature", timeout=30000)
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")
        try:
            all_on = page.evaluate("async () => (await HS.db.rpc('my_features')).data")
            c.check("Varsayılan: tüm anahtarlar açık", bool(all_on) and all(v is True for v in all_on.values()), f"{len(all_on or {})} anahtar")

            vals = ", ".join(f"('{uid}', '{k}', false, 'E2E test')" for k in KEYS)
            sql(f"insert into public.user_feature_overrides (user_id, key, enabled, note) values {vals} on conflict (user_id, key) do update set enabled = false;")
            page.reload()
            page.wait_for_function("() => window.HS && HS.feature", timeout=30000)
            off = page.evaluate("async (ks) => { const o = {}; for (const k of ks) o[k] = await HS.feature(k); return o; }", KEYS)
            c.check("Panel: HS.feature kapalıları görüyor", all(v is False for v in off.values()), str(off))
            r = page.evaluate(CALLS)
            c.check("Linkten yükleme kapalı -> 403", r["imp"] == 403 and "paketinde kapalı" in r["impBody"], str(r)[:200])
            c.check("Metni kanala göre yaz kapalı -> 403", r["cc"] == 403, str(r["cc"]))
            c.check("Çok kanal kapalı -> gönderim reddedildi", "paketinde kapalı" in r["ss"], r["ss"])
        finally:
            sql(f"delete from public.user_feature_overrides where user_id = '{uid}' and note = 'E2E test';")
        # Önbellek 60 sn; açılınca çalışmalı
        page.wait_for_timeout(61000)
        page.reload()
        page.wait_for_function("() => window.HS && HS.feature", timeout=30000)
        r = page.evaluate(CALLS)
        c.check("Geri açıldı -> linkten yükleme çalışıyor", r["imp"] == 200, str(r)[:160])
        c.check("Geri açıldı -> çok kanal (iş yok hatası, paket değil)", "paketinde kapalı" not in r["ss"], r["ss"])
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
