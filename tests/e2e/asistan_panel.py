"""Panel: 🤖 Asistan sayfası (asistan.html).

 1) Menüde "🤖 Asistan", sayfada 4 kanal (Telegram, WhatsApp, Instagram DM, Messenger)
 2) [Telegram'a bağla] -> 8 haneli bağlama kodu
 3) Kod Telegram'dan gönderilmiş gibi (telegram-bot, sistem çağrısı) -> sayfa yenilenmeden "Bağlı hesaplar"da görünür
 4) Ayarlar: Kâr kuralı, Varsayılan kanallar, Yayından önce onay iste, Haftalık özet, Sessiz saatler -> Kaydet -> yenileyince aynı;
    katalog sayfasındaki diğer kurallar (yuvarlama vb.) bozulmaz
 5) Çalışanlar: "Sadece siparişler" yetkisiyle kod
 6) [Bağlantıyı kaldır] -> listeden ve veritabanından silinir
 7) Telefon genişliğinde yatay kaydırma yok
Sonunda ayarlar eski haline döner.
"""
import os
import subprocess
import tempfile
import time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
REF = "ytucdrrgxsjhrqmaxckt"


def sys_call(fn, body_json):
    """Sistem çağrısı: mevcut cron komutunu kopyalayıp hedef fonksiyonu ve gövdeyi değiştirir (gizli anahtar dışarı çıkmaz)."""
    sql = f"""do $$ declare v text; begin
  select replace(replace(command, '/functions/v1/cj-alt-match', '/functions/v1/{fn}'), '{{"cronSecret"', '{body_json[:-1]},"cronSecret"') into v
  from cron.job where jobname = 'cj-alt-match-1h';
  execute v;
end $$;"""
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(sql, encoding="utf-8")
        subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", REF, "-f", str(f), "-o", "csv"], cwd=d, capture_output=True, timeout=120)


def main():
    shots = shots_dir()
    c = Checks()
    chat_id = str(990000 + int(time.time()) % 9999)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page)
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        old = page.evaluate("""async () => { const uid = (await HS.db.auth.getUser()).data.user.id;
            return { s: (await HS.db.from('assistant_settings').select('*').eq('user_id', uid).maybeSingle()).data,
                     r: (await HS.db.from('import_rules').select('rules').eq('user_id', uid).maybeSingle()).data }; }""")
        try:
            # 1) Menü + kanallar
            c.check("Panel menüsünde \"🤖 Asistan\"", page.locator("button[data-i18n='menu.assistant']").count() == 1)
            page.goto(f"{SITE}/asistan.html")
            page.wait_for_selector(".ch", timeout=30000)
            names = page.locator(".ch-name").all_inner_texts()
            c.check("4 kanal kartı", len(names) == 4 and "Telegram" in names[0] and "WhatsApp" in names[1], str(names))
            c.check("Başlık \"🤖 Asistan\"", page.locator("h1").inner_text() == "🤖 Asistan")

            # 2) Bağlama kodu
            page.click("#tgBtn")
            page.wait_for_selector("#codeBoxCode", timeout=20000)
            code = page.locator("#codeBoxCode").inner_text().strip()
            c.check("[Telegram'a bağla] -> 8 haneli kod", len(code) == 8 and code.isalnum(), code)
            page.screenshot(path=str(Path(shots) / "asistan_kod.png"), full_page=True)

            # 3) Telegram'dan bağlanma (sistem çağrısı) -> liste kendiliğinden güncellenir
            sys_call("telegram-bot", '{"update":{"update_id":1,"message":{"message_id":1,"chat":{"id":%s,"type":"private"},"from":{"id":%s,"first_name":"E2E","last_name":"Telegram"},"text":"/start %s"}}}' % (chat_id, chat_id, code))
            try:
                page.wait_for_selector("#linkList .item", timeout=40000)
                item = page.locator("#linkList .item").first.inner_text()
            except Exception:
                item = ""
            c.check("Telegram bağlantısı listede (sayfa yenilemeden)", "Telegram" in item and "E2E Telegram" in item and "Tam yetki" in item, item[:120])

            # 4) Ayarlar
            page.fill("#margin", "40")
            page.check("input[name=chan][value=trendyol]")
            page.check("input[name=mode][value=approve]")
            page.uncheck("#weekly")
            page.fill("#qStart", "23:00"); page.fill("#qEnd", "07:00")
            c.check("Değişiklikte \"Kaydedilmemiş\" uyarısı", "Kaydedilmemiş" in page.locator("#saveMsg").inner_text())
            page.click("#saveBtn")
            page.wait_for_selector("#toast:has-text('Kaydedildi')", timeout=15000)
            page.reload()
            page.wait_for_selector("#margin", timeout=30000)
            ok = (page.input_value("#margin") == "40" and page.is_checked("input[name=chan][value=trendyol]") and page.is_checked("input[name=chan][value=own_store]")
                  and page.is_checked("input[name=mode][value=approve]") and not page.is_checked("#weekly") and page.is_checked("#morning")
                  and page.input_value("#qStart") == "23:00" and page.input_value("#qEnd") == "07:00")
            c.check("Ayarlar kaydedildi ve yenileyince aynı", ok)
            rules = page.evaluate("async () => (await HS.db.from('import_rules').select('rules').maybeSingle()).data?.rules")
            prev = (old.get("r") or {}).get("rules") or {}
            kept = all(rules.get(k) == v for k, v in prev.items() if k != "margin")
            c.check("Kâr kuralı katalog kurallarıyla ortak; diğer kurallar bozulmadı", rules.get("margin") == 40 and kept, str(rules)[:160])

            # 5) Çalışan
            page.select_option("#empRole", "orders")
            page.click("#empBtn")
            page.wait_for_selector("#empCodeBoxCode", timeout=20000)
            ecode = page.locator("#empCodeBoxCode").inner_text().strip()
            row = page.evaluate("async (c) => (await HS.db.from('assistant_link_codes').select('role, is_owner, channel').eq('code', c).maybeSingle()).data", ecode)
            c.check("Çalışan kodu: Sadece siparişler, sahip değil", row and row["role"] == "orders" and row["is_owner"] is False and row["channel"] == "telegram", str(row))

            # 7) Telefon genişliği
            page.set_viewport_size({"width": 375, "height": 800})
            sw = page.evaluate("() => document.documentElement.scrollWidth")
            page.screenshot(path=str(Path(shots) / "asistan_telefon.png"), full_page=True)
            c.check("Telefonda yatay kaydırma yok", sw <= 376, str(sw))
            page.set_viewport_size({"width": 1280, "height": 900})

            # 6) Bağlantıyı kaldır
            page.on("dialog", lambda d: d.accept())
            page.locator("#linkList .item").filter(has_text="E2E Telegram").locator("button").click()
            page.wait_for_selector("#toast:has-text('kaldırıldı')", timeout=15000)
            left = page.evaluate("async (x) => (await HS.db.from('assistant_links').select('id').eq('channel', 'telegram').eq('external_id', x)).data.length", chat_id)
            c.check("[Bağlantıyı kaldır] -> silindi", left == 0 and "E2E Telegram" not in page.locator("#linkList").inner_text())
            page.screenshot(path=str(Path(shots) / "asistan_ayar.png"), full_page=True)
        finally:
            page.evaluate("""async (o) => { const uid = (await HS.db.auth.getUser()).data.user.id;
                if (o.s) await HS.db.from('assistant_settings').upsert(o.s); else await HS.db.from('assistant_settings').delete().eq('user_id', uid);
                if (o.r) await HS.db.from('import_rules').upsert({ user_id: uid, rules: o.r.rules });
                await HS.db.from('assistant_links').delete().eq('user_id', uid).eq('channel', 'telegram').like('display_name', 'E2E%'); }""", old)
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
