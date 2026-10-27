"""WhatsApp webhook'u İMZALI sahte isteklerle uçtan uca dener (gerçek Meta numarası / anahtarı gerekmez).

whatsapp-webhook fonksiyonu bu bilgisayarda deno ile, bilinen bir TEST uygulama anahtarıyla çalıştırılır; canlı veritabanına bağlanır.
Gerekli anahtarlar Supabase CLI'dan anlık alınır, diske / ekrana yazılmaz.
Denenen:
 1) GET doğrulama: doğru doğrulama anahtarı -> challenge, yanlış -> 403
 2) POST imzasız -> 401, yanlış imza -> 401, doğru imza (X-Hub-Signature-256) -> 200
 3) Bağlı olmayan numara: işlem yapılmaz, kibar cevap en fazla 10 dakikada bir (rate_limits "unl:")
 4) Numara bağlama: panelden alınan kod "BAĞLA <kod>" ile gönderilir -> assistant_links'e WhatsApp numarası yazılır
 5) Bağlı numaranın mesajı işlenir (last_inbound_at güncellenir)
 6) Numara başına sınır: dakikada 20'den fazla mesaj işlenmez
Sonunda test numarası ve sınır kayıtları silinir.
Çalıştırma: <venv>\\Scripts\\python tests\\e2e\\whatsapp_webhook_imza.py
"""
import hashlib, hmac, json, os, random, subprocess, sys, time, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from ortak import Checks, test_user

REF = "ytucdrrgxsjhrqmaxckt"
URL = f"https://{REF}.supabase.co"
PUB = "sb_publishable_xJXwqD9NmwU70kv2eFKk0A_O2q9gOcD"
LOCAL = os.environ["LOCALAPPDATA"]
DENO = Path(LOCAL) / "seltigo-e2e" / "venv" / "Scripts" / "deno.exe"
CLI = Path(LOCAL) / "supabase-cli" / "supabase.exe"
ROOT = Path(__file__).resolve().parents[2]
APP_SECRET = "test-app-secret-" + str(random.randint(10**6, 10**7))
VERIFY = "test-verify-" + str(random.randint(10**6, 10**7))
PHONE_ID = "TESTPHONE123"
NUM = "90555" + str(random.randint(1000000, 9999999))
PORT = 8000


def http(method, url, body=None, headers=None, timeout=60):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    r = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            return f.status, f.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def keys():
    out = subprocess.run([str(CLI), "projects", "api-keys", "--project-ref", REF, "-o", "json"], capture_output=True, text=True, timeout=120).stdout
    d = {k["name"]: k["api_key"] for k in json.loads(out) if k.get("type") == "legacy"}
    return d["service_role"], d["anon"]


def wa_body(msg):
    return {"object": "whatsapp_business_account", "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"phone_number_id": PHONE_ID, "display_phone_number": "15550000000"},
        "contacts": [{"wa_id": NUM, "profile": {"name": "Test Satıcı"}}], "messages": [msg]}}]}]}


def text_msg(text):
    return {"from": NUM, "id": "wamid.TEST" + str(random.randint(10**8, 10**9)), "timestamp": str(int(time.time())), "type": "text", "text": {"body": text}}


def sign(raw):
    return "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()


def post(msg, signature="ok"):
    raw = json.dumps(wa_body(msg)).encode()
    h = {"Content-Type": "application/json"}
    if signature == "ok": h["X-Hub-Signature-256"] = sign(raw)
    elif signature: h["X-Hub-Signature-256"] = signature
    return http("POST", f"http://localhost:{PORT}/", raw, h)


def main():
    c = Checks()
    service, anon = keys()
    svc = {"apikey": service, "Authorization": "Bearer " + service, "Content-Type": "application/json"}
    rest = lambda path: json.loads(http("GET", f"{URL}/rest/v1/{path}", None, svc)[1])
    env = {**os.environ, "SUPABASE_URL": URL, "SUPABASE_SERVICE_ROLE_KEY": service, "SUPABASE_ANON_KEY": anon,
           "FACEBOOK_CLIENT_SECRET": APP_SECRET, "WHATSAPP_VERIFY_TOKEN": VERIFY, "ASSISTANT_WA_PHONE_ID": PHONE_ID}
    for k in ("ASSISTANT_WA_ENABLED", "ASSISTANT_WA_TOKEN", "CRON_SECRET"): env.pop(k, None)
    proc = subprocess.Popen([str(DENO), "run", "-A", str(ROOT / "supabase" / "functions" / "whatsapp-webhook" / "index.ts")], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(90):
            try:
                if http("GET", f"http://localhost:{PORT}/?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1", timeout=3)[0] == 403: break
            except Exception: pass
            time.sleep(1)
        s, b = http("GET", f"http://localhost:{PORT}/?hub.mode=subscribe&hub.verify_token={VERIFY}&hub.challenge=987654")
        c.check("GET doğrulama: doğru anahtar -> challenge", s == 200 and b == "987654", f"{s} {b[:40]}")
        s, _ = http("GET", f"http://localhost:{PORT}/?hub.mode=subscribe&hub.verify_token=yanlis&hub.challenge=1")
        c.check("GET doğrulama: yanlış anahtar -> 403", s == 403)
        s, _ = post(text_msg("merhaba"), signature=None)
        c.check("İmzasız POST -> 401", s == 401, str(s))
        s, _ = post(text_msg("merhaba"), signature="sha256=" + "0" * 64)
        c.check("Yanlış imzalı POST -> 401", s == 401, str(s))

        # 3) Bağlı olmayan numara
        s, _ = post(text_msg("merhaba"))
        c.check("Doğru imzalı POST -> 200", s == 200, str(s))
        time.sleep(3)
        rl = rest(f"rate_limits?key=eq.unl:whatsapp:{NUM}&select=hits")
        c.check("Bağlı olmayan numara: işlem yok, kibar cevap verildi (sınır kaydı)", rl and rl[0]["hits"] == 1, str(rl))
        post(text_msg("tekrar merhaba")); time.sleep(3)
        rl = rest(f"rate_limits?key=eq.unl:whatsapp:{NUM}&select=hits")
        c.check("Bağlı olmayan numaraya 10 dk içinde ikinci cevap gitmez", rl and rl[0]["hits"] == 2, str(rl))
        links = rest(f"assistant_links?channel=eq.whatsapp&external_id=eq.{NUM}&select=id")
        c.check("Bağlı olmayan numara için hesap açılmadı", links == [], str(links))

        # 4) Bağlama kodu (test kullanıcısı, panelden alınan kod)
        email, pw = test_user()
        s, d = http("POST", f"{URL}/auth/v1/token?grant_type=password", {"email": email, "password": pw}, {"apikey": PUB, "Content-Type": "application/json"})
        tok = json.loads(d)["access_token"]
        s, d = http("POST", f"{URL}/functions/v1/assistant", {"action": "link_code", "channel": "whatsapp", "userAccessToken": tok},
                    {"apikey": PUB, "Authorization": "Bearer " + PUB, "Content-Type": "application/json"})
        code = json.loads(d)["code"]
        s, _ = post(text_msg("BAĞLA " + code)); time.sleep(4)
        links = rest(f"assistant_links?channel=eq.whatsapp&external_id=eq.{NUM}&select=id,user_id,last_inbound_at")
        c.check("Kodla bağlandı: WhatsApp numarası satıcıya yazıldı", s == 200 and len(links) == 1, str(links)[:120])

        # 5) Bağlı numaranın mesajı
        before = links[0]["last_inbound_at"] if links else None
        time.sleep(1)
        s, _ = post(text_msg("yardım")); time.sleep(4)
        after = rest(f"assistant_links?channel=eq.whatsapp&external_id=eq.{NUM}&select=last_inbound_at")
        c.check("Bağlı numaranın mesajı işlendi", s == 200 and after and after[0]["last_inbound_at"] != before, f"{before} -> {after}")

        # 6) Numara başına sınır (dakikada 20)
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(22) as ex:  # aynı dakika içinde 22 mesaj
            list(ex.map(lambda i: post(text_msg(f"mesaj {i}")), range(22)))
        time.sleep(6)
        rl = rest(f"rate_limits?key=eq.msg:m:whatsapp:{NUM}&select=hits")
        w = rest(f"rate_limits?key=eq.msg:w:whatsapp:{NUM}&select=hits")
        c.check("Dakikada 20'den fazla mesaj işlenmedi (uyarı en fazla bir kez)", rl and rl[0]["hits"] > 20 and w and w[0]["hits"] >= 1, f"{rl} {w}")
    finally:
        proc.terminate()
        for k in ("unl", "code", "msg:m", "msg:d", "msg:w"):
            http("DELETE", f"{URL}/rest/v1/rate_limits?key=eq.{k}:whatsapp:{NUM}", None, svc)
        http("DELETE", f"{URL}/rest/v1/assistant_links?channel=eq.whatsapp&external_id=eq.{NUM}", None, svc)
    c.finish()


if __name__ == "__main__":
    main()
