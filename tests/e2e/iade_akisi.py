"""İade otomasyonu (returns) — uçtan uca, test kullanıcısıyla.

Kendi Mağazam siparişleri SQL ile hazırlanır (teslim edilmiş); müşteri tarafı takip anahtarıyla, satıcı tarafı oturumla çağrılır.
 1) info: iade hakkı ve kalan gün
 2) "Beden uymadı": kurala uygun -> otomatik onay -> Yurtiçi TEST ortamında iade etiketi; kargo ücretini müşteri öder; aynı siparişe ikinci talep reddedilir
 3) "Kusurlu" ama fotoğraf yok -> satıcı onayına düşer; satıcı onaylar -> iade etiketi
 4) Satıcı "teslim aldım" -> stok geri eklenir, para iadesi defteri (bekliyor); "parayı iade ettim" -> tamam
 5) Dropshipping (CJ) ürünü: ürün geri gelmez, etiket açılmaz, para iadesi bekler
 6) Kusurlu + fotoğraf: AI fotoğrafı kontrol eder (düz renk -> kusur yok -> satıcıya)
 7) Otomatik onay sınırı üstü tutar ve süresi geçmiş sipariş -> satıcıya
 8) Paket anahtarı returns_auto kapalı -> otomatik işlem yok
 9) Güvenlik: oturumsuz satıcı işlemi 401, başka iade numarası bulunamaz, yanlış takip anahtarı
Sonunda tüm test kayıtları silinir.
"""
import os
import secrets
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright
from ortak import SITE, login, Checks

CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"
        f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "csv"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=180)
        return (r.stdout or "") + (r.stderr or "")


CALL = """async ([fn, payload, auth]) => {
  if (auth) payload.userAccessToken = (await HS.db.auth.getSession()).data.session.access_token;
  const res = await fetch(HS.SUPABASE_URL + '/functions/v1/' + fn, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json().catch(() => null) }; }"""


def main():
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        login(page)
        page.wait_for_function("() => window.HS && HS.db", timeout=30000)
        uid = page.evaluate("async () => (await HS.db.auth.getUser()).data.user.id")
        call = lambda fn, payload, auth=False: page.evaluate(CALL, [fn, payload, auth])
        get = lambda rid: page.evaluate("async (id) => (await HS.db.from('returns').select('*').eq('id', id).maybeSingle()).data", rid)
        tag = "E2E-IADE-" + secrets.token_hex(3)
        out = sql(f"""insert into public.products (user_id, name, sale_price, stock_qty, store_visible, content_language) values
          ('{uid}', '{tag} kendi', 100, 5, false, 'tr'), ('{uid}', '{tag} cj', 100, null, false, 'tr') returning id;""")
        ids = [int(x) for x in out.split() if x.strip().isdigit()]
        own, cj = ids[0], ids[1]
        sql(f"update public.products set supplier='cj' where id={cj};")
        tokens = {}

        def order(name, pid, days=2, price=100):
            t = secrets.token_hex(16)
            sql(f"""insert into public.store_orders (user_id, product_id, customer_name, customer_phone, customer_address, customer_city, customer_district, status, quantity, unit_price, currency, tracking_token, shipped_at, delivered_at)
              values ('{uid}', {pid}, 'E2E Alıcı', '05551112233', 'Caferağa Mah. Test Sok. No 5', 'İstanbul', 'Kadıköy', 'delivered', 1, {price}, 'TRY', '{t}', now() - interval '{days + 2} days', now() - interval '{days} days');""")
            tokens[name] = t
            return t

        try:
            # 1) info
            t1 = order("o1", own)
            i = call("returns", {"action": "info", "token": t1})["body"]
            c.check("İade hakkı: talep açılabilir, kalan gün 12", i.get("ok") and i["canRequest"] and i["daysLeft"] == 12 and "size" in i["reasons"], str(i)[:200])

            # 2) Beden -> otomatik onay -> iade etiketi (Yurtiçi test)
            r = call("returns", {"action": "request", "token": t1, "reasonCode": "size", "text": "Küçük geldi", "quantity": 1})["body"]
            rid1 = (r.get("return") or {}).get("id")
            ret = get(rid1) if rid1 else {}
            for _ in range(3):  # Yurtiçi test sunucusu zaman zaman geç yanıt verir; satıcı "etiketi tekrar dene"
                if ret.get("status") == "label_ready": break
                call("returns", {"action": "label", "returnId": rid1}, True); ret = get(rid1)
            if ret.get("status") == "label_ready": r["return"]["label"] = call("returns", {"action": "info", "token": t1})["body"]["return"]["label"]
            c.check("Beden uymadı: otomatik onaylandı", r.get("ok") and r.get("waiting") is False and ret.get("decision") == "auto", str(r)[:200])
            c.check("İade etiketi Yurtiçi test ortamında oluştu (iade kodu + etiket)", ret.get("status") == "label_ready" and ret.get("return_code") and (r["return"] or {}).get("label"),
                    f"{ret.get('status')} {ret.get('return_code')} {str(ret.get('events'))[-160:]}")
            c.check("Kargo ücretini müşteri öder (beden)", ret.get("shipping_payer") == "customer")
            sh = page.evaluate("async (id) => (await HS.db.from('shipments').select('kind, provider, test, status').eq('return_id', id).maybeSingle()).data", rid1)
            c.check("Gönderi kaydı: iade türünde, test", sh and sh["kind"] == "return" and sh["test"] is True, str(sh))
            dup = call("returns", {"action": "request", "token": t1, "reasonCode": "size"})["body"]
            c.check("Aynı siparişe ikinci talep reddedildi", dup.get("ok") is False, str(dup))
            i2 = call("returns", {"action": "info", "token": t1})["body"]
            c.check("Takip sayfası bilgisi iade durumunu gösterir", i2["canRequest"] is False and i2["return"]["status"] == "label_ready", str(i2.get("return"))[:160])

            # 3) Kusurlu, fotoğraf yok -> satıcı onayı
            t2 = order("o2", own)
            r = call("returns", {"action": "request", "token": t2, "reasonCode": "defective", "text": "Fermuar bozuk"})["body"]
            rid2 = r["return"]["id"]
            ret = get(rid2)
            c.check("Kusurlu + fotoğraf yok: satıcı onayına düştü", r["waiting"] is True and ret["status"] == "requested" and "fotoğraf" in (ret["decision_note"] or ""), ret["decision_note"])
            d = call("returns", {"action": "decide", "returnId": rid2, "approve": True}, True)["body"]
            ret = get(rid2)
            for _ in range(3):
                if ret["status"] == "label_ready": break
                call("returns", {"action": "label", "returnId": rid2}, True); ret = get(rid2)
            c.check("Satıcı onayladı -> iade etiketi", d.get("ok") and ret["decision"] == "seller" and ret["status"] == "label_ready", f"{d} {ret['status']}")
            dl = call("returns", {"action": "label", "returnId": rid2}, True)["body"]
            c.check("Etiketi tekrar dene: zaten hazırsa aynı gönderi kullanılır (ikinci gönderi açılmaz)", page.evaluate("async (id) => (await HS.db.from('shipments').select('id').eq('return_id', id).neq('status','cancelled')).data.length", rid2) == 1, str(dl))
            again = call("returns", {"action": "decide", "returnId": rid2, "approve": False}, True)["body"]
            c.check("Karar verilmiş iadeye tekrar red verilemez", again.get("ok") is False, str(again))

            # 4) Teslim alındı -> stok + para iadesi defteri; parayı iade ettim
            stock0 = page.evaluate("async (id) => (await HS.db.from('products').select('stock_qty').eq('id', id).single()).data.stock_qty", own)
            rc = call("returns", {"action": "received", "returnId": rid2}, True)["body"]
            ret = get(rid2)
            stock1 = page.evaluate("async (id) => (await HS.db.from('products').select('stock_qty').eq('id', id).single()).data.stock_qty", own)
            led = page.evaluate("async (id) => (await HS.db.from('refund_ledger').select('amount, status, method').eq('return_id', id).maybeSingle()).data", rid2)
            c.check("Teslim alındı: stok geri eklendi (+1)", rc.get("ok") and ret["restocked"] and stock1 == stock0 + 1, f"{stock0}->{stock1}")
            c.check("Para iadesi defteri: 100 TL bekliyor (kargo satıcıdan)", led and float(led["amount"]) == 100 and led["status"] == "pending" and ret["refund_status"] == "pending", str(led))
            rf = call("returns", {"action": "refunded", "returnId": rid2}, True)["body"]
            ret = get(rid2)
            led = page.evaluate("async (id) => (await HS.db.from('refund_ledger').select('status').eq('return_id', id).maybeSingle()).data", rid2)
            c.check("Parayı iade ettim: iade tamamlandı", rf.get("ok") and ret["status"] == "refunded" and ret["refund_status"] == "done" and led["status"] == "done")

            # 5) Dropshipping
            t3 = order("o3", cj)
            r = call("returns", {"action": "request", "token": t3, "reasonCode": "changed_mind"})["body"]
            ret = get(r["return"]["id"])
            shc = page.evaluate("async (id) => (await HS.db.from('shipments').select('id').eq('return_id', id)).data.length", ret["id"])
            c.check("Dropshipping: otomatik onay, ürün geri gelmez (etiket yok), para iadesi bekliyor", ret["status"] == "approved" and shc == 0 and ret["refund_status"] == "pending", f"{ret['status']} {shc} {ret['refund_status']}")

            # 6) Kusurlu + fotoğraf: AI kontrol eder
            t4 = order("o4", own)
            png = page.evaluate("() => { const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); x.fillStyle = '#c0392b'; x.fillRect(0, 0, 256, 256); return c.toDataURL('image/png'); }")
            r = call("returns", {"action": "request", "token": t4, "reasonCode": "damaged", "text": "Kutu ezik geldi", "photos": [png]})["body"]
            ret = get(r["return"]["id"])
            c.check("Fotoğraf özel depoya kaydedildi", len(ret["photos"]) == 1 and ret["photos"][0].startswith(uid + "/"), str(ret["photos"]))
            c.check("AI fotoğrafı inceledi; kusur görünmüyor -> satıcıya", ret["ai"] and ret["ai"].get("defect_visible") is False and ret["status"] == "requested", str(ret["ai"])[:200] + " | " + str(ret["decision_note"]))
            ph = call("returns", {"action": "photos", "returnId": ret["id"]}, True)["body"]
            c.check("Satıcı fotoğrafı imzalı adresle görür", ph.get("ok") and len(ph["urls"]) == 1 and "token=" in ph["urls"][0])

            # 7) Sınır üstü tutar ve süresi geçmiş
            t5 = order("o5", own, price=5000)
            r = call("returns", {"action": "request", "token": t5, "reasonCode": "size"})["body"]
            c.check("Otomatik onay sınırı üstü (5000 > 1000) -> satıcıya", r["waiting"] is True and "sınır" in (get(r["return"]["id"])["decision_note"] or ""))
            t6 = order("o6", own, days=20)
            r = call("returns", {"action": "request", "token": t6, "reasonCode": "size"})["body"]
            c.check("İade süresi geçmiş (20 gün > 14) -> satıcıya", r["waiting"] is True and "süre" in (get(r["return"]["id"])["decision_note"] or ""))

            # 8) Paket anahtarı kapalı
            sql(f"insert into public.user_feature_overrides (user_id, key, enabled, note) values ('{uid}', 'returns_auto', false, 'e2e') on conflict (user_id, key) do update set enabled = false;")
            t7 = order("o7", own)
            r = call("returns", {"action": "request", "token": t7, "reasonCode": "size"})["body"]
            ret = get(r["return"]["id"])
            c.check("returns_auto kapalı: otomatik onay yok, satıcı bekler", r["waiting"] is True and ret["status"] == "requested" and ret["decision"] is None)
            sql(f"delete from public.user_feature_overrides where user_id='{uid}' and key='returns_auto';")

            # 9) Güvenlik
            no = call("returns", {"action": "decide", "returnId": rid1, "approve": False})
            c.check("Oturumsuz satıcı işlemi reddedildi (401)", no["status"] == 401)
            nf = call("returns", {"action": "decide", "returnId": "00000000-0000-0000-0000-000000000000", "approve": True}, True)["body"]
            c.check("Olmayan / başkasının iadesi bulunamaz", nf.get("ok") is False and "bulunamadı" in nf.get("error", ""))
            bt = call("returns", {"action": "request", "token": "a" * 32, "reasonCode": "size"})["body"]
            c.check("Yanlış takip anahtarıyla talep açılamaz", bt.get("ok") is False)
        finally:
            toks = ",".join(f"'{t}'" for t in tokens.values()) or "''"
            sql(f"""delete from public.refund_ledger where return_id in (select r.id from public.returns r join public.store_orders s on s.id = r.store_order_id where s.tracking_token in ({toks}));
              delete from public.shipments where return_id in (select r.id from public.returns r join public.store_orders s on s.id = r.store_order_id where s.tracking_token in ({toks}));
              delete from public.returns where store_order_id in (select id from public.store_orders where tracking_token in ({toks}));
              delete from public.store_orders where tracking_token in ({toks});
              delete from public.products where id in ({own}, {cj});
              delete from public.user_feature_overrides where user_id='{uid}' and key='returns_auto';""")
            browser.close()
    c.finish()


if __name__ == "__main__":
    main()
