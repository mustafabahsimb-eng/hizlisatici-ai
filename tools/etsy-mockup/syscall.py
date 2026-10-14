"""Sistem çağrısı: cron komutunu kopyalayıp gövdeye JSON ekler; istek no'su app_cache'e yazılır, cevap net._http_response'tan okunur. Anahtar dışarı çıkmaz."""
import json, os, subprocess, sys, tempfile, time, uuid
from pathlib import Path
CLI = Path(os.environ["LOCALAPPDATA"]) / "supabase-cli" / "supabase.exe"
def sql(q):
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "q.sql"; f.write_text(q, encoding="utf-8")
        r = subprocess.run([str(CLI), "db", "query", "--linked", "--project-ref", "ytucdrrgxsjhrqmaxckt", "-f", str(f), "-o", "json"], cwd=d, capture_output=True, text=True, encoding="utf-8", timeout=180)
        return r.stdout
def rows(out):
    try: return json.loads(out[out.index("["):out.rindex("]")+1])
    except Exception: return []
def start(fn, body):
    tag = "syscall:" + uuid.uuid4().hex
    frag = json.dumps(body)[1:-1].replace("'", "''")
    sql(f"""do $$ declare v text; rid bigint; begin
  select replace(replace(command, '/functions/v1/cj-alt-match', '/functions/v1/{fn}'), '{{"cronSecret"', '{{{frag},"cronSecret"') into v from cron.job where jobname='cj-alt-match-1h';
  v := replace(replace(v, 'timeout_milliseconds := 120000', 'timeout_milliseconds := 600000'), ';', '');
  execute v into rid;
  insert into public.app_cache(key, value) values ('{tag}', to_jsonb(rid));
end $$;""")
    r = rows(sql(f"select value from public.app_cache where key='{tag}';"))
    return int(r[0]["value"]) if r else None
def result(rid, wait=600):
    t0 = time.time()
    while time.time() - t0 < wait:
        r = rows(sql(f"select status_code, content, error_msg from net._http_response where id={rid};"))
        if r: return r[0]
        time.sleep(5)
    return None
def call(fn, body, wait=600):
    rid = start(fn, body)
    if rid is None: raise RuntimeError("istek başlatılamadı")
    return result(rid, wait)
if __name__ == "__main__":
    print(call(sys.argv[1], json.loads(sys.argv[2])))
