"""WhatsApp / panel "PDF + link ile yükleme" testleri için örnek PDF'ler üretir (Playwright, internet gerekmez).

Çıktı klasörü (argüman):
  resimli_katalog.pdf      2 sütunlu kart düzeni, JPEG fotoğraflar, model kodu, barkod (EAN-13), stok, bayi + PSF fiyatı, bedenler
  fiyat_listesi.pdf        resimsiz toptan fiyat tablosu (2 sayfa, renk satırları = varyant, alt satıra kayan uzun ad)
  fiyat_listesi_shopify.pdf  demo Shopify mağazasındaki (hydrogen-preview.myshopify.com) ürünlerin toptan fiyatı ve stoğu, görselsiz
  fiyat_listesi_woo.pdf      demo WooCommerce mağazasındaki (demos.flatsome.com) ürünlerin toptan fiyatı ve stoğu, görselsiz
Her kart fotoğrafı farklı renk ve şekilde; doğru eşleşme renkten anlaşılır (COLORS).
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright


def ean13(base12):
    d = [int(c) for c in base12]
    s = sum(x * (3 if i % 2 else 1) for i, x in enumerate(d))
    return base12 + str((10 - s % 10) % 10)


# (kod, ad, barkod, stok, bayi, psf, bedenler, renk, şekil)
CARDS = [
    ("WK-201", "Pamuklu Basic Tişört Beyaz", ean13("869123450001"), 120, "89,90", "179,90", "S, M, L, XL", "#e5e7eb", "circle"),
    ("WK-202", "Oversize Kapüşonlu Sweatshirt Siyah", ean13("869123450002"), 45, "219,00", "429,90", "M, L, XL", "#111827", "square"),
    ("WK-203", "Slim Fit Kot Pantolon Mavi", ean13("869123450003"), 60, "289,50", "549,90", "30, 32, 34, 36", "#1d4ed8", "triangle"),
    ("WK-204", "Keten Gömlek Bej", ean13("869123450004"), 30, "199,90", "399,90", "S, M, L", "#d6c7a1", "circle"),
    ("WK-205", "Spor Şort Lacivert", ean13("869123450005"), 85, "79,90", "159,90", "S, M, L, XL", "#1e3a8a", "square"),
    ("WK-206", "Triko Hırka Bordo", ean13("869123450006"), 25, "249,00", "499,90", "M, L", "#7f1d1d", "triangle"),
    ("WK-207", "Kanvas Sneaker Ayakkabı Kırmızı", ean13("869123450007"), 40, "349,90", "699,90", "38, 39, 40, 41, 42", "#dc2626", "circle"),
    ("WK-208", "Deri Kemer Kahverengi", ean13("869123450008"), 150, "99,00", "199,90", "", "#78350f", "square"),
]
COLORS = {c[0]: c[7] for c in CARDS}

TABLE = [
    # (stok kodu, barkod, ad, marka, renk, stok, bayi, psf)
    ("EV-1001", ean13("869765400101"), "Porselen Yemek Tabağı 27 cm", "EvKeyfi", "Beyaz", 240, "54,90", "99,90"),
    ("EV-1002", ean13("869765400102"), "Porselen Çorba Kasesi 16 cm", "EvKeyfi", "Beyaz", 180, "39,90", "74,90"),
    ("EV-1003", ean13("869765400103"), "Cam Su Bardağı 6'lı Set", "EvKeyfi", "Şeffaf", 95, "119,00", "219,90"),
    ("EV-1004", ean13("869765400104"), "Paslanmaz Çelik Çatal Bıçak Seti 24 Parça Kutulu Hediyelik", "EvKeyfi", "Gümüş", 40, "449,00", "849,90"),
    ("EV-1005", ean13("869765400105"), "Granit Tava 28 cm", "Mutfakİz", "Siyah", 70, "329,90", "629,90"),
    ("EV-1006", ean13("869765400106"), "Granit Tava 28 cm", "Mutfakİz", "Gri", 35, "329,90", "629,90"),
    ("EV-1007", ean13("869765400107"), "Granit Tencere Seti 7 Parça", "Mutfakİz", "Siyah", 22, "1.249,00", "2.399,00"),
    ("EV-1008", ean13("869765400108"), "Silikon Fırın Eldiveni", "Mutfakİz", "Kırmızı", 300, "44,90", "89,90"),
    ("EV-1009", ean13("869765400109"), "Bambu Servis Tahtası 40 cm", "EvKeyfi", "Naturel", 64, "149,00", "289,90"),
    ("EV-1010", ean13("869765400110"), "Cam Saklama Kabı 3'lü Set", "EvKeyfi", "Şeffaf", 110, "139,90", "259,90"),
    ("EV-1011", ean13("869765400111"), "Elektrikli Su Isıtıcı 1.7 L", "Mutfakİz", "Krem", 28, "549,00", "999,90"),
    ("EV-1012", ean13("869765400112"), "Elektrikli Su Isıtıcı 1.7 L", "Mutfakİz", "Siyah", 31, "549,00", "999,90"),
    ("EV-1013", ean13("869765400113"), "Türk Kahvesi Makinesi", "Mutfakİz", "Siyah", 19, "899,00", "1.699,00"),
    ("EV-1014", ean13("869765400114"), "Doğrayıcı Rondo 500 W", "Mutfakİz", "Beyaz", 26, "649,90", "1.249,00"),
    ("EV-1015", ean13("869765400115"), "Çay Takımı 12 Parça", "EvKeyfi", "Desenli", 48, "279,00", "529,90"),
    ("EV-1016", ean13("869765400116"), "Kahve Fincanı 6'lı Set", "EvKeyfi", "Lacivert", 57, "189,90", "359,90"),
    ("EV-1017", ean13("869765400117"), "Mutfak Terazisi Dijital", "Mutfakİz", "Beyaz", 73, "159,00", "299,90"),
    ("EV-1018", ean13("869765400118"), "Baharatlık 12'li Döner Stand", "EvKeyfi", "Naturel", 39, "229,00", "439,90"),
    ("EV-1019", ean13("869765400119"), "Ekmek Kutusu Bambu Kapaklı", "EvKeyfi", "Naturel", 44, "259,90", "499,90"),
    ("EV-1020", ean13("869765400120"), "Çelik Termos 1 L", "Mutfakİz", "Yeşil", 66, "239,00", "459,90"),
    ("EV-1021", ean13("869765400121"), "Çelik Termos 1 L", "Mutfakİz", "Mavi", 52, "239,00", "459,90"),
    ("EV-1022", ean13("869765400122"), "Yağdanlık Cam 500 ml", "EvKeyfi", "Şeffaf", 130, "69,90", "129,90"),
    ("EV-1023", ean13("869765400123"), "Pizza Taşı 33 cm", "Mutfakİz", "Bej", 18, "299,00", "579,90"),
    ("EV-1024", ean13("869765400124"), "Kesme Tahtası Seti 3'lü", "EvKeyfi", "Renkli", 88, "119,90", "229,90"),
]

SHOPIFY = [  # demo Shopify mağazasındaki ürün adları (fiyatlar toptancı fiyatı, USD)
    ("SD-ZEN", "The Zenith", 410.00, 12), ("SD-XTR", "The Xtreme", 405.50, 8), ("SD-WLD", "The Wildfire", 420.00, 5),
    ("SD-STO", "The Storm", 415.00, 9), ("SD-PHX", "The Phoenix", 399.90, 14), ("SD-ODY", "The Odyssey", 399.90, 3),
]
WOO = [  # demo WooCommerce mağazasındaki ürün adları (toptan fiyat, USD)
    ("FL-01", "All Star Canvas Hi Converse", 14.50, 30), ("FL-02", "U Old Skool VANS", 9.90, 22),
    ("FL-03", "Arizona Racer Ox Converse", 15.00, 17), ("FL-04", "Lucy Slim Jeans Noisy May", 61.00, 11),
    ("FL-05", "Classic Bag, Svea", 13.75, 40),
]

CARD_JS = """
(cards) => {
  for (const [code, color, shape] of cards) {
    const cv = document.createElement('canvas'); cv.width = 480; cv.height = 480;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 480, 480); g.addColorStop(0, '#fafafa'); g.addColorStop(1, '#d4d4d8');
    c.fillStyle = g; c.fillRect(0, 0, 480, 480);
    c.fillStyle = color;
    if (shape === 'circle') { c.beginPath(); c.arc(240, 240, 170, 0, Math.PI * 2); c.fill(); }
    else if (shape === 'square') c.fillRect(70, 70, 340, 340);
    else { c.beginPath(); c.moveTo(240, 50); c.lineTo(430, 420); c.lineTo(50, 420); c.closePath(); c.fill(); }
    c.fillStyle = '#ffffff'; c.font = 'bold 48px Arial'; c.fillText(code, 150, 255);
    document.getElementById('img-' + code).src = cv.toDataURL('image/jpeg', 0.9);
  }
}
"""

CSS = ("<style>body{font-family:Arial;margin:26px;color:#111}h1{margin:0 0 4px}.sub{color:#555;margin-bottom:14px}"
       ".grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{border:1px solid #ddd;border-radius:8px;padding:12px;display:flex;gap:12px;break-inside:avoid}"
       ".n{font-weight:bold;font-size:15px;margin-bottom:4px}.k{font-size:11px;color:#444;margin:2px 0}.p{font-size:14px;margin-top:6px}"
       "table{width:100%;border-collapse:collapse;font-size:11px}th,td{border-bottom:1px solid #ddd;padding:5px 6px;text-align:left}"
       "th{background:#f1f5f9}td.r,th.r{text-align:right}.foot{margin-top:14px;font-size:11px;color:#555}</style>")


def card_html():
    cards = []
    for i, (code, name, bc, stock, bayi, psf, sizes, color, shape) in enumerate(CARDS):
        if i == 6:
            cards.append('</div><div style="page-break-before:always"></div><h1>Sezon Kataloğu — devam</h1><div class="grid">')
        cards.append(
            f'<div class="card"><img id="img-{code}" width="120" height="120"><div>'
            f'<div class="n">{name}</div><div class="k">Model: {code}</div><div class="k">Barkod: {bc}</div>'
            f'<div class="k">Stok: {stock} adet</div>' + (f'<div class="k">Bedenler: {sizes}</div>' if sizes else '') +
            f'<div class="p">Bayi: {bayi} TL &nbsp; PSF: {psf} TL</div></div></div>')
    return ("<html><head><meta charset='utf-8'>" + CSS + "</head><body><h1>Moda Toptan — Sezon Kataloğu 2026</h1>"
            "<div class='sub'>Marka: ModaKent · Bayi fiyat listesi · Fiyatlara KDV dahil değildir.</div><div class='grid'>" + "".join(cards) +
            "</div><div class='foot'>www.modakenttoptan.com.tr · Sipariş: 0212 000 00 00</div></body></html>")


def table_html(rows, title, note, cols, cur_note=""):
    head = "".join(f"<th{' class=r' if c[1] else ''}>{c[0]}</th>" for c in cols)
    body = []
    for i, r in enumerate(rows):
        if i == 16 and len(rows) > 18:
            body.append(f"</tbody></table><div style='page-break-before:always'></div><h2>{title} (devam)</h2><table><thead><tr>{head}</tr></thead><tbody>")
        body.append("<tr>" + "".join(f"<td{' class=r' if cols[k][1] else ''}>{v}</td>" for k, v in enumerate(r)) + "</tr>")
    return ("<html><head><meta charset='utf-8'>" + CSS + f"</head><body><h1>{title}</h1><div class='sub'>{note}</div>"
            f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"
            f"<div class='foot'>{cur_note}www.ornektoptan.com.tr · Fiyatlar haftalık güncellenir.</div></body></html>")


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / "wa-katalog-ornekleri"
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 900, "height": 1300})
        page.set_content(card_html())
        page.evaluate(CARD_JS, [[c[0], c[7], c[8]] for c in CARDS])
        page.wait_for_timeout(300)
        page.pdf(path=str(out / "resimli_katalog.pdf"), format="A4", print_background=True)

        cols = [("Stok Kodu", 0), ("Barkod", 0), ("Ürün Adı", 0), ("Marka", 0), ("Renk", 0), ("Stok", 1), ("Bayi Fiyatı", 1), ("PSF", 1)]
        page.set_content(table_html([(a, b_, c, d, e, f, g + " TL", h + " TL") for a, b_, c, d, e, f, g, h in TABLE],
                                    "Toptan Fiyat Listesi — Ekim 2026", "Ev & Mutfak · Bayi fiyatlarıdır, KDV hariç.", cols))
        page.pdf(path=str(out / "fiyat_listesi.pdf"), format="A4", print_background=True)

        cols2 = [("Kod", 0), ("Ürün", 0), ("Stok", 1), ("Net Fiyat", 1)]
        page.set_content(table_html([(a, n, s, f"{pr:.2f}") for a, n, pr, s in SHOPIFY], "Snowboard Bayi Listesi",
                                    "Toptan net fiyatlar.", cols2, "Fiyatlar USD'dir. "))
        page.pdf(path=str(out / "fiyat_listesi_shopify.pdf"), format="A4")
        page.set_content(table_html([(a, n, s, f"{pr:.2f}") for a, n, pr, s in WOO], "Ayakkabı & Çanta Bayi Listesi",
                                    "Toptan net fiyatlar.", cols2, "Fiyatlar USD'dir. "))
        page.pdf(path=str(out / "fiyat_listesi_woo.pdf"), format="A4")
        b.close()
    print(out)


if __name__ == "__main__":
    main()
