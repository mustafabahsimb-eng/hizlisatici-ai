r"""bahsistore mağaza düzeni: bölümler (Sets of 4 en üstte) + 5 adet 4'lü set öne çıkan ürün (featured_rank 1-5). Resmi API (etsy-listings organize).
İlan numaraları %LOCALAPPDATA%\seltigo-etsy-kapak\ids.json (ilan sırası 1-25: 1-20 tekli, 21-25 setler)."""
import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent)); from syscall import call
ids = {int(k): v for k, v in json.loads((Path(os.environ["LOCALAPPDATA"]) / "seltigo-etsy-kapak" / "ids.json").read_text()).items()}
style = lambda n: (n - 1) % 5  # 0 krem, 1 siyah, 2 adaçayı, 3 kiremit, 4 siyah-beyaz
grp = lambda s: [ids[n] for n in range(1, 21) if style(n) == s]
sections = [{"title": "Sets of 4", "listingIds": [ids[n] for n in range(21, 26)]},
            {"title": "Cream Minimalist", "listingIds": grp(0)}, {"title": "Terracotta", "listingIds": grp(3)},
            {"title": "Black Minimalist", "listingIds": grp(1)}, {"title": "Sage Green", "listingIds": grp(2)},
            {"title": "Bold Black & White", "listingIds": grp(4)}]
r = call("etsy-listings", {"action": "organize", "userId": "92458d1e-1fd7-4cf0-a3ec-9658a949377a", "sections": sections, "featured": [ids[n] for n in range(21, 26)]}, 600)
print(json.dumps(json.loads(r["content"]), indent=1, ensure_ascii=False))
