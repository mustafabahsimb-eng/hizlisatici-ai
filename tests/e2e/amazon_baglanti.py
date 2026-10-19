"""Amazon bağlantısı (Hesaplarım + amazon-callback.html) — "Amazon mağazanı bağla" akışı.

Amazon'un sitesi tarayıcıda HİÇ açılmaz (CLAUDE.md): amazon.* alan adlarına giden her istek kesilir, yalnız gidilmek istenen adres okunur.
 1) amazon-connect durum: uygulama tanımlı (AMAZON_APP_ID), sandbox modunda, 23 pazar
 2) Amazon TR [Mağazanı Bağla] -> Seller Central TR onay adresi: application_id, tek kullanımlık state, version=beta (taslak uygulama)
 3) Uluslararası Amazon -> bölge seçimi (Avrupa / Kuzey Amerika / Uzak Doğu) -> Avrupa: sellercentral-europe onay adresi
 4) Amazon'un "giriş adresi" adımı: amazon-callback.html, amazon_callback_uri'ye aynı state ile geri yollar
 5) Son adım: Amazon'dan gelen kod (burada sahte) -> amazon-connect state'i tanır, kodu Amazon'da (LWA) değiştirmeyi dener -> Amazon reddeder,
    satıcıya anlaşılır hata. (Gerçek kodu yalnız Mustafa'nın Seller Central onayı üretir.)
 6) Sahte / süresi geçmiş state -> anlaşılır hata; telefon genişliğinde yatay kaydırma yok
"""
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright
from ortak import SITE, login, shots_dir, Checks

APP_ID = "amzn1.sp.solution.de647a89-0737-4ae3-99bb-ddf3469210ca"
CALLBACK = f"{SITE}/amazon-callback.html"


def main():
    shots = shots_dir()
    c = Checks()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        amazon = []  # tarayıcının gitmek istediği Amazon adresleri (istekler kesilir)
        ctx.route("**/*", lambda r: (amazon.append(r.request.url), r.abort()) if "amazon." in urlparse(r.request.url).netloc else r.continue_())
        page = ctx.new_page()
        login(page)
        page.goto(f"{SITE}/accounts.html")
        page.wait_for_selector("#connect-amazontr", timeout=30000)

        st = page.evaluate("""async () => { const tok = (await HS.db.auth.getSession()).data.session.access_token;
            const r = await fetch(HS.SUPABASE_URL + '/functions/v1/amazon-connect', { method: 'POST', headers: { 'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + HS.SUPABASE_KEY, 'apikey': HS.SUPABASE_KEY }, body: JSON.stringify({ action: 'status', userAccessToken: tok }) });
            return await r.json(); }""")
        c.check("amazon-connect durum: uygulama tanımlı, sandbox modunda, 23 pazar",
                st.get("ok") and st.get("configured") is True and st.get("live") is False and len(st.get("markets", [])) == 23, str(st)[:160])

        def consent_after(click):
            amazon.clear()
            click()
            for _ in range(40):
                hits = [u for u in amazon if "/apps/authorize/consent" in u]
                if hits:
                    return hits[0]
                page.wait_for_timeout(500)
            return None

        # 2) Amazon TR
        u = consent_after(lambda: page.click("#connect-amazontr"))
        c.check("Amazon TR -> Seller Central TR onay adresi", bool(u) and urlparse(u).netloc == "sellercentral.amazon.com.tr", (u or "yok")[:120])
        q = parse_qs(urlparse(u).query) if u else {}
        state = (q.get("state") or [""])[0]
        c.check("Onay adresinde Seltigo uygulama numarası", q.get("application_id") == [APP_ID], str(q.get("application_id")))
        c.check("Taslak uygulama: version=beta", q.get("version") == ["beta"])
        c.check("Tek kullanımlık durum anahtarı (state) üretildi", len(state) >= 20, f"{len(state)} karakter")
        c.check("Geri dönüş adresi amazon-callback.html", (q.get("redirect_uri") or [""])[0] == CALLBACK, str(q.get("redirect_uri")))
        page.goto(f"{SITE}/accounts.html")  # kesilen Amazon isteğinden sonra hata sayfasındayız; aynı sekmede Seltigo'ya dön
        saved = page.evaluate("sessionStorage.getItem('amzState')")
        c.check("Durum anahtarı tarayıcıda saklandı (giriş adresi adımı için)", saved == state)

        # 3) Uluslararası: bölge seçimi -> Avrupa
        page.wait_for_selector("#connect-amazon", timeout=30000)
        page.click("#connect-amazon")
        page.wait_for_selector("#amazonRegionOverlay", state="visible", timeout=5000)
        regions = page.locator(".amz-region b").all_inner_texts()
        c.check("Bölge seçimi: Avrupa / Kuzey Amerika / Uzak Doğu", regions == ["Avrupa", "Kuzey Amerika", "Uzak Doğu"], str(regions))
        page.screenshot(path=str(Path(shots) / "amazon_bolge.png"))
        u2 = consent_after(lambda: page.locator(".amz-region").first.click())
        c.check("Avrupa -> sellercentral-europe onay adresi", bool(u2) and urlparse(u2).netloc == "sellercentral-europe.amazon.com", (u2 or "yok")[:120])
        state2 = (parse_qs(urlparse(u2).query).get("state") or [""])[0] if u2 else ""
        c.check("Her bağlanma denemesi yeni durum anahtarı", bool(state2) and state2 != state)

        # 4) Amazon onaydan sonra satıcıyı giriş adresimize getirir -> aynı state ile Amazon'a geri
        amazon.clear()
        cb = "https://sellercentral-europe.amazon.com/apps/authorize/confirm"
        page.goto(f"{CALLBACK}?amazon_callback_uri={cb}&amazon_state=amz-test&selling_partner_id=A1TEST&version=beta")
        page.wait_for_timeout(3000)
        back = [x for x in amazon if x.startswith(cb)]
        bq = parse_qs(urlparse(back[0]).query) if back else {}
        c.check("Giriş adresi adımı: Amazon'a aynı state + amazon_state ile geri", bool(back) and bq.get("state") == [state2] and bq.get("amazon_state") == ["amz-test"],
                (back[0] if back else "yok")[:140])

        # 5) Amazon'dan dönüş: state tanınır, kod Amazon'da değiştirilmeye çalışılır (sahte kod -> Amazon reddeder)
        page.goto(f"{CALLBACK}?spapi_oauth_code=SAHTE-KOD&state={state2}&selling_partner_id=A1TEST")
        page.wait_for_selector("#message.error", timeout=40000)
        msg = page.inner_text("#message")
        c.check("Son adım: state geçerli, kod Amazon'a (LWA) soruldu, sahte kod reddedildi -> anlaşılır hata",
                "Amazon" in msg and "geçersiz ya da süresi doldu" not in msg, msg[:160])

        # 6) Sahte state / boş dönüş
        page.goto(f"{CALLBACK}?spapi_oauth_code=FAKE&state=gecersiz&selling_partner_id=A1TEST")
        page.wait_for_selector("#message.error", timeout=30000)
        msg = page.inner_text("#message")
        c.check("Sahte state -> anlaşılır hata", "geçersiz" in msg or "süresi doldu" in msg, msg[:120])
        page.goto(CALLBACK)
        page.wait_for_selector("#message.error", timeout=30000)
        c.check("Onay bilgisi yok -> hata", "tamamlanmadı" in page.inner_text("#message"))

        page.goto(f"{SITE}/accounts.html")
        page.wait_for_selector("#connect-amazon", timeout=30000)
        page.set_viewport_size({"width": 375, "height": 800})
        sw = page.evaluate("() => document.documentElement.scrollWidth")
        c.check("Telefonda yatay kaydırma yok", sw <= 376, str(sw))
        page.wait_for_timeout(1500)
        page.screenshot(path=str(Path(shots) / "amazon_hesaplarim_telefon.png"), full_page=True)
        c.check("Hiçbir Amazon sayfası açılmadı (istekler kesildi)", "amazon." not in urlparse(page.url).netloc)
        browser.close()
    c.finish()


if __name__ == "__main__":
    main()
