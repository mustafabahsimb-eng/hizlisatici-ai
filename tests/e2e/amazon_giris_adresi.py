# Amazon onay akışının "giriş adresi" (Login URI) adımı: amazon-callback.html, Amazon'un amazon_callback_uri'sine
# kendi durum anahtarımızla geri yönlendirir; yabancı adrese ya da durum anahtarı yokken yönlendirmez.
# Amazon'a HİÇBİR istek gitmez: sellercentral istekleri tarayıcıda kesilir, yalnız gidilmek istenen adres okunur.
import sys, time
from urllib.parse import urlparse, parse_qs
from ortak import SITE
from playwright.sync_api import sync_playwright

res = []
def check(n, ok, info=""):
    res.append(ok); print(("GEÇTİ " if ok else "KALDI ") + n + (f" — {info}" if info else ""))

CB = "https://sellercentral.amazon.com.tr/apps/authorize/confirm"
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context()
    seen = []
    ctx.route("**/*", lambda r: (seen.append(r.request.url), r.abort()) if "amazon." in urlparse(r.request.url).netloc else r.continue_())
    pg = ctx.new_page()
    pg.goto(f"{SITE}/accounts.html?t={int(time.time())}")  # aynı köken: oturum deposu yazılabilsin
    pg.evaluate("sessionStorage.setItem('amzState', 'durum-123')")
    pg.goto(f"{SITE}/amazon-callback.html?amazon_callback_uri={CB}&amazon_state=amz-xyz&selling_partner_id=A1TEST&version=beta")
    pg.wait_for_timeout(3000)
    go = [u for u in seen if u.startswith(CB)]
    check("Amazon'a geri yönlendirme denendi", bool(go), go[0][:160] if go else str(seen[:3]))
    if go:
        q = parse_qs(urlparse(go[0]).query)
        check("amazon_state aynen geri gider", q.get("amazon_state") == ["amz-xyz"])
        check("bizim durum anahtarımız gider", q.get("state") == ["durum-123"])
        check("redirect_uri = bu sayfa", q.get("redirect_uri", [""])[0].endswith("/amazon-callback.html"), q.get("redirect_uri"))
        check("taslak uygulama: version=beta", q.get("version") == ["beta"])
    seen.clear()
    pg.goto(f"{SITE}/amazon-callback.html?amazon_callback_uri=https://kotu-site.example/x&amazon_state=a")
    pg.wait_for_timeout(2500)
    check("yabancı adrese yönlendirmez (açık yönlendirme yok)", urlparse(pg.url).netloc.endswith("github.io") and not any(urlparse(u).netloc == "kotu-site.example" for u in seen), pg.url)
    pg.goto(f"{SITE}/accounts.html")
    pg.evaluate("sessionStorage.removeItem('amzState')")
    seen.clear()
    pg.goto(f"{SITE}/amazon-callback.html?amazon_callback_uri={CB}&amazon_state=a")
    pg.wait_for_timeout(2500)
    check("durum anahtarı yoksa yönlendirmez", not any(u.startswith(CB) for u in seen))
    b.close()
print(f"\nSonuç: {sum(res)}/{len(res)} geçti")
sys.exit(0 if all(res) else 1)
