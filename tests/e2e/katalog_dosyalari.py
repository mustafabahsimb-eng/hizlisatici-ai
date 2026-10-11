"""Katalog / fiyat listesi testleri için örnek dosyalar üretir (Playwright ile, internet gerekmez).

Çıktı klasörü (argüman): katalog_kodsuz.pdf (resimli, model kodu yok), katalog_kodlu.pdf,
taranmis.pdf (sayfa tek bir görüntü: OCR gerekir), ekran.png (ekran görüntüsü),
tablo.csv (alışılmadık başlıklar: "Ref", "Açıklama", "Birim Fiyat").
Her ürünün fotoğrafı farklı renk ve şekilde çizilir; doğru eşleşme gözle ve renkten anlaşılır.
"""
import sys
import base64
from pathlib import Path
from playwright.sync_api import sync_playwright

PRODUCTS = [
    ("KT-101", "Kırmızı Seramik Kupa 350 ml", "149,90", "#d62828", "circle"),
    ("KT-102", "Mavi Saklama Kutusu 2 L", "89,50", "#1d4ed8", "square"),
    ("KT-103", "Yeşil Bambu Kesme Tahtası", "219,00", "#15803d", "triangle"),
    ("KT-104", "Sarı Silikon Spatula", "64,90", "#eab308", "circle"),
    ("KT-105", "Mor Cam Su Şişesi 750 ml", "129,00", "#7e22ce", "square"),
    ("KT-106", "Turuncu Çelik Termos 500 ml", "349,90", "#ea580c", "triangle"),
]

PAGE_JS = """
(products) => {
  for (const [code, name, price, color, shape] of products) {
    const cv = document.createElement('canvas'); cv.width = 300; cv.height = 300;
    const c = cv.getContext('2d');
    c.fillStyle = '#f4f4f5'; c.fillRect(0, 0, 300, 300);
    c.fillStyle = color;
    if (shape === 'circle') { c.beginPath(); c.arc(150, 150, 110, 0, Math.PI * 2); c.fill(); }
    else if (shape === 'square') c.fillRect(45, 45, 210, 210);
    else { c.beginPath(); c.moveTo(150, 30); c.lineTo(270, 260); c.lineTo(30, 260); c.closePath(); c.fill(); }
    document.getElementById('img-' + code).src = cv.toDataURL('image/png');
  }
}
"""


def catalog_html(with_codes):
    cards = []
    for i, (code, name, price, color, shape) in enumerate(PRODUCTS):
        if i == 3:
            cards.append('<div style="page-break-before:always"></div><h1>Mutfak Kataloğu 2026 — devam</h1>')
        cards.append(
            f'<div class="card"><img id="img-{code}" width="180" height="180">'
            f'<div class="t"><div class="n">{name}</div>'
            + (f'<div class="c">Ürün kodu: {code}</div>' if with_codes else '')
            + f'<div class="p">{price} TL</div></div></div>')
    return ("<html><head><meta charset='utf-8'><style>body{font-family:Arial;margin:30px}"
            ".card{display:flex;gap:24px;align-items:center;border-bottom:1px solid #ddd;padding:18px 0}"
            ".n{font-size:20px;font-weight:bold}.c{color:#555;margin:6px 0}.p{font-size:22px;color:#b91c1c}</style></head>"
            "<body><h1>Mutfak Kataloğu 2026</h1><div>Marka: EvKeyfi · Fiyatlara KDV dahildir.</div>" + "".join(cards) + "</body></html>")


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / "katalog-ornekleri"
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 900, "height": 1300})
        for with_codes, fname in ((False, "katalog_kodsuz.pdf"), (True, "katalog_kodlu.pdf")):
            page.set_content(catalog_html(with_codes))
            page.evaluate(PAGE_JS, [list(x) for x in PRODUCTS])
            page.pdf(path=str(out / fname), format="A4", print_background=True)
        # Ekran görüntüsü (yalnız ilk 3 ürün) ve taranmış PDF
        page.set_content(catalog_html(False).replace('<div style="page-break-before:always"></div>', '<div style="display:none">'))
        page.evaluate(PAGE_JS, [list(x) for x in PRODUCTS])
        page.screenshot(path=str(out / "ekran.png"), full_page=True)
        shot = base64.b64encode((out / "ekran.png").read_bytes()).decode()
        page.set_content(f"<html><body style='margin:0'><img src='data:image/png;base64,{shot}' style='width:100%'></body></html>")
        page.pdf(path=str(out / "taranmis.pdf"), format="A4", print_background=True, margin={"top": "0", "bottom": "0", "left": "0", "right": "0"})
        b.close()
    (out / "tablo.csv").write_text(
        "Ref;Açıklama;Birim Fiyat;Adet\n" + "\n".join(f"{c};{n};{pr} TL;10" for c, n, pr, _, _ in PRODUCTS) + "\n",
        encoding="utf-8")
    print(out)


if __name__ == "__main__":
    main()
