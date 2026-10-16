"""🗓️ İçerik Takvimi — uçtan uca (test kullanıcısı; sahte Instagram / Facebook bağlantısı, anahtar yok -> paylaşım Meta'ya gitmez).

 1) Panel menüsü; sayfa: varsayılanlar (kapalı, günde 1, haftada 3 hikâye, 19:30, onay açık), kanallar bağlı görünür
 2) "Planı şimdi oluştur": 7 gün × 2 kanal gönderi + 3 hikâye; şablon görseli (herkese açık JPEG), AI metni; hepsi onay bekliyor
 3) Onayla / Metni düzenle / Atla; "Hepsini onayla" bekleyenleri zamanlar
 4) Şimdi paylaş (Facebook): anahtar yok -> anlaşılır hata satırda
 5) Saatlik iş: zamanı gelen Instagram içeriği paylaşım kuyruğuna (görsel + metin + tür) girer; kuyruk "paylaşıldı" olunca içerik "Paylaşıldı" + bağlantı
 6) Onaysız zamanı geçen içerik atlanır
"""
import os
import secrets
import subprocess
import tempfile
import urllib.request
import json
import time
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"


def sql(q, fmt="csv"):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", fmt], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=180)
        return (r.stdout or "") + (r.stderr or "")


def run_content():
    """Saatlik işi bir kez çalıştır (sistem çağrısı; cron komutu kopyalanır)."""
    tag = "syscall:" + uuid.uuid4().hex
    sql(f"""do $$ declare v text; rid bigint; begin
  select replace(replace(command, '/functions/v1/cj-alt-match', '/functions/v1/content'), '{{"cronSecret"', '{{"action":"run","cronSecret"') into v from cron.job where jobname='cj-alt-match-1h';
  v := replace(v, ';', ''); execute v into rid; insert into public.app_cache(key, value) values ('{tag}', to_jsonb(rid)); end $$;""")
    for _ in range(60):
        out = sql(f"select r.content from net._http_response r join public.app_cache a on a.key = '{tag}' and r.id = (a.value #>> '{{}}')::bigint;", "json")
        try:
            rows = json.loads(out[out.index("["):out.rindex("]") + 1])
        except Exception:
            rows = []
        if rows and rows[0].get("content"):
            return rows[0]["content"]
        time.sleep(4)
    return ""


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
        tag = "E2E-ICERIK-" + secrets.token_hex(3)
        sql(f"delete from public.content_items where user_id = '{uid}'; delete from public.content_settings where user_id = '{uid}';")
        vals = ",".join(f"('{uid}', '{tag} ürün {i}', {100 + i * 50}, 10, true, 'https://picsum.photos/seed/{tag}{i}/900')" for i in range(1, 9))
        out = sql(f"insert into public.products (user_id, name, sale_price, stock_qty, store_visible, image_url) values {vals} returning id;")
        pids = [int(x) for x in out.split() if x.strip().isdigit()]
        out = sql(f"""insert into public.social_channels (user_id, platform, account_id, account_name, active, token_status) values
          ('{uid}', 'instagram', 'IG_E2E_{tag}', '@e2e_test', true, 'ok'), ('{uid}', 'facebook', 'FB_E2E_{tag}', 'E2E Sayfa', true, 'ok') returning id;""")
        chids = [x.strip() for x in out.split() if len(x.strip()) == 36]
        try:
            page.goto(f"{SITE}/dashboard.html")
            page.wait_for_selector("[data-i18n='menu.content']", state="attached", timeout=30000)
            c.check("Panel menüsünde '🗓️ İçerik Takvimi'", "İçerik Takvimi" in page.text_content("[data-i18n='menu.content']"))
            page.goto(f"{SITE}/content.html")
            page.wait_for_selector("#setCard", timeout=30000)
            d = page.evaluate("() => ({ en: document.getElementById('cEnabled').checked, pd: document.getElementById('cPerDay').value, pw: document.getElementById('cPerWeek').value, h: document.getElementById('cHour').value, ap: document.getElementById('cApproval').checked })")
            c.check("Varsayılanlar: kapalı, günde 1, haftada 3 hikâye, 19:30, onay açık", d == {"en": False, "pd": "1", "pw": "3", "h": "19:30", "ap": True}, str(d))
            sc = page.inner_text("#setCard")
            c.check("Kanallar bağlı görünür (Instagram @e2e_test, Facebook E2E Sayfa)", "@e2e_test" in sc and "E2E Sayfa" in sc)
            t0 = time.time()
            page.click("#planBtn")
            page.wait_for_selector(".item", timeout=240000)
            took = time.time() - t0
            items = page.evaluate("async () => (await HS.db.from('content_items').select('*').order('scheduled_at')).data")
            posts = [i for i in items if i["kind"] == "post"]; stories = [i for i in items if i["kind"] == "story"]
            c.check("Plan: gönderiler 2 kanalda (6-7 gün) + hikâyeler (bugünün saati geçtiyse 2), hepsi onay bekliyor", len(posts) >= 12 and len(stories) >= 2 and all(i["status"] == "pending_approval" for i in items), f"{len(posts)} gönderi, {len(stories)} hikâye, {took:.0f} sn")
            img = items[0]["media_urls"][0]
            ok_img = urllib.request.urlopen(img, timeout=30).headers.get("Content-Type", "")
            c.check("Şablon görseli herkese açık JPEG", "image/jpeg" in ok_img, ok_img)
            c.check("Gönderi metinleri hazır (hikâyede metin yok)", all((i["caption"] or "").strip() for i in posts) and all(not i["caption"] for i in stories), str(posts[0]["caption"])[:120])
            c.check("Şablon çeşitliliği", len({i["template"] for i in posts}) >= 2, str({i["template"] for i in posts}))
            page.screenshot(path=str(Path(shots) / "icerik_plan.png"), full_page=True)
            c.check("Onay çubuğu: 'N içerik onay bekliyor' + 'Hepsini onayla'", "onay bekliyor" in page.inner_text("#pendBar"))
            # Onayla / düzenle / atla
            first, second, third = posts[0]["id"], posts[1]["id"], posts[2]["id"]
            page.click(f"[data-item='{first}'] [data-act='approve']")
            page.wait_for_function(f"() => /Zamanlandı/.test(document.querySelector(\"[data-item='{first}']\").innerText)", timeout=30000)
            c.check("Onayla -> Zamanlandı", True)
            page.click(f"[data-item='{second}'] [data-act='edit']")
            page.fill("#capEdit", "E2E düzenlenmiş metin #test")
            page.click(f"[data-item='{second}'] [data-act='saveCap']")
            page.wait_for_function(f"() => /E2E düzenlenmiş metin/.test(document.querySelector(\"[data-item='{second}']\").innerText)", timeout=30000)
            c.check("Metni düzenle -> kaydedildi", True)
            page.click(f"[data-item='{third}'] [data-act='skip']")
            page.wait_for_function(f"() => /Atlandı/.test(document.querySelector(\"[data-item='{third}']\").innerText)", timeout=30000)
            c.check("Atla -> Atlandı", True)
            fb = next(i for i in posts[3:] if i["channel"] == "facebook")
            page.click(f"[data-item='{fb['id']}'] [data-act='publish_now']")
            page.wait_for_function(f"() => /Hata/.test(document.querySelector(\"[data-item='{fb['id']}']\").innerText)", timeout=60000)
            c.check("Şimdi paylaş (Facebook, anahtar yok) -> anlaşılır hata", "anahtar" in page.inner_text(f"[data-item='{fb['id']}']"), page.inner_text(f"[data-item='{fb['id']}']")[-120:])
            page.click("#approveAll")
            page.wait_for_function("() => !document.getElementById('pendBar')", timeout=30000)
            left = page.evaluate("async () => (await HS.db.from('content_items').select('id').eq('status', 'pending_approval')).data.length")
            c.check("Hepsini onayla -> onay bekleyen kalmadı", left == 0)
            # Saatlik iş: Instagram içeriğinin zamanı geldi
            ig = next(i for i in posts if i["channel"] == "instagram" and i["id"] not in (third,))
            sql(f"update public.content_items set scheduled_at = now() - interval '1 minute', status = 'scheduled' where id = '{ig['id']}';")
            run_content()
            sp = page.evaluate(f"async () => (await HS.db.from('content_items').select('status, social_post_id').eq('id', '{ig['id']}').single()).data")
            c.check("Saatlik iş: Instagram içeriği paylaşım kuyruğunda (görsel + metin)", sp["status"] == "publishing" and sp["social_post_id"], str(sp))
            sql(f"update public.social_posts set status = 'posted', post_id = 'IGMEDIA_E2E', post_url = 'https://instagram.com/p/e2e', posted_at = now() where id = '{sp['social_post_id']}';")
            run_content()
            fin = page.evaluate(f"async () => (await HS.db.from('content_items').select('status, external_id, external_url').eq('id', '{ig['id']}').single()).data")
            c.check("Kuyruk 'paylaşıldı' -> içerik 'Paylaşıldı' + bağlantı", fin["status"] == "published" and fin["external_id"] == "IGMEDIA_E2E", str(fin))
            # Onaysız zamanı geçen atlanır
            other = next(i for i in posts if i["id"] not in (first, second, third, fb["id"], ig["id"]))
            sql(f"update public.content_items set status = 'pending_approval', scheduled_at = now() - interval '3 hours' where id = '{other['id']}';")
            run_content()
            st = page.evaluate(f"async () => (await HS.db.from('content_items').select('status').eq('id', '{other['id']}').single()).data.status")
            c.check("Onaylanmadan zamanı geçen içerik atlandı", st == "skipped", st)
            page.reload(); page.wait_for_selector(".item", timeout=30000)
            c.check("Sayfa: 'Paylaşıldı' + 'Gönderiyi aç'", "Paylaşıldı" in page.inner_text("#content") and "Gönderiyi aç" in page.inner_text("#content"))
            page.screenshot(path=str(Path(shots) / "icerik_sonuc.png"), full_page=True)
            c.check("Sayfada JavaScript hatası yok", not errors, str(errors[:3]))
        finally:
            sql(f"""delete from public.social_posts where user_id = '{uid}' and channel_id in ({",".join(f"'{x}'" for x in chids) or "null"});
              delete from public.content_items where user_id = '{uid}'; delete from public.content_settings where user_id = '{uid}';
              delete from public.social_channels where id in ({",".join(f"'{x}'" for x in chids) or "null"});
              delete from public.products where id in ({",".join(map(str, pids)) or "0"});""")
            browser.close()
    c.finish()


if __name__ == "__main__":
    main()
