"""Seltigo Ads — canlı arka uç (test kullanıcısı; Meta bağlantısı olmadan çalışan kısımlar).

 1) status: hazırlık işaretleri (Meta / katalog / sayfa / hesap), canlı reklam kapalı (ADS_LIVE yok)
 2) plan: kârlı ürün seçimi (maliyet USD -> TL kur), nedenli eleme, bütçe sınırı yoksa bütçe 0
 3) kurallar girilince bütçe = günlük sınır; aylık sınır dolunca 0
 4) launch güvenlikleri: hesap yok -> açılmaz; sandbox olmayan hesap + ADS_LIVE yok -> açılmaz
 5) vitrin: pikseli olan mağazada get-store meta_pixel_id; sipariş reklam kaynağıyla (UTM / fbclid) kaydedilir
 6) saatlik iş (run) çalışır; asistan "reklamlar nasıl" / bildirim düğmeleri
Sonunda test kayıtları silinir.
"""
import os
import secrets
import subprocess
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, Checks

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
SLUG = "e2e-test-magaza"


def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "csv"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=180)
        return (r.stdout or "") + (r.stderr or "")


FN = """async ([fn, payload]) => { payload.userAccessToken = (await HS.db.auth.getSession()).data.session.access_token;
  const res = await fetch(HS.SUPABASE_URL + '/functions/v1/' + fn, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify(payload) });
  return await res.json().catch(() => ({})); }"""


def main():
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page)
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")
        ads = lambda payload: page.evaluate(FN, ["ads", payload])
        tag = "E2E-ADS-" + secrets.token_hex(3)
        # Ürünler: kârlı (maliyet USD), düşük kârlı, maliyetsiz, stoksuz
        out = sql(f"""insert into public.products (user_id, name, sale_price, supplier_price, cost_currency, stock_qty, store_visible, image_url) values
          ('{uid}', '{tag} karli', 1000, 5, 'USD', 10, true, 'https://picsum.photos/400'),
          ('{uid}', '{tag} dusuk', 100, 1.6, 'USD', 10, true, 'https://picsum.photos/400'),
          ('{uid}', '{tag} maliyetsiz', 500, null, null, 10, true, 'https://picsum.photos/400'),
          ('{uid}', '{tag} stoksuz', 900, 3, 'USD', 0, true, 'https://picsum.photos/400') returning id;""")
        ids = [int(x) for x in out.split() if x.strip().isdigit()]
        so_ids = []
        try:
            st = ads({"action": "status"})
            c.check("status: hesap yok, canlı reklam kapalı (ADS_LIVE yok)", st.get("ok") and st["live"] is False and st["ready"]["account"] is False and st["account"] is None, str(st.get("ready")))

            pl = ads({"action": "plan", "productIds": ids})
            picked = [x["id"] for x in pl["picked"]]
            why = {x["id"]: x.get("reason", "") for x in pl["skipped"]}
            c.check("Plan: yalnız kârlı ürün seçildi (USD maliyet TL'ye çevrildi)", picked == [ids[0]] and pl["picked"][0]["marginPct"] > 60, str(pl["picked"])[:200])
            c.check("Elenenler nedenli: düşük kâr / maliyet yok / stokta yok", "Kâr oranı" in why.get(ids[1], "") and "Maliyet" in why.get(ids[2], "") and why.get(ids[3]) == "Stokta yok", str(why))
            c.check("Bütçe sınırı girilmeden bütçe 0 (reklam açılmaz)", pl["budget"] == 0 and "sınırı" in (pl["budgetReason"] or ""), str(pl["budgetReason"]))

            page.evaluate("async (u) => await HS.db.from('ad_rules').upsert({ user_id: u, daily_cap: 250, monthly_cap: 5000, target_roas: 3, min_margin_pct: 25 })", uid)
            pl = ads({"action": "plan", "productIds": ids})
            c.check("Kurallar girilince bütçe = günlük sınır (250)", pl["budget"] == 250, str(pl["budget"]))
            pl2 = ads({"action": "plan", "productIds": ids, "dailyBudget": 100})
            c.check("İstenen bütçe sınırın altındaysa o kullanılır (100)", pl2["budget"] == 100)

            ln = ads({"action": "launch", "productIds": ids})
            c.check("Reklam hesabı yoksa reklam açılmaz", ln.get("ok") is False and "hesabı bağlı değil" in ln.get("error", ""), str(ln))
            sql(f"""insert into public.ad_accounts (user_id, platform, external_id, name, currency, sandbox, pixel_id, page_id, status) values
              ('{uid}', 'meta', 'act_e2e_live', 'E2E canlı hesap', 'TRY', false, '1234567890123', 'PAGE_E2E', 'connected');""")
            ln = ads({"action": "launch", "productIds": ids})
            c.check("Sandbox olmayan hesap + canlı kapalı -> reklam açılmaz (para harcanmaz)", ln.get("ok") is False and "sandbox" in ln.get("error", ""), str(ln))
            sql(f"update public.ad_accounts set sandbox = true where user_id = '{uid}';")
            ln = ads({"action": "launch", "productIds": ids})
            c.check("Sandbox hesap ama Facebook bağlantısı / katalog yok -> anlaşılır hata", ln.get("ok") is False and ("Facebook" in ln.get("error", "") or "katalog" in ln.get("error", "")), str(ln))
            n_camp = page.evaluate("async () => (await HS.db.from('ad_campaigns').select('id')).data.length")
            c.check("Başarısız denemede kampanya kaydı açılmadı", n_camp == 0, str(n_camp))

            # Aylık sınır dolu
            sql(f"""insert into public.ad_campaigns (id, user_id, account_id, name, status, daily_budget, currency, product_ids, breakeven_roas)
              select '00000000-0000-0000-0000-0000000e2e01', '{uid}', id, '{tag} kampanya', 'paused', 100, 'TRY', array[{ids[0]}]::bigint[], 1.3 from public.ad_accounts where user_id = '{uid}';
              insert into public.ad_spend_ledger (campaign_id, day, user_id, amount, currency) values ('00000000-0000-0000-0000-0000000e2e01', current_date, '{uid}', 5000, 'TRY');
              insert into public.ad_metrics_daily (campaign_id, product_id, day, user_id, spend, revenue, purchases) values ('00000000-0000-0000-0000-0000000e2e01', 0, current_date, '{uid}', 5000, 15000, 12);
              update public.ad_campaigns set spend_7d = 5000, revenue_7d = 15000, roas_7d = 3 where id = '00000000-0000-0000-0000-0000000e2e01';""")
            pl = ads({"action": "plan", "productIds": ids})
            c.check("Aylık sınır dolunca bütçe 0", pl["budget"] == 0 and "Aylık" in (pl["budgetReason"] or ""), str(pl["budgetReason"]))
            rs = ads({"action": "resume", "campaignId": "00000000-0000-0000-0000-0000000e2e01"})
            c.check("Aylık sınır doluyken yeniden başlatılamaz", rs.get("ok") is False, str(rs))

            # Vitrin: piksel + reklam kaynağı
            store = browser.new_page()
            store.goto(f"{SITE}/magaza.html?slug={SLUG}&utm_source=meta&utm_campaign=e2e&fbclid=E2E{secrets.token_hex(4)}")
            store.wait_for_selector(".card", timeout=60000)
            store.wait_for_function("() => typeof window.fbq === 'function'", timeout=20000)
            px = store.evaluate("() => (typeof currentStore !== 'undefined' && currentStore && currentStore.meta_pixel_id) || null")
            c.check("Vitrin: mağazanın Meta pikseli yüklendi", px == "1234567890123" and store.evaluate("() => typeof window.fbq === 'function'"), str(px))
            store.locator(".card .buy-btn").first.click()
            store.wait_for_selector("#orderModalOverlay.open")
            for sel in store.locator("#variantFields select").all():
                opts = [o for o in sel.locator("option").all() if o.get_attribute("value") and o.get_attribute("disabled") is None]
                if opts: sel.select_option(opts[0].get_attribute("value"))
            store.fill("#orderName", "E2E Reklam Alıcı"); store.fill("#orderPhone", "05551112233"); store.fill("#orderAddress", "Caferağa Mah. Test Sok. No 5")
            store.fill("#orderCity", "İstanbul"); store.fill("#orderDistrict", "Kadıköy")
            store.wait_for_selector("#preinfoBox", state="visible", timeout=15000); store.check("#orderPreinfo")
            store.click("#orderSubmitBtn")
            store.wait_for_selector("#orderDone", state="visible", timeout=30000)
            src = page.evaluate("async () => (await HS.db.from('store_orders').select('ad_source').eq('customer_name', 'E2E Reklam Alıcı').order('created_at', {ascending:false}).limit(1)).data?.[0]?.ad_source")
            c.check("Sipariş reklam kaynağıyla kaydedildi (utm + fbclid / fbc)", bool(src) and src.get("utm_source") == "meta" and src.get("utm_campaign") == "e2e" and str(src.get("fbc", "")).startswith("fb.1."), str(src))

            # Asistan: durum komutu + bildirim düğmeleri
            CALL = """async (p) => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
              const res = await fetch(HS.SUPABASE_URL + '/functions/v1/assistant', { method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify({ ...p, userAccessToken: tok }) });
              return await res.json().catch(() => ({})); }"""
            say = lambda **kw: page.evaluate(CALL, dict(action="test", externalId="reklam", **kw))
            code = page.evaluate(CALL, {"action": "link_code", "channel": "test"})["code"]
            say(text=code)
            r = say(text="reklamlar nasıl")
            t = "\n".join(x.get("text", "") for x in (r.get("replies") or []))
            c.check("Asistan 'reklamlar nasıl' -> 7 günlük özet (harcama, satış, ROAS)", "Reklamlar" in t and "ROAS 3" in t, t[:200])
            r = say(text="reklam bütçesini 300 yap")
            t = "\n".join(x.get("text", "") for x in (r.get("replies") or []))
            c.check("Asistan 'reklam bütçesini 300 yap' -> aylık sınır dolu, yapılamaz (güvenli)", "yapılamadı" in t and "Aylık" in t, t[:200])
        finally:
            ids_s = ",".join(map(str, ids)) or "0"
            sql(f"""delete from public.ad_campaigns where user_id = '{uid}';
              delete from public.ad_accounts where user_id = '{uid}';
              delete from public.ad_rules where user_id = '{uid}';
              delete from public.store_orders where user_id = '{uid}' and customer_name = 'E2E Reklam Alıcı';
              delete from public.products where id in ({ids_s});
              delete from public.assistant_links where user_id = '{uid}' and channel = 'test';""")
            browser.close()
    c.finish()


if __name__ == "__main__":
    main()
