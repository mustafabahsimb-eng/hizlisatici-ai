r"""bahsistore: yeni kapakları (görsel 1) Etsy'ye uygula + mağaza bölümleri + öne çıkan setler. Tek komut:
   %LOCALAPPDATA%\seltigo-mockup\Scripts\python.exe tools\etsy-mockup\kapak_uygula.py
Kapaklar: %LOCALAPPDATA%\seltigo-etsy-kapak\NN.jpg (satılık tasarım içerdiği için depoda değil).
Akış: depoya yükle -> product_images (sıra 0) adresini değiştir -> etsy-listings push (yeni görsel önce yüklenir, eskisi sonra silinir; ilan görselsiz kalmaz)
      -> organize (bölümler + öne çıkanlar) -> listing_info ile doğrula. Etsy'ye yalnız resmi API ile gidilir."""
import json, os, sys, time, urllib.request, concurrent.futures as cf
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent)); from syscall import sql, rows, call
K = Path(os.environ["LOCALAPPDATA"]) / "seltigo-etsy-kapak"
UID = "92458d1e-1fd7-4cf0-a3ec-9658a949377a"
BASE = "https://ytucdrrgxsjhrqmaxckt.supabase.co/storage/v1/object/public/product-images/"
ST = json.loads((K/"send_state.json").read_text())
st = rows(sql("select status from public.store_connections where id='6b83a6d2-7c96-4541-a8af-d83ce11f47a9';"))
if not st or st[0]["status"] != "connected": sys.exit("Etsy bağlantısı açık değil (Hesaplarım > Etsy > yeniden bağla). Önce bağla, sonra tekrar çalıştır.")
t = time.strftime("%Y%m%d%H%M%S")
paths = {n: f"{UID}/folder/bahsistore-{n:02d}-kapak2-{t}.jpg" for n in range(1, 26)}
urls = json.loads(call("etsy-listings", {"action": "signed_upload", "bucket": "product-images", "paths": list(paths.values())})["content"])["urls"]
def put(n):
    req = urllib.request.Request(urls[paths[n]], data=(K/f"{n:02d}.jpg").read_bytes(), method="PUT", headers={"Content-Type": "image/jpeg", "x-upsert": "true"})
    return urllib.request.urlopen(req, timeout=300).status
with cf.ThreadPoolExecutor(6) as ex: assert all(s == 200 for s in ex.map(put, range(1, 26)))
print("25 kapak depoya yüklendi")
for n in range(1, 26):
    pid = ST[str(n)]["product"]; u = BASE + paths[n]
    sql(f"update public.product_images set url='{u}' where product_id={pid} and position=0 and deleted_at is null; update public.products set image_url='{u}' where id={pid};")
res = {}
def push(n):
    r = call("etsy-listings", {"action": "push", "listingId": ST[str(n)]["listing"]}, 600)
    return n, json.loads(r["content"]) if r else {"ok": False, "error": "cevap yok"}
for g in range(1, 26, 5):
    with cf.ThreadPoolExecutor(5) as ex:
        for n, r in ex.map(push, range(g, min(g + 5, 26))): res[n] = r; print(n, r.get("ok"), r.get("state"), r.get("errors") or "", r.get("warnings") or "", flush=True)
import subprocess
subprocess.run([sys.executable, str(Path(__file__).with_name("organize.py"))], check=False)
print("Bitti. Hatalı:", [n for n, r in res.items() if not r.get("ok")])
