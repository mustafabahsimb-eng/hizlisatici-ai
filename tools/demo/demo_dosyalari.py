"""Saha demosu için WhatsApp'a gönderilecek PDF'leri üretir.

  python tools/demo/demo_dosyalari.py [çıktı klasörü]

Çıktı:
  Toptan_Giyim_Katalogu.pdf   resimli toptancı kataloğu (10 giyim ürünü, 2 sütunlu kart, gerçek ürün fotoğrafı,
                               model kodu, barkod, stok, bayi + PSF fiyatı, bedenler). Fotoğraflar herkese açık
                               www.gaus.com.tr ürün sayfalarından; firma adı uydurmadır.
  Bayi_Fiyat_Listesi.pdf      resimsiz bayi fiyat listesi (9 ürün, www.gaus.com.tr'de satılan ürünler; 3'ü barkodla,
                               3'ü stok koduyla, 3'ü yalnız adla eşleşir). Linki: https://www.gaus.com.tr/
Playwright gerekir (%LOCALAPPDATA%\\seltigo-e2e\\venv).
"""
import base64
import re
import shutil
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
IMG = "https://static.ticimax.cloud/48063/uploads/urunresimleri/buyuk/"


def ean13(base12):
    d = [int(c) for c in base12]
    s = sum(x * (3 if i % 2 else 1) for i, x in enumerate(d))
    return base12 + str((10 - s % 10) % 10)


# (model, ad, stok, bayi, psf, bedenler, görsel)
CARDS = [
    ("TG-101", "Ekose Yumuşak Dokulu Crop Gömlek", 48, "46,50", "83,90", "S, M, L", "ekose-yumusak-dokulu-crop-gomlek--44b9-.jpg"),
    ("TG-102", "Yılan Desenli Kırmızı Ceket", 22, "48,90", "87,90", "S, M, L", "rojo-yilan-desenli-kirmizi-ceket--4fdd-9.jpg"),
    ("TG-103", "Gri Kapüşonlu Cepli Sweatshirt", 60, "49,90", "89,90", "S, M, L, XL", "doux-gri-kapsonlu-cepli-sweatshirt--45f2-.jpg"),
    ("TG-104", "Ekose Desen Kolej Elbise", 35, "55,50", "99,90", "S, M", None),
    ("TG-105", "Bej Yırtmaçlı Etek", 41, "44,40", "79,90", "S, M, L", None),
    ("TG-106", "Beyaz Oversize Gömlek", 75, "49,90", "89,90", "STD", None),
    ("TG-107", "Krem Düğmeli Hırka", 18, "61,00", "109,90", "STD", None),
    ("TG-108", "Deri Siyah Palazzo Pantolon", 27, "88,80", "159,90", "S, M, L", None),
    ("TG-109", "Lacivert Çizgili Ceket", 14, "72,20", "129,90", "S, M, L", None),
    ("TG-110", "Siyah İçi Polar Kürklü Yelek", 30, "94,40", "169,90", "M, L", None),
]
SLUGS = [
    "ekose-yumusak-dokulu-crop-gomlek", "rojo-yilan-desenli-kirmizi-ceket-", "doux-gri-kapsonlu-cepli-sweatshirt",
    "azul-ekose-desen-kolej-elbise", "bej-yirtmacli-etek1", "beyaz-oversize-gomlek", "ciel-krem-dugmeli-hirka-",
    "deri-siyah--palazzo-pantolon-", "linea-lacivert-cizgili-ceket-", "negro-siyah-ici-polar-kurklu-yelek-",
]

CSS = ("<style>body{font-family:Arial;margin:26px;color:#111}h1{margin:0 0 4px}.sub{color:#555;margin-bottom:14px}"
       ".grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{border:1px solid #ddd;border-radius:8px;padding:12px;display:flex;gap:12px;break-inside:avoid}"
       ".card img{width:120px;height:160px;object-fit:cover;border-radius:4px}"
       ".n{font-weight:bold;font-size:15px;margin-bottom:4px}.k{font-size:11px;color:#444;margin:2px 0}.p{font-size:14px;margin-top:6px}"
       ".foot{margin-top:14px;font-size:11px;color:#555}</style>")


def first_images(page):
    """Her ürünün ana fotoğrafı: ürün sayfasındaki og:image (sayfa açılmazsa CARDS'taki dosya adı)."""
    out = []
    for slug, c in zip(SLUGS, CARDS):
        url = None
        try:
            r = page.request.get("https://www.gaus.com.tr/" + slug, timeout=30000)
            m = re.search(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', r.text())
            url = m.group(1) if m else None
        except Exception:
            pass
        url = url or (IMG + c[6] if c[6] else "")
        # Görsel veri adresi olarak gömülür (tuvalde küçültülebilsin; başka alan adındaki görsel tuvali kilitler)
        r = page.request.get(url, timeout=30000)
        out.append("data:image/jpeg;base64," + base64.b64encode(r.body()).decode())
    return out


def card_html(images):
    cards = []
    for i, ((code, name, stock, bayi, psf, sizes, _), img) in enumerate(zip(CARDS, images)):
        if i == 6:
            cards.append('</div><div style="page-break-before:always"></div><h1>Kış Sezonu Kataloğu — devam</h1><div class="grid">')
        bc = ean13("86912345" + str(1100 + i))
        cards.append(
            f'<div class="card"><img src="{img}"><div>'
            f'<div class="n">{name}</div><div class="k">Model: {code}</div><div class="k">Barkod: {bc}</div>'
            f'<div class="k">Stok: {stock} adet</div><div class="k">Bedenler: {sizes}</div>'
            f'<div class="p">Bayi: {bayi} TL &nbsp; PSF: {psf} TL</div></div></div>')
    return ("<html><head><meta charset='utf-8'>" + CSS + "</head><body><h1>Anadolu Tekstil Toptan — Kış Sezonu Kataloğu</h1>"
            "<div class='sub'>Kadın giyim · Bayi fiyat listesi · Fiyatlara KDV dahil değildir.</div><div class='grid'>" + "".join(cards) +
            "</div><div class='foot'>Sipariş ve bayilik: WhatsApp hattı · En az sipariş 3 adet / model</div></body></html>")


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / "demo-dosyalari"
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 900, "height": 1300})
        images = first_images(page)
        page.set_content(card_html(images), wait_until="networkidle")
        page.wait_for_function("() => [...document.images].every((i) => i.complete && i.naturalWidth > 0)", timeout=60000)
        # Fotoğraflar 480 px'e küçültülür: dosya WhatsApp'ta hızlı gider, sunucu sayfayı kısa sürede okur
        page.evaluate("""() => { for (const im of document.images) {
            const k = 480 / Math.max(im.naturalWidth, im.naturalHeight); if (k >= 1) continue;
            const c = document.createElement('canvas'); c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
            c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); im.src = c.toDataURL('image/jpeg', 0.85); } }""")
        page.wait_for_timeout(500)
        page.pdf(path=str(out / "Toptan_Giyim_Katalogu.pdf"), format="A4", print_background=True)
        b.close()
    shutil.copy(HERE / "Bayi_Fiyat_Listesi.pdf", out / "Bayi_Fiyat_Listesi.pdf")
    print(out)


if __name__ == "__main__":
    main()
