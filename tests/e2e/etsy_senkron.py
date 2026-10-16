"""Etsy senkronu panel testi: Printify etiketi, "Etsy'de yok" etiketi, sabit Etsy ücretiyle doğru net kâr ve toplamlar.
Test kullanıcısına geçici iki ürün eklenir (Printify sweatshirt: 2073,99 TL satış, 1358,49 TL maliyet, %9,5 + 22,24 TL Etsy kesintisi
-> net 496,23 TL; ikincisi Etsy'de silinmiş ilan), panel açılır, sonra kayıtlar silinir.
Çalıştırma: <venv>\\Scripts\\python tests\\e2e\\etsy_senkron.py [ekran_klasoru]   (SELTIGO_SITE ile yerel sunucu verilebilir)"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent)); sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "etsy-mockup"))
from ortak import SITE, Checks, login, shots_dir, test_user
from syscall import sql, rows
from playwright.sync_api import sync_playwright

email, _ = test_user(); c = Checks(); shots = shots_dir()
uid = rows(sql(f"select id from auth.users where email = '{email}';"))[0]["id"]
TAG = "e2e-etsy-senkron"
def cleanup():
    sql(f"delete from public.listings where user_id = '{uid}' and attributes->>'e2e' = '{TAG}'; delete from public.products where user_id = '{uid}' and source_item_id like '{TAG}%';")
cleanup()
r = rows(sql(f"""insert into public.products (user_id, name, sale_price, supplier, supplier_price, commission_rate, fixed_fee, cost_currency, platform, source_platform, source_item_id, product_type, store_visible)
values ('{uid}', 'E2E Printify Sweatshirt', 2073.99, 'printify', 1358.49, 9.5, 22.24, 'TRY', 'etsy', 'etsy', '{TAG}-1', 'physical', false),
       ('{uid}', 'E2E Etsy Removed Item', 249, null, null, 9.5, 22.24, 'TRY', 'etsy', 'etsy', '{TAG}-2', 'digital', false) returning id;"""))
p1, p2 = r[0]["id"], r[1]["id"]
sql(f"""insert into public.listings (user_id, product_id, marketplace_code, currency, title, price, status, external_listing_id, attributes, validation) values
('{uid}', {p1}, 'etsy', 'TRY', 'E2E Printify Sweatshirt', 2073.99, 'published', '{TAG}-1', '{{"managed_by":"printify","e2e":"{TAG}"}}', '{{"etsy":{{"state":"active"}}}}'),
('{uid}', {p2}, 'etsy', 'TRY', 'E2E Etsy Removed Item', 249, 'published', '{TAG}-2', '{{"managed_by":"etsy","e2e":"{TAG}"}}', '{{"etsy":{{"state":"removed"}}}}');""")
jobs = rows(sql(f"select count(*) n from public.sync_jobs where user_id = '{uid}' and created_at > now() - interval '2 minutes';"))[0]["n"]
c.check("içe aktarılan ilan gönderim kuyruğuna girmez", int(jobs) == 0, f"{jobs} iş")
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); page = b.new_page(viewport={"width": 1280, "height": 900})
        errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
        login(page); page.wait_for_selector(".product-row", timeout=30000); page.wait_for_timeout(1500)
        row1 = page.locator(".product-row", has_text="E2E Printify Sweatshirt"); row2 = page.locator(".product-row", has_text="E2E Etsy Removed Item")
        c.check("Printify etiketi görünür", row1.locator(".bundle-badge", has_text="Printify").count() == 1)
        t1 = row1.locator(".product-profit").inner_text()
        c.check("sweatshirt net kârı 496,23 TL", "496" in t1 and "23" in t1, t1)
        m1 = row1.locator(".product-meta").inner_text()
        c.check("marj %23,9", "23,9" in m1 or "23.9" in m1, m1)
        c.check("Etsy'de yok etiketi görünür", row2.locator(".bundle-badge", has_text="Etsy'de yok").count() == 1)
        total = page.locator("#totalProducts").inner_text()
        c.check("toplam ürün sayısı yeni ürünleri içerir", int(total.replace(".", "")) >= 2, total)
        row1.scroll_into_view_if_needed(); page.screenshot(path=str(shots / "etsy_senkron.png"))
        c.check("sayfa hatası yok", not errs, "; ".join(errs)[:200])
        b.close()
finally:
    cleanup()
c.finish()
