# Amazon SP-API — tek komutla deneme / açma (Claude çalıştırır; gizli değerler depoya yazılmaz)
#   python tools/amazon/amazon_ac.py test                 -> Amazon'un GERÇEK sandbox'ında uçtan uca deneme (amazon-connect selftest)
#   python tools/amazon/amazon_ac.py uygulama-no <APP_ID> -> AMAZON_APP_ID secret'ı + deneme (Hesaplarım'dan "Amazon mağazanı bağla" açılır)
#   python tools/amazon/amazon_ac.py canli [--yayinda]     -> AMAZON_LIVE=true (canlı uç noktalar); --yayinda: Appstore onayı geldi, AMAZON_APP_DRAFT=false
#   python tools/amazon/amazon_ac.py sandbox               -> canlıdan sandbox'a geri dön (AMAZON_LIVE silinir)
# Deneme isteği, gizli CRON anahtarı veritabanından hiç çıkmadan mevcut zamanlanmış işin komutu kopyalanarak gönderilir.
import json, os, subprocess, sys, tempfile, time

REF = "ytucdrrgxsjhrqmaxckt"
CLI = os.path.join(os.environ["LOCALAPPDATA"], "supabase-cli", "supabase.exe")


def sql(q: str):
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write("-- amazon_ac\n" + q)
        path = f.name
    try:
        out = subprocess.run([CLI, "db", "query", "--linked", "--project-ref", REF, "-f", path], capture_output=True, text=True, encoding="utf-8").stdout
    finally:
        os.unlink(path)
    i = out.find("{")
    return json.JSONDecoder().raw_decode(out[i:])[0].get("rows", []) if i >= 0 else []


def secrets_set(**kv):
    args = [f"{k}={v}" for k, v in kv.items()]
    subprocess.run([CLI, "secrets", "set", "--project-ref", REF, *args], check=True, capture_output=True)


def secrets_unset(*names):
    subprocess.run([CLI, "secrets", "unset", "--project-ref", REF, *names], capture_output=True)


def selftest():
    sql("""do $$ declare c text; begin
  select replace(replace(command, 'functions/v1/amazon-orders', 'functions/v1/amazon-connect'), '{"cronSecret"', '{"action":"selftest","cronSecret"')
    into c from cron.job where jobname = 'amazon-orders-15min';
  execute c;
end $$;""")
    for _ in range(12):
        time.sleep(5)
        rows = sql("select content::text c from net._http_response where created > now() - interval '2 minutes' and content::text like '%\"steps\"%' order by id desc limit 1;")
        if rows:
            d = json.loads(rows[0]["c"])
            for k, v in (d.get("steps") or {}).items():
                print(("  ✓ " if v == "geçti" else "  ✗ ") + k + ("" if v == "geçti" else ": " + v))
            if d.get("need"):
                print("  eksik secret:", ", ".join(d["need"]))
            print("SONUÇ:", "GEÇTİ" if d.get("ok") else "KALDI", f"({d.get('ms', '?')} ms)", "" if d.get("appIdSet") else "— AMAZON_APP_ID yok: mağaza bağlama sayfası kapalı")
            return bool(d.get("ok"))
    print("Cevap gelmedi (amazon-connect günlüğüne bak).")
    return False


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "test"
    if cmd == "test":
        sys.exit(0 if selftest() else 1)
    if cmd == "uygulama-no":
        app = sys.argv[2].strip()
        if not app.startswith("amzn1.sp.solution."):
            sys.exit("Uygulama numarası 'amzn1.sp.solution.' ile başlar.")
        secrets_set(AMAZON_APP_ID=app)
        print("AMAZON_APP_ID kaydedildi.")
        sys.exit(0 if selftest() else 1)
    if cmd == "canli":
        kv = {"AMAZON_LIVE": "true"}
        if "--yayinda" in sys.argv:
            kv["AMAZON_APP_DRAFT"] = "false"
        secrets_set(**kv)
        print("Canlı uç noktalar açıldı:", ", ".join(kv))
        sys.exit(0 if selftest() else 1)  # deneme her zaman sandbox uç noktasında
    if cmd == "sandbox":
        secrets_unset("AMAZON_LIVE")
        print("AMAZON_LIVE silindi: her şey sandbox'ta.")
        return
    sys.exit(__doc__ or "komut: test | uygulama-no <APP_ID> | canli [--yayinda] | sandbox")


if __name__ == "__main__":
    main()
