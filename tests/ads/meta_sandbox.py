"""Seltigo Ads — Meta SANDBOX reklam hesabında uçtan uca (para harcanmaz, reklam yayınlanmaz).

Satıcı: Mustafa (bahsistore), hesap act_1138060605425004 ("Seltigo Test"). Önkoşul: Facebook bağlantısında ads_management izni.
 1) izin + hesap görünür  2) hesabı bağla (sayfa API'den)  3) geçici bütçe sınırı (100 / 1000 TRY, onay modu)
 4) kampanya aç -> onay bekliyor; Meta'da kampanya / reklam seti / reklam DURAKLATILMIŞ, OUTCOME_SALES, günlük 100 TRY, ürün seti
 5) onayla -> ACTIVE  6) bütçe 80 -> Meta 8000 kuruş; sınır üstü 500 -> sınıra çekilir  7) durdur -> PAUSED, devam ettir -> ACTIVE
 8) saatlik iş (ölçüm) hatasız  9) temizlik: Meta'daki test kampanyası + ürün seti silinir, geçici kurallar kaldırılır (hesap bağlı kalır)
Çalıştırma: python tests/ads/meta_sandbox.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

USER = "92458d1e-1fd7-4cf0-a3ec-9658a949377a"
ACT = "act_1138060605425004"
CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
ok_n = fail_n = 0


def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"; f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "json"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=180)
        out = r.stdout or ""
        try: return json.loads(out[out.index("["):out.rindex("]") + 1])
        except Exception: return []


def call(body, wait=300):
    """Sistem çağrısı (cron komutu kopyalanır; gizli anahtar dışarı çıkmaz)."""
    tag = "syscall:" + uuid.uuid4().hex
    frag = json.dumps(dict(body, userId=USER))[1:-1].replace("'", "''")
    sql(f"""do $$ declare v text; rid bigint; begin
  select replace(replace(command, '/functions/v1/cj-alt-match', '/functions/v1/ads'), '{{"cronSecret"', '{{{frag},"cronSecret"') into v from cron.job where jobname='cj-alt-match-1h';
  v := replace(replace(v, 'timeout_milliseconds := 120000', 'timeout_milliseconds := 300000'), ';', '');
  execute v into rid; insert into public.app_cache(key, value) values ('{tag}', to_jsonb(rid)); end $$;""")
    rid = sql(f"select value from public.app_cache where key='{tag}';")[0]["value"]
    t0 = time.time()
    while time.time() - t0 < wait:
        r = sql(f"select status_code, content from net._http_response where id={rid};")
        if r and r[0].get("content"): return json.loads(r[0]["content"])
        time.sleep(4)
    return {"ok": False, "error": "zaman aşımı"}


def check(name, cond, detail=""):
    global ok_n, fail_n
    if cond: ok_n += 1
    else: fail_n += 1
    print(("GEÇTİ " if cond else "KALDI ") + name + (f" — {detail}" if detail else ""), flush=True)


def main():
    d = call({"action": "diag", "account": ACT})
    perms = d.get("permissions") or []
    check("Facebook bağlantısında reklam izni (ads_management)", "ads_management" in perms, str(perms))
    if "ads_management" not in perms:
        print("\nÖnkoşul eksik: Reklamlar sayfasında 'Facebook'u reklam izniyle bağla'."); sys.exit(2)
    check("Sandbox hesap API'de görünür", isinstance(d.get("account"), dict) and d["account"].get("currency") == "TRY", str(d.get("account"))[:200])
    rules_before = sql(f"select row_to_json(r)::text j from public.ad_rules r where user_id = '{USER}';")
    camp = None
    try:
        r = call({"action": "connect", "externalId": ACT})
        acc = r.get("account") or {}
        check("Hesap bağlandı: test hesabı (sandbox), sayfa bulundu", r.get("ok") and acc.get("sandbox") and acc.get("page_id"), str(r)[:240])
        sql(f"""insert into public.ad_rules (user_id, daily_cap, monthly_cap, approval_mode, auto_launch, auto_scale) values ('{USER}', 100, 1000, 'approve', false, false)
          on conflict (user_id) do update set daily_cap = 100, monthly_cap = 1000, approval_mode = 'approve', auto_launch = false, auto_scale = false;""")
        r = call({"action": "launch"}, wait=420)
        camp = r.get("campaignId")
        check("Kampanya açıldı -> onay bekliyor (test hesabı)", r.get("ok") and r.get("status") == "pending_approval" and r.get("sandbox"), str(r)[:300])
        if not r.get("ok"):
            return
        i = call({"action": "inspect", "campaignId": camp})
        c, s, a = i.get("campaign", {}), i.get("adset", {}), i.get("ad", {})
        check("Meta: kampanya OUTCOME_SALES, DURAKLATILMIŞ", isinstance(c, dict) and c.get("objective") == "OUTCOME_SALES" and c.get("status") == "PAUSED", str(c)[:200])
        check("Meta: reklam seti günlük 100 TRY (10000 kuruş), Türkiye, DURAKLATILMIŞ", isinstance(s, dict) and str(s.get("daily_budget")) == "10000" and s.get("status") == "PAUSED"
              and "TR" in json.dumps(s.get("targeting", {})), str(s)[:240])
        check("Meta: reklam DURAKLATILMIŞ; ürün seti seltigo_81", isinstance(a, dict) and a.get("status") == "PAUSED" and "seltigo_81" in json.dumps(i.get("productSet", {})), str(i.get("productSet"))[:200])
        r = call({"action": "approve", "campaignId": camp})
        i = call({"action": "inspect", "campaignId": camp})
        check("Onayla -> Meta'da ACTIVE (kampanya / set / reklam)", r.get("ok") and all(isinstance(i.get(k), dict) and i[k].get("status") == "ACTIVE" for k in ("campaign", "adset", "ad")), str(r) + " " + str({k: (i.get(k) or {}).get("status") if isinstance(i.get(k), dict) else i.get(k) for k in ("campaign", "adset", "ad")}))
        r = call({"action": "budget", "campaignId": camp, "amount": 80})
        i = call({"action": "inspect", "campaignId": camp})
        check("Bütçe 80 -> Meta 8000 kuruş", r.get("ok") and str((i.get("adset") or {}).get("daily_budget")) == "8000", str(r))
        r = call({"action": "budget", "campaignId": camp, "amount": 500})
        check("Sınır üstü bütçe (500) günlük sınıra (100) çekildi", r.get("ok") and r.get("budget") == 100 and r.get("capped"), str(r))
        r = call({"action": "pause", "campaignId": camp})
        i = call({"action": "inspect", "campaignId": camp})
        check("Durdur -> Meta'da PAUSED", r.get("ok") and (i.get("campaign") or {}).get("status") == "PAUSED" and (i.get("ad") or {}).get("status") == "PAUSED", str(r))
        r = call({"action": "resume", "campaignId": camp})
        i = call({"action": "inspect", "campaignId": camp})
        check("Devam ettir -> Meta'da ACTIVE", r.get("ok") and (i.get("campaign") or {}).get("status") == "ACTIVE", str(r))
        r = call({"action": "run"}, wait=420)
        mine = [x for x in (r.get("results") or []) if x.get("userId") == USER]
        check("Saatlik iş (ölçüm + optimizasyon) hatasız", r.get("ok") and mine and not mine[0].get("error"), str(mine)[:300])
        r = call({"action": "stop", "campaignId": camp})
        check("Kampanya sonlandırıldı (Meta'da PAUSED)", r.get("ok") and r.get("status") == "stopped", str(r))
    finally:
        cl = call({"action": "cleanup_test"})
        print("Temizlik:", json.dumps(cl)[:300])
        if rules_before: sql(f"delete from public.ad_rules where user_id = '{USER}'; insert into public.ad_rules select * from json_populate_record(null::public.ad_rules, '{rules_before[0]['j']}'::json);")
        else: sql(f"delete from public.ad_rules where user_id = '{USER}';")
        print(f"\nSonuç: {ok_n}/{ok_n + fail_n} geçti")
    sys.exit(1 if fail_n else 0)


if __name__ == "__main__":
    main()
