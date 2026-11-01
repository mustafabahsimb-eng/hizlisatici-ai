"""Saha demosunda yüklenen ürünleri siler (tek komut).

  python C:\\Projeler\\hizlisatici-ai\\tools\\demo\\demo_temizle.py

Silinen: demo dosyalarından (Toptan_Giyim_Katalogu.pdf, Bayi_Fiyat_Listesi.pdf) ya da demo sitesinin linkinden
(gaus.com.tr) yapılan yüklemelerin AÇTIĞI ürünler + ilanları (Kendi Mağazam dahil). Yüklemeden önce zaten var olan
ürünlere dokunulmaz. Silme yumuşaktır (deleted_at): ürün panelden ve mağazadan kalkar, kayıt veritabanında durur.
Demo dosyaları: tools/demo/demo_dosyalari.py. Supabase CLI girişi gerekir (bu bilgisayarda kayıtlı).
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT = "ytucdrrgxsjhrqmaxckt"
FILES = ("Toptan_Giyim_Katalogu.pdf", "Bayi_Fiyat_Listesi.pdf")
SITE = "gaus.com.tr"

SQL = f"""-- demo ürünlerini sil
with imp as (
  select id, created_at from public.catalog_imports
  where pdf_name in ({", ".join("'" + f + "'" for f in FILES)}) or link_url ilike '%{SITE}%'
), prod as (
  select distinct p.id from public.catalog_import_rows r
  join imp on imp.id = r.import_id
  join public.products p on p.id = r.product_id
  where p.deleted_at is null and (r.status = 'created' or p.created_at >= imp.created_at - interval '5 seconds')
), lis as (
  update public.listings set deleted_at = now() where product_id in (select id from prod) and deleted_at is null returning id
), pr as (
  update public.products set deleted_at = now(), store_visible = false where id in (select id from prod) returning id, name
)
select (select count(*) from pr) as urun, (select count(*) from lis) as ilan, (select json_agg(name) from pr) as adlar;
"""


def main():
    cli = Path(os.environ.get("LOCALAPPDATA", "")) / "supabase-cli" / "supabase.exe"
    if not cli.exists():
        sys.exit("Supabase CLI bulunamadı: " + str(cli))
    f = Path(tempfile.gettempdir()) / "demo_temizle.sql"
    f.write_text(SQL, encoding="utf-8")
    r = subprocess.run([str(cli), "db", "query", "--linked", "--project-ref", PROJECT, "-f", str(f)],
                       capture_output=True, text=True, encoding="utf-8", cwd=Path(__file__).resolve().parents[2])
    try:
        row = json.loads(r.stdout[r.stdout.index("{"):])["rows"][0]
    except Exception:
        sys.exit("Silinemedi:\n" + (r.stderr or r.stdout)[-800:])
    print(f"Demo temizlendi: {row['urun']} ürün ve {row['ilan']} ilan silindi.")
    for n in row.get("adlar") or []:
        print("  -", n)


if __name__ == "__main__":
    main()
